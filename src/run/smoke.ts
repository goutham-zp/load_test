import fs from "node:fs";
import { chromiumArgs } from "../browser/launch.ts";
import path from "node:path";
import { chromium } from "playwright";
import { newGuardedContext } from "../browser/context.ts";
import { ensureSessions, writeK6Tokens } from "../browser/session.ts";
import { RequestTracker } from "../browser/tracker.ts";
import { visitPage } from "../browser/visit.ts";
import { busySelector } from "../config/app.ts";
import { loadApp, loadServices, loadSettings, writeJson } from "../config/load.ts";
import type { EnvConfig } from "../config/types.ts";
import { envGuard } from "../guard/readonly.ts";
import { parseK6Output, startK6, writePlanFile } from "../load/k6runner.ts";
import { buildLoadPlan } from "../load/plan.ts";
import { dirs } from "../paths.ts";
import { esc, fmtMs, page } from "../report/html.ts";
import { timestamp } from "../util.ts";
import { assertTokensFor, catalogCompanies, catalogUsers, loadCatalog, sessionList } from "./run.ts";

export interface SmokeResult {
  passed: boolean;
  runDir: string;
  endpointFailures: { key: string; service: string; n: number; ok: number; errors: number; clientErrors: number; throttled: number }[];
  /** Endpoints that never answered in discovery: they are loaded to show the timeouts, so a failure here is expected and does not fail the smoke. */
  expectedUnanswered: { key: string; service: string; n: number; ok: number; errors: number }[];
  /** calls: the page's failed API calls (status 0 = no response or cancelled by the app). */
  pageFailures: { page: string; url: string; problem: string; calls?: { method: string; url: string; status: number }[] }[];
  blockedWrites: { method: string; url: string }[];
  refused: number;
}

/** Every endpoint once per user sample (base variant, slow pace) plus every page once in a browser. */
export async function smoke(env: EnvConfig, log: (m: string) => void): Promise<SmokeResult> {
  const settings = loadSettings();
  const app = loadApp(env);
  const catalog = loadCatalog(env, app);
  const users = catalogUsers(env, catalog);
  const guard = envGuard(env, app);
  const plan = buildLoadPlan(catalog, guard, loadServices(env), settings.load.safetyFactor, { baseOnly: true });
  const runDir = path.join(dirs.runs, `${timestamp()}-${env.name}-smoke`);
  fs.mkdirSync(runDir, { recursive: true });
  const planFile = writePlanFile(runDir, plan);
  const total = plan.services.reduce((a, s) => a + s.slots.length, 0);
  log(`Smoke: ${total} API requests across ${plan.services.length} services, ${catalog.pages.filter((p) => p.reached).length} pages`);

  const browser = await chromium.launch({ headless: true, args: chromiumArgs() });
  const pageFailures: SmokeResult["pageFailures"] = [];
  const blockedWrites: SmokeResult["blockedWrites"] = [];
  let parsed;
  try {
    const sessions = await ensureSessions(browser, env, app, guard, users, 1800, log, { companies: catalogCompanies(catalog) });
    assertTokensFor(plan, sessions);
    const tokensFile = writeK6Tokens(env.name, sessions);
    // Pace each service's single VU so it stays under that service's ceiling.
    const smokePace = Object.fromEntries(plan.services.map((s) => [s.name, Math.min(60, Math.max(0.25, Number.isFinite(s.cap) ? 1 / s.cap : 0.25))]));
    const handle = startK6(path.join(runDir, "api"), planFile, tokensFile, {
      mode: "smoke",
      rates: Object.fromEntries(plan.services.map((s) => [s.name, 1])),
      durationSec: 0,
      timeoutSec: settings.load.requestTimeoutSec,
      maxVUs: 1,
      smokePace,
    }, log);

    // Browser pass runs while k6 works through the API list, as the first session (first user, first company).
    const first = sessionList(sessions, users)[0]!;
    const { context, blocked } = await newGuardedContext(browser, guard, first.storageStatePath);
    const pg = await context.newPage();
    const tracker = new RequestTracker(pg, { gatewayBaseUrls: env.gatewayBaseUrls, inspectBodies: false });
    const visitOpts = {
      quietMs: settings.browser.readyQuietMs,
      timeoutMs: settings.browser.readyTimeoutMs,
      busySelector: busySelector(app),
      loadSettleMs: app.loadSettleMs,
      selectors: app.selectors,
      log: () => {},
    };
    for (const p of catalog.pages.filter((x) => x.reached)) {
      const own = p.urls.find((u) => u.user === first.user && first.companies.includes(u.companyId));
      // Another user's URL only works when the token isn't tied to a company.
      const target = own ?? (app.tokenScope === "user" ? p.urls[0] : undefined);
      if (!target) {
        log(`  page ${p.id}: skipped (not discovered for ${first.key})`);
        continue;
      }
      const url = target.url;
      const [load] = await visitPage(pg, tracker, p.id, url, undefined, visitOpts);
      const failed = load!.calls.filter((c) => c.status === 0 || c.status >= 400);
      if (load!.error) pageFailures.push({ page: p.id, url, problem: load!.error });
      else if (load!.timedOut) pageFailures.push({ page: p.id, url, problem: `not ready after ${fmtMs(load!.readyMs)}: ${load!.busy}` });
      else if (failed.length) {
        pageFailures.push({
          page: p.id,
          url,
          problem: `${failed.length} API calls failed (${[...new Set(failed.map((f) => f.status))].join(", ")})`,
          calls: failed.map((f) => ({ method: f.method, url: f.url, status: f.status })),
        });
      }
      log(`  page ${p.id}: ${load!.error ? "ERROR" : load!.timedOut ? "TIMEOUT" : fmtMs(load!.readyMs)}`);
      tracker.calls.length = 0;
    }
    blockedWrites.push(...blocked.filter((b) => b.reason === "write").map((b) => ({ method: b.method, url: b.url })));
    await context.close();

    const code = await handle.done;
    if (code !== 0) log(`k6 exited with code ${code} (see ${path.join(runDir, "api", "k6.log")})`);
    parsed = await parseK6Output(handle.outFile, plan);
  } finally {
    await browser.close();
  }

  const unansweredKeys = new Set(catalog.endpoints.filter((e) => e.unanswered).map((e) => e.key));
  const notOk = [...parsed.endpoints]
    .filter(([, v]) => v.stats.ok < v.stats.n)
    .map(([key, v]) => ({ key, service: v.service, n: v.stats.n, ok: v.stats.ok, errors: v.stats.errors, clientErrors: v.stats.clientErrors, throttled: v.stats.throttled }));
  const endpointFailures = notOk.filter((f) => !unansweredKeys.has(f.key));
  const expectedUnanswered = notOk.filter((f) => unansweredKeys.has(f.key));
  // A page that waited on one of those endpoints fails for that reason alone: it is expected too.
  const isUnanswered = unansweredMatcher(catalog.endpoints.filter((e) => e.unanswered).map((e) => e.key));
  const unexpectedPageFailures = pageFailures.filter((f) => !(isUnanswered(f.problem) || (f.calls?.length && f.calls.every((c) => isUnanswered(c.url)))));
  const sent = [...parsed.endpoints.values()].reduce((a, v) => a + v.stats.n, 0);
  if (sent < total) log(`Only ${sent} of ${total} smoke requests completed.`);
  const result: SmokeResult = {
    passed: endpointFailures.length === 0 && unexpectedPageFailures.length === 0 && parsed.refused === 0 && sent === total,
    runDir,
    endpointFailures,
    expectedUnanswered,
    pageFailures,
    blockedWrites,
    refused: parsed.refused,
  };
  writeJson(path.join(runDir, "smoke.json"), result);
  fs.writeFileSync(path.join(runDir, "smoke.html"), renderSmoke(env, result, total, sent));
  return result;
}

