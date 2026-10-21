import type { Browser, BrowserContext } from "playwright";
import type { CompiledGuard } from "../guard/readonly.ts";
import { LCP_INIT_SCRIPT } from "./ready.ts";

export interface BlockedEvent {
  method: string;
  url: string;
  reason: "third-party" | "write";
  body?: string;
  at: number;
}

export interface GuardedContext {
  context: BrowserContext;
  blocked: BlockedEvent[];
}

/** A browser context with the read-only guard, third-party blocking and the LCP observer installed. */
export async function newGuardedContext(
  browser: Browser,
  guard: CompiledGuard,
  storageStatePath?: string
): Promise<GuardedContext> {
  const context = await browser.newContext({
    storageState: storageStatePath,
    serviceWorkers: "block",
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
  });
  context.setDefaultTimeout(30_000);
  await context.addInitScript(LCP_INIT_SCRIPT);
  const blocked: BlockedEvent[] = [];
  await context.route("**/*", async (route) => {
    const req = route.request();
    const decision = guard.decide(req.method(), req.url());
    if (decision.action === "block") {
      if (decision.reason === "write") {
        blocked.push({ method: req.method(), url: req.url(), reason: decision.reason, body: req.postData()?.slice(0, 2000), at: Date.now() });
      }
      await route.abort("blockedbyclient").catch(() => {});
      return;
    }
    await route.continue().catch(() => {});
  });
  return { context, blocked };
}
