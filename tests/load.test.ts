import { describe, expect, it } from "vitest";
import { advanceStates, checkBreak, emergencyReason, nothingLeftToClimb, type ServiceState } from "../src/analysis/evaluate.ts";
import { classifyStatus, percentile, StatsBuilder } from "../src/analysis/stats.ts";
import type { Catalog, CatalogEndpoint } from "../src/catalog/types.ts";
import type { ResolvedServices } from "../src/config/load.ts";
import type { ServiceConfig, Settings } from "../src/config/types.ts";
import { compileGuard } from "../src/guard/readonly.ts";
import { buildLoadPlan, endpointSequence, interleave, serviceCap, stepRates, sustainedRate } from "../src/load/plan.ts";

const breakRules: Settings["break"] = { errorRate: 0.05, p95Ms: 10_000, minRequests: 20 };

describe("rate limits", () => {
  it("uses the strictest window", () => {
    expect(sustainedRate([])).toBe(Infinity);
    expect(sustainedRate([{ perSeconds: 1, limit: 5 }, { perSeconds: 900, limit: 100 }])).toBeCloseTo(100 / 900);
  });

  it("scales token-keyed limits by users and pods, not ip-keyed ones", () => {
    expect(serviceCap({ limits: [{ perSeconds: 1, limit: 10 }], key: "token", pods: 2 }, 4, 0.8)).toBeCloseTo(64);
    expect(serviceCap({ limits: [{ perSeconds: 1, limit: 30 }], key: "ip", pods: 1 }, 4, 0.8)).toBeCloseTo(24);
    expect(serviceCap({ limits: [], key: "token", pods: 1 }, 4, 0.8)).toBe(Infinity);
  });
});

function endpoint(key: string, service: string, users: string[], variants = 1, method = "GET"): CatalogEndpoint {
  return {
    key,
    method,
    pathTemplate: key.split(" ")[1]!,
    service,
    matchedRoute: true,
    pages: ["home"],
    samples: users.map((u) => ({ user: u, companyId: "1", url: `https://gw${key.split(" ")[1]}?page=1`, headers: {} })),
    dimensions: [],
    variants: Array.from({ length: variants }, (_, i) =>
      i === 0 ? { label: "base", set: [] } : { label: `page=${i + 1}`, set: [{ location: { in: "query" as const, name: "page" }, value: String(i + 1) }] }
    ),
    observedStatuses: { 200: 1 },
    discoveryMedianMs: 10,
  };
}

const services: ResolvedServices = {
  get(name: string) {
    const cfg: ServiceConfig = name === "a"
      ? { pods: 1, key: "token", limits: [{ perSeconds: 1, limit: 10 }], limitsVerified: true }
      : { pods: 1, key: "token", limits: [], limitsVerified: true };
    return { ...cfg, known: true };
  },
};

const guard = compileGuard({ auth0Host: "auth", allowlist: [{ method: "POST", path: "/search$", reviewed: true }], blockedThirdPartyHosts: [] });

describe("plan", () => {
  it("rotates users innermost and walks variants", () => {
    const seq = endpointSequence(endpoint("GET /x", "a", ["user1", "user2"], 3), false);
    expect(seq.map((s) => `${s.variant}/${s.user}`)).toEqual(["base/user1", "base/user2", "page=2/user1", "page=2/user2", "page=3/user1", "page=3/user2"]);
    expect(seq[2]!.url).toContain("page=2");
  });

  it("interleaves endpoints equally", () => {
    const a = endpointSequence(endpoint("GET /a", "a", ["user1"], 3), false);
    const b = endpointSequence(endpoint("GET /b", "a", ["user1"], 1), false);
    expect(interleave([a, b]).map((s) => s.tpl)).toEqual(["GET /a", "GET /b", "GET /a", "GET /b", "GET /a", "GET /b"]);
  });

  it("excludes writes unless allowlisted, and splits rate equally per endpoint with caps and holds", () => {
    const catalog = {
      endpoints: [
        endpoint("GET /a1", "a", ["user1", "user2"]),
        endpoint("GET /a2", "a", ["user1", "user2"]),
        endpoint("GET /b1", "b", ["user1"]),
        endpoint("POST /b/search", "b", ["user1"], 1, "POST"),
        endpoint("POST /b/save", "b", ["user1"], 1, "POST"),
      ],
    } as unknown as Catalog;
    catalog.endpoints[3]!.samples[0]!.url = "https://gw/b/search";
    catalog.endpoints[4]!.samples[0]!.url = "https://gw/b/save";
    const plan = buildLoadPlan(catalog, guard, services, 0.8);
    expect(plan.totalEndpoints).toBe(4);
    expect(plan.excluded).toEqual([{ key: "POST /b/save", reason: "POST not in reviewed read-allowlist" }]);
    const a = plan.services.find((s) => s.name === "a")!;
    expect(a.cap).toBeCloseTo(16); // 10/s x 2 users x 0.8

    const r1 = stepRates(plan, 20, new Map());
    expect(r1.get("a")).toMatchObject({ rate: 10, capped: false });
    expect(r1.get("b")!.rate).toBe(10);
    const r2 = stepRates(plan, 100, new Map());
    expect(r2.get("a")).toMatchObject({ capped: true });
    expect(r2.get("a")!.rate).toBeCloseTo(16);
    const r3 = stepRates(plan, 100, new Map([["b", 7]]));
    expect(r3.get("b")).toMatchObject({ rate: 7, held: true });
  });
});

