import type { BreakReason } from "../analysis/evaluate.ts";
import type { RunResults, StepRecord } from "../run/results.ts";
import { esc, fmtCount, fmtMs, fmtNum, fmtPct, numTd, page, th } from "./html.ts";

/** Step targets are req/s, or virtual users in users mode. */
export function usersMode(r: Pick<RunResults, "meta">): boolean {
  return r.meta.mode === "users";
}

export function targetText(r: Pick<RunResults, "meta">, target: number): string {
  return usersMode(r) ? `${target} users` : `${target} req/s`;
}

/**
 * The first step where the load went up by half or more but the requests handled per second barely moved
 * (under 20% more): the app was already at its throughput ceiling and extra load only queued.
 */
export function throughputCeiling(r: Pick<RunResults, "steps">): { step: number; rps: number } | undefined {
  for (let i = 1; i < r.steps.length; i++) {
    const prev = r.steps[i - 1]!;
    const cur = r.steps[i]!;
    if (prev.overall.rps > 0 && cur.targetRps >= prev.targetRps * 1.5 && cur.overall.rps < prev.overall.rps * 1.2) {
      return { step: i, rps: Math.max(prev.overall.rps, cur.overall.rps) };
    }
  }
  return undefined;
}

/** The step the API list opens on: where the system broke, else the heaviest step run. */
export function focusStep(r: RunResults): StepRecord | undefined {
  return r.steps.find((s) => s.index === r.systemBreak?.step) ?? r.steps[r.steps.length - 1];
}

function breakRuleText(r: RunResults): string {
  const b = r.meta.breakRules;
  return `p95 over ${fmtMs(b.p95Ms)} or more than ${fmtPct(b.errorRate)} errors`;
}

/** Which break limits a step crossed: from the services that broke in it, else from the step's own numbers. */
export function stepProblems(r: RunResults, s: StepRecord): { slow: boolean; errors: boolean } {
  const reasons = s.services.flatMap((x) => x.broke ?? []);
  return {
    slow: reasons.includes("p95") || s.overall.p95 > r.meta.breakRules.p95Ms,
    errors: reasons.includes("error-rate") || s.overall.errorRate > r.meta.breakRules.errorRate,
  };
}

function problemText(p: { slow: boolean; errors: boolean }): string {
  return p.slow && p.errors ? "too slow and too many errors" : p.slow ? "too slow" : p.errors ? "too many errors" : "";
}

/**
 * e.g. "too slow: p95 32.3 s (limit 10.0 s); no calls failed". When only some services crossed a limit, names them
 * with their own figure: "too slow: fms/banking-apis p95 10.7 s (limit 10.0 s; all calls 4.91 s); no calls failed".
 */
export function brokeWhy(r: RunResults, s: StepRecord): string {
  const p = stepProblems(r, s);
  const b = r.meta.breakRules;
  const which = (reason: BreakReason) =>
    s.services
      .filter((x) => x.broke?.includes(reason))
      .slice(0, 3)
      .map((x) => `${x.name} ${reason === "p95" ? fmtMs(x.stats.p95) : fmtPct(x.stats.errorRate)}`)
      .join(", ");
  const slowOverall = s.overall.p95 > b.p95Ms;
  const errorsOverall = s.overall.errorRate > b.errorRate;
  const p95 = slowOverall || !which("p95")
    ? `p95 ${fmtMs(s.overall.p95)} (limit ${fmtMs(b.p95Ms)})`
    : `${which("p95")} p95 (limit ${fmtMs(b.p95Ms)}; all calls ${fmtMs(s.overall.p95)})`;
  const errors = errorsOverall || !which("error-rate")
    ? `${fmtPct(s.overall.errorRate)} errors (limit ${fmtPct(b.errorRate)})`
    : `${which("error-rate")} errors (limit ${fmtPct(b.errorRate)}; all calls ${fmtPct(s.overall.errorRate)})`;
  const detail = p.slow && p.errors ? `${p95}, ${errors}` : p.slow ? `${p95}${s.overall.errors === 0 ? "; no calls failed" : ""}` : errors;
  return `${problemText(p)}: ${detail}`;
}

