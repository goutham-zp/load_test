// Shared building blocks for the self-contained HTML reports (no external assets).

export function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function fmtMs(ms: number | undefined): string {
  if (ms === undefined || Number.isNaN(ms)) return "–";
  if (ms >= 10_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.round(ms)} ms`;
}

export function fmtPct(x: number | undefined): string {
  if (x === undefined || Number.isNaN(x)) return "–";
  return `${(x * 100).toFixed(x > 0 && x < 0.01 ? 2 : 1)}%`;
}

/** Whole counts (calls, visits): never shows decimals. */
export function fmtCount(n: number | undefined): string {
  return n === undefined || Number.isNaN(n) ? "–" : Math.round(n).toLocaleString("en-US");
}

export function fmtNum(n: number | undefined): string {
  if (n === undefined || Number.isNaN(n)) return "–";
  if (!Number.isFinite(n)) return "unlimited";
  if (Math.abs(n) >= 100) return Math.round(n).toLocaleString("en-US");
  if (Math.abs(n) >= 10) return n.toFixed(1);
  return n.toFixed(2).replace(/\.?0+$/, "") || "0";
}

const CSS = `
:root {
  /* DXP.Web light theme (shared_features/themes/theme/light-theme-options.ts). Light only, like the app. */
  color-scheme: light;
  --page: #F9FAFC; --surface: #FFFFFF; --ink: #111827; --ink-2: #374151; --muted: #6B7280; --brand: #002A4C;
  --grid: #E6E8F0; --axis: #D1D5DB; --border: #E6E8F0; --head: #F3F4F6;
  --series-1: #176CFF; --series-2: #eb6834;
  --good: #1E9962; --warning: #FCA70D; --serious: #ec835a; --critical: #E80000; --good-text: #007A2B;
  --critical-text: #E80000; --chip: #F3F4F6;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink); font: 14px/1.5 "Source Sans Pro", "Roboto", -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
main { max-width: 1280px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 22px; margin: 0 0 4px; font-weight: 600; color: var(--brand); }
h2 { font-size: 17px; margin: 32px 0 8px; font-weight: 600; }
h3 { font-size: 14px; margin: 16px 0 6px; font-weight: 600; }
p, li { color: var(--ink-2); }
.sub { color: var(--ink-2); margin: 0 0 16px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
.tile .label { color: var(--ink-2); font-size: 13px; }
.tile .value { font-size: 22px; font-weight: 600; margin-top: 2px; }
.tile .note { color: var(--muted); font-size: 12px; }
.charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 12px; }
.chart { position: relative; }
.chart svg { width: 100%; height: auto; display: block; overflow: visible; }
.chart .title { font-weight: 600; margin-bottom: 2px; }
.chart .legend { display: flex; gap: 14px; font-size: 12px; color: var(--ink-2); margin-bottom: 6px; flex-wrap: wrap; }
.key { display: inline-block; width: 14px; height: 2px; vertical-align: middle; margin-right: 6px; border-radius: 1px; }
.tip { position: absolute; pointer-events: none; background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
  padding: 6px 10px; font-size: 12px; box-shadow: 0 4px 16px rgba(0,0,0,0.12); display: none; white-space: nowrap; z-index: 5; }
.tip .v { font-weight: 600; color: var(--ink); font-variant-numeric: tabular-nums; }
.tip .k { color: var(--ink-2); }
.warn { margin: 0; padding-left: 20px; }
.warn li { margin: 4px 0; }
.table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { padding: 6px 10px; text-align: left; border-bottom: 1px solid var(--grid); vertical-align: top; }
th { color: var(--ink-2); font-weight: 600; position: sticky; top: 0; background: var(--head); cursor: pointer; user-select: none; white-space: nowrap; }
th.nosort { cursor: default; }
th[aria-sort="ascending"]::after { content: " ▲"; font-size: 10px; }
th[aria-sort="descending"]::after { content: " ▼"; font-size: 10px; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
td.wide { min-width: 260px; }
td.nowrap { white-space: nowrap; word-break: normal; }
td.mono, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; word-break: break-all; }
tr:last-child td { border-bottom: none; }
.muted { color: var(--muted); }
.badge { display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; border-radius: 999px; font-size: 12px; background: var(--chip); color: var(--ink); white-space: nowrap; }
.badge .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.worse { color: var(--critical-text); font-weight: 600; }
.better { color: var(--good-text); font-weight: 600; }
details summary { cursor: pointer; color: var(--ink-2); }
details table { margin-top: 6px; }
.controls { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin: 8px 0 12px; }
select, input[type="search"] { font: inherit; padding: 4px 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface); color: var(--ink); }
.spark { display: block; }
footer { margin-top: 40px; color: var(--muted); font-size: 12px; }
@media (max-width: 640px) { .charts { grid-template-columns: 1fr; } }
`;

const SCRIPT = `
(() => {
  // Sortable tables: click a header to sort by that column (numbers via data-v).
  document.querySelectorAll("table.sortable").forEach((table) => {
    const heads = table.querySelectorAll(":scope > thead th");
    heads.forEach((th, col) => {
      if (th.classList.contains("nosort")) return;
      th.addEventListener("click", () => {
        const dir = th.getAttribute("aria-sort") === "descending" ? "ascending" : "descending";
        heads.forEach((h) => h.removeAttribute("aria-sort"));
        th.setAttribute("aria-sort", dir);
        table.querySelectorAll(":scope > tbody").forEach((tbody) => {
          const rows = Array.from(tbody.children);
          rows.sort((a, b) => {
            const ca = a.children[col], cb = b.children[col];
            const va = ca && ca.dataset.v !== undefined ? ca.dataset.v : (ca ? ca.textContent : "");
            const vb = cb && cb.dataset.v !== undefined ? cb.dataset.v : (cb ? cb.textContent : "");
            const na = Number(va), nb = Number(vb);
            const cmp = !isNaN(na) && !isNaN(nb) && va !== "" && vb !== "" ? na - nb : String(va).localeCompare(String(vb));
            return dir === "ascending" ? cmp : -cmp;
          });
          rows.forEach((r) => tbody.appendChild(r));
        });
      });
    });
  });

  // Step selectors: show the tbody / section for the chosen step.
  document.querySelectorAll("select[data-step-target]").forEach((sel) => {
    const apply = () => {
      document.querySelectorAll("[data-step-group='" + sel.dataset.stepTarget + "']").forEach((el) => {
        el.hidden = el.dataset.step !== sel.value;
      });
    };
    sel.addEventListener("change", apply);
    apply();
  });

  // Text filter for tables.
  document.querySelectorAll("input[data-filter-target]").forEach((input) => {
    input.addEventListener("input", () => {
      const q = input.value.toLowerCase();
      document.querySelectorAll("[data-filter-group='" + input.dataset.filterTarget + "'] > tr").forEach((tr) => {
        tr.style.display = tr.textContent.toLowerCase().includes(q) ? "" : "none";
      });
    });
  });

  // Line charts: crosshair snaps to the nearest step; one tooltip lists every series.
  document.querySelectorAll(".chart[data-chart]").forEach((wrap) => {
    const data = JSON.parse(wrap.dataset.chart);
    const svg = wrap.querySelector("svg");
    const tip = wrap.querySelector(".tip");
    const hair = svg.querySelector(".hair");
    const show = (i) => {
      const x = data.xs[i];
      hair.setAttribute("x1", x); hair.setAttribute("x2", x); hair.style.display = "";
      tip.replaceChildren();
      const head = document.createElement("div");
      head.className = "k"; head.textContent = data.labels[i];
      tip.appendChild(head);
      data.series.forEach((s) => {
        const row = document.createElement("div");
        const key = document.createElement("span");
        key.className = "key"; key.style.background = "var(" + s.color + ")";
        const v = document.createElement("span");
        v.className = "v"; v.textContent = s.fmt[i] ?? "–";
        const k = document.createElement("span");
        k.className = "k"; k.textContent = "  " + s.name;
        row.append(key, v, k);
        tip.appendChild(row);
      });
      const box = svg.getBoundingClientRect();
      const scale = box.width / data.w;
      tip.style.display = "block";
      const left = x * scale + 12;
      tip.style.left = Math.min(left, box.width - tip.offsetWidth - 4) + "px";
      tip.style.top = "36px";
    };
    const hide = () => { tip.style.display = "none"; hair.style.display = "none"; };
    const nearest = (clientX) => {
      const box = svg.getBoundingClientRect();
      const x = ((clientX - box.left) / box.width) * data.w;
      let best = 0;
      data.xs.forEach((xx, i) => { if (Math.abs(xx - x) < Math.abs(data.xs[best] - x)) best = i; });
      return best;
    };
    svg.addEventListener("pointermove", (e) => show(nearest(e.clientX)));
    svg.addEventListener("pointerleave", hide);
    svg.addEventListener("focus", () => show(data.xs.length - 1));
    svg.addEventListener("blur", hide);
  });
})();
`;

export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
${body}
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

export interface LineSeries {
  name: string;
  /** CSS variable holding the series color, e.g. "--series-1". */
  color: string;
  values: (number | null)[];
  fmt: (v: number) => string;
}

export interface ChartMarker {
  index: number;
  label: string;
}

/** A single-axis line chart over load steps, with crosshair tooltip and optional "broke" markers. */
export function lineChart(opts: {
  title: string;
  labels: string[];
  series: LineSeries[];
  yFmt: (v: number) => string;
  markers?: ChartMarker[];
}): string {
  const w = 560;
  const h = 220;
  const pad = { l: 56, r: 16, t: 12, b: 34 };
  const n = opts.labels.length;
  const all = opts.series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const maxV = niceMax(Math.max(0, ...all));
  const x = (i: number) => (n <= 1 ? (pad.l + w - pad.r) / 2 : pad.l + (i * (w - pad.l - pad.r)) / (n - 1));
  const y = (v: number) => pad.t + (h - pad.t - pad.b) * (1 - (maxV ? v / maxV : 0));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * maxV);

  const grid = ticks
    .map((t) => `<line x1="${pad.l}" x2="${w - pad.r}" y1="${y(t)}" y2="${y(t)}" stroke="var(--grid)" stroke-width="1"/>` +
      `<text x="${pad.l - 8}" y="${y(t) + 4}" text-anchor="end" font-size="11" fill="var(--muted)" style="font-variant-numeric:tabular-nums">${esc(opts.yFmt(t))}</text>`)
    .join("");
  const xLabels = opts.labels
    .map((l, i) => `<text x="${x(i)}" y="${h - 12}" text-anchor="middle" font-size="11" fill="var(--muted)">${esc(l)}</text>`)
    .join("");
  const lines = opts.series
    .map((s) => {
      const pts = s.values.map((v, i) => (v === null ? null : `${x(i)},${y(v)}`));
      const segs: string[] = [];
      let cur: string[] = [];
      for (const p of pts) {
        if (p === null) {
          if (cur.length) segs.push(cur.join(" "));
          cur = [];
        } else cur.push(p);
      }
      if (cur.length) segs.push(cur.join(" "));
      const paths = segs.map((pp) => `<polyline points="${pp}" fill="none" stroke="var(${s.color})" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`).join("");
      const dots = s.values
        .map((v, i) => (v === null ? "" : `<circle cx="${x(i)}" cy="${y(v)}" r="4" fill="var(${s.color})" stroke="var(--surface)" stroke-width="2"/>`))
        .join("");
      return paths + dots;
    })
    .join("");
  const markers = (opts.markers ?? [])
    .map((m) => {
      const top = pad.t;
      return `<line x1="${x(m.index)}" x2="${x(m.index)}" y1="${top}" y2="${h - pad.b}" stroke="var(--critical)" stroke-width="1"/>` +
        // Keep the label inside the plot: put it left of the line when the marker is near the right edge.
        (x(m.index) > w * 0.7
          ? `<text x="${x(m.index) - 4}" y="${top + 10}" text-anchor="end" font-size="11" fill="var(--ink-2)">✕ ${esc(m.label)}</text>`
          : `<text x="${x(m.index) + 4}" y="${top + 10}" font-size="11" fill="var(--ink-2)">✕ ${esc(m.label)}</text>`);
    })
    .join("");
  const data = {
    w,
    xs: opts.labels.map((_, i) => x(i)),
    labels: opts.labels,
    series: opts.series.map((s) => ({ name: s.name, color: s.color, fmt: s.values.map((v) => (v === null ? "–" : s.fmt(v))) })),
  };
  const legend =
    opts.series.length > 1
      ? `<div class="legend">${opts.series.map((s) => `<span><span class="key" style="background:var(${s.color})"></span>${esc(s.name)}</span>`).join("")}</div>`
      : "";
  return `<div class="card chart" data-chart="${esc(JSON.stringify(data))}">
<div class="title">${esc(opts.title)}</div>${legend}
<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(opts.title)}" tabindex="0">
${grid}<line x1="${pad.l}" x2="${w - pad.r}" y1="${y(0)}" y2="${y(0)}" stroke="var(--axis)" stroke-width="1"/>
${markers}${lines}${xLabels}
<line class="hair" y1="${pad.t}" y2="${h - pad.b}" stroke="var(--axis)" stroke-width="1" style="display:none"/>
</svg>
<div class="tip"></div>
</div>`;
}

/** Tiny single-series sparkline; a critical dot marks the step a service broke. */
export function sparkline(values: (number | null)[], fmt: (v: number) => string, labels: string[], breakIndex?: number): string {
  const w = 120;
  const h = 28;
  const nums = values.filter((v): v is number => v !== null);
  if (nums.length === 0) return `<span class="muted">–</span>`;
  const maxV = Math.max(...nums) || 1;
  const n = values.length;
  const x = (i: number) => (n <= 1 ? w / 2 : 4 + (i * (w - 8)) / (n - 1));
  const y = (v: number) => 4 + (h - 8) * (1 - v / maxV);
  const pts = values.map((v, i) => (v === null ? null : `${x(i)},${y(v)}`)).filter(Boolean).join(" ");
  const dots = values
    .map((v, i) => {
      if (v === null) return "";
      const isBreak = i === breakIndex;
      const isLast = i === n - 1 || values.slice(i + 1).every((u) => u === null);
      if (!isBreak && !isLast) return `<circle cx="${x(i)}" cy="${y(v)}" r="6" fill="transparent"><title>${esc(labels[i])}: ${esc(fmt(v))}</title></circle>`;
      return `<circle cx="${x(i)}" cy="${y(v)}" r="3.5" fill="var(${isBreak ? "--critical" : "--series-1"})" stroke="var(--surface)" stroke-width="1.5"><title>${esc(labels[i])}: ${esc(fmt(v))}</title></circle>`;
    })
    .join("");
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="var(--series-1)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>${dots}</svg>`;
}

export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * exp >= v) return m * exp;
  return 10 * exp;
}

export type BadgeKind = "broken" | "capped" | "healthy" | "insufficient";

export function badge(kind: BadgeKind, text?: string): string {
  const map: Record<BadgeKind, { color: string; icon: string; label: string }> = {
    broken: { color: "--critical", icon: "✕", label: "Broke" },
    capped: { color: "--warning", icon: "◼", label: "At rate-limit ceiling" },
    healthy: { color: "--good", icon: "✓", label: "Healthy" },
    insufficient: { color: "--muted", icon: "?", label: "Too few requests" },
  };
  const m = map[kind];
  return `<span class="badge"><span class="dot" style="background:var(${m.color})"></span>${m.icon} ${esc(text ?? m.label)}</span>`;
}

export function th(label: string, cls = ""): string {
  return `<th class="${cls}">${esc(label)}</th>`;
}

export function numTd(v: number | undefined, text: string, cls = ""): string {
  return `<td class="num ${cls}" data-v="${v === undefined || Number.isNaN(v) ? "" : v}">${text}</td>`;
}
