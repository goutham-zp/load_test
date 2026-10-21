import { describe, expect, it } from "vitest";
import { StatsBuilder } from "../src/analysis/stats.ts";
import { computeComparison, delta, matchSteps } from "../src/report/compare.ts";
import { esc, niceMax } from "../src/report/html.ts";
import { renderRunReport } from "../src/report/runReport.ts";
import type { RunResults, StepRecord } from "../src/run/results.ts";

function stats(p95: number, n = 100) {
  const b = new StatsBuilder();
  for (let i = 0; i < n; i++) b.add(200, i < n * 0.9 ? p95 / 2 : p95);
  return b.build(60);
}

function step(index: number, targetRps: number, p95: number): StepRecord {
  return {
    index,
    targetRps,
    startedAt: "",
    endedAt: "",
    windowSec: 60,
    overall: stats(p95),
    services: [{ name: "fms/invoice-apis", plannedRps: targetRps, wantedRps: targetRps, cap: 40, capped: false, held: false, stats: stats(p95), dropped: 0, throttled: {} }],
    endpoints: [{ key: "GET /fms/v3/invoices", service: "fms/invoice-apis", stats: stats(p95) }],
    variants: [
      { key: "GET /fms/v3/invoices", service: "fms/invoice-apis", variant: "base", stats: stats(p95) },
      { key: "GET /fms/v3/invoices", service: "fms/invoice-apis", variant: "pageNumber=49", stats: stats(p95 * 4) },
    ],
    pages: [{ page: "home", interaction: "load", n: 3, timeouts: 0, errors: 0, p50: 400, p95: 900, max: 900, topEndpoints: [{ key: "GET /fms/v3/invoices", p95, n: 3 }] }],
    runner: { cpuAvg: 10, cpuMax: 20, memMaxPct: 50 },
    refused: 0,
    blockedWrites: 0,
    k6ExitCode: 0,
  };
}

function results(env: string, p95s: number[], breakAt?: number): RunResults {
  return {
    meta: {
      tool: "dxp-loadtest",
      kind: "run",
      env,
      envKind: env.includes("pg") ? "postgres" : "oracle",
      webBaseUrl: "https://web",
      startedAt: "2026-10-20T10:00:00.000Z",
      endedAt: "2026-10-20T10:30:00.000Z",
      runner: { host: "h", platform: "darwin arm64", cpus: 10, memGb: 32 },
      versions: { node: "v26", k6: "k6", playwright: "1" },
      catalogCreatedAt: "",
      catalogSignature: ["GET /fms/v3/invoices"],
      filters: {},
      stepsPlanned: [5, 10, 25],
      stepDurationSec: 60,
      browsers: 2,
      users: 4,
      stopAtFirstBreak: false,
      breakRules: { errorRate: 0.05, p95Ms: 10000, minRequests: 20 },
      safetyFactor: 0.8,
      endReason: "all steps completed",
    },
    plan: { services: [{ name: "fms/invoice-apis", endpoints: 1, users: 4, cap: 40, limitsVerified: true, knownService: true }], excluded: [], totalEndpoints: 1 },
    steps: p95s.map((p, i) => step(i, [5, 10, 25][i]!, p)),
    services: [{ name: "fms/invoice-apis", status: breakAt === undefined ? "climbing" : "broken", reasons: breakAt === undefined ? [] : ["p95"], brokeAtStep: breakAt, lastHealthyRate: 5 }],
    systemBreak: breakAt === undefined ? undefined : { step: breakAt, targetRps: [5, 10, 25][breakAt]!, services: ["fms/invoice-apis"] },
    endpointsMeta: { "GET /fms/v3/invoices": { service: "fms/invoice-apis", servicePath: "/api/v3/invoices", pages: ["home"] } },
    pagesMeta: [],
    warnings: ["<script>alert(1)</script>"],
  };
}

describe("run report", () => {
  it("renders self-contained HTML and escapes untrusted text", () => {
    const html = renderRunReport(results("oracle-qa", [100, 200, 400], 2));
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("pageNumber=49");
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+href=/);
  });
});

describe("compare", () => {
  it("matches steps by target rate and ranks regressions first", () => {
    const a = results("oracle-qa", [100, 200, 400]);
    const b = results("pg-qa", [150, 600]);
    expect(matchSteps(a, b).map((s) => s.targetRps)).toEqual([5, 10]);
    const c = computeComparison(a, b);
    expect(c.defaultStep).toBe(1);
    const row = c.endpoints.get(1)![0]!;
    expect(row.deltaMs).toBe(400);
    expect(row.deltaPct).toBeCloseTo(2);
    expect(c.mismatches).toEqual([]);
  });

  it("flags unfair comparisons", () => {
    const a = results("oracle-qa", [100]);
    const b = results("pg-qa", [100]);
    b.meta.runner.host = "other";
    b.meta.catalogSignature = ["GET /other"];
    const m = computeComparison(a, b).mismatches.join(" ");
    expect(m).toMatch(/Different endpoint sets/);
    expect(m).toMatch(/Different runners/);
  });

  it("delta handles zero and missing", () => {
    expect(delta(undefined, 5)).toEqual({});
    expect(delta(0, 5).deltaPct).toBe(Infinity);
  });
});

describe("html helpers", () => {
  it("rounds axis maxima and escapes", () => {
    expect(niceMax(730)).toBe(1000);
    expect(niceMax(0.037)).toBe(0.05);
    expect(esc("<a \"b\">&")).toBe("&lt;a &quot;b&quot;&gt;&amp;");
  });
});