function verdict(r: RunResults): string {
  const sb = r.systemBreak;
  const lines: string[] = [];
  const brokeIdx = sb ? r.steps.findIndex((s) => s.index === sb.step) : -1;
  if (!r.steps.length) {
    lines.push("No load step completed.");
  } else if (sb && brokeIdx === 0) {
    lines.push(`It broke at the first step, <strong>${esc(targetText(r, sb.targetRps))}</strong>, ${esc(brokeWhy(r, r.steps[0]!))}. Run lower steps to find the load it handles well.`);
  } else if (sb) {
    lines.push(`It handled <strong>${esc(targetText(r, r.steps[brokeIdx - 1]!.targetRps))}</strong> and broke at <strong>${esc(targetText(r, sb.targetRps))}</strong>, ${esc(brokeWhy(r, r.steps[brokeIdx]!))}.`);
  } else {
    lines.push(`No break: it handled every step up to <strong>${esc(targetText(r, r.steps[r.steps.length - 1]!.targetRps))}</strong>.`);
  }
  const ceiling = throughputCeiling(r);
  if (ceiling) {
    const a = r.steps[ceiling.step - 1]!;
    const b = r.steps[ceiling.step]!;
    lines.push(
      `Throughput stopped growing at about <strong>${fmtNum(ceiling.rps)} req/s</strong>: going from ${esc(targetText(r, a.targetRps))} to ${esc(targetText(r, b.targetRps))} only made responses slower (p95 ${fmtMs(a.overall.p95)} → ${fmtMs(b.overall.p95)}).`,
    );
  }
  const cpu = Math.max(0, ...r.steps.map((s) => s.runner.cpuMax));
  if (cpu >= 85) lines.push(`<span class="worse">The load machine's CPU reached ${cpu}%, so the machine may have limited the load, not the app.</span>`);
  return `<div class="card verdict">${lines.map((l) => `<p>${l}</p>`).join("")}</div>`;
}

function stepsTable(r: RunResults): string {
  const showThrottled = r.steps.some((s) => s.overall.throttled > 0);
  const rows = r.steps
    .map((s) => {
      const broke = s.services.filter((x) => x.broke).length;
      // Services that broke in an earlier step aren't flagged again, so the step's own numbers count too.
      const why = problemText(stepProblems(r, s));
      const what = why.charAt(0).toUpperCase() + why.slice(1);
      const result = s.emergency
        ? `<span class="worse">Emergency stop</span>`
        : broke
          ? `<span class="worse">✕ ${esc(what)}: ${broke} service(s) broke</span>`
          : why
            ? `<span class="worse">✕ ${esc(what)}</span>`
            : `<span class="better">✓ OK</span>`;
      return `<tr>
${numTd(s.targetRps, String(s.targetRps))}
${usersMode(r) ? numTd(visitsOf(s), visitsOf(s) === undefined ? "–" : fmtCount(visitsOf(s))) : ""}
${numTd(s.overall.n, fmtCount(s.overall.n))}
${numTd(s.overall.rps, fmtNum(s.overall.rps))}
${numTd(s.overall.p50, fmtMs(s.overall.p50))}
${numTd(s.overall.p95, fmtMs(s.overall.p95), s.overall.p95 > r.meta.breakRules.p95Ms ? "worse" : "")}
${numTd(s.overall.errorRate, fmtPct(s.overall.errorRate), s.overall.errorRate > r.meta.breakRules.errorRate ? "worse" : "")}
${showThrottled ? numTd(s.overall.throttled, fmtCount(s.overall.throttled), s.overall.throttled ? "worse" : "") : ""}
<td>${result}</td>
</tr>`;
    })
    .join("");
  const cpu = Math.max(0, ...r.steps.map((s) => s.runner.cpuMax));
  return `<div class="table-wrap"><table><thead><tr>
${th(usersMode(r) ? "Users" : "Target req/s", "num nosort")}${usersMode(r) ? th("Page visits", "num nosort") : ""}${th("Calls made", "num nosort")}${th("Req/s served", "num nosort")}${th("p50", "num nosort")}${th("p95", "num nosort")}${th("Errors", "num nosort")}${showThrottled ? th("Rate-limited (429)", "num nosort") : ""}${th("Result", "nosort")}
</tr></thead><tbody>${rows}</tbody></table></div>
<p class="muted">A service breaks when its p95 goes over ${fmtMs(r.meta.breakRules.p95Ms)} or more than ${fmtPct(r.meta.breakRules.errorRate)} of its calls fail, so a step can break with no errors at all. Each step ran ${r.meta.stepDurationSec}s. Errors = 5xx and calls with no response${r.meta.requestTimeoutSec ? ` (given up after ${r.meta.requestTimeoutSec}s)` : ""}; 4xx are not counted. Load machine CPU peaked at ${cpu}%.</p>`;
}

