import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { chooseCompanies, companiesFromAuthList, exchangeBody, fieldAt, isApiPath, siblingApiUrl } from "../src/browser/login.ts";
import { companySessionsUsable, type UserSession } from "../src/browser/session.ts";
import { buildCatalog, resolveEndpoint } from "../src/catalog/build.ts";
import type { CatalogEndpoint, RecordedRequest } from "../src/catalog/types.ts";
import { loginPath, pagePathFromUrl, pageUrl, tokenKeyFor } from "../src/config/app.ts";
import { loadApp, loadInteractions, loadPages } from "../src/config/load.ts";
import { createRouteMatcher } from "../src/gateway/routes.ts";
import { compileGuard, isReplayable } from "../src/guard/readonly.ts";
import { buildLoadPlan, endpointSequence } from "../src/load/plan.ts";
import { assertTokensFor, catalogCompanies } from "../src/run/run.ts";

const retailer = loadApp({ name: "t", app: "retailer" });
const fms = loadApp({ name: "t", app: "fms" });
const env = { webBaseUrl: "https://web", lang: "en" };

describe("app profiles", () => {
  it("load with their pages and interactions; an env without app is retailer", () => {
    expect(loadApp({ name: "t" }).name).toBe("retailer");
    expect(loadPages(retailer).length).toBeGreaterThan(30);
    expect(loadPages(fms).some((p) => p.companyTypes?.includes("Retailer"))).toBe(true);
    expect(loadInteractions(fms).defaults.grid?.sortColumns).toBe(3);
    expect(() => loadApp({ name: "t", app: "nope" })).toThrow(/unknown app "nope"/);
  });

  it("build and split page URLs: company in the URL for retailer, not for FMS", () => {
    expect(pageUrl(retailer, env, "1001", "invoices/my-invoices")).toBe("https://web/en/retailer/1001/invoices/my-invoices");
    expect(pagePathFromUrl(retailer, "en", "https://web/en/retailer/1001/invoices/my-invoices?x=1")).toEqual({ companyId: "1001", rest: "invoices/my-invoices" });
    expect(pageUrl(fms, env, "2001", "invoice-summary")).toBe("https://web/invoice-summary");
    expect(pageUrl(fms, env, "2001", "")).toBe("https://web");
    expect(pagePathFromUrl(fms, "en", "https://web/invoice-summary?x=1")).toEqual({ companyId: undefined, rest: "invoice-summary" });
    expect(pagePathFromUrl(fms, "en", "https://web/")).toEqual({ companyId: undefined, rest: "" });
    expect(loginPath(retailer, { lang: "en" })).toBe("/en/retailer");
    expect(loginPath(fms, { lang: "en", loginPath: "/custom" })).toBe("/custom");
  });

  it("keys tokens per user, or per user and company", () => {
    expect(tokenKeyFor("user", "user1", "1001")).toBe("user1");
    expect(tokenKeyFor("company", "user1", "2001")).toBe("user1|2001");
  });
});

