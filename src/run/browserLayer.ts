import type { Browser, BrowserContext } from "playwright";
import { newGuardedContext } from "../browser/context.ts";
import { resolveInteractions } from "../browser/interactions.ts";
import type { UserSession } from "../browser/session.ts";
import { RequestTracker } from "../browser/tracker.ts";
import { visitPage, type VisitStep } from "../browser/visit.ts";
import type { Catalog } from "../catalog/types.ts";
import { busySelector } from "../config/app.ts";
import type { AppProfile, EnvConfig, InteractionsFile, Settings } from "../config/types.ts";
import type { CompiledGuard } from "../guard/readonly.ts";

export interface LayerVisit extends VisitStep {
  user: string;
  worker: number;
}

/**
 * A small pool of headless browsers cycling through the discovered pages while k6 applies load.
 * Browsers only work while a step is active; the orchestrator assigns each measured step to a load step
 * by time window (see visitsWithin).
 */
export class BrowserLayer {
  /** True while a load step is running. */
  active = false;
  readonly visits: LayerVisit[] = [];
  blockedWrites = 0;
  private stopping = false;
  private loops: Promise<void>[] = [];
  private contexts: BrowserContext[] = [];
  private readonly browser: Browser;
  private readonly env: EnvConfig;
  private readonly app: AppProfile;
  private readonly guard: CompiledGuard;
  private readonly sessions: UserSession[];
  private readonly catalog: Catalog;
  private readonly interactions: InteractionsFile;
  private readonly settings: Settings;
  private readonly workers: number;
  private readonly onlyPage?: string;
  private readonly log: (m: string) => void;

  constructor(args: {
    browser: Browser;
    env: EnvConfig;
    app: AppProfile;
    guard: CompiledGuard;
    sessions: UserSession[];
    catalog: Catalog;
    interactions: InteractionsFile;
    settings: Settings;
    workers: number;
    onlyPage?: string;
    log: (m: string) => void;
  }) {
    this.browser = args.browser;
    this.env = args.env;
    this.app = args.app;
    this.guard = args.guard;
    this.sessions = args.sessions;
    this.catalog = args.catalog;
    this.interactions = args.interactions;
    this.settings = args.settings;
    this.workers = args.workers;
    this.onlyPage = args.onlyPage;
    this.log = args.log;
  }

  async start(): Promise<void> {
    for (let w = 0; w < this.workers; w++) {
      const session = this.sessions[w % this.sessions.length]!;
      const { context, blocked } = await newGuardedContext(this.browser, this.guard, session.storageStatePath);
      this.contexts.push(context);
      this.loops.push(this.loop(w, session, context, blocked));
    }
  }

  /** Pages this session can open: its user's discovered URLs for the companies the session holds. */
  private pagesFor(session: UserSession) {
    return this.catalog.pages
      .filter((p) => p.reached && (!this.onlyPage || p.id === this.onlyPage))
      .map((p) => ({ id: p.id, urls: p.urls.filter((u) => u.user === session.user && session.companies.includes(u.companyId)).map((u) => u.url) }))
      .filter((p) => p.urls.length > 0);
  }

  private async loop(w: number, session: UserSession, context: BrowserContext, blocked: { reason: string }[]): Promise<void> {
    const pages = this.pagesFor(session);
    if (pages.length === 0) {
      this.log(`browser ${w}: no discovered pages for ${session.key}`);
      return;
    }
    const page = await context.newPage();
    const tracker = new RequestTracker(page, { gatewayBaseUrls: this.env.gatewayBaseUrls, inspectBodies: false });
    const opts = {
      quietMs: this.settings.browser.readyQuietMs,
      timeoutMs: this.settings.browser.readyTimeoutMs,
      busySelector: busySelector(this.app),
      selectors: this.app.selectors,
      log: () => {},
    };
    let i = w; // stagger workers across the page list
    while (!this.stopping) {
      if (!this.active) {
        await page.waitForTimeout(250).catch(() => {});
        continue;
      }
      const target = pages[i % pages.length]!;
      // Rotate through the user's companies on each pass over the page list.
      const url = target.urls[Math.floor(i / pages.length) % target.urls.length]!;
      const before = blocked.length;
      const cfg = this.settings.browser.runInteractions ? resolveInteractions(this.interactions, target.id) : undefined;
      try {
        const steps = await visitPage(page, tracker, target.id, url, cfg, opts);
        for (const s of steps) this.visits.push({ ...s, user: session.user, worker: w });
      } catch (e) {
        this.log(`browser ${w}: ${target.id}: ${(e as Error).message.split("\n")[0]}`);
      }
      this.blockedWrites += blocked.slice(before).filter((b) => b.reason === "write").length;
      tracker.calls.length = 0;
      i++;
    }
  }

  /** Measured steps that started and finished inside [startMs, endMs]. */
  visitsWithin(startMs: number, endMs: number): LayerVisit[] {
    return this.visits.filter((v) => v.startedAt >= startMs && v.startedAt + v.readyMs <= endMs);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled(this.loops);
    await Promise.allSettled(this.contexts.map((c) => c.close()));
  }
}
