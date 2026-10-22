import type { BreakReason, ServiceState } from "../analysis/evaluate.ts";
import { percentile, StatsBuilder, type Stats } from "../analysis/stats.ts";
import { resolveEndpoint } from "../catalog/build.ts";
import type { RouteMatcher } from "../gateway/routes.ts";
import type { RunnerHealth } from "./health.ts";
import type { LayerVisit } from "./browserLayer.ts";

export interface PageAgg {
  page: string;
  interaction: string;
  n: number;
  timeouts: number;
  errors: number;
  p50: number;
  p95: number;
  max: number;
  lcpP95?: number;
  /** Endpoints that dominated this page/interaction (by p95). */
  topEndpoints: { key: string; p95: number; n: number }[];
}

export interface StepServiceRecord {
  name: string;
  plannedRps: number;
  wantedRps: number;
  cap: number | null;
  capped: boolean;
  held: boolean;
  stats: Stats;
  dropped: number;
  throttled: Record<string, number>;
  broke?: BreakReason[];
}

export interface StepRecord {
  index: number;
  targetRps: number;
  startedAt: string;
  endedAt: string;
  windowSec: number;
  overall: Stats;
  services: StepServiceRecord[];
  /** failures: why calls failed, e.g. {"HTTP 503": 2, "Timed out (no response)": 5}. Absent in old results. */
  endpoints: { key: string; service: string; stats: Stats; failures?: Record<string, number> }[];
  variants: { key: string; service: string; variant: string; stats: Stats }[];
  pages: PageAgg[];
  /** Users mode: pages opened per page id. Estimated from the calls for runs made before it was counted. */
  visits?: Record<string, number>;
  visitsEstimated?: boolean;
  runner: RunnerHealth;
  refused: number;
  blockedWrites: number;
  k6ExitCode: number;
  emergency?: string;
}

export interface RunMeta {
  tool: "dxp-loadtest";
  kind: "run";
  env: string;
  /** The web app driven (absent in runs made before apps existed: "retailer"). */
  app?: string;
  envKind: string;
  webBaseUrl: string;
  label?: string;
  startedAt: string;
  endedAt: string;
  runner: { host: string; platform: string; cpus: number; memGb: number };
  versions: { node: string; k6: string; playwright: string };
  catalogCreatedAt: string;
  catalogSignature: string[];
  filters: { onlyPage?: string; onlyEndpoint?: string; onlyService?: string; excludeServices?: string[] };
  /** Step targets: total req/s ("rate", the default) or virtual users ("users"). */
  stepsPlanned: number[];
  mode?: "rate" | "users";
  thinkTimeSec?: number;
  sessionsPerUser?: number;
  stepDurationSec: number;
  /** k6 gives up on a call after this long (absent in old results). */
  requestTimeoutSec?: number;
  browsers: number;
  users: number;
  stopAtFirstBreak: boolean;
  breakRules: { errorRate: number; p95Ms: number; minRequests: number };
  safetyFactor: number;
  endReason: string;
}

export interface PlanSummaryService {
  name: string;
  endpoints: number;
  users: number;
  cap: number | null;
  limitsVerified: boolean;
  knownService: boolean;
  repoPath?: string;
}

export interface RunResults {
  meta: RunMeta;
  plan: { services: PlanSummaryService[]; excluded: { key: string; reason: string }[]; totalEndpoints: number };
  steps: StepRecord[];
  services: ServiceState[];
  systemBreak?: { step: number; targetRps: number; services: string[] };
  endpointsMeta: Record<string, { service: string; servicePath?: string; pages: string[] }>;
  pagesMeta: { id: string; reached: boolean; interactions: string[]; note?: string }[];
  warnings: string[];
}

/** Aggregates browser visits of one step into per page+interaction timings with the dominant endpoints. */
export function aggregatePages(visits: LayerVisit[], matcher: RouteMatcher): PageAgg[] {
  const groups = new Map<string, LayerVisit[]>();
  for (const v of visits) {
    const k = `${v.page}\u0000${v.interaction}`;
    const list = groups.get(k) ?? [];
    list.push(v);
    groups.set(k, list);
  }
  const out: PageAgg[] = [];
  for (const list of groups.values()) {
    const all = list.map((v) => v.readyMs).sort((a, b) => a - b);
    const lcps = list.map((v) => v.lcpMs).filter((x): x is number => x !== undefined).sort((a, b) => a - b);
    const perEndpoint = new Map<string, StatsBuilder>();
    for (const v of list) {
      for (const c of v.calls) {
        const key = resolveEndpoint(matcher, c.method, c.url).key;
        if (!perEndpoint.has(key)) perEndpoint.set(key, new StatsBuilder());
        perEndpoint.get(key)!.add(c.status, c.durationMs);
      }
    }
    const top = [...perEndpoint.entries()]
      .map(([key, b]) => {
        const s = b.build(0);
        return { key, p95: s.p95, n: s.n };
      })
      .sort((a, b) => b.p95 - a.p95)
      .slice(0, 5);
    out.push({
      page: list[0]!.page,
      interaction: list[0]!.interaction,
      n: list.length,
      timeouts: list.filter((v) => v.timedOut).length,
      errors: list.filter((v) => v.error).length,
      // Timed-out visits count at their timeout so p95 reflects them.
      p50: Math.round(percentile(all, 50)),
      p95: Math.round(percentile(all, 95)),
      max: Math.round(all[all.length - 1] ?? 0),
      lcpP95: lcps.length ? Math.round(percentile(lcps, 95)) : undefined,
      topEndpoints: top,
    });
  }
  return out.sort((a, b) => b.p95 - a.p95);
}
