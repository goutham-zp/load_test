import { describe, expect, it } from "vitest";
import { normaliseNavPath, pageInNavBar } from "../src/browser/nav.ts";
import type { PageConfig } from "../src/config/types.ts";

describe("normaliseNavPath", () => {
  it("lowercases and strips slashes, query and hash", () => {
    expect(normaliseNavPath("/Invoice-Summary/?a=1#x")).toBe("invoice-summary");
    expect(normaliseNavPath("spend-overview-reports")).toBe("spend-overview-reports");
    expect(normaliseNavPath("https://uatfms.fintech.com/company/edit")).toBe("company/edit");
  });
  it("ignores links that are not pages", () => {
    for (const h of ["#", "", null, undefined, "javascript:void(0)", "mailto:a@b.com"]) expect(normaliseNavPath(h as string | null | undefined)).toBeUndefined();
  });
});

describe("pageInNavBar", () => {
  const nav = new Set(["invoice-summary", "pocontacts", "company/edit"]);
  const page = (path: string, extra: Partial<PageConfig> = {}): PageConfig => ({ id: path, path, ...extra });
  it("visits pages the nav bar links to, ignoring case", () => {
    expect(pageInNavBar(page("invoice-summary"), nav)).toBe(true);
    expect(pageInNavBar(page("poContacts"), nav)).toBe(true);
  });
  it("skips pages the nav bar does not link to", () => {
    expect(pageInNavBar(page("payment-preferences"), nav)).toBe(false);
    expect(pageInNavBar(page("invoice-documents"), nav)).toBe(false);
  });
  it("always visits the landing page", () => {
    expect(pageInNavBar(page(""), nav)).toBe(true);
  });
  it("skips detail pages reached by clicking a row", () => {
    expect(pageInNavBar(page("invoice-summary", { detailFrom: { page: "x" } }), nav)).toBe(false);
  });
});
