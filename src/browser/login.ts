import fs from "node:fs";
import path from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import { companyRouteRegex, loginPath } from "../config/app.ts";
import type { AppProfile, CompanyExchangeLogin, EnvConfig, User, UsersDataLogin } from "../config/types.ts";
import type { CompiledGuard } from "../guard/readonly.ts";
import { authDir } from "../paths.ts";
import { slug } from "../util.ts";
import { newGuardedContext } from "./context.ts";
import { decodeJwtExp, decodeJwtPayload } from "./jwt.ts";
import type { UserSession } from "./session.ts";

const USERNAME = "input#username, input[name=\"username\"], input[type=\"email\"]";
const PASSWORD = "input#password, input[name=\"password\"], input[type=\"password\"]";
// Auth0's new login screens put a hidden decoy submit (aria-hidden, under the input) before the real one.
const SUBMIT = ["[data-action-button-primary=\"true\"]", "button[type=\"submit\"][name=\"action\"]", "button[type=\"submit\"]"]
  .map((s) => `${s}:not([aria-hidden="true"])`)
  .join(", ");
const AUTH_ERROR = "#error-element-password, #error-element-username, .ulp-input-error-message, .ulp-error-info";

async function submit(page: Page): Promise<void> {
  await page.locator(SUBMIT).filter({ visible: true }).first().click({ timeout: 10_000 });
}

/**
 * Fills username-only screens until a password field shows, then the password. Covers Auth0 classic (both fields),
 * identifier-first (username, then password) and an app's own username page in front of Auth0 (FMS_UI /login).
 */
export async function fillLoginForms(page: Page, user: User): Promise<void> {
  const username = page.locator(USERNAME).first();
  const password = page.locator(PASSWORD).first();
  for (let round = 0; round < 4; round++) {
    await Promise.any([
      username.waitFor({ state: "visible", timeout: 60_000 }),
      password.waitFor({ state: "visible", timeout: 60_000 }),
    ]).catch(() => {
      throw new Error(`${user.key}: no login form appeared within 60s. Last URL: ${page.url()}`);
    });
    if (await username.isVisible().catch(() => false)) {
      if ((await username.inputValue().catch(() => "")) !== user.email) await username.fill(user.email);
    }
    if (await password.isVisible().catch(() => false)) {
      await password.fill(user.password);
      await submit(page);
      return;
    }
    const before = page.url();
    await submit(page);
    // Wait for the next screen: the password field, this username field going away, or a new URL (the next screen,
    // e.g. Auth0 after the app's own page, may have a username field of its own).
    await Promise.any([
      password.waitFor({ state: "visible", timeout: 30_000 }),
      username.waitFor({ state: "hidden", timeout: 30_000 }),
      page.waitForURL((u) => u.href !== before, { timeout: 30_000, waitUntil: "domcontentloaded" }),
    ]).catch(() => {});
  }
  throw new Error(`${user.key}: never reached a password field. Last URL: ${page.url()}`);
}

/**
 * Opens the app's login page, fills Auth0 universal login (classic or identifier-first) and waits until the app has
 * stored `storageKey` in localStorage on its own host.
 */
