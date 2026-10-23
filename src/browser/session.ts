import fs from "node:fs";
import path from "node:path";
import type { Browser } from "playwright";
import { readJson, writeJson } from "../config/load.ts";
import type { AppProfile, EnvConfig, User } from "../config/types.ts";
import type { CompiledGuard } from "../guard/readonly.ts";
import { authDir } from "../paths.ts";
import { loginCompanyUser, loginUsersDataUser } from "./login.ts";

export { decodeJwtExp, decodeJwtPayload } from "./jwt.ts";

export interface UserSession {
  /** The user, or "user|company" for company-token apps. Also the key of this token in the k6 token file. */
  key: string;
  user: string;
  token: string;
  /** Token expiry, epoch seconds (0 when unknown). */
  exp: number;
  /** Companies this session can open, landing company first. Company-token apps: exactly one. */
  companies: string[];
  /** Company-token apps: the company's display name and type (from the token, when the app names a claim). */
  companyName?: string;
  companyType?: string;
  /** Company-token apps: how many companies the user has in all (decides whether a re-login is needed). */
  companiesAvailable?: number;
  storageStatePath: string;
  loggedInAt: string;
  /** The env's web host at login. A session from another deployment (the env file was repointed) is never reused. */
  webBaseUrl?: string;
  /**
   * Which login of the account this is (1 = the first). Extra logins (--sessions-per-user) get their own token, and
   * the services' per-token rate limits treat each token as its own client, as they do with real users.
   */
  sessionNo?: number;
  /** The token key planned requests use (user, or user|company); all sessions of one account share it. */
  tokenKey?: string;
  /** The account's email at login: a session is not reused once .env names another account for this user key. */
  email?: string;
}

export function sessionsFile(envName: string): string {
  return path.join(authDir(envName), "sessions.json");
}

export function loadSessions(envName: string): Record<string, UserSession> {
  const file = sessionsFile(envName);
  if (!fs.existsSync(file)) return {};
  const sessions = readJson<Record<string, UserSession>>(file);
  // Sessions saved before company-token apps existed have no key: it was the user.
  for (const [k, s] of Object.entries(sessions)) {
    s.key ??= k;
    s.sessionNo ??= 1;
    s.tokenKey ??= s.key;
  }
  return sessions;
}

export function saveSessions(envName: string, sessions: Record<string, UserSession>): void {
  writeJson(sessionsFile(envName), sessions);
  fs.chmodSync(sessionsFile(envName), 0o600);
}

/**
 * Token file handed to k6 (outside runs/, so tokens never land in results), keyed by the planned token key. An account
 * with several sessions maps to a list of tokens, which k6 rotates through.
 */
export function k6Tokens(sessions: Record<string, UserSession>): Record<string, string | string[]> {
  const byKey = new Map<string, UserSession[]>();
  for (const s of Object.values(sessions)) {
    const key = s.tokenKey ?? s.key;
    byKey.set(key, [...(byKey.get(key) ?? []), s]);
  }
  return Object.fromEntries(
    [...byKey].map(([key, list]) => {
      const tokens = list.sort((a, b) => (a.sessionNo ?? 1) - (b.sessionNo ?? 1)).map((s) => s.token);
      return [key, tokens.length === 1 ? tokens[0]! : tokens];
    })
  );
}

export function writeK6Tokens(envName: string, sessions: Record<string, UserSession>): string {
  const file = path.join(authDir(envName), "k6-tokens.json");
  writeJson(file, k6Tokens(sessions));
  fs.chmodSync(file, 0o600);
  return file;
}

export function needsRefresh(session: UserSession | undefined, horizonSec: number, nowSec = Date.now() / 1000): boolean {
  if (!session || !session.token) return true;
  if (!session.exp) return false;
  return session.exp - nowSec < horizonSec;
}

export function sessionsOf(sessions: Record<string, UserSession>, user: string): UserSession[] {
  return Object.values(sessions).filter((s) => s.user === user);
}

export interface EnsureOptions {
  /** Company-token apps: log in to at most this many companies per user (when `companies` doesn't name them). */
  maxCompanies?: number;
  /** Company-token apps: the companies each user needs (e.g. the catalog's), by user. */
  companies?: Record<string, string[]>;
  /** Logins per account (default 1). Each is a separate session with its own token. */
  sessionsPerUser?: number;
  /** Logins running at once (default 6), each in its own browser context. */
  loginConcurrency?: number;
}

export const DEFAULT_LOGIN_CONCURRENCY = 6;

/**
 * Sessions whose token equals an earlier session's token of the same account. Auth0 tokens carry no unique id, so two
 * logins finishing in the same second get the very same token, which would share one rate-limit bucket.
 */
export function duplicateTokenSessions(sessions: Record<string, UserSession>): UserSession[] {
  const seen = new Map<string, Set<string>>();
  const dups: UserSession[] = [];
  for (const s of Object.values(sessions).sort((a, b) => (a.sessionNo ?? 1) - (b.sessionNo ?? 1))) {
    const key = s.tokenKey ?? s.key;
    const tokens = seen.get(key) ?? new Set<string>();
    if (tokens.has(s.token)) dups.push(s);
    else tokens.add(s.token);
    seen.set(key, tokens);
  }
  return dups;
}

/** Runs tasks with at most `limit` at a time; every task runs even when others fail. */
export async function runPool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await tasks[i]!() };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, worker));
  return results;
}

/**
 * Runs `task`, and once more if it fails with an error `retryable` accepts (e.g. a slow login page, not a wrong
 * password, which retrying could lock out).
 */
