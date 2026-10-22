import type { Stats } from "../analysis/stats.ts";
import type { RunResults, StepRecord } from "../run/results.ts";
import { fmtRate } from "../util.ts";
import { badge, esc, fmtMs, fmtNum, fmtPct, lineChart, numTd, page, th } from "./html.ts";

export interface CommonStep {
  a: number;
  b: number;
  targetRps: number;
}

export interface DeltaRow {
  key: string;
  service: string;
  a?: Stats;
  b?: Stats;
  deltaMs?: number;
  deltaPct?: number;
  variants: { variant: string; a?: Stats; b?: Stats; deltaMs?: number; deltaPct?: number }[];
}

export interface PageDeltaRow {
  page: string;
  interaction: string;
  aP95?: number;
  bP95?: number;
  deltaMs?: number;
  deltaPct?: number;
}

export interface Comparison {
  commonSteps: CommonStep[];
  defaultStep: number;
  mismatches: string[];
  endpoints: Map<number, DeltaRow[]>;
  pages: Map<number, PageDeltaRow[]>;
  onlyInA: string[];
  onlyInB: string[];
}

/** Steps are compared when both runs targeted the same total rate. */
export function matchSteps(a: RunResults, b: RunResults): CommonStep[] {
  const out: CommonStep[] = [];
  const usedB = new Set<number>();
  for (const sa of a.steps) {
    const sb = b.steps.find((s) => s.targetRps === sa.targetRps && !usedB.has(s.index));
    if (!sb) continue;
    usedB.add(sb.index);
    out.push({ a: sa.index, b: sb.index, targetRps: sa.targetRps });
  }
  return out;
}

export function delta(a: number | undefined, b: number | undefined): { deltaMs?: number; deltaPct?: number } {
  if (a === undefined || b === undefined) return {};
  return { deltaMs: b - a, deltaPct: a > 0 ? (b - a) / a : b > 0 ? Infinity : 0 };
}

function mismatches(a: RunResults, b: RunResults): string[] {
  const out: string[] = [];
  const appA = a.meta.app ?? "retailer";
  const appB = b.meta.app ?? "retailer";
  if (appA !== appB) out.push(`Different apps (A ${appA}, B ${appB}): the runs load different request sets, so they are not a deployment comparison.`);
  const sa = new Set(a.meta.catalogSignature);
  const sb = new Set(b.meta.catalogSignature);
  const onlyA = [...sa].filter((k) => !sb.has(k));
  const onlyB = [...sb].filter((k) => !sa.has(k));
  if (onlyA.length || onlyB.length) out.push(`Different endpoint sets: ${onlyA.length} only in A, ${onlyB.length} only in B. Totals are not like-for-like; compare per endpoint.`);
  if ((a.meta.mode ?? "rate") !== (b.meta.mode ?? "rate")) {
    out.push(`Different load modes (A ${a.meta.mode ?? "rate"}, B ${b.meta.mode ?? "rate"}): steps are virtual users in one and req/s in the other, so step-by-step numbers are not comparable.`);
  } else if (a.meta.mode === "users" && a.meta.thinkTimeSec !== b.meta.thinkTimeSec) {
    out.push(`Different think times (A ${a.meta.thinkTimeSec}s, B ${b.meta.thinkTimeSec}s): the same user count sends different request rates.`);
  }
  if (a.meta.stepsPlanned.join() !== b.meta.stepsPlanned.join()) out.push(`Different step plans (A: ${a.meta.stepsPlanned.join(", ")}; B: ${b.meta.stepsPlanned.join(", ")}). Only matching target rates are compared.`);
  if (a.meta.stepDurationSec !== b.meta.stepDurationSec) out.push(`Different step durations (A ${a.meta.stepDurationSec}s, B ${b.meta.stepDurationSec}s).`);
  if (a.meta.runner.host !== b.meta.runner.host) out.push(`Different runners (A ${a.meta.runner.host}, B ${b.meta.runner.host}): network distance differs, so latency differences may be partly the network.`);
  if (a.meta.browsers !== b.meta.browsers) out.push(`Different browser counts (A ${a.meta.browsers}, B ${b.meta.browsers}).`);
  if (a.meta.users !== b.meta.users) out.push(`Different user counts (A ${a.meta.users}, B ${b.meta.users}): rate-limit ceilings differ.`);
  if (JSON.stringify(a.meta.filters) !== JSON.stringify(b.meta.filters)) out.push("Different filters (only-page/endpoint/service).");
  if (JSON.stringify(a.meta.breakRules) !== JSON.stringify(b.meta.breakRules)) out.push("Different break rules.");
  return out;
}

