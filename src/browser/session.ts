import fs from "node:fs";
import path from "node:path";
import type { Browser, Page } from "playwright";
import { readJson, writeJson } from "../config/load.ts";
import type { EnvConfig, User } from "../config/types.ts";
import { authDir } from "../paths.ts";

export interface UserSession {
  user: string;
  token: string;
  /** Token expiry, epoch seconds (0 when unknown). */
  exp: number;
  /** Company ids (ftsId) the user can open, landing company first. */
  companies: string[];
  storageStatePath: string;
  loggedInAt: string;
}

export function decodeJwtExp(token: string): number {
  const part = token.split(".")[1];
  if (!part) return 0;
  try {
    const payload = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp : 0;
  } catch {
    return 0;
  }
}

interface CompanyNode {
  ftsId?: number | string;
  companyId?: number | string;
  childCompanies?: CompanyNode[];
}

/** Flattens /users/data activeCompanies (+ childCompanies) into ftsIds, preserving order. */
export function companiesFromUserData(data: unknown): string[] {
  const list = (data as { result?: { activeCompanies?: CompanyNode[] } })?.result?.activeCompanies ?? [];
  const out: string[] = [];
  const visit = (c: CompanyNode) => {
    const id = c.ftsId ?? c.companyId;
    if (id !== undefined && id !== null && !out.includes(String(id))) out.push(String(id));
    for (const child of c.childCompanies ?? []) visit(child);
  };
  for (const c of list) visit(c);
  return out;
}

/** Where the app loads the user's companies, relative to a gateway base URL. */
export const USERS_DATA_PATH = "/fms/v2.1/users/data";

export function isUsersDataUrl(url: string): boolean {
  return /\/users\/data$/.test(new URL(url).pathname);
}

/** Fetches /users/data with the user's token, retrying slow or failing calls. Returns companies or why it failed. */
async function fetchCompanies(url: string, token: string, extraHeaders: Record<string, string> = {}, attempts = 3): Promise<{ companies: string[]; problem?: string }> {
  const headers: Record<string, string> = { accept: "application/json", authorization: `Bearer ${token}` };
  for (const [k, v] of Object.entries(extraHeaders)) if (k.toLowerCase() === "retailerftsid") headers[k] = v;
  let problem = "";
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
      if (res.ok) {
        const companies = companiesFromUserData(await res.json());
        if (companies.length) return { companies };
        problem = "response has no activeCompanies";
        break;
      }
      problem = `HTTP ${res.status}`;
      if (res.status < 500 && res.status !== 429) break;
    } catch (e) {
      problem = (e as Error).message;
    }
    if (i < attempts) await new Promise((r) => setTimeout(r, 2000 * i));
  }
  return { companies: [], problem: `${url}: ${problem}` };
}

const USERNAME = "input#username, input[name=\"username\"], input[type=\"email\"]";
const PASSWORD = "input#password, input[name=\"password\"], input[type=\"password\"]";
const SUBMIT = "[data-action-button-primary=\"true\"], button[type=\"submit\"][name=\"action\"], button[type=\"submit\"]";
const AUTH_ERROR = "#error-element-password, #error-element-username, .ulp-input-error-message, .ulp-error-info";

async function submit(page: Page): Promise<void> {
  await page.locator(SUBMIT).first().click({ timeout: 10_000 });
}

