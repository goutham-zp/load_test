import type { RunResults, StepRecord } from "../run/results.ts";
import { fmtRate } from "../util.ts";
import { badge, esc, fmtMs, fmtNum, fmtPct, lineChart, numTd, page, sparkline, th } from "./html.ts";

/** Step targets are req/s, or virtual users in users mode. */
export function usersMode(r: Pick<RunResults, "meta">): boolean {
  return r.meta.mode === "users";
}

export function targetText(r: Pick<RunResults, "meta">, target: number): string {
  return usersMode(r) ? `${target} users` : `${target} req/s`;
}

export function stepLabel(s: Pick<StepRecord, "index" | "targetRps">, users = false): string {
  return users ? `S${s.index + 1} · ${s.targetRps} users` : `S${s.index + 1} · ${s.targetRps}/s`;
}

/** The step tables open on: the last healthy step before the system broke, else the last step. */
export function defaultStep(r: RunResults): number {
  if (!r.steps.length) return 0;
  if (r.systemBreak) return Math.max(0, r.systemBreak.step - 1);
  return r.steps[r.steps.length - 1]!.index;
}

function stepSelect(r: RunResults, group: string, selected: number): string {
  const opts = r.steps
    .map((s) => `<option value="${s.index}"${s.index === selected ? " selected" : ""}>Step ${s.index + 1} — ${usersMode(r) ? `${s.targetRps} virtual users` : `target ${s.targetRps} req/s`}${r.systemBreak?.step === s.index ? " (system broke)" : ""}</option>`)
    .join("");
  return `<label>Load step <select data-step-target="${group}">${opts}</select></label>`;
}

function endLabel(reason: string): string {
  if (reason.startsWith("emergency")) return "Emergency stop";
  if (reason.startsWith("interrupted")) return "Interrupted";
  if (reason.startsWith("k6 produced") || reason.startsWith("failed")) return "Failed";
  if (reason.startsWith("stopped at first break")) return "At first break";
  if (reason.startsWith("every service")) return "Ceilings reached";
  if (reason.startsWith("no service left")) return "Nothing left to load";
  return "Completed";
}

function headline(r: RunResults): string {
  const peak = r.steps.reduce((m, s) => Math.max(m, s.overall.rps), 0);
  const broken = r.services.filter((s) => s.status === "broken").length;
  const capped = r.services.filter((s) => s.status === "capped").length;
  const sb = r.systemBreak;
  const tiles = [
    {
      label: "System breaking point",
      value: sb ? `Step ${sb.step + 1} · ${targetText(r, sb.targetRps)}` : "Not reached",
      note: sb ? `First to break: ${sb.services.join(", ")}` : "No service broke within the steps run",
    },
    { label: "Services broke / at ceiling", value: `${broken} / ${capped}`, note: `of ${r.services.length} services loaded` },
    { label: "Peak achieved rate", value: `${fmtNum(peak)} req/s`, note: `${r.steps.length} of ${r.meta.stepsPlanned.length} steps run` },
    { label: "Run ended", value: endLabel(r.meta.endReason), note: r.meta.endReason },
  ];
  return `<div class="tiles">${tiles
    .map((t) => `<div class="card tile"><div class="label">${esc(t.label)}</div><div class="value">${esc(t.value)}</div><div class="note">${esc(t.note)}</div></div>`)
    .join("")}</div>`;
}

function charts(r: RunResults): string {
  const labels = r.steps.map((s) => stepLabel(s, usersMode(r)));
  const markers = r.systemBreak ? [{ index: r.steps.findIndex((s) => s.index === r.systemBreak!.step), label: "system broke" }] : [];
  return `<div class="charts">
${lineChart({
  title: "p95 latency per step (all API requests)",
  labels,
  series: [{ name: "p95", color: "--series-1", values: r.steps.map((s) => s.overall.p95), fmt: fmtMs }],
  yFmt: fmtMs,
  markers,
})}
${lineChart({
  title: "Error rate per step (5xx, timeouts; 429 excluded)",
  labels,
  series: [{ name: "error rate", color: "--series-1", values: r.steps.map((s) => s.overall.errorRate), fmt: fmtPct }],
  yFmt: fmtPct,
  markers,
})}
${lineChart({
  title: "Planned vs achieved request rate",
  labels,
  series: [
    { name: "planned req/s", color: "--series-1", values: r.steps.map((s) => s.services.reduce((a, x) => a + x.plannedRps, 0)), fmt: (v) => `${fmtNum(v)} req/s` },
    { name: "achieved req/s", color: "--series-2", values: r.steps.map((s) => s.overall.rps), fmt: (v) => `${fmtNum(v)} req/s` },
  ],
  yFmt: (v) => fmtNum(v),
})}
</div>`;
}