function endpointRows(sa: StepRecord, sb: StepRecord): DeltaRow[] {
  const keys = new Set([...sa.endpoints.map((e) => e.key), ...sb.endpoints.map((e) => e.key)]);
  const rows: DeltaRow[] = [];
  for (const key of keys) {
    const ea = sa.endpoints.find((e) => e.key === key);
    const eb = sb.endpoints.find((e) => e.key === key);
    const variantNames = new Set([...sa.variants, ...sb.variants].filter((v) => v.key === key).map((v) => v.variant));
    const variants = [...variantNames].map((variant) => {
      const va = sa.variants.find((v) => v.key === key && v.variant === variant)?.stats;
      const vb = sb.variants.find((v) => v.key === key && v.variant === variant)?.stats;
      return { variant, a: va, b: vb, ...delta(va?.p95, vb?.p95) };
    });
    rows.push({ key, service: (ea ?? eb)!.service, a: ea?.stats, b: eb?.stats, ...delta(ea?.stats.p95, eb?.stats.p95), variants });
  }
  // Regressions first: biggest relative slowdown in B, rows missing on one side last.
  return rows.sort((x, y) => (y.deltaPct ?? -Infinity) - (x.deltaPct ?? -Infinity));
}

function pageRows(sa: StepRecord, sb: StepRecord): PageDeltaRow[] {
  const keys = new Set([...sa.pages, ...sb.pages].map((p) => `${p.page}\u0000${p.interaction}`));
  return [...keys]
    .map((k) => {
      const [pg, interaction] = k.split("\u0000") as [string, string];
      const pa = sa.pages.find((p) => p.page === pg && p.interaction === interaction);
      const pb = sb.pages.find((p) => p.page === pg && p.interaction === interaction);
      return { page: pg, interaction, aP95: pa?.p95, bP95: pb?.p95, ...delta(pa?.p95, pb?.p95) };
    })
    .sort((x, y) => (y.deltaPct ?? -Infinity) - (x.deltaPct ?? -Infinity));
}

export function computeComparison(a: RunResults, b: RunResults): Comparison {
  const commonSteps = matchSteps(a, b);
  const endpoints = new Map<number, DeltaRow[]>();
  const pages = new Map<number, PageDeltaRow[]>();
  commonSteps.forEach((c, i) => {
    const sa = a.steps.find((s) => s.index === c.a)!;
    const sb = b.steps.find((s) => s.index === c.b)!;
    endpoints.set(i, endpointRows(sa, sb));
    pages.set(i, pageRows(sa, sb));
  });
  // Default: the highest common step where neither run had broken yet.
  const limitA = a.systemBreak?.step ?? Infinity;
  const limitB = b.systemBreak?.step ?? Infinity;
  let defaultStep = 0;
  commonSteps.forEach((c, i) => {
    if (c.a < limitA && c.b < limitB) defaultStep = i;
  });
  const sa = new Set(a.meta.catalogSignature);
  const sb = new Set(b.meta.catalogSignature);
  return {
    commonSteps,
    defaultStep,
    mismatches: mismatches(a, b),
    endpoints,
    pages,
    onlyInA: [...sa].filter((k) => !sb.has(k)),
    onlyInB: [...sb].filter((k) => !sa.has(k)),
  };
}