/** Matches text or a URL that names one of these endpoint keys ("GET [svc] /api/v1/x/{num}/y"), ids matched by {...}. */
function unansweredMatcher(keys: string[]): (text: string) => boolean {
  const res = keys.map((k) => new RegExp(k.replace(/^\S+ (\[[^\]]+\] )?/, "").replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{[^}]+\}/g, "[^/?\\s]+")));
  return (text) => res.some((r) => r.test(text));
}

function renderSmoke(env: EnvConfig, r: SmokeResult, total: number, sent: number): string {
  const ep = r.endpointFailures
    .map((f) => `<tr><td class="mono">${esc(f.key)}</td><td class="mono">${esc(f.service)}</td><td class="num">${f.ok}/${f.n}</td><td class="num">${f.errors}</td><td class="num">${f.clientErrors}</td><td class="num">${f.throttled}</td></tr>`)
    .join("");
  const pg = r.pageFailures.map((f) => `<tr><td>${esc(f.page)}</td><td>${esc(f.problem)}</td><td class="mono">${esc(f.url)}</td></tr>`).join("");
  const body = `<h1>Smoke check — ${esc(env.name)}</h1>
<p class="sub">${r.passed ? "✓ Passed" : "✕ Failed"} · ${sent}/${total} API requests completed · ${r.blockedWrites.length} writes blocked in the browser</p>
<h2>Endpoints with non-2xx responses</h2>
${ep ? `<div class="table-wrap"><table><thead><tr><th>Endpoint</th><th>Service</th><th class="num">OK</th><th class="num">5xx/timeout</th><th class="num">4xx</th><th class="num">429</th></tr></thead><tbody>${ep}</tbody></table></div>` : `<p>None.</p>`}
${r.expectedUnanswered.length ? `<h2>Never answered in discovery (loaded on purpose, not a smoke failure)</h2><ul>${r.expectedUnanswered.map((f) => `<li class="mono">${esc(f.key)}: ${f.ok}/${f.n} answered</li>`).join("")}</ul>` : ""}
<h2>Pages with problems</h2>
${pg ? `<div class="table-wrap"><table><thead><tr><th>Page</th><th>Problem</th><th>URL</th></tr></thead><tbody>${pg}</tbody></table></div>` : `<p>None.</p>`}`;
  return page(`Smoke — ${env.name}`, body);
}
