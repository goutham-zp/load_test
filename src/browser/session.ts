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
}

export function sessionsFile(envName: string): string {
  return path.join(authDir(envName), "sessions.json");
}

export function loadSessions(envName: string): Record<string, UserSession> {
  const file = sessionsFile(envName);
  if (!fs.existsSync(file)) return {};
  const sessions = readJson<Record<string, UserSession>>(file);
  // Sessions saved before company-token apps existed have no key: it was the user.
  for (const [k, s] of Object.entries(sessions)) s.key ??= k;
  return sessions;
}

export function saveSessions(envName: string, sessions: Record<string, UserSession>): void {
  writeJson(sessionsFile(envName), sessions);
  fs.chmodSync(sessionsFile(envName), 0o600);
}

/** Token file handed to k6 (outside runs/, so tokens never land in results), keyed by session key. */
export function writeK6Tokens(envName: string, sessions: Record<string, UserSession>): string {
  const file = path.join(authDir(envName), "k6-tokens.json");
  writeJson(file, Object.fromEntries(Object.values(sessions).map((s) => [s.key, s.token])));
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
}

/** True when a company-token user's saved sessions cover what's needed and stay valid past the horizon. */
export function companySessionsUsable(have: UserSession[], horizonSec: number, opts: EnsureOptions, user: string, nowSec = Date.now() / 1000): boolean {
  if (have.length === 0 || have.some((s) => needsRefresh(s, horizonSec, nowSec) || !fs.existsSync(s.storageStatePath))) return false;
  const wanted = opts.companies?.[user];
  if (wanted) return wanted.every((c) => have.some((s) => s.companies.includes(c)));
  const available = have[0]!.companiesAvailable ?? have.length;
  return have.length >= Math.min(opts.maxCompanies ?? 1, available);
}

/** Logs in every user whose sessions are missing, incomplete or expire within horizonSec. */
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
  for (const user of users) {
    const have = sessionsOf(sessions, user.key);
    if (have.some((s) => s.webBaseUrl !== env.webBaseUrl)) {
      for (const s of have) delete sessions[s.key];
      have.length = 0;
    }
    if (app.tokenScope === "user") {
      const s = have[0];
      if (s && !needsRefresh(s, horizonSec) && fs.existsSync(s.storageStatePath)) continue;
    } else if (companySessionsUsable(have, horizonSec, opts, user.key)) continue;
    for (const s of have) delete sessions[s.key];
    const fresh =
      app.login.kind === "users-data"
        ? [await loginUsersDataUser(browser, env, app, app.login, user, log)]
        : await loginCompanyUser(browser, env, app, app.login, guard, user, log, {
            maxCompanies: opts.maxCompanies ?? 1,
            companies: opts.companies?.[user.key],
          });
    for (const s of fresh) sessions[s.key] = s;
    changed = true;
  }
  for (const [key, s] of Object.entries(sessions)) if (!users.some((u) => u.key === s.user)) delete sessions[key];
  if (changed) saveSessions(env.name, sessions);
  return sessions;
}