async function auth0Login(page: Page, env: EnvConfig, app: AppProfile, user: User, storageKey: string): Promise<void> {
  await page.goto(env.webBaseUrl + loginPath(app, env), { waitUntil: "domcontentloaded", timeout: 60_000 });
  await fillLoginForms(page, user);

  const webHost = new URL(env.webBaseUrl).host;
  const outcome = await Promise.race([
    page
      .waitForFunction(([host, key]) => location.host === host && !!localStorage.getItem(key!), [webHost, storageKey], { timeout: 90_000 })
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
  if (outcome === "timeout") throw new Error(`${user.key}: login did not complete within 90s (no "${storageKey}" in localStorage). Last URL: ${page.url()}`);
}

async function saveState(context: BrowserContext, envName: string, file: string): Promise<string> {
  const dir = authDir(envName);
  fs.mkdirSync(dir, { recursive: true });
  const storageStatePath = path.join(dir, file);
  await context.storageState({ path: storageStatePath });
  fs.chmodSync(storageStatePath, 0o600);
  return storageStatePath;
}

const expiry = (exp: number) => (exp ? new Date(exp * 1000).toISOString() : "unknown");

// ------------------------------------------------------------------------------------------------ users-data (DXP.Web)

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

/** True for the companies call, matched on its last two path segments (e.g. users/data) so any API version counts. */
export function isUsersDataUrl(url: string, usersDataPath: string): boolean {
  const tail = usersDataPath.split("/").filter(Boolean).slice(-2).join("/");
  return new URL(url).pathname.endsWith("/" + tail);
}

/** Fetches the companies call with the user's token, retrying slow or failing calls. Returns companies or why it failed. */
async function fetchUserDataCompanies(url: string, token: string, extraHeaders: Record<string, string> = {}, attempts = 3): Promise<{ companies: string[]; problem?: string }> {
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

/** DXP.Web: one Auth0 token per user; the companies come from the app's /users/data call. */
export async function loginUsersDataUser(browser: Browser, env: EnvConfig, app: AppProfile, login: UsersDataLogin, user: User, log: (m: string) => void): Promise<UserSession> {
  const context = await browser.newContext({ serviceWorkers: "block", ignoreHTTPSErrors: true });
  const page = await context.newPage();
  let companies: string[] = [];
  let usersData: { url: string; headers: Record<string, string> } | undefined;
  page.on("response", async (res) => {
    if (!isUsersDataUrl(res.url(), login.usersDataPath)) return;
    usersData = { url: res.url(), headers: res.request().headers() };
    try {
      const found = companiesFromUserData(await res.json());
      if (found.length) companies = found;
    } catch {
      // The app navigates right after this call, so the body is often gone; re-fetched below.
    }
  });

  try {
    await auth0Login(page, env, app, user, app.tokenKey);

    // Single-company users land on a company page; multi-company users stay on a "Select Company" page. Either way,
    // wait (bounded) for the app's own companies call, then fall back to fetching it ourselves.
    const companyRoute = companyRouteRegex(login.companyRoute, env.lang);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !usersData && !companyRoute.test(page.url())) await page.waitForTimeout(250);
    const token = await page.evaluate((key) => localStorage.getItem(key) ?? "", app.tokenKey);
    const problems: string[] = [];
    if (companies.length === 0 && usersData) {
      const r = await fetchUserDataCompanies(usersData.url, token, usersData.headers);
      companies = r.companies;
      if (r.problem) problems.push(r.problem);
    }
    for (const base of companies.length ? [] : env.gatewayBaseUrls) {
      const url = base.replace(/\/$/, "") + login.usersDataPath;
      if (url === usersData?.url) continue;
      const r = await fetchUserDataCompanies(url, token);
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

    const storageStatePath = await saveState(context, env.name, `${user.key}.state.json`);
    const session: UserSession = {
      key: user.key,
      user: user.key,
      token,
      exp: decodeJwtExp(token),
      companies,
      storageStatePath,
      loggedInAt: new Date().toISOString(),
      webBaseUrl: env.webBaseUrl,
    };
    log(`${user.key}: logged in, ${companies.length} compan${companies.length === 1 ? "y" : "ies"}, token expires ${expiry(session.exp)}`);
    return session;
  } finally {
    await context.close();
  }
}

// ------------------------------------------------------------------------------------------ company-exchange (FMS_UI)

export interface AuthCompany {
  /** The company id used in the catalog: its ftsId, or its login when it has none. */
  id: string;
  /** wwwLogin: what the token exchange takes. */
  login: string;
  name?: string;
}

interface AuthCompanyNode {
  ftsId?: number | string;
  userName?: string;
  companyName?: string;
  childCompanies?: AuthCompanyNode[];
}

/** Flattens the auth companies list ({ result: [...] }, children included) in order. */
export function companiesFromAuthList(data: unknown): AuthCompany[] {
  const d = data as { result?: unknown; data?: { result?: unknown } } | unknown[];
  const list = (Array.isArray(d) ? d : Array.isArray(d?.result) ? d.result : Array.isArray(d?.data?.result) ? d.data.result : []) as AuthCompanyNode[];
  const out: AuthCompany[] = [];
  const visit = (c: AuthCompanyNode) => {
    if (c.userName && !out.some((o) => o.login === c.userName)) {
      out.push({ id: c.ftsId !== undefined && c.ftsId !== null ? String(c.ftsId) : c.userName, login: c.userName, name: c.companyName });
    }
    for (const child of c.childCompanies ?? []) visit(child);
  };
  for (const c of list) visit(c);
  return out;
}

/** Picks the companies to log in to: the wanted ids (in order) or the first `max`. */
export function chooseCompanies(all: AuthCompany[], opts: { maxCompanies: number; companies?: string[] }): { chosen: AuthCompany[]; missing: string[] } {
  if (!opts.companies) return { chosen: all.slice(0, Math.max(1, opts.maxCompanies)), missing: [] };
  const chosen = opts.companies.map((id) => all.find((c) => c.id === id || c.login === id)).filter((c): c is AuthCompany => !!c);
  return { chosen, missing: opts.companies.filter((id) => !chosen.some((c) => c.id === id || c.login === id)) };
}

async function fetchAuthCompanies(url: string, auth0Token: string): Promise<{ companies: AuthCompany[]; problem?: string }> {
  try {
    const res = await fetch(url, { headers: { accept: "application/json", authorization: `Bearer ${auth0Token}` }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return { companies: [], problem: `${url}: HTTP ${res.status}` };
    const companies = companiesFromAuthList(await res.json());
    return companies.length ? { companies } : { companies: [], problem: `${url}: no companies with a userName in the response` };
  } catch (e) {
    return { companies: [], problem: `${url}: ${(e as Error).message}` };
  }
}

const joinUrl = (base: string, p: string) => base.replace(/\/+$/, "") + p;
const gatewayTail = (p: string) => p.replace(/^\/api(?=\/)/, "");

/**
 * True when a URL path is the configured API path, called directly (`/api/v1/x`) or through the gateway, where FMS_UI
 * drops the leading `api/` and adds its router prefix (`/fms/v1/x`).
 */
export function isApiPath(pathname: string, configured: string): boolean {
  return pathname.endsWith(configured) || pathname.endsWith(gatewayTail(configured));
}

/** `toPath` next to a URL of `fromPath`: same host and, through the gateway, the same router prefix. */
export function siblingApiUrl(url: string, fromPath: string, toPath: string): string | undefined {
  const u = new URL(url);
  if (u.pathname.endsWith(fromPath)) return u.origin + u.pathname.slice(0, -fromPath.length) + toPath;
  const tail = gatewayTail(fromPath);
  if (u.pathname.endsWith(tail)) return u.origin + u.pathname.slice(0, -tail.length) + gatewayTail(toPath);
  return undefined;
}

/** The value at a dot path ("result.companyType") in parsed JSON, or undefined. */
export function fieldAt(data: unknown, dotPath: string): unknown {
  let cur: unknown = data;
  for (const key of dotPath.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** The exchange body: the profile's extra fields, then the app's own call's fields, with this token and company. */
export function exchangeBody(login: Pick<CompanyExchangeLogin, "exchangeExtraBody">, appBody: Record<string, unknown> | undefined, token: string, wwwLogin: string): Record<string, unknown> {
  return { ...(login.exchangeExtraBody ?? {}), ...(appBody ?? {}), token, wwwLogin };
}

/** Runs a page call, once more after the page settles if an app-side navigation destroyed its context. */
async function inPage<T>(page: Page, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    if (!/Execution context was destroyed|navigation/i.test((e as Error).message)) throw e;
    await page.waitForLoadState("load").catch(() => {});
    return call();
  }
}

/**
 * FMS_UI: Auth0 login, then one API token per company. The app swaps its Auth0 token for a company token at the auth
 * API (exchangePath); this does the same swap from the page for each chosen company and saves one session each.
 * The login runs in a guarded browser: only the app's declared auth calls may write.
 */
export async function loginCompanyUser(
  browser: Browser,
  env: EnvConfig,
  app: AppProfile,
  login: CompanyExchangeLogin,
  guard: CompiledGuard,
  user: User,
  log: (m: string) => void,
  want: { maxCompanies: number; companies?: string[] }
): Promise<UserSession[]> {
  const { context } = await newGuardedContext(browser, guard);
  const page = await context.newPage();
  let listed: AuthCompany[] = [];
  let companiesUrl: string | undefined;
  // The app's own exchange call: its URL, the company it chose and its body (fields such as requestedBy), which the
  // exchanges below repeat with only the token and company changed.
  let exchange: { url: string; login?: string; body?: Record<string, unknown> } | undefined;
  page.on("request", (req) => {
    if (!isApiPath(new URL(req.url()).pathname, login.exchangePath)) return;
    let body: Record<string, unknown> | undefined;
    try {
      body = JSON.parse(req.postData() ?? "{}") as Record<string, unknown>;
    } catch {
      // Not JSON: the URL is still useful.
    }
    exchange = { url: req.url(), login: typeof body?.wwwLogin === "string" ? body.wwwLogin : undefined, body };
  });
  let companyInfoUrl: string | undefined;
  page.on("request", (req) => {
    if (login.companyInfoPath && req.method() === "GET" && isApiPath(new URL(req.url()).pathname, login.companyInfoPath)) companyInfoUrl = req.url();
  });
  page.on("response", async (res) => {
    if (!isApiPath(new URL(res.url()).pathname, login.companiesPath)) return;
    companiesUrl = res.url();
    try {
      const found = companiesFromAuthList(await res.json());
      if (found.length) listed = found;
    } catch {
      // Body gone after a navigation; fetched again below.
    }
  });

  try {
    await auth0Login(page, env, app, user, login.auth0TokenKey);
    // Multi-company users stop at the company picker (the app lists companies); others are swapped straight to their
    // default company (the app calls the exchange itself). Wait for either.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !listed.length && !exchange) await page.waitForTimeout(250);
    const auth0Token = await page.evaluate((key) => localStorage.getItem(key) ?? "", login.auth0TokenKey);

    // The app lists companies only for some users (a feature flag, no default company); otherwise it swaps straight to
    // the default one. Then try the list next to the exchange (same gateway prefix), for --max-companies above 1.
    const problems: string[] = [];
    if (!listed.length) {
      const url =
        companiesUrl ??
        (env.usersApiBaseUrl ? joinUrl(env.usersApiBaseUrl, login.companiesPath) : undefined) ??
        (exchange ? siblingApiUrl(exchange.url, login.exchangePath, login.companiesPath) : undefined);
      if (url) {
        const r = await fetchAuthCompanies(url, auth0Token);
        listed = r.companies;
        if (listed.length) companiesUrl = url;
        if (r.problem) problems.push(r.problem);
      } else problems.push(`the app neither listed companies nor called the token exchange within 30s, and envs/${env.name}.json has no usersApiBaseUrl`);
      if (!listed.length && exchange?.login) log(`${user.key}: using the app's default company only (${problems.join("; ") || "no company list"})`);
    }
    // A single-company user: the company is whatever the app swapped to.
    if (!listed.length && exchange?.login) listed = [{ id: exchange.login, login: exchange.login }];
    if (!listed.length) throw new Error(`${user.key}: logged in but found no companies. Tried: ${problems.join("; ")}`);

    // Exchange URL: the app's own call, the env's authApiBaseUrl, or let the app pick the first company and read it then.
    if (!exchange && !env.authApiBaseUrl && login.pickerSelector) {
      const picker = page.locator(login.pickerSelector).first();
      if (await picker.isVisible({ timeout: 15_000 }).catch(() => false)) {
        // The app reloads after its exchange; wait for that navigation so later page calls don't race it.
        const navigated = page.waitForEvent("framenavigated", { predicate: (f) => f === page.mainFrame(), timeout: 30_000 }).catch(() => {});
        await picker.click({ timeout: 10_000 }).catch(() => {});
        const until = Date.now() + 30_000;
        while (Date.now() < until && !exchange) await page.waitForTimeout(250);
        await navigated;
        await page.waitForLoadState("load").catch(() => {});
      }
    }
    const exchangeUrl = exchange?.url ?? (env.authApiBaseUrl ? joinUrl(env.authApiBaseUrl, login.exchangePath) : undefined);
    if (!exchangeUrl) {
      throw new Error(`${user.key}: don't know where the token exchange is. Set "authApiBaseUrl" in envs/${env.name}.json (REACT_APP_AUTH_API_HOSTNAME of the deployment).`);
    }
    log(`${user.key}: token exchange at ${new URL(exchangeUrl).origin}, companies listed${companiesUrl ? ` at ${new URL(companiesUrl).origin}` : ""}: ${listed.length}`);
    const { chosen, missing } = chooseCompanies(listed, want);
    if (missing.length) log(`${user.key}: companies no longer available to this user: ${missing.join(", ")}`);

    const sessions: UserSession[] = [];
    for (const company of chosen) {
      const r = await inPage(page, async () => page.evaluate(
        async ({ url, body, accessHeader, refreshHeader }) => {
          const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
          return { status: res.status, access: res.headers.get(accessHeader), refresh: res.headers.get(refreshHeader) };
        },
        {
          url: exchangeUrl,
          body: exchangeBody(login, exchange?.body, auth0Token, company.login),
          accessHeader: login.accessTokenHeader,
          refreshHeader: login.refreshTokenHeader,
        }
      ));
      if (!r.access) {
        log(`${user.key}: company ${company.name ?? company.login}: token exchange gave HTTP ${r.status} and no ${login.accessTokenHeader}; skipped`);
        continue;
      }
      await inPage(page, () => page.evaluate(
        ({ values }) => {
          for (const [k, v] of Object.entries(values)) if (v) localStorage.setItem(k, v);
        },
        { values: { [app.tokenKey]: r.access!, [login.refreshTokenKey]: r.refresh ?? "", ...(login.extraStorage ?? {}) } }
      ));
      const storageStatePath = await saveState(context, env.name, `${user.key}__${slug(company.id)}.state.json`);
      let claim = login.companyTypeClaim ? decodeJwtPayload(r.access)?.[login.companyTypeClaim] : undefined;
      if (claim === undefined && login.companyInfoPath && login.companyTypeField) {
        // The app asks for the company right after its exchange; give that call a moment to show up.
        for (let i = 0; i < 20 && !companyInfoUrl; i++) await page.waitForTimeout(250);
        if (companyInfoUrl) {
          const info = await inPage(page, () => page.evaluate(
            async ({ url, token }) => {
              const res = await fetch(url, { headers: { accept: "application/json", authorization: `Bearer ${token}` } });
              return res.ok ? ((await res.json()) as unknown) : undefined;
            },
            { url: companyInfoUrl!, token: r.access! }
          )).catch(() => undefined);
          claim = fieldAt(info, login.companyTypeField);
        }
      }
      const session: UserSession = {
        key: `${user.key}|${company.id}`,
        user: user.key,
        token: r.access,
        exp: decodeJwtExp(r.access),
        companies: [company.id],
        companyName: company.name,
        companyType: typeof claim === "string" ? claim : undefined,
        companiesAvailable: listed.length,
        storageStatePath,
        loggedInAt: new Date().toISOString(),
        webBaseUrl: env.webBaseUrl,
      };
      sessions.push(session);
      log(`${user.key}: company ${company.name ?? company.login} (${company.id})${session.companyType ? ` [${session.companyType}]` : ""}, token expires ${expiry(session.exp)}`);
    }
    if (!sessions.length) throw new Error(`${user.key}: logged in, but no company token could be obtained.`);
    return sessions;
  } finally {
    await context.close();
  }
}
