import { applyVariant } from "../catalog/params.ts";
import type { Catalog, CatalogEndpoint, Sample } from "../catalog/types.ts";
import { tokenKeyFor } from "../config/app.ts";
import type { ResolvedServices } from "../config/load.ts";
import type { AppProfile, RateRule, ServiceConfig } from "../config/types.ts";
import { isReplayable, type CompiledGuard } from "../guard/readonly.ts";

/** Lowest sustained rate (req/s) allowed across all of a service's rules; Infinity when unlimited. */
export function sustainedRate(rules: RateRule[]): number {
  if (rules.length === 0) return Infinity;
  return Math.min(...rules.map((r) => r.limit / r.perSeconds));
}

/** Highest rate we let ourselves send to a service: limit x (tokens when keyed per token) x pods x safety. */
export function serviceCap(svc: Pick<ServiceConfig, "limits" | "key" | "pods">, tokensWithSamples: number, safety: number): number {
  const base = sustainedRate(svc.limits);
  if (!Number.isFinite(base)) return Infinity;
  const multiplier = svc.key === "token" ? Math.max(1, tokensWithSamples) : 1;
  return base * multiplier * Math.max(1, svc.pods) * safety;
}

export interface PlannedRequest {
  tpl: string;
  variant: string;
  user: string;
  /** Key of the API token to send (k6-tokens.json): the user, or user|company for company-token apps. */
  token: string;
  method: string;
  url: string;
  body?: string;
  headers: Record<string, string>;
  /** True for non-read methods explicitly allowlisted as reads. */
  allowlisted: boolean;
}

export interface ServicePlan {
  name: string;
  endpoints: string[];
  users: string[];
  /** API tokens with samples, times sessions per user: the rate-limit multiplier for token-keyed services. */
  tokens: number;
  cap: number;
  limitsVerified: boolean;
  knownService: boolean;
  slots: PlannedRequest[];
}

export interface LoadPlan {
  totalEndpoints: number;
  services: ServicePlan[];
  /** Endpoints left out, with the reason. */
  excluded: { key: string; reason: string }[];
}

/** One page as a virtual user opens it: the page's recorded API calls, all with one token. */
export interface Journey {
  page: string;
  token: string;
  requests: (PlannedRequest & { svc: string })[];
}

export interface PlanFilters {
  onlyPage?: string;
  onlyEndpoint?: string;
  onlyService?: string;
  /** Services left out of the load (e.g. one that is already down), listed as excluded in the report. */
  excludeServices?: string[];
  /** Smoke: base variant only, one request per sample. */
  baseOnly?: boolean;
}

const MAX_SLOTS_PER_SERVICE = 5000;
const READ = new Set(["GET", "HEAD", "OPTIONS"]);

type TokenScope = AppProfile["tokenScope"];

export function selectEndpoints(catalog: Catalog, guard: CompiledGuard, f: PlanFilters): { selected: CatalogEndpoint[]; excluded: LoadPlan["excluded"] } {
  const selected: CatalogEndpoint[] = [];
  const excluded: LoadPlan["excluded"] = [];
  for (const e of catalog.endpoints) {
    if (f.onlyPage && !e.pages.includes(f.onlyPage)) continue;
    if (f.onlyEndpoint && !e.key.toLowerCase().includes(f.onlyEndpoint.toLowerCase())) continue;
    if (f.onlyService && e.service !== f.onlyService) continue;
    if (f.excludeServices?.includes(e.service)) {
      excluded.push({ key: e.key, reason: `service ${e.service} excluded (--exclude-service)` });
      continue;
    }
    if (e.samples.length === 0) {
      const seen = catalog.failures.filter((x) => x.key === e.key).map((x) => (x.status === 0 ? "no response" : `HTTP ${x.status}`));
      excluded.push({ key: e.key, reason: `no successful sample during discovery${seen.length ? ` (${[...new Set(seen)].join(", ")})` : ""}` });
      continue;
    }
    if (!isReplayable(guard, e.method, e.samples[0]!.url)) {
      excluded.push({ key: e.key, reason: `${e.method} not in reviewed read-allowlist` });
      continue;
    }
    selected.push(e);
  }
  return { selected, excluded };
}

