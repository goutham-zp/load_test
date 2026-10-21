import type { Page } from "playwright";
import type { PageInteractions } from "../config/types.ts";
import { runInteractions } from "./interactions.ts";
import { readLcp, waitForReady, type ReadyResult } from "./ready.ts";
import type { RequestTracker, TrackedCall } from "./tracker.ts";

export interface VisitStep {
  page: string;
  interaction: string;
  url: string;
  startedAt: number;
  readyMs: number;
  timedOut: boolean;
  /** On timeout: what kept the page busy. */
  busy?: string;
  lcpMs?: number;
  calls: TrackedCall[];
  error?: string;
}

export interface VisitOptions {
  quietMs: number;
  timeoutMs: number;
  log: (msg: string) => void;
}

/** Measures one action on the page: tag new API calls with a fresh step id, run it, wait for ready. */
export async function measureStep(
  page: Page,
  tracker: RequestTracker,
  pageId: string,
  interaction: string,
  action: () => Promise<void>,
  opts: VisitOptions
): Promise<VisitStep> {
  const stepId = ++tracker.stepId;
  const startedAt = Date.now();
  let error: string | undefined;
  try {
    await action();
  } catch (e) {
    error = (e as Error).message.split("\n")[0];
  }
  // A failed action (element missing, navigation error) changed nothing worth waiting for.
  const ready: ReadyResult = error
    ? { readyMs: Date.now() - startedAt, timedOut: false }
    : await waitForReady(page, tracker, startedAt, { quietMs: opts.quietMs, timeoutMs: opts.timeoutMs });
  // Give late finishers a moment to be logged, then collect this step's calls.
  await page.waitForTimeout(50).catch(() => {});
  return {
    page: pageId,
    interaction,
    url: page.url(),
    startedAt,
    readyMs: ready.readyMs,
    timedOut: ready.timedOut,
    busy: ready.busy,
    lcpMs: interaction === "load" ? await readLcp(page) : undefined,
    calls: tracker.calls.filter((c) => c.stepId === stepId),
    error,
  };
}

/** Loads a page URL, then runs its interactions. Returns one step for the load and one per interaction. */
export async function visitPage(
  page: Page,
  tracker: RequestTracker,
  pageId: string,
  url: string,
  interactions: PageInteractions | undefined,
  opts: VisitOptions
): Promise<VisitStep[]> {
  const steps: VisitStep[] = [];
  steps.push(
    await measureStep(page, tracker, pageId, "load", async () => {
      await page.goto(url, { waitUntil: "load", timeout: opts.timeoutMs });
    }, opts)
  );
  // A page that never became ready (or failed to load) is not worth interacting with.
  if (interactions && !steps[0]!.error && !steps[0]!.timedOut) {
    await runInteractions(
      page,
      interactions,
      async (label, action) => {
        const step = await measureStep(page, tracker, pageId, label, action, opts);
        steps.push(step);
        if (step.timedOut) opts.log(`${pageId}: "${label}" never became ready; skipping the remaining interactions`);
        return !step.timedOut;
      },
      opts.log
    );
  }
  return steps;
}