function deltaCell(d: { deltaMs?: number; deltaPct?: number }): string {
  if (d.deltaMs === undefined) return `<td class="num" data-v="">–</td><td class="num" data-v="">–</td>`;
  // Small absolute changes are noise; only colour meaningful ones.
  const meaningful = Math.abs(d.deltaMs) >= 50 && Math.abs(d.deltaPct ?? 0) >= 0.2;
  const cls = meaningful ? (d.deltaMs > 0 ? "worse" : "better") : "";
  const pct = d.deltaPct === Infinity ? "new" : `${d.deltaPct! > 0 ? "+" : ""}${((d.deltaPct ?? 0) * 100).toFixed(0)}%`;
  return `${numTd(d.deltaMs, `${d.deltaMs > 0 ? "+" : d.deltaMs < 0 ? "−" : ""}${fmtMs(Math.abs(d.deltaMs))}`, cls)}${numTd(d.deltaPct === Infinity ? 1e9 : d.deltaPct, pct, cls)}`;
}

function runName(r: RunResults): string {
  return `${r.meta.env}${r.meta.label ? " · " + r.meta.label : ""} · ${r.meta.startedAt.slice(0, 16).replace("T", " ")}`;
}

function serviceStatus(r: RunResults, name: string): string {
  const st = r.services.find((s) => s.name === name);
  if (!st) return `<span class="muted">not loaded</span>`;
  if (st.status === "broken") return badge("broken", `Broke at ${fmtRate(st.brokeAtRate ?? 0)} req/s`);
  if (st.status === "capped") return badge("capped", "At ceiling");
  if (st.lastHealthyRate === undefined) return badge("insufficient");
  return badge("healthy");
}