function visitsOf(s: StepRecord): number | undefined {
  return s.visits ? Object.values(s.visits).reduce((a, b) => a + b, 0) : undefined;
}

/** Pages that call the API with how often each was opened in the step; long lists are cut to keep rows short. */
function pagesCell(pages: string[], visits: Record<string, number> | undefined): string {
  if (!pages.length) return `<td class="muted">–</td>`;
  // Most-visited first, so the pages that produced the calls are the ones shown.
  const sorted = visits ? [...pages].sort((a, b) => (visits[b] ?? 0) - (visits[a] ?? 0)) : pages;
  const label = (p: string) => (visits ? `${esc(p)} <span class="muted">×${visits[p] ?? 0}</span>` : esc(p));
  const shown = sorted.slice(0, 3).map(label).join("<br>");
  const rest = sorted.slice(3);
  const more = rest.length ? `<br><span class="muted" title="${esc(rest.map((p) => (visits ? `${p} ×${visits[p] ?? 0}` : p)).join(", "))}">+${rest.length} more</span>` : "";
  return `<td class="mono">${shown}${more}</td>`;
}

function reasonText(r: RunResults, reason: string): string {
  return reason === "Timed out (no response)" && r.meta.requestTimeoutSec ? `Timed out (no response in ${r.meta.requestTimeoutSec}s)` : reason;
}

/** Why the calls failed, most common first. Old results without reasons fall back to the status classes. */
function failures(r: RunResults, e: StepRecord["endpoints"][number]): [string, number][] {
  if (e.failures) return Object.entries(e.failures).sort((a, b) => b[1] - a[1]).map(([k, n]) => [reasonText(r, k), n]);
  const out: [string, number][] = [];
  if (e.stats.errors) out.push(["5xx or timed out", e.stats.errors]);
  if (e.stats.clientErrors) out.push(["4xx", e.stats.clientErrors]);
  if (e.stats.throttled) out.push(["HTTP 429 (rate limited)", e.stats.throttled]);
  return out;
}

function apiTable(r: RunResults, selected: number): string {
  const groups = r.steps
    .map((s) => {
      const rows = [...s.endpoints]
        .sort((a, b) => b.stats.p95 - a.stats.p95)
        .map((e) => {
          const meta = r.endpointsMeta[e.key];
          const x = e.stats;
          const why = failures(r, e);
          const failed = why.reduce((a, [, n]) => a + n, 0);
          return `<tr>
<td class="mono wide">${esc(e.key)}<div class="muted">${esc(e.service)}</div></td>
${pagesCell(meta?.pages ?? [], s.visits)}
${numTd(x.n, fmtCount(x.n))}
${numTd(x.mean, fmtMs(x.mean))}
${numTd(x.p50, fmtMs(x.p50))}
${numTd(x.p95, fmtMs(x.p95), x.p95 > r.meta.breakRules.p95Ms ? "worse" : "")}
${numTd(x.max, fmtMs(x.max))}
${numTd(failed, failed ? `${fmtCount(failed)} <span class="muted">(${fmtPct(failed / (x.n || 1))})</span>` : "0", failed ? "worse" : "")}
<td>${why.map(([k, n]) => `${fmtCount(n)} × ${esc(k)}`).join("<br>")}</td>
</tr>`;
        })
        .join("");
      return `<tbody data-step-group="api" data-step="${s.index}" ${s.index === selected ? "" : "hidden"}>${rows}</tbody>`;
    })
    .join("");
  const totals = r.steps
    .map((s) => {
      const v = visitsOf(s);
      const opened = v !== undefined ? `${v.toLocaleString("en-US")} page visits${s.visitsEstimated ? " (estimated)" : ""}, ` : "";
      return `<p class="sub" data-step-group="api" data-step="${s.index}" ${s.index === selected ? "" : "hidden"}>${opened}${s.endpoints.length} APIs, ${fmtCount(s.overall.n)} calls in ${r.meta.stepDurationSec}s (${fmtNum(s.overall.rps)} per second).</p>`;
    })
    .join("");
  const select =
    r.steps.length > 1
      ? `<div class="controls"><label>Show step <select data-step-target="api">${r.steps
          .map((s) => `<option value="${s.index}"${s.index === selected ? " selected" : ""}>${esc(targetText(r, s.targetRps))}${r.systemBreak?.step === s.index ? " (broke here)" : ""}</option>`)
          .join("")}</select></label></div>`
      : "";
  const visitsNote = usersMode(r)
    ? " Calls = how often users opened the pages that use the API (×N next to each page) times the calls per visit, so an API on every page is called far more than one on a single page."
    : "";
  return `${select}${totals}
<div class="table-wrap"><table class="sortable"><thead><tr>
${th("API (service)")}${th("Used on page")}${th("Calls", "num")}${th("Avg", "num")}${th("p50", "num")}${th("p95", "num")}${th("Max", "num")}${th("Failed", "num")}${th("Why it failed", "nosort")}
</tr></thead>${groups}</table></div>
<p class="muted">Sorted slowest first (p95); click a column to sort by it. Avg, p50, p95 and max include timed-out calls at the time they waited.${visitsNote}</p>`;
}

