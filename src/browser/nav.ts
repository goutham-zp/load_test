import type { Page } from "playwright";
import type { NavigationConfig, PageConfig } from "../config/types.ts";

/** "/Invoice-Summary/?a=1#x" and "https://host/invoice-summary" both become "invoice-summary". Not a page link: undefined. */
export function normaliseNavPath(href: string | null | undefined): string | undefined {
  if (!href) return undefined;
  const h = href.trim();
  if (!h || h.startsWith("#") || /^(javascript|mailto|tel):/i.test(h)) return undefined;
  let p = h;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(h)) p = new URL(h).pathname;
  return p.split(/[?#]/)[0]!.replace(/^\/+|\/+$/g, "").toLowerCase();
}

/** A page is visited when the account's nav bar links to it. The landing page (empty path) is always visited. */
export function pageInNavBar(page: PageConfig, nav: ReadonlySet<string>): boolean {
  if (page.detailFrom) return false;
  const p = normaliseNavPath(page.path) ?? "";
  return p === "" || nav.has(p);
}

/**
 * The page links an account sees in the nav bar: opens each dropdown and collects the links of its menu. What a user
 * sees depends on the company type, the company's features and the user's rights, and the menus fill in as the
 * account's data arrives, so the bar is read again until two reads in a row agree.
 */
export async function readNavPaths(page: Page, nav: NavigationConfig, timeoutMs: number): Promise<Set<string>> {
  const bar = page.locator(nav.navSelector).first();
  await bar.locator(nav.toggleSelector).first().waitFor({ state: "visible", timeout: timeoutMs });
  let previous: Set<string> | undefined;
  for (let attempt = 0; attempt < 8; attempt++) {
    const found = await readOnce(page, nav);
    if (previous && found.size > 0 && found.size === previous.size && [...found].every((p) => previous!.has(p))) return found;
    previous = found;
    await page.waitForTimeout(3000);
  }
  throw new Error("the nav bar kept changing; it did not settle in 8 reads");
}

async function readOnce(page: Page, nav: NavigationConfig): Promise<Set<string>> {
  const toggles = page.locator(nav.navSelector).first().locator(nav.toggleSelector);
  const found = new Set<string>();
  const n = await toggles.count();
  for (let i = 0; i < n; i++) {
    await toggles.nth(i).click({ timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(300);
    const hrefs = await page.locator(nav.itemSelector).evaluateAll((els) => els.map((e) => e.getAttribute("href")));
    for (const h of hrefs) {
      const p = normaliseNavPath(h);
      if (p) found.add(p);
    }
    await page.keyboard.press("Escape");
    await page.mouse.click(5, 5).catch(() => {});
  }
  return found;
}