describe("stats", () => {
  it("separates throttled, errors and client errors", () => {
    expect(classifyStatus(429)).toBe("throttled");
    expect(classifyStatus(0)).toBe("error");
    expect(classifyStatus(503)).toBe("error");
    expect(classifyStatus(404)).toBe("clientError");
    const b = new StatsBuilder();
    for (let i = 1; i <= 100; i++) b.add(200, i);
    b.add(429, 99999);
    b.add(500, 5);
    const s = b.build(10);
    expect(s.n).toBe(102);
    expect(s.throttled).toBe(1);
    expect(s.errorRate).toBeCloseTo(1 / 101);
    expect(s.max).toBe(100); // the 429 is not in latency
    expect(s.rps).toBe(10.2);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
  });
});

describe("break evaluation", () => {
  const stats = (n: number, errors: number, p95: number, throttled = 0) => {
    const b = new StatsBuilder();
    for (let i = 0; i < n - errors - throttled; i++) b.add(200, i < (n - errors - throttled) * 0.9 ? 10 : p95);
    for (let i = 0; i < errors; i++) b.add(503, 10);
    for (let i = 0; i < throttled; i++) b.add(429, 10);
    return b.build(60);
  };

  it("breaks on error rate or p95, ignores 429s", () => {
    expect(checkBreak(stats(100, 10, 10), breakRules)).toMatchObject({ broke: true, reasons: ["error-rate"] });
    expect(checkBreak(stats(100, 0, 20_000), breakRules)).toMatchObject({ broke: true, reasons: ["p95"] });
    expect(checkBreak(stats(100, 0, 10, 85), breakRules)).toMatchObject({ broke: false, insufficient: true });
    expect(checkBreak(stats(100, 0, 10, 50), breakRules).broke).toBe(false);
  });

  it("holds a broken service at its last healthy rate and stops when nothing can climb", () => {
    const states = new Map<string, ServiceState>();
    advanceStates(states, 0, [
      { name: "a", rate: 5, capped: false, held: false, stats: stats(300, 0, 10) },
      { name: "b", rate: 5, capped: false, held: false, stats: stats(300, 0, 10) },
    ], breakRules);
    const { newlyBroken } = advanceStates(states, 1, [
      { name: "a", rate: 10, capped: false, held: false, stats: stats(600, 100, 10) },
      { name: "b", rate: 8, capped: true, held: false, stats: stats(480, 0, 10) },
    ], breakRules);
    expect(newlyBroken).toEqual(["a"]);
    expect(states.get("a")).toMatchObject({ status: "broken", heldRate: 5, brokeAtStep: 1, brokeAtRate: 10 });
    expect(states.get("b")).toMatchObject({ status: "capped", lastHealthyRate: 8 });
    expect(nothingLeftToClimb(states)).toBe(true);
  });

  it("emergency stop on overall error rate", () => {
    expect(emergencyReason(stats(100, 30, 10), { errorRate: 0.25 })).toMatch(/exceeded 25%/);
    expect(emergencyReason(stats(100, 10, 10), { errorRate: 0.25 })).toBeUndefined();
  });
});