function setupBlock(r: RunResults): string {
  const m = r.meta;
  const items: [string, string][] = [
    ["Environment", `${m.env} — ${m.webBaseUrl} (${m.app ?? "retailer"} app)`],
    ["Started / ended (UTC)", `${m.startedAt.slice(0, 19).replace("T", " ")} → ${m.endedAt.slice(0, 19).replace("T", " ")}`],
    [
      "Steps",
      m.mode === "users"
        ? `${m.stepsPlanned.join(", ")} users × ${m.stepDurationSec}s, ${m.thinkTimeSec ?? "?"}s think time between pages, ${m.sessionsPerUser ?? 1} login(s) per account`
        : `${m.stepsPlanned.join(", ")} req/s × ${m.stepDurationSec}s`,
    ],
    ["Accounts / browsers", `${m.users} / ${m.browsers}`],
    ["Break rule", `${breakRuleText(r)} (min ${m.breakRules.minRequests} requests)`],
    ["Services left out", m.filters.excludeServices?.length ? m.filters.excludeServices.join(", ") : "none"],
    ["Load machine", `${m.runner.host} · ${m.runner.cpus} CPUs · ${m.runner.memGb} GB`],
    ["Run ended", m.endReason],
  ];
  const excluded = r.plan.excluded.length
    ? `<h3>APIs not loaded (${r.plan.excluded.length})</h3><table><tbody>${r.plan.excluded.map((e) => `<tr><td class="mono">${esc(e.key)}</td><td class="muted">${esc(e.reason)}</td></tr>`).join("")}</tbody></table>`
    : "";
  const notes = r.warnings.length ? `<h3>Notes</h3><ul class="warn">${r.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : "";
  return `<details class="card"><summary>Run setup, APIs not loaded, notes</summary>
<table><tbody>${items.map(([k, v]) => `<tr><td class="muted">${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</tbody></table>
${excluded}${notes}</details>`;
}

export function renderRunReport(r: RunResults): string {
  const title = `Load test — ${r.meta.env}${r.meta.label ? " — " + r.meta.label : ""}`;
  const focus = focusStep(r);
  const body = `
<h1>${esc(title)}</h1>
<p class="sub">${esc(r.meta.webBaseUrl)} · ${esc(r.meta.startedAt.slice(0, 16).replace("T", " "))} UTC · read-only load</p>
${verdict(r)}
<h2>Load steps</h2>
${stepsTable(r)}
<h2>API calls</h2>
${focus ? apiTable(r, focus.index) : `<p class="muted">No step completed.</p>`}
<h2>Details</h2>
${setupBlock(r)}
<footer>dxp-loadtest · results.json in this folder has every number, including per-page browser timings and parameter variants.</footer>`;
  return page(title, body);
}
