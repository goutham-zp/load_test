import { StatsBuilder, type Stats } from "../analysis/stats.ts";
import { resolveEndpoint } from "../catalog/build.ts";
import type { RecordedRequest } from "../catalog/types.ts";
import type { RouteMatcher } from "../gateway/routes.ts";

/** One measured page step (page load or interaction) from discovery. */
export interface TimedStep {
  user: string;
  companyId: string;
  page: string;
  interaction: string;
  readyMs: number;
  timedOut: boolean;
}

export interface SlowestCall {
  user: string;
  companyId: string;
  page: string;
  interaction: string;
  /** Path and query only (no host); never contains tokens. */
  url: string;
  status: number;
  durationMs: number;
}

/** One concrete URL (path + query, no host) of an endpoint, across users. */
export interface UrlTiming {
  url: string;
  users: string[];
  calls: number;
  p50: number;
  max: number;
  /** Response status -> count; 0 = no response (cancelled or network error). */
  statuses: Record<string, number>;
}

export interface EndpointTiming {
  key: string;
  service: string;
  servicePath?: string;
  pages: string[];
  all: Stats;
  byUser: Record<string, Stats>;
  slowest: SlowestCall;
  statuses: Record<string, number>;
  /** Slowest median first. */
  urls: UrlTiming[];
}

export interface PageTiming {
  page: string;
  interaction: string;
  /** Ready time; a timed-out step counts as an error with the time it was given up at. */
  all: Stats;
  byUser: Record<string, Stats>;
  timeouts: number;
}

/** Baseline (no load) timings collected during discovery: one browser, one user at a time. */
export interface DiscoveryTimings {
  kind: "discovery";
  env: string;
  createdAt: string;
  users: string[];
  companies: Record<string, string[]>;
  slowCallMs: number;
  endpoints: EndpointTiming[];
  pages: PageTiming[];
}

class Grouped {
  readonly all = new StatsBuilder();
  readonly byUser = new Map<string, StatsBuilder>();

  add(user: string, status: number, ms: number): void {
    this.all.add(status, ms);
    let b = this.byUser.get(user);
    if (!b) this.byUser.set(user, (b = new StatsBuilder()));
    b.add(status, ms);
  }

  stats(): { all: Stats; byUser: Record<string, Stats> } {
    return { all: this.all.build(0), byUser: Object.fromEntries([...this.byUser].map(([u, b]) => [u, b.build(0)])) };
  }
}

function sumStatuses(list: Record<string, number>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of list) for (const [k, n] of Object.entries(s)) out[k] = (out[k] ?? 0) + n;
  return out;
}

export function buildDiscoveryTimings(input: {
  env: string;
  users: string[];
  recorded: RecordedRequest[];
  steps: TimedStep[];
  matcher: RouteMatcher;
  slowCallMs: number;
  createdAt?: string;
}): DiscoveryTimings {
  const endpoints = new Map<
    string,
    { meta: ReturnType<typeof resolveEndpoint>; pages: Set<string>; g: Grouped; slowest: SlowestCall; urls: Map<string, { url: string; users: Set<string>; b: StatsBuilder; statuses: Record<string, number> }> }
  >();
  for (const r of input.recorded) {
    const meta = resolveEndpoint(input.matcher, r.method, r.url);
    const u = new URL(r.url);
    const call: SlowestCall = { user: r.user, companyId: r.companyId, page: r.page, interaction: r.interaction, url: u.pathname + u.search, status: r.status, durationMs: r.durationMs };
    let e = endpoints.get(meta.key);
    if (!e) endpoints.set(meta.key, (e = { meta, pages: new Set(), g: new Grouped(), slowest: call, urls: new Map() }));
    e.pages.add(r.page);
    e.g.add(r.user, r.status, r.durationMs);
    if (r.durationMs > e.slowest.durationMs) e.slowest = call;
    let variant = e.urls.get(call.url);
    if (!variant) e.urls.set(call.url, (variant = { url: call.url, users: new Set(), b: new StatsBuilder(), statuses: {} }));
    variant.users.add(r.user);
    variant.b.add(r.status, r.durationMs);
    variant.statuses[r.status] = (variant.statuses[r.status] ?? 0) + 1;
  }

  const pages = new Map<string, { page: string; interaction: string; g: Grouped; timeouts: number }>();
  for (const s of input.steps) {
    const key = `${s.page}\u0000${s.interaction}`;
    let p = pages.get(key);
    if (!p) pages.set(key, (p = { page: s.page, interaction: s.interaction, g: new Grouped(), timeouts: 0 }));
    p.g.add(s.user, s.timedOut ? 0 : 200, s.readyMs);
    if (s.timedOut) p.timeouts++;
  }

  const companies: Record<string, string[]> = {};
  for (const s of input.steps) {
    const list = (companies[s.user] ??= []);
    if (!list.includes(s.companyId)) list.push(s.companyId);
  }

  return {
    kind: "discovery",
    env: input.env,
    createdAt: input.createdAt ?? new Date().toISOString(),
    users: input.users,
    companies,
    slowCallMs: input.slowCallMs,
    endpoints: [...endpoints.values()]
      .map((e) => ({
        key: e.meta.key,
        service: e.meta.service,
        servicePath: e.meta.servicePath,
        pages: [...e.pages].sort(),
        ...e.g.stats(),
        slowest: e.slowest,
        statuses: sumStatuses([...e.urls.values()].map((u) => u.statuses)),
        urls: [...e.urls.values()]
          .map((u) => {
            const st = u.b.build(0);
            return { url: u.url, users: [...u.users].sort(), calls: st.n, p50: st.p50, max: st.max, statuses: u.statuses };
          })
          .sort((a, b) => b.p50 - a.p50 || b.max - a.max),
      }))
      .sort((a, b) => b.all.p50 - a.all.p50 || b.all.max - a.all.max),
    pages: [...pages.values()]
      .map((p) => ({ page: p.page, interaction: p.interaction, ...p.g.stats(), timeouts: p.timeouts }))
      .sort((a, b) => b.all.p50 - a.all.p50),
  };
}
