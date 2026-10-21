import type { Page } from "playwright";
import type { RequestTracker } from "./tracker.ts";

/** Loading indicators used across DXP.Web (MUI progress, skeletons, DataGrid loading overlay). */
export const BUSY_SELECTOR = [
  ".MuiCircularProgress-root",
  ".MuiLinearProgress-root",
  ".MuiSkeleton-root",
  ".MuiDataGrid-overlay .MuiCircularProgress-root",
  "[role=\"progressbar\"]",
].join(", ");

export interface ReadyResult {
  readyMs: number;
  timedOut: boolean;
  /** On timeout: what was still keeping the page busy. */
  busy?: string;
}

/** Why the page still counts as busy: in-flight API calls, else the visible loading indicators and where they are. */
export async function describeBusy(page: Page, tracker: RequestTracker): Promise<string> {
  const calls = tracker.inflightCalls();
  if (calls.length) return `API calls still in flight: ${calls.slice(0, 3).join(", ")}${calls.length > 3 ? ` (+${calls.length - 3} more)` : ""}`;
  const indicators = await page
    .locator(BUSY_SELECTOR)
    .filter({ visible: true })
    .evaluateAll((els) =>
      els.slice(0, 3).map((el) => {
        const cls = [...el.classList].find((c) => /^Mui\w+-root$/.test(c)) ?? el.getAttribute("role") ?? el.tagName.toLowerCase();
        const anchor = el.closest("[data-testid], [id], [aria-label]");
        const where = anchor?.getAttribute("data-testid") ?? anchor?.id ?? anchor?.getAttribute("aria-label");
        return where ? `${cls} in ${where}` : cls;
      })
    )
    .catch(() => [] as string[]);
  return indicators.length ? `loading indicator visible: ${indicators.join(", ")}` : "API activity kept restarting the quiet period";
}

/**
 * "Page ready" = no gateway API call in flight and no visible loading indicator, held for quietMs.
 * Ready time is the moment the page last became quiet, measured from startedAt.
 */
export async function waitForReady(
  page: Page,
  tracker: RequestTracker,
  startedAt: number,
  opts: { quietMs: number; timeoutMs: number }
): Promise<ReadyResult> {
  let lastBusyAt = startedAt;
  for (;;) {
    const now = Date.now();
    if (now - startedAt > opts.timeoutMs) return { readyMs: now - startedAt, timedOut: true, busy: await describeBusy(page, tracker) };
    let busy = tracker.inflight > 0;
    if (!busy) {
      try {
        busy = (await page.locator(BUSY_SELECTOR).filter({ visible: true }).count()) > 0;
      } catch {
        busy = false;
      }
    }
    if (busy) lastBusyAt = Date.now();
    const quietSince = Math.max(lastBusyAt, tracker.lastActivity, startedAt);
    if (!busy && Date.now() - quietSince >= opts.quietMs) {
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