function samplesByToken(samples: Sample[], scope: TokenScope): Map<string, Sample[]> {
  const m = new Map<string, Sample[]>();
  for (const s of samples) {
    const key = tokenKeyFor(scope, s.user, s.companyId);
    const list = m.get(key) ?? [];
    list.push(s);
    m.set(key, list);
  }
  return new Map([...m.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * The request sequence for one endpoint: walk variants, and for each, one request per token (tokens innermost,
 * so each token gets an equal share). Samples rotate so every recorded sample is used.
 */
export function endpointSequence(e: CatalogEndpoint, baseOnly: boolean, scope: TokenScope = "user"): PlannedRequest[] {
  const byToken = samplesByToken(e.samples, scope);
  const variants = baseOnly ? [e.variants[0] ?? { label: "base", set: [] }] : e.variants.length ? e.variants : [{ label: "base", set: [] }];
  const maxSamples = Math.max(...[...byToken.values()].map((l) => l.length));
  const rounds = baseOnly ? maxSamples : Math.max(variants.length, maxSamples);
  const seq: PlannedRequest[] = [];
  for (let i = 0; i < rounds; i++) {
    const v = variants[i % variants.length]!;
    for (const [token, list] of byToken) {
      if (baseOnly && i >= list.length) continue;
      const sample = list[i % list.length]!;
      const { url, body } = applyVariant(sample, v);
      seq.push({
        tpl: e.key,
        variant: v.label,
        user: sample.user,
        token,
        method: e.method,
        url,
        body,
        headers: sample.headers,
        allowlisted: !READ.has(e.method),
      });
    }
  }
  return seq;
}

/** Interleaves endpoint sequences round-robin so every endpoint gets the same share of a service's rate. */
export function interleave(seqs: PlannedRequest[][], maxSlots = MAX_SLOTS_PER_SERVICE): PlannedRequest[] {
  if (seqs.length === 0) return [];
  const longest = Math.max(...seqs.map((s) => s.length));
  const rounds = Math.max(1, Math.min(longest, Math.floor(maxSlots / seqs.length)));
  const out: PlannedRequest[] = [];
  for (let j = 0; j < rounds; j++) for (const s of seqs) out.push(s[j % s.length]!);
  return out;
}

export function buildLoadPlan(
  catalog: Catalog,
  guard: CompiledGuard,
  services: ResolvedServices,
  safety: number,
  filters: PlanFilters = {},
  sessionsPerUser = 1
): LoadPlan {
  const { selected, excluded } = selectEndpoints(catalog, guard, filters);
  const byService = new Map<string, CatalogEndpoint[]>();
  for (const e of selected) {
    const list = byService.get(e.service) ?? [];
    list.push(e);
    byService.set(e.service, list);
  }
  const scope = catalog.tokenScope ?? "user";
  const plans: ServicePlan[] = [];
  for (const [name, endpoints] of [...byService.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const cfg = services.get(name);
    const users = [...new Set(endpoints.flatMap((e) => e.samples.map((s) => s.user)))].sort();
    const tokens = new Set(endpoints.flatMap((e) => e.samples.map((s) => tokenKeyFor(scope, s.user, s.companyId)))).size * Math.max(1, sessionsPerUser);
    const slots = filters.baseOnly
      ? endpoints.flatMap((e) => endpointSequence(e, true, scope))
      : interleave(endpoints.map((e) => endpointSequence(e, false, scope)));
    plans.push({
      name,
      endpoints: endpoints.map((e) => e.key),
      users,
      tokens,
      cap: serviceCap(cfg, tokens, safety),
      limitsVerified: cfg.limitsVerified,
      knownService: cfg.known,
      slots,
    });
  }
  return { totalEndpoints: selected.length, services: plans, excluded };
}

export interface ServiceRate {
  rate: number;
  wanted: number;
  capped: boolean;
  held: boolean;
}

/** Equal rate per endpoint; a service's rate is the sum over its endpoints, capped at its ceiling or held. */
export function stepRates(plan: LoadPlan, totalRps: number, held: Map<string, number>): Map<string, ServiceRate> {
  const perEndpoint = plan.totalEndpoints ? totalRps / plan.totalEndpoints : 0;
  const out = new Map<string, ServiceRate>();
  for (const s of plan.services) {
    const wanted = perEndpoint * s.endpoints.length;
    if (held.has(s.name)) {
      out.set(s.name, { rate: held.get(s.name)!, wanted, capped: false, held: true });
      continue;
    }
    const rate = Math.min(wanted, s.cap);
    out.set(s.name, { rate, wanted, capped: wanted > s.cap, held: false });
  }
  return out;
}

const MAX_JOURNEYS_PER_PAGE_AND_TOKEN = 3;

/**
 * Journeys for the users mode: for every reached page and every token that has samples on it, the page's replayable
 * endpoints with that token's samples (base variant). Up to 3 per page and token, rotating samples, so repeated visits
 * don't all ask for the same record.
 */
export function buildJourneys(catalog: Catalog, guard: CompiledGuard, filters: PlanFilters = {}): Journey[] {
  const { selected } = selectEndpoints(catalog, guard, filters);
  const byKey = new Map(selected.map((e) => [e.key, e]));
  const scope = catalog.tokenScope ?? "user";
  const out: Journey[] = [];
  for (const page of catalog.pages.filter((p) => p.reached && (!filters.onlyPage || p.id === filters.onlyPage))) {
    const endpoints = page.endpoints.map((k) => byKey.get(k)).filter((e): e is CatalogEndpoint => !!e);
    const tokens = [...new Set(endpoints.flatMap((e) => e.samples.map((s) => tokenKeyFor(scope, s.user, s.companyId))))].sort();
    for (const token of tokens) {
      const perEndpoint = endpoints
        .map((e) => ({ e, list: e.samples.filter((s) => tokenKeyFor(scope, s.user, s.companyId) === token) }))
        .filter((x) => x.list.length > 0);
      const rounds = Math.min(MAX_JOURNEYS_PER_PAGE_AND_TOKEN, Math.max(...perEndpoint.map((x) => x.list.length)));
      for (let i = 0; i < rounds; i++) {
        out.push({
          page: page.id,
          token,
          requests: perEndpoint.map(({ e, list }) => {
            const sample = list[i % list.length]!;
            const { url, body } = applyVariant(sample, e.variants[0] ?? { label: "base", set: [] });
            return { svc: e.service, tpl: e.key, variant: "base", user: sample.user, token, method: e.method, url, body, headers: sample.headers, allowlisted: !READ.has(e.method) };
          }),
        });
      }
    }
  }
  return out;
}

/**
 * Rough requests per second each service gets from `vus` virtual users that open a random page, wait for its calls
 * and think `thinkSec` (plus ~1s for the calls themselves) before the next one.
 */
export function estimateUserRates(journeys: Journey[], vus: number, thinkSec: number): Map<string, number> {
  const out = new Map<string, number>();
  if (journeys.length === 0) return out;
  const perJourney = new Map<string, number>();
  for (const j of journeys) for (const r of j.requests) perJourney.set(r.svc, (perJourney.get(r.svc) ?? 0) + 1);
  const pageViewsPerSec = vus / (thinkSec + 1);
  for (const [svc, calls] of perJourney) out.set(svc, (calls / journeys.length) * pageViewsPerSec);
  return out;
}