function servicesTable(r: RunResults): string {
  const labels = r.steps.map((s) => stepLabel(s, usersMode(r)));
  const rows = r.plan.services
    .map((svc) => {
      const st = r.services.find((s) => s.name === svc.name);
      const per = r.steps.map((s) => s.services.find((x) => x.name === svc.name));
      const p95s = per.map((x) => (x && x.stats.n ? x.stats.p95 : null));
      const errs = per.map((x) => (x && x.stats.n ? x.stats.errorRate : null));
      const breakPos = st?.brokeAtStep !== undefined ? r.steps.findIndex((s) => s.index === st.brokeAtStep) : undefined;
      const throttled = per.reduce((a, x) => a + (x?.stats.throttled ?? 0), 0);
      const totalN = per.reduce((a, x) => a + (x?.stats.n ?? 0), 0);
      let status = badge("healthy");
      let order = 2;
      if (st?.status === "broken") {
        status = badge("broken", `Broke at step ${st.brokeAtStep! + 1} (${(st.reasons ?? []).join(", ")})`);
        order = 0;
      } else if (st?.status === "capped") {
        status = badge("capped", "At ceiling, no break");
        order = 1;
      } else if (st?.lastHealthyRate === undefined) {
        status = badge("insufficient");
        order = 3;
      }
      return `<tr>
<td class="mono wide">${esc(svc.name)}${svc.repoPath ? `<div class="muted">${esc(svc.repoPath)}</div>` : ""}</td>
<td data-v="${order}">${status}</td>
${numTd(st?.brokeAtRate, st?.brokeAtRate !== undefined ? fmtRate(st.brokeAtRate) : "–")}
${numTd(st?.lastHealthyRate, st?.lastHealthyRate !== undefined ? fmtRate(st.lastHealthyRate) : "–")}
${numTd(svc.cap ?? Infinity, svc.cap === null ? "unlimited" : fmtRate(svc.cap) + (svc.limitsVerified ? "" : " *"))}
${numTd(svc.endpoints, String(svc.endpoints))}
${numTd(totalN, fmtNum(totalN))}
${numTd(throttled, fmtNum(throttled), throttled ? "worse" : "")}
<td class="nosort">${sparkline(p95s, fmtMs, labels, breakPos)}</td>
<td class="nosort">${sparkline(errs, fmtPct, labels, breakPos)}</td>
</tr>`;
    })
    .join("");
  return `<div class="table-wrap"><table class="sortable"><thead><tr>
${th("Service")}${th("Status")}${th("Broke at (req/s)", "num")}${th("Last healthy (req/s)", "num")}${th("Ceiling (req/s)", "num")}${th("Endpoints", "num")}${th("Requests", "num")}${th("429s", "num")}${th("p95 by step", "nosort")}${th("Errors by step", "nosort")}
</tr></thead><tbody>${rows}</tbody></table></div>
<p class="muted">Ceiling = rate limit × users (per-token limits) × pods × safety factor ${r.meta.safetyFactor}. * = limit not verified from appsettings.</p>`;
}