export async function retryOnce<T>(task: () => Promise<T>, retryable: (e: Error) => boolean, onRetry: (e: Error) => void): Promise<T> {
  try {
    return await task();
  } catch (e) {
    if (!(e instanceof Error) || !retryable(e)) throw e;
    onRetry(e);
    return await task();
  }
}

/** True for login failures worth a second try: anything except Auth0 rejecting the credentials. */
export const retryableLoginError = (e: Error) => !e.message.startsWith("Auth0 rejected");

/** The label a session's login runs under: the user for the first, user#n for the others (files, keys). */
export function sessionLabel(user: string, sessionNo: number): string {
  return sessionNo === 1 ? user : `${user}#${sessionNo}`;
}

/** True when a company-token user's saved sessions cover what's needed and stay valid past the horizon. */
export function companySessionsUsable(have: UserSession[], horizonSec: number, opts: EnsureOptions, user: string, nowSec = Date.now() / 1000): boolean {
  if (have.length === 0 || have.some((s) => needsRefresh(s, horizonSec, nowSec) || !fs.existsSync(s.storageStatePath))) return false;
  const wanted = opts.companies?.[user];
  if (wanted) return wanted.every((c) => have.some((s) => s.companies.includes(c)));
  const available = have[0]!.companiesAvailable ?? have.length;
  return have.length >= Math.min(opts.maxCompanies ?? 1, available);
}

/**
 * Logs in every session (user x sessionsPerUser) that is missing, incomplete or expires within horizonSec, several at
 * a time. Each finished login is saved right away, so an interrupted run keeps what it got.
 */
export async function ensureSessions(
  browser: Browser,
  env: EnvConfig,
  app: AppProfile,
  guard: CompiledGuard,
  users: User[],
  horizonSec: number,
  log: (m: string) => void,
  opts: EnsureOptions = {}
): Promise<Record<string, UserSession>> {
  const sessions = loadSessions(env.name);
  let changed = false;
  for (const [key, s] of Object.entries(sessions)) {
    if (!users.some((u) => u.key === s.user)) {
      delete sessions[key];
      changed = true;
    }
  }
  const todo: { user: User; n: number }[] = [];
  for (const user of users) {
    const all = sessionsOf(sessions, user.key);
    if (all.some((s) => s.webBaseUrl !== env.webBaseUrl || s.email?.toLowerCase() !== user.email.toLowerCase())) {
      for (const s of all) delete sessions[s.key];
      changed = true;
    }
    for (let n = 1; n <= Math.max(1, opts.sessionsPerUser ?? 1); n++) {
      const have = sessionsOf(sessions, user.key).filter((s) => (s.sessionNo ?? 1) === n);
      if (app.tokenScope === "user") {
        const s = have[0];
        if (s && !needsRefresh(s, horizonSec) && fs.existsSync(s.storageStatePath)) continue;
      } else if (companySessionsUsable(have, horizonSec, opts, user.key)) continue;
      for (const s of have) delete sessions[s.key];
      changed = true;
      todo.push({ user, n });
    }
  }
  if (changed) saveSessions(env.name, sessions);

  const limit = opts.loginConcurrency ?? DEFAULT_LOGIN_CONCURRENCY;
  if (todo.length > 1) log(`Logging in ${todo.length} sessions, ${Math.min(limit, todo.length)} at a time`);
  const loginOne = async ({ user, n }: { user: User; n: number }) => {
      // Each login of the account runs under its own label, so keys and saved browser states don't collide.
      const label = sessionLabel(user.key, n);
      const as = { ...user, key: label };
      const fresh =
        app.login.kind === "users-data"
          ? [await loginUsersDataUser(browser, env, app, app.login, as, log)]
          : await loginCompanyUser(browser, env, app, app.login, guard, as, log, {
              maxCompanies: opts.maxCompanies ?? 1,
              companies: opts.companies?.[user.key],
            });
      for (const s of fresh) {
        s.user = user.key;
        s.email = user.email;
        s.sessionNo = n;
        s.tokenKey = label === user.key ? s.key : user.key + s.key.slice(label.length);
        sessions[s.key] = s;
      }
      saveSessions(env.name, sessions);
  };
  const results = await runPool(
    todo.map((t) => () =>
      retryOnce(
        () => loginOne(t),
        retryableLoginError,
        (e) => log(`${sessionLabel(t.user.key, t.n)}: login failed (${e.message.split("\n")[0]}); trying once more`)
      )
    ),
    limit
  );
  // Logins of one account that finished in the same second got the same token: redo those, staggered, until distinct.
  for (let round = 1; round <= 3; round++) {
    const dups = duplicateTokenSessions(sessions);
    if (dups.length === 0) break;
    log(`${dups.length} session(s) got the same token as another login of the same account; logging them in again (round ${round})`);
    for (const d of dups) delete sessions[d.key];
    saveSessions(env.name, sessions);
    const redo = dups.map((d) => ({ user: users.find((u) => u.key === d.user)!, n: d.sessionNo ?? 1 }));
    await runPool(
      redo.map((t, i) => async () => {
        await new Promise((r) => setTimeout(r, i * 1500));
        await loginOne(t);
      }),
      limit
    );
  }
  const stillDup = duplicateTokenSessions(sessions);
  if (stillDup.length) log(`Warning: ${stillDup.length} session(s) still share a token with another session of the account: ${stillDup.map((s) => s.key).join(", ")}`);
  const failed = results
    .map((r, i) => (r.status === "rejected" ? `${sessionLabel(todo[i]!.user.key, todo[i]!.n)}: ${(r.reason as Error).message.split("\n")[0]}` : undefined))
    .filter((m): m is string => !!m);
  if (failed.length) throw new Error(`${failed.length} of ${todo.length} logins failed (the others are saved; run again to retry):\n  ${failed.join("\n  ")}`);
  return sessions;
}
