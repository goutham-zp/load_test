import type { DiscoveryTimings, EndpointTiming, UrlTiming } from "../discover/timings.ts";
import { esc, fmtCount, fmtMs, numTd, page, th } from "./html.ts";

/** "200 ×194 · no response ×31"; 2xx first, then the rest by count. */
function responses(statuses: Record<string, number>): string {
  const parts = Object.entries(statuses)
    .sort((a, b) => Number(b[0].startsWith("2")) - Number(a[0].startsWith("2")) || b[1] - a[1])
    .map(([s, n]) => `${s === "0" ? "no response" : s} ×${fmtCount(n)}`);
  const bad = Object.keys(statuses).some((s) => !s.startsWith("2"));
  return `<td class="nowrap${bad ? " worse" : ""}">${esc(parts.join(" · "))}</td>`;
}

function timeTd(ms: number, slowMs: number): string {
  return numTd(ms, fmtMs(ms), ms >= slowMs ? "worse" : "");
}

function urlTable(urls: UrlTiming[], showUser: boolean, slowMs: number): string {
  const rows = urls
    .map(
      (u) =>
        `<tr><td class="mono">${esc(u.url)}</td>${showUser ? `<td class="nowrap">${esc(u.users.join(", "))}</td>` : ""}${numTd(u.calls, fmtCount(u.calls))}${timeTd(u.p50, slowMs)}${timeTd(u.max, slowMs)}${responses(u.statuses)}</tr>`
    )
    .join("");
  const heads = [th("URL", "nosort"), showUser ? th("Users", "nosort") : "", th("Calls", "num nosort"), th("Median", "num nosort"), th("Slowest", "num nosort"), th("Responses", "nosort")];
  return `<table><thead><tr>${heads.join("")}</tr></thead><tbody>${rows}</tbody></table>`;
}

function apiRow(e: EndpointTiming, t: DiscoveryTimings): string {
  // Runs recorded before per-URL timings existed have no urls: show the API row only.
  const urls = e.urls ?? [];
  let below = "";
  if (urls.length > 1) below = `<details><summary>${fmtCount(urls.length)} different URLs</summary>${urlTable(urls, t.users.length > 1, t.slowCallMs)}</details>`;
  else if (urls.length === 1 && urls[0]!.url !== e.key.split(" ")[1]) below = `<div class="muted mono">${esc(urls[0]!.url)}</div>`;
  return `<tr>
<td class="mono wide">${esc(e.key)}${below}</td>
${numTd(e.all.n, fmtCount(e.all.n))}
${timeTd(e.all.p50, t.slowCallMs)}
${timeTd(e.all.max, t.slowCallMs)}
${e.statuses ? responses(e.statuses) : "<td></td>"}
</tr>`;
}

export function renderDiscoveryReport(t: DiscoveryTimings): string {
  const title = `API timings — ${t.env}`;
  const calls = t.endpoints.reduce((a, e) => a + e.all.n, 0);
  const body = `
<h1>${esc(title)}</h1>
<p class="sub">${esc(t.createdAt.slice(0, 16).replace("T", " "))} UTC · ${esc(t.users.join(", "))} · ${fmtCount(t.endpoints.length)} APIs, ${fmtCount(calls)} calls · no load
(one browser, one user at a time). Calls to the same API with different values (<span class="mono">/invoices/1</span>,
<span class="mono">/invoices/2</span>) are one row; expand it to see each URL. Red = ${esc(fmtMs(t.slowCallMs))} or slower, or a non-2xx response.</p>
<div class="controls"><input type="search" placeholder="Filter APIs" aria-label="Filter APIs" data-filter-target="apis"></div>
<div class="table-wrap"><table class="sortable"><thead><tr>${th("API")}${th("Calls", "num")}${th("Median", "num")}${th("Slowest", "num")}${th("Responses")}</tr></thead>
<tbody data-filter-group="apis">${t.endpoints.map((e) => apiRow(e, t)).join("")}</tbody></table></div>
<footer>dxp-loadtest · times are request start to response end as the browser saw them. timings.json in this folder also has page ready times.</footer>`;
  return page(title, body);
}