/** Logs a user in through Auth0 universal login (classic or identifier-first) and saves the session. */
export async function loginUser(browser: Browser, env: EnvConfig, user: User, log: (m: string) => void): Promise<UserSession> {
  const context = await browser.newContext({ serviceWorkers: "block", ignoreHTTPSErrors: true });
  const page = await context.newPage();
  let companies: string[] = [];
  let usersData: { url: string; headers: Record<string, string> } | undefined;
  page.on("response", async (res) => {
    if (!isUsersDataUrl(res.url())) return;
    usersData = { url: res.url(), headers: res.request().headers() };
    try {
      const found = companiesFromUserData(await res.json());
      if (found.length) companies = found;
    } catch {
      // The app navigates right after this call, so the body is often gone; re-fetched below.
    }
  });

  try {
    const start = env.loginPath ?? `/${env.lang}/retailer`;
    await page.goto(env.webBaseUrl + start, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator(USERNAME).first().waitFor({ state: "visible", timeout: 60_000 });
    await page.locator(USERNAME).first().fill(user.email);
    const password = page.locator(PASSWORD).first();
    if (!(await password.isVisible().catch(() => false))) {
      await submit(page);
      await password.waitFor({ state: "visible", timeout: 30_000 });
    }
    await password.fill(user.password);
    await submit(page);

    const webHost = new URL(env.webBaseUrl).host;
    const outcome = await Promise.race([
      page
        .waitForFunction((host) => location.host === host && !!localStorage.getItem("token"), webHost, { timeout: 90_000 })
        .then(() => "ok" as const)
        .catch(() => "timeout" as const),
      page
        .locator(AUTH_ERROR)
        .filter({ visible: true })
        .first()
        .waitFor({ timeout: 90_000 })
        .then(() => "auth-error" as const)
        .catch(() => "timeout" as const),
    ]);
    if (outcome === "auth-error") {
      const msg = await page.locator(AUTH_ERROR).filter({ visible: true }).first().innerText().catch(() => "");
      throw new Error(`Auth0 rejected ${user.key}: ${msg.trim() || "unknown error"}`);
    }
    if (outcome === "timeout") throw new Error(`${user.key}: login did not complete within 90s (no token in localStorage). Last URL: ${page.url()}`);

    // Single-company users land on /retailer/<id>; multi-company users stay on a "Select Company" page. Either way,
    // wait (bounded) for the app's own /users/data call, then fall back to fetching it ourselves.
    const companyRoute = new RegExp(`/${env.lang}/retailer/(\\d+)`);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !usersData && !companyRoute.test(page.url())) await page.waitForTimeout(250);
    const token = await page.evaluate(() => localStorage.getItem("token") ?? "");
    const problems: string[] = [];
    if (companies.length === 0 && usersData) {
      const r = await fetchCompanies(usersData.url, token, usersData.headers);
      companies = r.companies;
      if (r.problem) problems.push(r.problem);
    }
    for (const base of companies.length ? [] : env.gatewayBaseUrls) {
      const url = base.replace(/\/$/, "") + USERS_DATA_PATH;
      if (url === usersData?.url) continue;
      const r = await fetchCompanies(url, token);
      if (r.companies.length) {
        companies = r.companies;
        break;
      }
      problems.push(r.problem!);
    }
    const landing = page.url().match(companyRoute)?.[1];
    if (landing) companies = [landing, ...companies.filter((c) => c !== landing)];
    if (companies.length === 0) {
      const seen = usersData ? "the app called /users/data but it gave no companies" : "the app never called /users/data";
      throw new Error(`${user.key}: logged in but found no company id (${seen}; landed on ${page.url()}). Tried: ${problems.join("; ") || "nothing"}`);
    }

    const dir = authDir(env.name);
    fs.mkdirSync(dir, { recursive: true });
    const storageStatePath = path.join(dir, `${user.key}.state.json`);
    await context.storageState({ path: storageStatePath });
    fs.chmodSync(storageStatePath, 0o600);
    const session: UserSession = {
      user: user.key,
      token,
      exp: decodeJwtExp(token),
      companies,
      storageStatePath,
      loggedInAt: new Date().toISOString(),
    };
    log(`${user.key}: logged in, ${companies.length} compan${companies.length === 1 ? "y" : "ies"}, token expires ${session.exp ? new Date(session.exp * 1000).toISOString() : "unknown"}`);
    return session;
  } finally {
    await context.close();
  }
}

export function sessionsFile(envName: string): string {
  return path.join(authDir(envName), "sessions.json");
}

export function loadSessions(envName: string): Record<string, UserSession> {
  const file = sessionsFile(envName);
  return fs.existsSync(file) ? readJson<Record<string, UserSession>>(file) : {};
}

export function saveSessions(envName: string, sessions: Record<string, UserSession>): void {
  writeJson(sessionsFile(envName), sessions);
  fs.chmodSync(sessionsFile(envName), 0o600);
}

/** Token file handed to k6 (outside runs/, so tokens never land in results). */
export function writeK6Tokens(envName: string, sessions: Record<string, UserSession>): string {
  const file = path.join(authDir(envName), "k6-tokens.json");
  writeJson(file, Object.fromEntries(Object.values(sessions).map((s) => [s.user, s.token])));
  fs.chmodSync(file, 0o600);
  return file;
}

export function needsRefresh(session: UserSession | undefined, horizonSec: number, nowSec = Date.now() / 1000): boolean {
  if (!session || !session.token) return true;
  if (!session.exp) return false;
  return session.exp - nowSec < horizonSec;
}

/** Logs in every user whose session is missing or expires within horizonSec. */
export async function ensureSessions(
  browser: Browser,
  env: EnvConfig,
  users: User[],
  horizonSec: number,
  log: (m: string) => void
): Promise<Record<string, UserSession>> {
  const sessions = loadSessions(env.name);
  let changed = false;
  for (const user of users) {
    const s = sessions[user.key];
    if (!needsRefresh(s, horizonSec) && s && fs.existsSync(s.storageStatePath)) continue;
    sessions[user.key] = await loginUser(browser, env, user, log);
    changed = true;
  }
  for (const key of Object.keys(sessions)) if (!users.some((u) => u.key === key)) delete sessions[key];
  if (changed) saveSessions(env.name, sessions);
  return sessions;
}
