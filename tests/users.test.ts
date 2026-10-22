import { describe, expect, it } from "vitest";
import { k6Tokens, sessionLabel, type UserSession } from "../src/browser/session.ts";
import { buildCatalog } from "../src/catalog/build.ts";
import type { RecordedRequest } from "../src/catalog/types.ts";
import { createRouteMatcher } from "../src/gateway/routes.ts";
import { compileGuard } from "../src/guard/readonly.ts";
import { buildJourneys, buildLoadPlan, estimateUserRates } from "../src/load/plan.ts";

const session = (key: string, tokenKey: string, sessionNo: number, token: string): UserSession => ({
  key,
  tokenKey,
  sessionNo,
  user: tokenKey.split("|")[0]!,
  token,
  exp: 0,
  companies: [],
  storageStatePath: "",
  loggedInAt: "",
});

describe("several sessions per account", () => {
  it("label extra logins user#n and hand k6 one token, or a list per token key", () => {
    expect(sessionLabel("user1", 1)).toBe("user1");
    expect(sessionLabel("user1", 3)).toBe("user1#3");
    const tokens = k6Tokens({
      "user1#2": session("user1#2", "user1", 2, "t1b"),
      user1: session("user1", "user1", 1, "t1a"),
      user2: session("user2", "user2", 1, "t2"),
      "user3#2|9": session("user3#2|9", "user3|9", 2, "t3b"),
      "user3|9": session("user3|9", "user3|9", 1, "t3a"),
    });
    expect(tokens).toEqual({ user1: ["t1a", "t1b"], user2: "t2", "user3|9": ["t3a", "t3b"] });
  });
});

describe("users mode planning", () => {
  const rec = (user: string, page: string, url: string, method = "GET"): RecordedRequest => ({
    user,
    companyId: "1001",
    page,
    interaction: "load",
    method,
    url,
    headers: {},
    status: 200,
    durationMs: 10,
  });
  const recorded = [
    rec("user1", "home", "https://gw/fms/v1/users/data"),
    rec("user1", "home", "https://gw/fms/v1/invoices?page=1"),
    rec("user2", "home", "https://gw/fms/v1/users/data"),
    rec("user1", "invoices", "https://gw/fms/v1/invoices?page=2"),
    rec("user1", "invoices", "https://gw/fms/v1/audit/track", "POST"),
  ];
  const pages = ["home", "invoices"].map((id) => ({ id, reached: true, urls: [], interactions: ["load"], endpoints: [] }));
  const catalog = buildCatalog({
    env: "t",
    app: "retailer",
    tokenScope: "user",
    webBaseUrl: "https://web",
    gatewayBaseUrls: ["https://gw"],
    users: ["user1", "user2"],
    recorded,
    pages,
    blocked: [],
    matcher: createRouteMatcher([]),
    maxSamplesPerUserPerEndpoint: 5,
    maxVariantsPerEndpoint: 5,
    searchTerms: [],
  });
  const guard = compileGuard({ auth0Host: "a", allowlist: [], blockedThirdPartyHosts: [] });

  it("build journeys per page and token with only replayable calls, each on that token, rotating samples", () => {
    const journeys = buildJourneys(catalog, guard);
    // user1 has 2 samples of the invoices endpoint (one per page), so its journeys come in 2 sample rotations.
    expect(journeys.map((j) => `${j.page}:${j.token}:${j.requests.length}`).sort()).toEqual(["home:user1:2", "home:user1:2", "home:user2:1", "invoices:user1:1", "invoices:user1:1"]);
    const invoiceUrls = journeys.filter((j) => j.page === "invoices").map((j) => j.requests[0]!.url).sort();
    expect(invoiceUrls).toEqual(["https://gw/fms/v1/invoices?page=1", "https://gw/fms/v1/invoices?page=2"]);
    expect(journeys.every((j) => j.requests.every((r) => r.token === j.token && r.method === "GET"))).toBe(true);
  });

  it("estimate each service's rate from users, journeys and think time", () => {
    const journeys = buildJourneys(catalog, guard);
    // 7 calls over 5 journeys; 100 users each open a page every 10s (9s think + ~1s) -> 10 pages/s.
    const rates = estimateUserRates(journeys, 100, 9);
    expect([...rates.values()].reduce((a, b) => a + b, 0)).toBeCloseTo((7 / 5) * 10, 5);
  });

  it("leave excluded services out of the plan and the journeys, and say why", () => {
    const plan = buildLoadPlan(catalog, guard, { get: () => ({ pods: 1, key: "token" as const, limits: [], limitsVerified: true, known: true }) }, 1, { excludeServices: ["unknown:fms"] });
    expect(plan.services).toHaveLength(0);
    expect(plan.excluded.some((x) => x.reason.includes("excluded (--exclude-service)"))).toBe(true);
    expect(buildJourneys(catalog, guard, { excludeServices: ["unknown:fms"] })).toHaveLength(0);
  });

  it("raise token-keyed ceilings by the sessions each account has", () => {
    const services = { get: () => ({ pods: 1, key: "token" as const, limits: [{ perSeconds: 1, limit: 10 }], limitsVerified: true, known: true }) };
    const one = buildLoadPlan(catalog, guard, services, 1);
    const four = buildLoadPlan(catalog, guard, services, 1, {}, 4);
    expect(four.services[0]!.cap).toBe(one.services[0]!.cap * 4);
  });
});
