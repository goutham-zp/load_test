import { describe, expect, it } from "vitest";
import { buildCatalog, resolveEndpoint } from "../src/catalog/build.ts";
import { pagePathFromUrl, pagePathRegex, templatePath, templateSegment } from "../src/catalog/normalize.ts";
import { applyVariant, buildVariants, classify, detectDimensions, parseDateValue, shiftDate } from "../src/catalog/params.ts";
import type { RecordedRequest, Sample } from "../src/catalog/types.ts";
import { createRouteMatcher, templateToRegex } from "../src/gateway/routes.ts";

describe("templateSegment / templatePath", () => {
  it("replaces id-like segments and keeps words", () => {
    expect(templatePath("/fms/v3/invoices/12345")).toBe("/fms/v3/invoices/{num}");
    expect(templatePath("/fms/v3/x/3fa85f64-5717-4562-b3fc-2c963f66afa6")).toBe("/fms/v3/x/{uuid}");
    expect(templateSegment("INV-100234")).toBe("{id}");
    expect(templateSegment("payment-activity")).toBe("payment-activity");
    expect(templateSegment("v2.1")).toBe("v2.1");
    expect(templateSegment("2026-01-31")).toBe("{date}");
  });

  it("extracts company and page path from page URLs", () => {
    expect(pagePathFromUrl("https://x/en/retailer/1001/invoices/my-invoices?x=1", "en")).toEqual({ companyId: "1001", rest: "invoices/my-invoices" });
    expect(pagePathRegex("invoices/payment-activity/{transactionId}").test("invoices/payment-activity/abc123")).toBe(true);
    expect(pagePathRegex("invoices/payment-activity/{transactionId}").test("invoices/payment-activity")).toBe(false);
  });
});

describe("gateway route matching", () => {
  const route = (method: string, gatewayPath: string, service: string) => ({
    service,
    method,
    gatewayPath,
    servicePath: "/api" + gatewayPath,
    host: "h",
    ...templateToRegex(gatewayPath),
  });
  const matcher = createRouteMatcher([
    route("GET", "/fms/v3/invoices/{id}", "fms/invoice-apis"),
    route("GET", "/fms/v3/invoices/average-spend", "fms/invoice-apis"),
    route("POST", "/fms/v5/reports/invoices", "fms/invoice-apis"),
  ]);

  it("prefers the most literal route", () => {
    expect(matcher.match("GET", "/fms/v3/invoices/average-spend")?.gatewayPath).toBe("/fms/v3/invoices/average-spend");
    expect(matcher.match("GET", "/fms/v3/invoices/42")?.gatewayPath).toBe("/fms/v3/invoices/{id}");
  });

  it("respects the method and falls back to a heuristic template", () => {
    expect(matcher.match("GET", "/fms/v5/reports/invoices")).toBeUndefined();
    const r = resolveEndpoint(matcher, "GET", "https://gw/fms/other/123");
    expect(r).toMatchObject({ key: "GET /fms/other/{num}", service: "unknown:fms", matchedRoute: false });
  });
});

describe("dates", () => {
  it("parses and shifts keeping the format", () => {
    expect(parseDateValue("2026-01-31")?.format).toBe("iso-date");
    expect(shiftDate("2026-01-31", { years: -1 })).toBe("2025-01-31");
    expect(shiftDate("2026-01-01", { years: -2 })).toBe("2024-01-01");
    expect(shiftDate("01/31/2026", { years: -1 })).toBe("01/31/2025");
    expect(shiftDate("2026-01-31T00:00:00.000Z", { days: -1 })).toBe("2026-01-30T00:00:00.000Z");
  });
});

