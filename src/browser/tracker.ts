import type { Page, Request } from "playwright";
import type { UntrackedHost } from "../catalog/types.ts";

export interface TrackedCall {
  stepId: number;
  method: string;
  url: string;
  body?: string;
  headers: Record<string, string>;
  /** 0 when there was no response (failed, or still open when its step timed out). */
  status: number;
  /** For a call still open at the step's timeout: the time it had been waiting (a lower bound). */
  durationMs: number;
  totalCount?: number;
}

const DROP_HEADERS = new Set([
  "authorization",
  "cookie",
  "user-agent",
  "referer",
  "origin",
  "accept-encoding",
  "accept-language",
  "connection",
  "host",
  "content-length",
  "priority",
  "pragma",
  "cache-control",
]);

/** Headers to replay from k6. Authorization is re-added per user at load time. */
export function replayHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (DROP_HEADERS.has(key) || key.startsWith("sec-") || key.startsWith(":") || key.startsWith("x-forwarded")) continue;
    out[key] = v;
  }
  return out;
}

const TOTAL_KEYS = /^(total|totalcount|totalrecords|totalrecordcount|totalrows|totalitems|totalelements|recordcount|totalresults|totalrowcount)$/i;

/** Finds the largest "total count" style number in a JSON response (depth-limited). */
export function findTotalCount(node: unknown, depth = 0): number | undefined {
  if (depth > 3 || node === null || typeof node !== "object") return undefined;
  let best: number | undefined;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (typeof v === "number" && TOTAL_KEYS.test(k)) best = Math.max(best ?? 0, v);
    else if (v && typeof v === "object" && !Array.isArray(v)) {
      const inner = findTotalCount(v, depth + 1);
      if (inner !== undefined) best = Math.max(best ?? 0, inner);
    }
  }
  return best;
}

export interface TrackerOptions {
  gatewayBaseUrls: string[];
  /** Parse JSON responses for total counts (discovery only; costs time). */
  inspectBodies: boolean;
  /** host[:port] or domains whose fetch/XHR calls are expected outside gatewayBaseUrls (Auth0, blocked third parties). */
  ignoreHosts?: string[];
}



/**
 * Tracks API calls to the gateway on one page: in-flight count and last activity (for the page-ready signal)
 * and a log of finished calls tagged with the measurement step that was active when they started.
 */
export class RequestTracker {
  inflight = 0;
  lastActivity = 0;
  stepId = 0;
  readonly calls: TrackedCall[] = [];
  readonly untracked = new Map<string, UntrackedHost>();
  private readonly started = new Map<Request, { at: number; stepId: number; headers: Record<string, string> }>();
  private readonly opts: TrackerOptions;
  private readonly page: Page;

  constructor(page: Page, opts: TrackerOptions) {
    this.opts = opts;
    this.page = page;
    page.on("request", (req) => this.onRequest(req));
    page.on("requestfinished", (req) => void this.onFinished(req));
    page.on("requestfailed", (req) => this.onFailed(req));
    // The old document keeps running until the new one arrives, and calls it starts in that gap are cancelled
    // without events too, so forget everything again once the new document's response is in.
    page.on("response", (res) => {
      const req = res.request();
      if (req.isNavigationRequest() && this.isMainFrame(req)) {
        this.started.clear();
        this.inflight = 0;
      }
    });
  }

  private isMainFrame(req: Request): boolean {
    try {
      return req.frame() === this.page.mainFrame();
    } catch {
      return false; // service worker requests have no frame
    }
  }

  /** Gateway calls still in flight, oldest first, as "METHOD path (age)". */
  inflightCalls(): string[] {
    const now = Date.now();
    return [...this.started]
      .sort((a, b) => a[1].at - b[1].at)
      .map(([req, s]) => `${req.method()} ${new URL(req.url()).pathname} (${Math.round((now - s.at) / 1000)}s)`);
  }

  isGateway(url: string): boolean {
    return this.opts.gatewayBaseUrls.some((base) => url.startsWith(base));
  }

  private onRequest(req: Request): void {
    // A new main-frame document cancels every call of the old one. Playwright does not always report those
    // cancellations (seen with routed requests), and a call that never settles would keep every later page "busy".
    if (req.isNavigationRequest() && this.isMainFrame(req)) {
      this.started.clear();
      this.inflight = 0;
      return;
    }
    if (!this.isGateway(req.url())) {
      this.noteUntracked(req);
      return;
    }
    this.inflight++;
    this.lastActivity = Date.now();
    this.started.set(req, { at: Date.now(), stepId: this.stepId, headers: req.headers() });
  }

  private noteUntracked(req: Request): void {
    const type = req.resourceType();
    if (type !== "fetch" && type !== "xhr") return;
    let u: URL;
    try {
      u = new URL(req.url());
    } catch {
      return;
    }
    if (!u.protocol.startsWith("http")) return;
    const host = u.host.toLowerCase();
    const hostname = u.hostname.toLowerCase();
    // Entries are host[:port] (Auth0) or domains (third parties, subdomains included).
    const ignored = (this.opts.ignoreHosts ?? []).map((h) => h.toLowerCase()).some((h) => host === h || hostname === h || hostname.endsWith("." + h));
    if (ignored) return;
    const entry = this.untracked.get(u.origin) ?? { origin: u.origin, count: 0, example: u.pathname };
    entry.count++;
    this.untracked.set(u.origin, entry);
  }

  private settle(req: Request): { at: number; stepId: number; headers: Record<string, string> } | undefined {
    const s = this.started.get(req);
    if (!s) return undefined;
    this.started.delete(req);
    this.inflight = Math.max(0, this.inflight - 1);
    this.lastActivity = Date.now();
    return s;
  }

  private async onFinished(req: Request): Promise<void> {
    const s = this.started.get(req);
    if (!s) return;
    const end = Date.now();
    let status = 0;
    let totalCount: number | undefined;
    try {
      const res = await req.response();
      status = res?.status() ?? 0;
      if (res && this.opts.inspectBodies && (res.headers()["content-type"] ?? "").includes("json")) {
        totalCount = findTotalCount(await res.json());
      }
    } catch {
      // Body unavailable (redirect, page closed): keep the status we have.
    }
    this.settle(req);
    this.calls.push({
      stepId: s.stepId,
      method: req.method(),
      url: req.url(),
      body: req.postData() ?? undefined,
      headers: replayHeaders(s.headers),
      status,
      durationMs: end - s.at,
      totalCount,
    });
  }

  /**
   * Calls of a timed-out step that are still open are logged as "no response" with the time waited so far, so a hung
   * API shows up in the reports and the catalog instead of vanishing when the next page cancels it.
   */
  closeUnfinished(stepId: number): void {
    const now = Date.now();
    for (const [req, s] of [...this.started]) {
      if (s.stepId !== stepId) continue;
      this.started.delete(req);
      this.inflight = Math.max(0, this.inflight - 1);
      this.calls.push({
        stepId,
        method: req.method(),
        url: req.url(),
        body: req.postData() ?? undefined,
        headers: replayHeaders(s.headers),
        status: 0,
        durationMs: now - s.at,
      });
    }
  }

  private onFailed(req: Request): void {
    const s = this.settle(req);
    if (!s) return;
    const failure = req.failure()?.errorText ?? "";
    if (failure.includes("BLOCKED_BY_CLIENT")) return;
    this.calls.push({
      stepId: s.stepId,
      method: req.method(),
      url: req.url(),
      body: req.postData() ?? undefined,
      headers: replayHeaders(s.headers),
      status: 0,
      durationMs: Date.now() - s.at,
    });
  }
}