function endpointsTable(r: RunResults, selected: number): string {
  const bodies = r.steps
    .map((s) => {
      const rows = [...s.endpoints]
        .sort((a, b) => b.stats.p95 - a.stats.p95)
        .map((e) => {
          const meta = r.endpointsMeta[e.key];
          const variants = s.variants.filter((v) => v.key === e.key && v.variant !== "base").sort((a, b) => b.stats.p95 - a.stats.p95);
          const base = s.variants.find((v) => v.key === e.key && v.variant === "base");
          const variantBlock = variants.length
            ? `<details><summary>${variants.length} parameter variants (slowest: ${esc(variants[0]!.variant)} ${fmtMs(variants[0]!.stats.p95)})</summary><table><thead><tr><th class="nosort">Variant</th><th class="num nosort">n</th><th class="num nosort">p50</th><th class="num nosort">p95</th><th class="num nosort">Errors</th></tr></thead><tbody>${[
                ...(base ? [base] : []),
                ...variants,
              ]
                .map((v) => `<tr><td class="mono">${esc(v.variant)}</td><td class="num">${v.stats.n}</td><td class="num">${fmtMs(v.stats.p50)}</td><td class="num">${fmtMs(v.stats.p95)}</td><td class="num">${fmtPct(v.stats.errorRate)}</td></tr>`)
                .join("")}</tbody></table></details>`
            : "";
          return `<tr>
<td class="mono wide">${esc(e.key)}${meta?.servicePath ? `<div class="muted">→ ${esc(meta.servicePath)}</div>` : ""}${variantBlock}</td>
<td class="mono">${esc(e.service)}</td>
<td>${esc((meta?.pages ?? []).join(", "))}</td>
${numTd(e.stats.n, String(e.stats.n))}
${numTd(e.stats.p50, fmtMs(e.stats.p50))}
${numTd(e.stats.p95, fmtMs(e.stats.p95))}
${numTd(e.stats.p99, fmtMs(e.stats.p99))}
${numTd(e.stats.errorRate, fmtPct(e.stats.errorRate), e.stats.errorRate > r.meta.breakRules.errorRate ? "worse" : "")}
${numTd(e.stats.throttled, String(e.stats.throttled))}
${numTd(e.stats.clientErrors, String(e.stats.clientErrors))}
</tr>`;
        })
        .join("");
      return `<tbody data-step-group="endpoints" data-step="${s.index}" data-filter-group="endpoints" ${s.index === selected ? "" : "hidden"}>${rows}</tbody>`;
    })
    .join("");
  return `<div class="controls">${stepSelect(r, "endpoints", selected)}<input type="search" placeholder="Filter endpoints" aria-label="Filter endpoints" data-filter-target="endpoints"></div>
<div class="table-wrap"><table class="sortable"><thead><tr>
${th("Endpoint (gateway → service path)")}${th("Service")}${th("Pages")}${th("n", "num")}${th("p50", "num")}${th("p95", "num")}${th("p99", "num")}${th("Errors", "num")}${th("429", "num")}${th("4xx", "num")}
</tr></thead>${bodies}</table></div>`;
}

function pagesTable(r: RunResults, selected: number): string {
  const any = r.steps.some((s) => s.pages.length);
  if (!any) return `<p class="muted">No browser measurements (browsers = ${r.meta.browsers}).</p>`;
  const bodies = r.steps
    .map((s) => {
      const rows = s.pages
        .map((p) => `<tr>
<td>${esc(p.page)}</td>
<td class="mono">${esc(p.interaction)}</td>
${numTd(p.n, String(p.n))}
${numTd(p.p50, fmtMs(p.p50))}
${numTd(p.p95, fmtMs(p.p95))}
${numTd(p.max, fmtMs(p.max))}
${numTd(p.lcpP95, fmtMs(p.lcpP95))}
${numTd(p.timeouts, String(p.timeouts), p.timeouts ? "worse" : "")}
<td class="mono">${p.topEndpoints.slice(0, 3).map((t) => `${esc(t.key)} <span class="muted">${fmtMs(t.p95)}</span>`).join("<br>")}</td>
</tr>`)
        .join("");
      return `<tbody data-step-group="pages" data-step="${s.index}" ${s.index === selected ? "" : "hidden"}>${rows || `<tr><td colspan="9" class="muted">No complete visits in this step.</td></tr>`}</tbody>`;
    })
    .join("");
  return `<div class="controls">${stepSelect(r, "pages", selected)}</div>
<div class="table-wrap"><table class="sortable"><thead><tr>
${th("Page")}${th("Interaction")}${th("Visits", "num")}${th("Ready p50", "num")}${th("Ready p95", "num")}${th("Max", "num")}${th("LCP p95", "num")}${th("Timeouts", "num")}${th("Slowest API calls (p95)", "nosort")}
</tr></thead>${bodies}</table></div>
<p class="muted">Ready = no API call in flight and no loading indicator for ${esc("500 ms")}; measured from navigation or click.</p>`;
}

