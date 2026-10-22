import type { Locator, Page } from "playwright";
import type { AppSelectors, InteractionsFile, PageInteractions } from "../config/types.ts";

/** Measures one labelled action and waits for page-ready. Resolves false when the page is stuck (stop interacting). */
export type Measure = (label: string, action: () => Promise<void>) => Promise<boolean>;

export function resolveInteractions(file: InteractionsFile, pageId: string): PageInteractions | undefined {
  const entry = file.pages[pageId];
  if (entry === undefined || entry === "none") return undefined;
  if (entry === "default") return file.defaults;
  return { ...file.defaults, ...entry };
}

async function visible(locator: Locator): Promise<Locator[]> {
  const out: Locator[] = [];
  const n = await locator.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const el = locator.nth(i);
    if (await el.isVisible().catch(() => false)) out.push(el);
  }
  return out;
}

async function labelOf(el: Locator, fallback: string): Promise<string> {
  const text = ((await el.innerText().catch(() => "")) || (await el.getAttribute("aria-label").catch(() => "")) || "").trim();
  return (text.split("\n")[0] || fallback).slice(0, 40);
}

/**
 * Runs a page's scripted interactions; each action is one measured step. A failed action is skipped;
 * a step where the page never becomes ready stops the remaining interactions for this page.
 */
export async function runInteractions(page: Page, cfg: PageInteractions, measure: Measure, log: (msg: string) => void, sel: AppSelectors): Promise<void> {
  // Tabs: open every tab that isn't selected, then go back to the first one.
  if (cfg.tabs) {
    const tabs = await visible(page.locator(sel.tab));
    const wanted = cfg.tabs === "auto" ? undefined : cfg.tabs.map((t) => t.toLowerCase());
    let firstSelected: Locator | undefined;
    for (const tab of tabs) {
      const label = await labelOf(tab, "tab");
      const selected =
        (await tab.getAttribute("aria-selected").catch(() => null)) === "true" ||
        /(^|\s)active(\s|$)/.test((await tab.getAttribute("class").catch(() => null)) ?? "");
      if (selected) {
        firstSelected ??= tab;
        continue;
      }
      if (wanted && !wanted.includes(label.toLowerCase())) continue;
      if (!(await measure(`tab:${label}`, () => tab.click({ timeout: 5_000 })))) return;
    }
    if (firstSelected && tabs.length > 1) {
      const label = await labelOf(firstSelected, "tab");
      if (!(await measure(`tab:${label}`, () => firstSelected!.click({ timeout: 5_000 })))) return;
    }
  }

  // Grid: sort by the first N sortable columns, then page forward.
  if (cfg.grid) {
    const headers = (await visible(page.locator(sel.sortableHeader))).slice(0, cfg.grid.sortColumns ?? 0);
    for (const h of headers) {
      const label = await labelOf(h, "column");
      if (!(await measure(`sort:${label}`, () => h.click({ timeout: 5_000 })))) return;
    }
    for (let i = 0; i < (cfg.grid.nextPages ?? 0); i++) {
      const next = (await visible(page.locator(sel.nextPage)))[0];
      if (!next || !(await next.isEnabled().catch(() => false))) break;
      if (!(await measure(`page:${i + 2}`, () => next.click({ timeout: 5_000 })))) return;
    }
  }

  if (cfg.search?.terms.length) {
    const box = (await visible(page.locator(cfg.search.selector ?? sel.searchBox)))[0];
    if (box) {
      for (const term of cfg.search.terms) {
        const ok = await measure(`search:${term}`, async () => {
          await box.fill(term);
          await box.press("Enter");
        });
        if (!ok) return;
      }
      const ok = await measure("search:clear", async () => {
        await box.fill("");
        await box.press("Enter");
      });
      if (!ok) return;
    }
  }

  for (const step of cfg.steps ?? []) {
    const ok = await measure(step.label, async () => {
      const el = page.locator(step.selector).first();
      if (step.action === "click") await el.click({ timeout: 10_000 });
      else if (step.action === "fill") await el.fill(step.value, { timeout: 10_000 });
      else await el.selectOption(step.value, { timeout: 10_000 });
    });
    if (!ok) return;
  }
}

/** Clicks into the first row of a list page to reach a detail page. Returns false if nothing clickable. */
export async function clickFirstRow(page: Page, firstRow: string[], customSelector?: string): Promise<boolean> {
  const selectors = customSelector ? [customSelector] : firstRow;
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    if (await el.isVisible().catch(() => false)) {
      await el.click({ timeout: 5_000 }).catch(() => {});
      return true;
    }
  }
  return false;
}
