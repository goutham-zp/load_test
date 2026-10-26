import { describe, expect, it } from "vitest";
import { duplicateTokenSessions, k6Tokens, retryableLoginError, retryOnce, runPool, sessionLabel, type UserSession } from "../src/browser/session.ts";
import { buildCatalog } from "../src/catalog/build.ts";
import type { RecordedRequest } from "../src/catalog/types.ts";
import { createRouteMatcher } from "../src/gateway/routes.ts";
import { compileGuard } from "../src/guard/readonly.ts";
import { pickJourney, vusOnToken } from "../src/load/k6/pick.js";
import { journeyIndex } from "../src/load/k6runner.ts";
import { buildJourneys, buildLoadPlan, estimateUserRates } from "../src/load/plan.ts";
import { environmentReachable } from "../src/run/run.ts";

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

describe("parallel logins", () => {
  it("find sessions that got the same token as another login of the account", () => {
    const dups = duplicateTokenSessions({
      user2: session("user2", "user2", 1, "same"),
      "user2#2": session("user2#2", "user2", 2, "same"),
      "user2#3": session("user2#3", "user2", 3, "other"),
      user3: session("user3", "user3", 1, "same"),
    });
    expect(dups.map((s) => s.key)).toEqual(["user2#2"]);
  });

  it("run at most `limit` tasks at once and finish every task even when some fail", async () => {
    let running = 0;
    let peak = 0;
    const task = (i: number) => async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      if (i === 2) throw new Error("bad password");
      return i;
    };
    const results = await runPool([0, 1, 2, 3, 4, 5, 6].map(task), 3);
    expect(peak).toBe(3);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "rejected", "fulfilled", "fulfilled", "fulfilled", "fulfilled"]);
  });

  it("retry a login once after a slow login page, but never after Auth0 rejects the credentials", async () => {
    const retried: string[] = [];
    let calls = 0;
    const slowThenOk = async () => {
      if (calls++ === 0) throw new Error("user3#2: no login form appeared within 180s. Last URL: https://x/en/retailer");
      return "ok";
    };
    await expect(retryOnce(slowThenOk, retryableLoginError, (e) => retried.push(e.message))).resolves.toBe("ok");
    expect(calls).toBe(2);
    expect(retried).toHaveLength(1);

    let rejected = 0;
    const wrongPassword = async () => {
      rejected++;
      throw new Error("Auth0 rejected user1: Wrong email or password");
    };
    await expect(retryOnce(wrongPassword, retryableLoginError, () => {})).rejects.toThrow(/Auth0 rejected/);
    expect(rejected).toBe(1);

    const alwaysSlow = async () => {
      throw new Error("no login form appeared");
    };
    await expect(retryOnce(alwaysSlow, retryableLoginError, () => {})).rejects.toThrow(/no login form/);
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

  it("give an account journeys only on pages it reached, not on every page that lists a shared call", () => {
    // home lists the users/data call user1 also has samples of, but here only user2 reached home.
    const onlyUser2Home = { ...catalog, pages: catalog.pages.map((p) => (p.id === "home" ? { ...p, urls: [{ user: "user2", companyId: "", url: "https://web/" }] } : p)) };
    const journeys = buildJourneys(onlyUser2Home, guard);
    expect(journeys.filter((j) => j.page === "home").map((j) => j.token)).toEqual(["user2"]);
    expect(journeys.filter((j) => j.page === "invoices").map((j) => j.token)).toEqual(["user1", "user1"]);
  });

  it("index journeys per token grouped by page, for k6 to pick from", () => {
    const journeys = buildJourneys(catalog, guard);
    const index = journeyIndex(journeys);
    expect(index.tokens).toEqual(["user1", "user2"]);
    expect(index.byToken.user1!.map((pageJourneys) => pageJourneys.map((i) => journeys[i]!.page))).toEqual([["home", "home"], ["invoices", "invoices"]]);
    expect(index.byToken.user2!.map((pageJourneys) => pageJourneys.map((i) => journeys[i]!.page))).toEqual([["home"]]);
  });
});

describe("users mode page picking (k6 pick.js)", () => {
  // A token key with 60 pages of 3 recorded samples, like the FMS catalog; journey number = page * 3 + sample.
  const pages = Array.from({ length: 60 }, (_, p) => [p * 3, p * 3 + 1, p * 3 + 2]);
  // Pages token key 0's VUs open in their first `visits` visits (VU n is on key n % tokenCount).
  const pagesOpened = (vus: number, visits: number, tokenCount = 2) => {
    const seen = new Set<number>();
    for (let vu = 0; vu < vus; vu += tokenCount) {
      for (let it = 0; it < visits; it++) seen.add(Math.floor(pickJourney(pages, Math.floor(vu / tokenCount), vusOnToken(vus, tokenCount, 0), it) / 3));
    }
    return seen.size;
  };

  it("count the VUs on each token key", () => {
    expect([0, 1].map((t) => vusOnToken(25, 2, t))).toEqual([13, 12]);
    expect(vusOnToken(1, 2, 1)).toBe(1);
  });

  it("open every page within a few visits, however short the step", () => {
    // 13 VUs on key 0: 60 pages / 13 -> 5 visits each.
    expect(pagesOpened(25, 5)).toBe(60);
    // 22 Oct-25 Oct runs: 25 users made ~11 visits each in a 3-minute step and opened only the first 12 pages.
    expect(pagesOpened(25, 11)).toBe(60);
    expect(pagesOpened(2, 60)).toBe(60);
  });

  it("move one page per visit and take the next sample on each lap", () => {
    const visits = Array.from({ length: 61 }, (_, it) => pickJourney(pages, 0, 1, it));
    expect(visits.slice(0, 3)).toEqual([0, 3, 6]);
    expect(visits[60]).toBe(1); // page 0 again, its second sample
  });
});

describe("environment check between steps", () => {
  const env = { webBaseUrl: "https://web", auth0Domain: "https://auth" };
  // Fails the first `failures` calls (network error), then answers `status`.
  const flaky = (failures: number, status = 200) => {
    let calls = 0;
    const fn = (async () => {
      calls++;
      if (calls <= failures) throw new Error("fetch failed");
      return new Response(null, { status });
    }) as unknown as typeof fetch;
    return { fn, calls: () => calls };
  };

  it("does not stop a run for one lost request", async () => {
    const f = flaky(1);
    expect(await environmentReachable(env, f.fn, 3, 0)).toBeUndefined();
    expect(f.calls()).toBe(3); // web: fail, ok; auth: ok
  });

  it("counts a certificate Node can't verify as up (internal CA, as on devfms)", async () => {
    const certFail = (async () => {
      throw Object.assign(new Error("fetch failed"), { cause: { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" } });
    }) as unknown as typeof fetch;
    expect(await environmentReachable(env, certFail, 3, 0)).toBeUndefined();
  });

  it("stops when every attempt fails or the host keeps answering 5xx", async () => {
    expect(await environmentReachable(env, flaky(9).fn, 3, 0)).toBe("https://web unreachable (fetch failed), 3 attempts");
    expect(await environmentReachable(env, flaky(0, 503).fn, 3, 0)).toBe("https://web returned 503, 3 attempts");
  });

  it("names the network error behind Node's \"fetch failed\"", async () => {
    const connectTimeout = (async () => {
      throw Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } });
    }) as unknown as typeof fetch;
    expect(await environmentReachable(env, connectTimeout, 3, 0)).toBe(
      "https://web unreachable (fetch failed: UND_ERR_CONNECT_TIMEOUT), 3 attempts"
    );
  });
});