function stepsTable(r: RunResults): string {
  const rows = r.steps
    .map((s) => `<tr>
<td>${s.index + 1}</td>
${numTd(s.targetRps, String(s.targetRps))}
${numTd(s.overall.rps, fmtNum(s.overall.rps))}
${numTd(s.overall.n, fmtNum(s.overall.n))}
${numTd(s.overall.p50, fmtMs(s.overall.p50))}
${numTd(s.overall.p95, fmtMs(s.overall.p95))}
${numTd(s.overall.errorRate, fmtPct(s.overall.errorRate))}
${numTd(s.overall.throttled, String(s.overall.throttled))}
${numTd(s.runner.cpuMax, `${s.runner.cpuMax}%`, s.runner.cpuMax >= 85 ? "worse" : "")}
<td>${esc(s.services.filter((x) => x.broke).map((x) => x.name).join(", ") || "")}${s.emergency ? ` <strong>Emergency: ${esc(s.emergency)}</strong>` : ""}</td>
</tr>`)
    .join("");
  return `<div class="table-wrap"><table class="sortable"><thead><tr>
${th("Step")}${th(usersMode(r) ? "Virtual users" : "Target req/s", "num")}${th("Achieved req/s", "num")}${th("Requests", "num")}${th("p50", "num")}${th("p95", "num")}${th("Errors", "num")}${th("429", "num")}${th("Runner CPU max", "num")}${th("Broke in this step")}
</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function metaBlock(r: RunResults): string {
  const m = r.meta;
  const items: [string, string][] = [
    ["Environment", `${m.env} (${m.envKind}) — ${m.webBaseUrl}`],
    ["Started / ended", `${m.startedAt} → ${m.endedAt}`],
    ["Runner", `${m.runner.host} · ${m.runner.platform} · ${m.runner.cpus} CPUs · ${m.runner.memGb} GB`],
    ["Versions", `node ${m.versions.node} · ${m.versions.k6} · playwright ${m.versions.playwright}`],
    [
      "Steps",
      m.mode === "users"
        ? `${m.stepsPlanned.join(", ")} virtual users × ${m.stepDurationSec}s, ${m.thinkTimeSec ?? "?"}s think time between pages`
        : `${m.stepsPlanned.join(", ")} req/s × ${m.stepDurationSec}s`,
    ],
    ["Sessions per user", String(m.sessionsPerUser ?? 1)],
    ["Break rule", `error rate > ${fmtPct(m.breakRules.errorRate)} or p95 > ${fmtMs(m.breakRules.p95Ms)} (min ${m.breakRules.minRequests} requests)`],
    ["App", m.app ?? "retailer"],
    ["Users / browsers", `${m.users} / ${m.browsers}`],
    ["Filters", Object.entries(m.filters).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(", ") || "none"],
    ["Catalog", `${m.catalogCreatedAt} · ${m.catalogSignature.length} endpoints`],
  ];
  return `<div class="table-wrap"><table><tbody>${items.map(([k, v]) => `<tr><td class="muted">${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</tbody></table></div>`;
}

function excludedBlock(r: RunResults): string {
  if (!r.plan.excluded.length) return "";
  return `<details><summary>${r.plan.excluded.length} endpoints not loaded</summary><div class="table-wrap"><table><tbody>${r.plan.excluded
    .map((e) => `<tr><td class="mono">${esc(e.key)}</td><td>${esc(e.reason)}</td></tr>`)
    .join("")}</tbody></table></div></details>`;
}

export function renderRunReport(r: RunResults): string {
  const selected = defaultStep(r);
  const title = `Load test — ${r.meta.env}${r.meta.label ? " — " + r.meta.label : ""}`;
  const body = `
<h1>${esc(title)}</h1>
<p class="sub">${esc(r.meta.envKind)} deployment · ${esc(r.meta.startedAt.slice(0, 16).replace("T", " "))} UTC · read-only load on the ${esc(r.meta.app ?? "retailer")} app</p>
${headline(r)}
${r.warnings.length ? `<h2>Warnings</h2><div class="card"><ul class="warn">${r.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>` : ""}
<h2>Latency and errors by load step</h2>
${charts(r)}
<h2>Services</h2>
${servicesTable(r)}
<h2>Slowest endpoints</h2>
<p class="sub">Sorted by p95 for the chosen step. Expand a row to see paging/sort/filter/search variants.</p>
${endpointsTable(r, selected)}
${excludedBlock(r)}
<h2>Slowest pages (real browser, under load)</h2>
${pagesTable(r, selected)}
<h2>Steps</h2>
${stepsTable(r)}
<h2>Run details</h2>
${metaBlock(r)}
<footer>dxp-loadtest · results.json in this folder holds every number shown here.</footer>`;
  return page(title, body);
}