export function renderComparison(a: RunResults, b: RunResults, c: Comparison): string {
  const labels = c.commonSteps.map((s, i) => `S${i + 1} · ${s.targetRps}/s`);
  const stepA = (i: number) => a.steps.find((s) => s.index === c.commonSteps[i]!.a)!;
  const stepB = (i: number) => b.steps.find((s) => s.index === c.commonSteps[i]!.b)!;
  const nameA = `A: ${a.meta.env}${a.meta.label ? " · " + a.meta.label : ""}`;
  const nameB = `B: ${b.meta.env}${b.meta.label ? " · " + b.meta.label : ""}`;

  const select = (group: string) =>
    `<label>Load step <select data-step-target="${group}">${c.commonSteps
      .map((s, i) => `<option value="${i}"${i === c.defaultStep ? " selected" : ""}>${s.targetRps} req/s (A step ${s.a + 1}, B step ${s.b + 1})</option>`)
      .join("")}</select></label>`;

  const d = c.defaultStep;
  const regressions = c.commonSteps.length
    ? (c.endpoints.get(d) ?? []).filter((r) => (r.deltaMs ?? 0) >= 50 && (r.deltaPct ?? 0) >= 0.2).length
    : 0;
  const improvements = c.commonSteps.length
    ? (c.endpoints.get(d) ?? []).filter((r) => (r.deltaMs ?? 0) <= -50 && (r.deltaPct ?? 0) <= -0.2).length
    : 0;
  const tiles = [
    { label: "System breaking point", value: `A ${a.systemBreak ? a.systemBreak.targetRps + " req/s" : "not reached"} · B ${b.systemBreak ? b.systemBreak.targetRps + " req/s" : "not reached"}`, note: "target rate of the step where the first service broke" },
    c.commonSteps.length
      ? { label: `Overall p95 at ${c.commonSteps[d]!.targetRps} req/s`, value: `A ${fmtMs(stepA(d).overall.p95)} · B ${fmtMs(stepB(d).overall.p95)}`, note: "all API requests" }
      : { label: "Overall p95", value: "–", note: "no common steps" },
    { label: "Endpoints slower in B", value: String(regressions), note: "≥ 20% and ≥ 50 ms slower at p95" },
    { label: "Endpoints faster in B", value: String(improvements), note: "≥ 20% and ≥ 50 ms faster at p95" },
  ];

  const charts = c.commonSteps.length
    ? `<div class="charts">${lineChart({
        title: "p95 latency per step",
        labels,
        series: [
          { name: nameA, color: "--series-1", values: c.commonSteps.map((_, i) => stepA(i).overall.p95), fmt: fmtMs },
          { name: nameB, color: "--series-2", values: c.commonSteps.map((_, i) => stepB(i).overall.p95), fmt: fmtMs },
        ],
        yFmt: fmtMs,
      })}${lineChart({
        title: "Error rate per step (429 excluded)",
        labels,
        series: [
          { name: nameA, color: "--series-1", values: c.commonSteps.map((_, i) => stepA(i).overall.errorRate), fmt: fmtPct },
          { name: nameB, color: "--series-2", values: c.commonSteps.map((_, i) => stepB(i).overall.errorRate), fmt: fmtPct },
        ],
        yFmt: fmtPct,
      })}</div>`
    : `<p class="muted">The runs have no load steps with the same target rate.</p>`;

  const serviceNames = [...new Set([...a.plan.services.map((s) => s.name), ...b.plan.services.map((s) => s.name)])].sort();
  const svcRows = serviceNames
    .map((name) => {
      const pa = c.commonSteps.length ? stepA(d).services.find((s) => s.name === name)?.stats : undefined;
      const pb = c.commonSteps.length ? stepB(d).services.find((s) => s.name === name)?.stats : undefined;
      return `<tr><td class="mono wide">${esc(name)}</td><td>${serviceStatus(a, name)}</td><td>${serviceStatus(b, name)}</td>${numTd(pa?.p95, fmtMs(pa?.p95))}${numTd(pb?.p95, fmtMs(pb?.p95))}${deltaCell(delta(pa?.p95, pb?.p95))}${numTd(pa?.errorRate, fmtPct(pa?.errorRate))}${numTd(pb?.errorRate, fmtPct(pb?.errorRate))}</tr>`;
    })
    .join("");

  const epBodies = c.commonSteps
    .map((_, i) => {
      const rows = (c.endpoints.get(i) ?? [])
        .map((r) => {
          const vs = r.variants.filter((v) => v.variant !== "base" && (v.a || v.b));
          const vBlock = vs.length
            ? `<details><summary>${vs.length} parameter variants</summary><table><thead><tr><th class="nosort">Variant</th><th class="num nosort">A p95</th><th class="num nosort">B p95</th><th class="num nosort">Δ</th></tr></thead><tbody>${vs
                .sort((x, y) => (y.deltaPct ?? -Infinity) - (x.deltaPct ?? -Infinity))
                .map((v) => `<tr><td class="mono">${esc(v.variant)}</td><td class="num">${fmtMs(v.a?.p95)}</td><td class="num">${fmtMs(v.b?.p95)}</td><td class="num">${v.deltaPct === undefined ? "–" : v.deltaPct === Infinity ? "new" : `${v.deltaPct > 0 ? "+" : ""}${(v.deltaPct * 100).toFixed(0)}%`}</td></tr>`)
                .join("")}</tbody></table></details>`
            : "";
          const meta = b.endpointsMeta[r.key] ?? a.endpointsMeta[r.key];
          return `<tr><td class="mono wide">${esc(r.key)}${meta?.servicePath ? `<div class="muted">→ ${esc(meta.servicePath)}</div>` : ""}${vBlock}</td><td class="mono">${esc(r.service)}</td>${numTd(r.a?.p95, fmtMs(r.a?.p95))}${numTd(r.b?.p95, fmtMs(r.b?.p95))}${deltaCell(r)}${numTd(r.a?.errorRate, fmtPct(r.a?.errorRate))}${numTd(r.b?.errorRate, fmtPct(r.b?.errorRate))}${numTd(r.b?.n, String(r.b?.n ?? "–"))}</tr>`;
        })
        .join("");
      return `<tbody data-step-group="cmp-endpoints" data-step="${i}" data-filter-group="cmp-endpoints" ${i === d ? "" : "hidden"}>${rows}</tbody>`;
    })
    .join("");

  const pgBodies = c.commonSteps
    .map((_, i) => {
      const rows = (c.pages.get(i) ?? [])
        .map((p) => `<tr><td>${esc(p.page)}</td><td class="mono">${esc(p.interaction)}</td>${numTd(p.aP95, fmtMs(p.aP95))}${numTd(p.bP95, fmtMs(p.bP95))}${deltaCell(p)}</tr>`)
        .join("");
      return `<tbody data-step-group="cmp-pages" data-step="${i}" ${i === d ? "" : "hidden"}>${rows || `<tr><td colspan="6" class="muted">No browser measurements.</td></tr>`}</tbody>`;
    })
    .join("");

  const title = `Comparison — ${a.meta.env} vs ${b.meta.env}`;
  const body = `
<h1>${esc(title)}</h1>
<p class="sub"><span class="key" style="background:var(--series-1)"></span>A = ${esc(runName(a))} (${esc(a.meta.envKind)}) &nbsp; <span class="key" style="background:var(--series-2)"></span>B = ${esc(runName(b))} (${esc(b.meta.envKind)}). Deltas are B relative to A.</p>
<div class="tiles">${tiles.map((t) => `<div class="card tile"><div class="label">${esc(t.label)}</div><div class="value">${esc(t.value)}</div><div class="note">${esc(t.note)}</div></div>`).join("")}</div>
${c.mismatches.length ? `<h2>Is this a fair comparison?</h2><div class="card"><ul class="warn">${c.mismatches.map((m) => `<li>${esc(m)}</li>`).join("")}</ul></div>` : `<p class="muted">Same endpoint set, step plan, runner and settings: like-for-like.</p>`}
<h2>Latency and errors by load step</h2>
${charts}
<h2>Services</h2>
<p class="sub">Latency columns are at ${c.commonSteps.length ? esc(c.commonSteps[d]!.targetRps) + " req/s" : "–"}.</p>
<div class="table-wrap"><table class="sortable"><thead><tr>${th("Service")}${th("A status")}${th("B status")}${th("A p95", "num")}${th("B p95", "num")}${th("Δ", "num")}${th("Δ %", "num")}${th("A errors", "num")}${th("B errors", "num")}</tr></thead><tbody>${svcRows}</tbody></table></div>
<h2>Endpoints — biggest slowdowns in B first</h2>
<div class="controls">${select("cmp-endpoints")}<input type="search" placeholder="Filter endpoints" aria-label="Filter endpoints" data-filter-target="cmp-endpoints"></div>
<div class="table-wrap"><table class="sortable"><thead><tr>${th("Endpoint")}${th("Service")}${th("A p95", "num")}${th("B p95", "num")}${th("Δ", "num")}${th("Δ %", "num")}${th("A errors", "num")}${th("B errors", "num")}${th("B n", "num")}</tr></thead>${epBodies}</table></div>
${c.onlyInA.length || c.onlyInB.length ? `<details><summary>Endpoints in only one run (${c.onlyInA.length} A, ${c.onlyInB.length} B)</summary><p class="mono">${c.onlyInA.map((k) => "A only: " + esc(k)).join("<br>")}<br>${c.onlyInB.map((k) => "B only: " + esc(k)).join("<br>")}</p></details>` : ""}
<h2>Pages (real browser)</h2>
<div class="controls">${select("cmp-pages")}</div>
<div class="table-wrap"><table class="sortable"><thead><tr>${th("Page")}${th("Interaction")}${th("A p95", "num")}${th("B p95", "num")}${th("Δ", "num")}${th("Δ %", "num")}</tr></thead>${pgBodies}</table></div>
<footer>dxp-loadtest compare · ${esc(fmtNum(c.commonSteps.length))} common steps</footer>`;
  return page(title, body);
}