describe("dimension detection and variants", () => {
  const sample = (user: string, url: string, body?: unknown): Sample => ({
    user,
    companyId: user === "user1" ? "1001" : "2002",
    url,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {},
  });

  it("classifies by name", () => {
    expect(classify("pageNumber", [0])).toBe("page");
    expect(classify("sortBy", ["date"])).toBe("sort");
    expect(classify("sortOrder", ["desc"])).toBe("direction");
    expect(classify("fromDate", ["2026-01-01"])).toBe("dateFrom");
    expect(classify("toDate", ["2026-10-01"])).toBe("dateTo");
    expect(classify("fromDate", ["not a date"])).toBeUndefined();
  });

  it("generates deep pages bounded by total count, flips direction, widens dates", () => {
    const samples = [
      sample("user1", "https://gw/fms/v3/invoices?pageNumber=0&pageSize=25&sortBy=invoiceDate&sortOrder=desc&fromDate=2026-01-01&toDate=2026-10-01"),
    ];
    const dims = detectDimensions(samples, { maxTotalCount: 1240, searchTerms: ["a"] });
    const page = dims.find((d) => d.label === "pageNumber")!;
    expect(page.kind).toBe("page");
    expect(page.values).toEqual(["0", "1", "4", "19", "49"]); // 1240/25 = 50 pages -> last index 49
    expect(dims.find((d) => d.label === "sortOrder")!.values).toEqual(["desc", "asc"]);
    expect(dims.find((d) => d.label === "fromDate")!.values).toEqual(["2026-01-01", "2025-01-01", "2024-01-01"]);
    expect(dims.find((d) => d.label === "pageSize")!.values).toEqual(["25"]);
  });

  it("treats a param as a filter only if it varies within one user's company and is not an id", () => {
    const samples = [
      sample("user1", "https://gw/x?status=open&storeId=111"),
      sample("user1", "https://gw/x?status=paid&storeId=111"),
      sample("user2", "https://gw/x?status=open&storeId=222"),
    ];
    const dims = detectDimensions(samples, { searchTerms: [] });
    expect(dims.map((d) => `${d.label}:${d.kind}`)).toEqual(["status:filter"]);
  });

  it("reads body params and applies variants without losing types", () => {
    const s = sample("user1", "https://gw/fms/v5/reports/invoices", { paging: { pageNumber: 1, pageSize: 50 }, sortBy: "amount" });
    const dims = detectDimensions([s], { searchTerms: [] });
    const variants = buildVariants(dims, s, 10);
    expect(variants[0]!.label).toBe("base");
    const deep = variants.find((v) => v.label === "paging.pageNumber=20")!;
    expect(JSON.parse(applyVariant(s, deep).body!)).toEqual({ paging: { pageNumber: 20, pageSize: 50 }, sortBy: "amount" });
  });

  it("caps variants and interleaves dimensions", () => {
    const s = sample("user1", "https://gw/x?page=1&sort=a&order=asc&search=b");
    const dims = detectDimensions([s], { searchTerms: ["x", "y", "z"] });
    const v = buildVariants(dims, s, 4);
    expect(v).toHaveLength(4);
    expect(new Set(v.slice(1).map((x) => x.label.split("=")[0])).size).toBe(3);
  });
});

describe("buildCatalog", () => {
  const rec = (over: Partial<RecordedRequest>): RecordedRequest => ({
    user: "user1",
    companyId: "1001",
    page: "home",
    interaction: "load",
    method: "GET",
    url: "https://gw/fms/v3/invoices/1",
    headers: { retailerftsid: "1001" },
    status: 200,
    durationMs: 100,
    ...over,
  });

  it("groups by template, keeps only successful samples, records failures", () => {
    const matcher = createRouteMatcher([]);
    const c = buildCatalog({
      env: "t",
      webBaseUrl: "https://web",
      gatewayBaseUrls: ["https://gw"],
      users: ["user1"],
      recorded: [rec({}), rec({ url: "https://gw/fms/v3/invoices/2" }), rec({ url: "https://gw/fms/v3/invoices/3", status: 500 })],
      pages: [{ id: "home", reached: true, urls: [], interactions: ["load"], endpoints: [] }],
      blocked: [],
      matcher,
      maxSamplesPerUserPerEndpoint: 5,
      maxVariantsPerEndpoint: 10,
      searchTerms: [],
    });
    expect(c.endpoints).toHaveLength(1);
    expect(c.endpoints[0]!.key).toBe("GET /fms/v3/invoices/{num}");
    expect(c.endpoints[0]!.samples).toHaveLength(2);
    expect(c.failures).toEqual([{ key: "GET /fms/v3/invoices/{num}", status: 500, count: 1 }]);
    expect(c.pages[0]!.endpoints).toEqual(["GET /fms/v3/invoices/{num}"]);
  });
});
