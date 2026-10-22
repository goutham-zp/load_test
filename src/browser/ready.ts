import type { Page } from "playwright";
import type { RequestTracker } from "./tracker.ts";

export interface ReadyResult {
  readyMs: number;
  timedOut: boolean;
  /** On timeout: what was still keeping the page busy. */
  busy?: string;
}

/** Visible loading indicators in every frame (embedded pages such as FMS_UI's Insights iframes count too). */
async function visibleBusyCount(page: Page, busySelector: string): Promise<number> {
  let n = 0;
  for (const frame of page.frames()) n += await frame.locator(busySelector).filter({ visible: true }).count().catch(() => 0);
  return n;
}

/** Why the page still counts as busy: in-flight API calls, else the visible loading indicators and where they are. */
export async function describeBusy(page: Page, tracker: RequestTracker, busySelector: string): Promise<string> {
  const calls = tracker.inflightCalls();
  if (calls.length) return `API calls still in flight: ${calls.slice(0, 3).join(", ")}${calls.length > 3 ? ` (+${calls.length - 3} more)` : ""}`;
  const indicators: string[] = [];
  for (const frame of page.frames()) {
    const found = await frame
      .locator(busySelector)
      .filter({ visible: true })
      .evaluateAll((els) =>
        els.slice(0, 3).map((el) => {
          const cls = [...el.classList].find((c) => /^Mui\w+-root$/.test(c)) ?? el.classList[0] ?? el.getAttribute("role") ?? el.tagName.toLowerCase();
          const anchor = el.closest("[data-testid], [id], [aria-label]");
          const where = anchor?.getAttribute("data-testid") ?? anchor?.id ?? anchor?.getAttribute("aria-label");
          return where ? `${cls} in ${where}` : cls;
        })
      )
      .catch(() => [] as string[]);
    indicators.push(...found.map((f) => (frame === page.mainFrame() ? f : `${f} (iframe)`)));
    if (indicators.length >= 3) break;
  }
  return indicators.length ? `loading indicator visible: ${indicators.slice(0, 3).join(", ")}` : "API activity kept restarting the quiet period";
}

/**
 * "Page ready" = no gateway API call in flight and no visible loading indicator, held for quietMs after the action
 * finished (actionDoneAt, e.g. the load event): a page that hasn't started its API calls yet is not ready.
 * Ready time is the moment the page last became quiet, measured from startedAt.
 */
export async function waitForReady(
  page: Page,
  tracker: RequestTracker,
  startedAt: number,
  opts: { quietMs: number; timeoutMs: number; busySelector: string; actionDoneAt?: number; settleMs?: number }
): Promise<ReadyResult> {
  let lastBusyAt = opts.actionDoneAt ?? startedAt;
  for (;;) {
    const now = Date.now();
    if (now - startedAt > opts.timeoutMs) return { readyMs: now - startedAt, timedOut: true, busy: await describeBusy(page, tracker, opts.busySelector) };
    const busy = tracker.inflight > 0 || (await visibleBusyCount(page, opts.busySelector)) > 0;
    if (busy) lastBusyAt = Date.now();
    const quietSince = Math.max(lastBusyAt, tracker.lastActivity, startedAt);
    const settled = Date.now() - (opts.actionDoneAt ?? startedAt) >= (opts.settleMs ?? 0);
    if (!busy && settled && Date.now() - quietSince >= opts.quietMs) {
      return { readyMs: quietSince - startedAt, timedOut: false };
    }
    await page.waitForTimeout(100);
  }
}

export const LCP_INIT_SCRIPT = `
(() => {
  try {
    window.__ltLcp = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__ltLcp = Math.max(window.__ltLcp, e.renderTime || e.loadTime || e.startTime);
    }).observe({ type: "largest-contentful-paint", buffered: true });
  } catch (e) {}
})();
`;

export async function readLcp(page: Page): Promise<number | undefined> {
  try {
    const v = await page.evaluate(() => (window as unknown as { __ltLcp?: number }).__ltLcp ?? 0);
    return v > 0 ? Math.round(v) : undefined;
  } catch {
    return undefined;
  }
}