describe("company-token login helpers", () => {
  const list = {
    result: [
      { ftsId: 2001, userName: "ret_a", companyName: "Retail A", childCompanies: [{ ftsId: 2002, userName: "ret_a2", companyName: "Retail A2" }] },
      { userName: "dist_b", companyName: "Dist B" },
      { ftsId: 9, companyName: "no login" },
    ],
  };

  it("flattens the companies list with children and skips entries without a login", () => {
    expect(companiesFromAuthList(list)).toEqual([
      { id: "2001", login: "ret_a", name: "Retail A" },
      { id: "2002", login: "ret_a2", name: "Retail A2" },
      { id: "dist_b", login: "dist_b", name: "Dist B" },
    ]);
    expect(companiesFromAuthList(list.result)).toHaveLength(3);
    expect(companiesFromAuthList({ data: list })).toHaveLength(3);
  });

  it("chooses the first N companies, or exactly the wanted ones", () => {
    const all = companiesFromAuthList(list);
    expect(chooseCompanies(all, { maxCompanies: 2 }).chosen.map((c) => c.id)).toEqual(["2001", "2002"]);
    expect(chooseCompanies(all, { maxCompanies: 1, companies: ["dist_b", "2001", "777"] })).toEqual({
      chosen: [all[2], all[0]],
      missing: ["777"],
    });
  });

  it("match API paths called directly or through the gateway (no api/, a router prefix)", () => {
    expect(isApiPath("/api/v1/auth2/auth0Validation", "/api/v1/auth2/auth0Validation")).toBe(true);
    expect(isApiPath("/fms/v1/auth2/auth0Validation", "/api/v1/auth2/auth0Validation")).toBe(true);
    expect(isApiPath("/fms/users/v1/usersauth/companies", "/api/users/v1/usersauth/companies")).toBe(true);
    expect(isApiPath("/fms/v1/auth2/login", "/api/v1/auth2/auth0Validation")).toBe(false);
    expect(siblingApiUrl("https://gw/fms/v1/auth2/auth0Validation", "/api/v1/auth2/auth0Validation", "/api/users/v1/usersauth/companies")).toBe("https://gw/fms/users/v1/usersauth/companies");
    expect(siblingApiUrl("https://auth/api/v1/auth2/auth0Validation", "/api/v1/auth2/auth0Validation", "/api/users/v1/usersauth/companies")).toBe("https://auth/api/users/v1/usersauth/companies");
    expect(siblingApiUrl("https://gw/other", "/api/v1/auth2/auth0Validation", "/x")).toBeUndefined();
  });

  it("repeat the app's exchange body with only the token and company changed", () => {
    expect(exchangeBody(fms.login as { exchangeExtraBody?: Record<string, unknown> }, undefined, "t", "c1")).toEqual({ requestedBy: 3, token: "t", wwwLogin: "c1" });
    expect(exchangeBody({}, { token: "old", wwwLogin: "c0", requestedBy: 7, extra: true }, "t", "c1")).toEqual({ requestedBy: 7, extra: true, token: "t", wwwLogin: "c1" });
  });

  it("read the company type from the app's company call when the token has no claim", () => {
    expect(fieldAt({ result: { companyType: "Distributor", ftsId: 8152 } }, "result.companyType")).toBe("Distributor");
    expect(fieldAt({ result: null }, "result.companyType")).toBeUndefined();
    expect(fieldAt(undefined, "result.companyType")).toBeUndefined();
    expect(isApiPath("/fms/service/v1.1/configuration/redirect", "/api/v1.1/configuration/redirect")).toBe(true);
  });

  it("re-logs in only when a company session is missing, expiring or not wanted yet", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lt-sess-")), "s.json");
    fs.writeFileSync(file, "{}");
    const s = (company: string, exp = 2000): UserSession => ({ key: `u|${company}`, user: "u", token: "t", exp, companies: [company], companiesAvailable: 3, storageStatePath: file, loggedInAt: "" });
    const now = 1000;
    expect(companySessionsUsable([s("1"), s("2")], 300, { maxCompanies: 2 }, "u", now)).toBe(true);
    expect(companySessionsUsable([s("1")], 300, { maxCompanies: 2 }, "u", now)).toBe(false);
    expect(companySessionsUsable([s("1")], 300, { maxCompanies: 5 }, "u", now)).toBe(false);
    expect(companySessionsUsable([s("1"), s("2", 1100)], 300, { maxCompanies: 2 }, "u", now)).toBe(false);
    expect(companySessionsUsable([s("1"), s("2")], 300, { companies: { u: ["2"] } }, "u", now)).toBe(true);
    expect(companySessionsUsable([s("1")], 300, { companies: { u: ["2"] } }, "u", now)).toBe(false);
  });
});

describe("guard auth calls", () => {
  const guard = compileGuard({ auth0Host: "tenant.auth0.com", allowlist: [], blockedThirdPartyHosts: [], authCalls: fms.authCalls });

  it("lets the app's token exchange and refresh through, but never replays them", () => {
    expect(guard.decide("POST", "https://auth/api/v1/auth2/auth0Validation")).toEqual({ action: "allow", reason: "auth" });
    expect(guard.decide("POST", "https://auth/api/v1/auth2/refresh")).toEqual({ action: "allow", reason: "auth" });
    expect(guard.decide("POST", "https://gw/fms/v1/users/authPortal")).toEqual({ action: "allow", reason: "auth" });
    expect(guard.decide("POST", "https://gw/fms/v1/auth2/auth0Validation")).toEqual({ action: "allow", reason: "auth" });
    expect(guard.decide("POST", "https://auth/api/v1/auth2/other")).toEqual({ action: "block", reason: "write" });
    expect(isReplayable(guard, "POST", "https://auth/api/v1/auth2/auth0Validation")).toBe(false);
  });
});

