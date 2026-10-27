import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { advanceStates, checkBreak, emergencyReason, nothingLeftToClimb, type ServiceState } from "../src/analysis/evaluate.ts";
import { classifyStatus, percentile, StatsBuilder } from "../src/analysis/stats.ts";
import { applyDateRange, overrideBody } from "../src/catalog/params.ts";
import type { Catalog, CatalogEndpoint } from "../src/catalog/types.ts";
import type { ResolvedServices } from "../src/config/load.ts";
import type { ServiceConfig, Settings } from "../src/config/types.ts";
import { compileGuard } from "../src/guard/readonly.ts";
import { failureReason, parseK6Output } from "../src/load/k6runner.ts";
import { buildLoadPlan, endpointSequence, interleave, serviceCap, stepRates, sustainedRate, type LoadPlan } from "../src/load/plan.ts";

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
    expect(classifyStatus(401)).toBe("error"); // token rejected under load
    expect(classifyStatus(403)).toBe("error");
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

  it("count calls with no response as timeouts, inside the errors", () => {
    const b = new StatsBuilder();
    b.add(200, 10);
    b.add(0, 60_000);
    b.add(503, 20);
    const s = b.build(10);
    expect(s.errors).toBe(2);
    expect(s.timeouts).toBe(1);
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

describe("k6 output: failure reasons and page visits", () => {
  it("name why calls failed from status and k6 error code", () => {
    expect(failureReason(200)).toBeUndefined();
    expect(failureReason(503)).toBe("HTTP 503");
    expect(failureReason(429)).toBe("HTTP 429 (rate limited)");
    expect(failureReason(0, "1050")).toBe("Timed out (no response)");
    expect(failureReason(0, "1212")).toBe("Connection refused");
    expect(failureReason(0, "1999")).toBe("Request failed (k6 error 1999)");
  });

  const point = (metric: string, tags: Record<string, string>, value = 1) => JSON.stringify({ metric, type: "Point", data: { time: "2026-10-22T10:00:00Z", value, tags } });
  const write = (lines: string[]) => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lt-k6-")), "k6.json.gz");
    fs.writeFileSync(file, zlib.gzipSync(lines.join("\n")));
    return file;
  };
  const call = (tpl: string, page: string, status: string, error_code?: string) =>
    point("http_req_duration", { tpl, page, status, svc: "fms/x", ...(error_code ? { error_code } : {}) }, 100);
  const plan = { services: [] } as unknown as LoadPlan;

  it("count reasons per endpoint and visits per page", async () => {
    const res = await parseK6Output(
      write([point("lt_visits", { page: "home" }), point("lt_visits", { page: "home" }), call("GET /a", "home", "200"), call("GET /a", "home", "0", "1050"), call("GET /a", "home", "503")]),
      plan,
    );
    expect(res.endpoints.get("GET /a")!.failures).toEqual({ "Timed out (no response)": 1, "HTTP 503": 1 });
    expect(res.endpoints.get("GET /a")!.stats.timeouts).toBe(1);
    expect(res.visits).toEqual({ home: 2 });
    expect(res.visitsEstimated).toBe(false);
  });

  it("estimate visits from the calls when the run predates the visit counter", async () => {
    const res = await parseK6Output(write([call("GET /a", "home", "200"), call("GET /a", "home", "200"), call("GET /b", "home", "200"), call("GET /b", "plan", "200")]), plan);
    expect(res.visits).toEqual({ home: 2, plan: 1 });
    expect(res.visitsEstimated).toBe(true);
  });

  it("leave out requests that started during the ramp-up (--ramp-up)", async () => {
    const at = (time: string, tpl: string, status: string, ms: number) =>
      JSON.stringify({ metric: "http_req_duration", type: "Point", data: { time, value: ms, tags: { tpl, status, svc: "fms/x" } } });
    const visit = (time: string) => JSON.stringify({ metric: "lt_visits", type: "Point", data: { time, value: 1, tags: { page: "home" } } });
    const file = write([
      visit("2026-10-22T10:00:00Z"),
      at("2026-10-22T10:00:01Z", "GET /a", "0", 1000), // started 10:00:00, the first request
      visit("2026-10-22T10:00:30Z"),
      at("2026-10-22T10:01:30Z", "GET /a", "200", 40_000), // started 10:00:50, still in the 60 s ramp
      visit("2026-10-22T10:01:05Z"),
      at("2026-10-22T10:01:10Z", "GET /a", "200", 500), // started 10:01:09.5, after the ramp
    ]);
    const all = await parseK6Output(file, plan);
    expect(all.endpoints.get("GET /a")!.stats.n).toBe(3);
    const measured = await parseK6Output(file, plan, { excludeFirstSec: 60 });
    expect(measured.endpoints.get("GET /a")!.stats.n).toBe(1);
    expect(measured.endpoints.get("GET /a")!.stats.max).toBe(500);
    expect(measured.visits).toEqual({ home: 1 });
  });
});

describe("run --set", () => {
  const withBody = (body: unknown): CatalogEndpoint => {
    const e = endpoint("POST /search", "a", ["user1"], 3, "POST");
    e.samples = e.samples.map((s) => ({ ...s, body: JSON.stringify(body) }));
    return e;
  };

  it("replaces only the body fields the request has, and sends the base variant only", () => {
    const seq = endpointSequence(withBody({ startDate: "2026-10-25T00:00:00Z", endDate: "2026-10-25T00:00:00Z", pageSize: 50 }), false, "user", {
      startDate: "2025-01-01T00:00:00Z",
      endDate: "2025-03-31T00:00:00Z",
      dateFilter: 1,
    });
    expect(seq.map((r) => r.variant)).toEqual(["base"]); // 3 variants recorded, one sample
    expect(JSON.parse(seq[0]!.body!)).toEqual({ startDate: "2025-01-01T00:00:00Z", endDate: "2025-03-31T00:00:00Z", pageSize: 50 });
  });

  it("leaves other bodies and requests without a body as they are", () => {
    expect(overrideBody(undefined, { startDate: "x" })).toBeUndefined();
    expect(overrideBody("not json", { startDate: "x" })).toBe("not json");
    expect(overrideBody('{"a":1}', { startDate: "x" })).toBe('{"a":1}');
    expect(overrideBody("[1,2]", { startDate: "x" })).toBe("[1,2]");
  });
});

describe("run --date-range", () => {
  const range = { from: "2025-05-01", to: "2025-05-31" };

  it("sets range fields in the body, at any depth, in each field's own format", () => {
    const body = JSON.stringify({
      startDate: "2026-10-26T00:00:00Z",
      endDate: "2026-10-26T23:59:59",
      filters: { fromDate: "10/26/2026", toDate: "2026-10-26" },
      poDate: "2026-10-26",
      dateFilter: 1,
    });
    const r = applyDateRange("https://gw/x", body, range);
    expect(JSON.parse(r.body!)).toEqual({
      startDate: "2025-05-01T00:00:00Z",
      endDate: "2025-05-31T23:59:59",
      filters: { fromDate: "05/01/2025", toDate: "2025-05-31" },
      poDate: "2026-10-26",
      dateFilter: 1,
    });
    expect(r.fields).toEqual(["startDate", "endDate", "filters.fromDate", "filters.toDate"]);
  });

  it("sets range fields in the query and leaves other requests as they are", () => {
    const r = applyDateRange("https://gw/x?startDate=2026-10-26&endDate=2026-10-26&page=1", undefined, range);
    expect(new URL(r.url).searchParams.get("startDate")).toBe("2025-05-01");
    expect(new URL(r.url).searchParams.get("endDate")).toBe("2025-05-31");
    expect(new URL(r.url).searchParams.get("page")).toBe("1");
    const none = applyDateRange("https://gw/y?page=1", '{"a":1}', range);
    expect(none).toEqual({ url: "https://gw/y?page=1", body: '{"a":1}', fields: [] });
  });

  it("leaves a lone start or end date as recorded: a cut-off is not a range", () => {
    const body = JSON.stringify({ requestDateTo: "2026-10-26T00:00:00Z", status: 1 });
    expect(applyDateRange("https://gw/x", body, range)).toEqual({ url: "https://gw/x", body, fields: [] });
  });

  it("sends the base variant only", () => {
    const e = endpoint("POST /search", "a", ["user1"], 3, "POST");
    e.samples = e.samples.map((s) => ({ ...s, body: JSON.stringify({ startDate: "2026-10-26", endDate: "2026-10-26" }) }));
    const seq = endpointSequence(e, false, "user", undefined, range);
    expect(seq.map((r) => r.variant)).toEqual(["base"]);
    expect(JSON.parse(seq[0]!.body!)).toEqual({ startDate: "2025-05-01", endDate: "2025-05-31" });
  });
});
