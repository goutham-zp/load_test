import { describe, expect, it } from "vitest";
import type { RecordedRequest } from "../src/catalog/types.ts";
import { buildDiscoveryTimings, type TimedStep } from "../src/discover/timings.ts";
import { createRouteMatcher, templateToRegex } from "../src/gateway/routes.ts";
import { renderDiscoveryReport } from "../src/report/discoveryReport.ts";

const matcher = createRouteMatcher([
  { service: "fms/invoice-apis", method: "GET", gatewayPath: "/fms/v3/invoices/{id}", servicePath: "/api/v3/invoices/{id}", host: "h", ...templateToRegex("/fms/v3/invoices/{id}") },
]);

function call(user: string, url: string, durationMs: number, status = 200): RecordedRequest {
  return { user, companyId: "c-" + user, page: "invoices/my-invoices", interaction: "load", method: "GET", url, headers: {}, status, durationMs };
}

function step(user: string, page: string, readyMs: number, timedOut = false): TimedStep {
  return { user, companyId: "c-" + user, page, interaction: "load", readyMs, timedOut };
}

describe("discovery timings", () => {
  const t = buildDiscoveryTimings({
    env: "pg-test",
    users: ["user1", "user2"],
    recorded: [
      call("user1", "https://gw/fms/v3/invoices/1", 3000),
      call("user1", "https://gw/fms/v3/invoices/2?page=4", 5000),
      call("user2", "https://gw/fms/v3/invoices/3", 400),
      call("user2", "https://gw/fms/users/data", 100),
      call("user2", "https://gw/fms/users/data", 120, 503),
    ],
    steps: [step("user1", "home", 1200), step("user2", "home", 60000, true)],
    matcher,
    slowCallMs: 2000,
    createdAt: "2026-10-21T10:00:00.000Z",
  });

  it("groups calls by gateway endpoint and by user", () => {
    const inv = t.endpoints.find((e) => e.key === "GET /fms/v3/invoices/{id}")!;
    expect(inv.service).toBe("fms/invoice-apis");
    expect(inv.all.n).toBe(3);
    expect(inv.byUser.user1!.p50).toBe(3000);
    expect(inv.byUser.user2!.max).toBe(400);
    expect(inv.slowest).toMatchObject({ user: "user1", url: "/fms/v3/invoices/2?page=4", durationMs: 5000 });
  });

  it("sorts slowest median first and counts failures", () => {
    expect(t.endpoints[0]!.key).toBe("GET /fms/v3/invoices/{id}");
    const users = t.endpoints.find((e) => e.key.includes("users/data"))!;
    expect(users.all.errors).toBe(1);
  });

  it("records page ready times, timeouts and companies per user", () => {
    const home = t.pages.find((p) => p.page === "home")!;
    expect(home.timeouts).toBe(1);
    expect(home.byUser.user1!.p50).toBe(1200);
    expect(t.companies).toEqual({ user1: ["c-user1"], user2: ["c-user2"] });
  });

  it("keeps each concrete URL under its API, slowest first", () => {
    const inv = t.endpoints.find((e) => e.key === "GET /fms/v3/invoices/{id}")!;
    expect(inv.urls.map((u) => u.url)).toEqual(["/fms/v3/invoices/2?page=4", "/fms/v3/invoices/1", "/fms/v3/invoices/3"]);
    const users = t.endpoints.find((e) => e.key.includes("users/data"))!;
    expect(users.statuses).toEqual({ 200: 1, 503: 1 });
    expect(users.urls).toHaveLength(1);
    expect(users.urls[0]!.users).toEqual(["user2"]);
  });

  it("renders one row per API with its URLs grouped underneath", () => {
    const html = renderDiscoveryReport(t);
    expect(html.match(/<tbody data-filter-group="apis">/g)).toHaveLength(1);
    expect(html).toContain("3 different URLs");
    expect(html).toContain("/fms/v3/invoices/2?page=4");
    expect(html).toContain("200 ×1 · 503 ×1");
    expect(html).not.toContain("Pages without load");
  });
});