describe("directly called hosts", () => {
  const matcher = createRouteMatcher([], { "https://users-api": "fms/users", "https://users-api/api/v2": "fms/users-v2" });

  it("map to their service; the key carries it so equal paths on two hosts stay apart", () => {
    expect(resolveEndpoint(matcher, "GET", "https://users-api/api/v1/company-users/12")).toMatchObject({ key: "GET [fms/users] /api/v1/company-users/{num}", service: "fms/users", matchedRoute: true });
    expect(resolveEndpoint(matcher, "GET", "https://users-api/api/v2/x").service).toBe("fms/users-v2");
    expect(resolveEndpoint(matcher, "GET", "https://other/api/v1/company-users/12")).toMatchObject({ key: "GET /api/v1/company-users/{num}", service: "unknown:api" });
  });
});

describe("company-token catalogs and plans", () => {
  const rec = (user: string, companyId: string, n: number): RecordedRequest => ({
    user,
    companyId,
    page: "invoice-summary",
    interaction: "load",
    method: "GET",
    url: `https://gw/fms/v1/companies/${companyId}/invoices?page=${n}`,
    headers: {},
    status: 200,
    durationMs: 10,
  });
  const recorded = [1, 2, 3].flatMap((n) => [rec("user1", "2001", n), rec("user1", "3001", n), rec("user2", "2001", n)]);
  const build = (tokenScope: "user" | "company", maxSamples: number) =>
    buildCatalog({
      env: "t",
      app: tokenScope === "company" ? "fms" : "retailer",
      tokenScope,
      webBaseUrl: "https://web",
      gatewayBaseUrls: ["https://gw"],
      users: ["user1", "user2"],
      recorded,
      pages: [],
      blocked: [],
      matcher: createRouteMatcher([]),
      maxSamplesPerUserPerEndpoint: maxSamples,
      maxVariantsPerEndpoint: 5,
      searchTerms: [],
    });

  it("caps samples per token, so every company keeps its own", () => {
    const perUser = build("user", 2).endpoints[0]!;
    expect(perUser.samples.map((s) => `${s.user}|${s.companyId}`)).toEqual(["user1|2001", "user1|3001", "user2|2001", "user2|2001"]);
    const perCompany = build("company", 2).endpoints[0]!;
    expect(new Set(perCompany.samples.map((s) => `${s.user}|${s.companyId}`))).toEqual(new Set(["user1|2001", "user1|3001", "user2|2001"]));
    expect(perCompany.samples).toHaveLength(6);
  });

  it("plans one turn per token and counts tokens for the rate-limit ceiling", () => {
    const catalog = build("company", 2);
    const seq = endpointSequence(catalog.endpoints[0] as CatalogEndpoint, true, "company");
    expect(new Set(seq.map((s) => s.token))).toEqual(new Set(["user1|2001", "user1|3001", "user2|2001"]));
    expect(seq.every((s) => s.token.startsWith(s.user + "|"))).toBe(true);
    const guard = compileGuard({ auth0Host: "a", allowlist: [], blockedThirdPartyHosts: [] });
    const services = { get: () => ({ pods: 1, key: "token" as const, limits: [{ perSeconds: 1, limit: 10 }], limitsVerified: true, known: true }) };
    const plan = buildLoadPlan(catalog, guard, services, 1);
    expect(plan.services[0]!.tokens).toBe(3);
    expect(plan.services[0]!.users).toEqual(["user1", "user2"]);
    expect(plan.services[0]!.cap).toBe(30);
    expect(catalogCompanies(catalog)).toEqual({ user1: ["2001", "3001"], user2: ["2001"] });
    expect(catalogCompanies(build("user", 2))).toBeUndefined();

    const session = (key: string): UserSession => ({ key, user: key.split("|")[0]!, token: "t", exp: 0, companies: [], storageStatePath: "", loggedInAt: "" });
    expect(() => assertTokensFor(plan, { a: session("user1|2001"), b: session("user1|3001"), c: session("user2|2001") })).not.toThrow();
    expect(() => assertTokensFor(plan, { a: session("user1|2001") })).toThrow(/No login for 2 planned token/);
  });
});
