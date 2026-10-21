import type { Catalog } from "../catalog/types.ts";
import { fmtRate } from "../util.ts";
import type { RunResults } from "./results.ts";

/** Everything that could make the numbers misleading, most important first. */
export function buildWarnings(r: RunResults, catalog: Catalog): string[] {
  const w: string[] = [];
  if (["emergency", "interrupted", "k6 produced", "failed"].some((p) => r.meta.endReason.startsWith(p))) {
    w.push(`Run ended early: ${r.meta.endReason}.`);
  }

  const throttled = new Map<string, { n: number; sources: Record<string, number>; maxRps: number }>();
  for (const s of r.steps) {
    for (const svc of s.services) {
      const total = Object.values(svc.throttled).reduce((a, b) => a + b, 0) || svc.stats.throttled;
      if (!total) continue;
      const t = throttled.get(svc.name) ?? { n: 0, sources: {}, maxRps: 0 };
      t.n += total;
      for (const [k, v] of Object.entries(svc.throttled)) t.sources[k] = (t.sources[k] ?? 0) + v;
      t.maxRps = Math.max(t.maxRps, svc.plannedRps);
      throttled.set(svc.name, t);
    }
  }
  for (const [name, t] of throttled) {
    const src = Object.entries(t.sources).map(([k, v]) => `${k}: ${v}`).join(", ");
    w.push(`${name}: ${t.n} requests got 429 at up to ${fmtRate(t.maxRps)} req/s (${src || "source unknown"}). Its limit in config/services.json (limit, key or pods) is probably wrong, or a gateway limit applies. 429s are excluded from latency and error rate.`);
  }

  const refused = r.steps.reduce((a, s) => a + s.refused, 0);
  if (refused) w.push(`k6 refused ${refused} non-read requests (the planner should never produce these; check config/read-allowlist.json).`);

  const blocked = r.steps.reduce((a, s) => a + s.blockedWrites, 0);
  if (blocked) w.push(`The read-only guard blocked ${blocked} write requests from the browser layer. Some pages may have behaved differently than for a real user.`);

  for (const s of r.steps) {
    for (const svc of s.services) {
      if (svc.dropped > 0) {
        w.push(`Step ${s.index + 1}, ${svc.name}: k6 dropped ${svc.dropped} iterations (all VUs busy waiting on slow responses), so the achieved rate was below plan.`);
      }
    }
    if (s.runner.cpuMax >= 85) {
      w.push(`Step ${s.index + 1}: runner CPU peaked at ${s.runner.cpuMax}%. Latency in this step may partly be the load generator; use fewer browsers or a bigger machine.`);
    }
    const authErrors = s.services.reduce((a, svc) => a + svc.stats.clientErrors, 0);
    if (authErrors > 0 && authErrors / Math.max(1, s.overall.n) > 0.05) {
      w.push(`Step ${s.index + 1}: ${authErrors} 4xx responses (other than 429). Check for expired tokens (401) or ids not valid for the user (403/404).`);
    }
  }

  const unknown = r.plan.services.filter((s) => !s.knownService);
  if (unknown.length) {
    w.push(`No rate-limit config for: ${unknown.map((s) => s.name).join(", ")}. A conservative default was used; add them to config/services.json.`);
  }
  const unverified = r.plan.services.filter((s) => s.knownService && !s.limitsVerified);
  if (unverified.length) w.push(`Rate limits not verified from appsettings for: ${unverified.map((s) => s.name).join(", ")}.`);
  const unmapped = r.plan.services.filter((s) => s.name.startsWith("unknown:"));
  if (unmapped.length) {
    w.push(`Endpoints not found in the gateway config (grouped as ${unmapped.map((s) => s.name).join(", ")}). Their backend service is unknown.`);
  }
  if (r.plan.excluded.length) w.push(`${r.plan.excluded.length} discovered endpoints were not loaded (no successful sample, or a write not in the reviewed allowlist).`);

  const notReached = catalog.pages.filter((p) => !p.reached);
  if (notReached.length) w.push(`Pages not reached during discovery (not measured): ${notReached.map((p) => p.id).join(", ")}.`);
  const noInteractions = catalog.pages.filter((p) => p.reached && p.interactions.length <= 1);
  if (noInteractions.length) w.push(`Pages measured on default view only (no interaction coverage): ${noInteractions.map((p) => p.id).join(", ")}.`);
  if (catalog.blocked.length) w.push(`During discovery the guard blocked ${catalog.blocked.length} distinct write requests; see catalogs/${catalog.env}/catalog.json "blocked" for allowlist suggestions.`);
  return w;
}
