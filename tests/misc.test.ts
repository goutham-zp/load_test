import { describe, expect, it } from "vitest";
import { companiesFromUserData, isUsersDataUrl } from "../src/browser/login.ts";
import { decodeJwtExp, needsRefresh } from "../src/browser/session.ts";
import { findTotalCount, replayHeaders } from "../src/browser/tracker.ts";
import { isProdLikeHost } from "../src/config/safety.ts";
import type { PageConfig } from "../src/config/types.ts";
import { orderPages, withParents } from "../src/discover/discover.ts";
import { compileGuard, isReplayable } from "../src/guard/readonly.ts";

describe("prod guard", () => {
  it("flags production-looking hosts only", () => {
    expect(isProdLikeHost("dev-dxp.app.fintech.com")).toBe(false);
    expect(isProdLikeHost("test-opm-dxp.app.fintech.com")).toBe(false);
    expect(isProdLikeHost("pre-prd-dxp.app.fintech.com")).toBe(false);
    expect(isProdLikeHost("fintech-dev.us.auth0.com")).toBe(false);
    expect(isProdLikeHost("localhost")).toBe(false);
    expect(isProdLikeHost("dxp.app.fintech.com")).toBe(true);
    expect(isProdLikeHost("prd-dxp.app.fintech.com")).toBe(true);
    expect(isProdLikeHost("apis.app.fintech.com")).toBe(true);
  });
});

describe("read-only guard", () => {
  const guard = compileGuard({
    auth0Host: "tenant.auth0.com",
    allowlist: [
      { method: "POST", path: "/v5/reports/invoices$", reviewed: true },
      { method: "POST", path: "/contacts/list$", reviewed: false },
    ],
    blockedThirdPartyHosts: ["heapanalytics.com"],
  });

  it("allows reads, auth0 and reviewed allowlist entries; blocks other writes and third parties", () => {
    expect(guard.decide("GET", "https://gw/fms/x").action).toBe("allow");
    expect(guard.decide("POST", "https://tenant.auth0.com/oauth/token")).toEqual({ action: "allow", reason: "auth0" });
    expect(guard.decide("POST", "https://gw/fms/v5/reports/invoices")).toEqual({ action: "allow", reason: "allowlisted" });
    expect(guard.decide("POST", "https://gw/fms/contacts/list")).toEqual({ action: "block", reason: "write" });
    expect(guard.decide("DELETE", "https://gw/fms/v5/reports/invoices")).toEqual({ action: "block", reason: "write" });
    expect(guard.decide("GET", "https://cdn.heapanalytics.com/h.js")).toEqual({ action: "block", reason: "third-party" });
    expect(isReplayable(guard, "PUT", "https://gw/fms/v5/reports/invoices")).toBe(false);
  });

  it("matches auth0 by host and port", () => {
    const local = compileGuard({ auth0Host: "localhost:4101", allowlist: [], blockedThirdPartyHosts: [] });
    expect(local.decide("POST", "http://localhost:4101/login").action).toBe("allow");
    expect(local.decide("POST", "http://localhost:4102/fms/v1/audit").action).toBe("block");
  });
});

describe("session helpers", () => {
  it("flattens companies with children", () => {
    const data = { result: { activeCompanies: [{ ftsId: 1, childCompanies: [{ ftsId: 2, childCompanies: [] }] }, { companyId: 3 }] } };
    expect(companiesFromUserData(data)).toEqual(["1", "2", "3"]);
  });

  it("recognises the /users/data call", () => {
    const p = "/fms/v2.1/users/data";
    expect(isUsersDataUrl("https://pg-apis.app.fintech.com/fms/v2.1/users/data", p)).toBe(true);
    expect(isUsersDataUrl("https://pg-apis.app.fintech.com/fms/v2.2/users/data?x=1", p)).toBe(true);
    expect(isUsersDataUrl("https://pg-apis.app.fintech.com/fms/users/preferences/abc", p)).toBe(false);
  });

  it("decodes JWT exp and decides refresh", () => {
    const payload = Buffer.from(JSON.stringify({ exp: 2_000_000_000 })).toString("base64url");
    const token = `x.${payload}.y`;
    expect(decodeJwtExp(token)).toBe(2_000_000_000);
    const s = { key: "u", user: "u", token, exp: 1000, companies: [], storageStatePath: "", loggedInAt: "" };
    expect(needsRefresh(s, 300, 600)).toBe(false);
    expect(needsRefresh(s, 300, 800)).toBe(true);
    expect(needsRefresh(undefined, 300)).toBe(true);
  });
});

describe("tracker helpers", () => {
  it("finds total counts and filters replay headers", () => {
    expect(findTotalCount({ result: { items: [], totalCount: 1240 } })).toBe(1240);
    expect(findTotalCount({ items: [{ total: 5 }] })).toBeUndefined();
    expect(replayHeaders({ Authorization: "x", Cookie: "c", retailerftsid: "1", "Content-Type": "application/json", "sec-ch-ua": "z" })).toEqual({
      retailerftsid: "1",
      "content-type": "application/json",
    });
  });
});

describe("page ordering", () => {
  const pages: PageConfig[] = [
    { id: "c", path: "a/{x}/{y}", detailFrom: { page: "b" } },
    { id: "b", path: "a/{x}", detailFrom: { page: "a" } },
    { id: "a", path: "a" },
    { id: "z", path: "z" },
  ];
  it("puts parents before children at any depth", () => {
    expect(orderPages(pages).map((p) => p.id)).toEqual(["a", "z", "b", "c"]);
  });
  it("pulls in parents of selected pages", () => {
    expect(withParents(pages, ["c"]).map((p) => p.id).sort()).toEqual(["a", "b", "c"]);
  });
});
