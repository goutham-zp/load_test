import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { newGuardedContext, type BlockedEvent } from "../browser/context.ts";
import { clickFirstRow, resolveInteractions, runInteractions } from "../browser/interactions.ts";
import { ensureSessions } from "../browser/session.ts";
import { RequestTracker } from "../browser/tracker.ts";
import { measureStep, visitPage, type VisitStep } from "../browser/visit.ts";
import { buildCatalog } from "../catalog/build.ts";
import { pagePathFromUrl, pagePathRegex, templatePath } from "../catalog/normalize.ts";
import type { BlockedRequest, Catalog, CatalogPage, RecordedRequest } from "../catalog/types.ts";
import { loadAllowlist, loadInteractions, loadPages, loadSettings, loadUsers, writeJson } from "../config/load.ts";
import type { EnvConfig, PageConfig } from "../config/types.ts";
import { createRouteMatcher, loadGatewayRoutes } from "../gateway/routes.ts";
import { compileGuard } from "../guard/readonly.ts";
import { catalogDir, dirs, expandHome } from "../paths.ts";
import { renderDiscoveryReport } from "../report/discoveryReport.ts";
import { timestamp } from "../util.ts";
import { backupCatalog, coverKey, loadRecording, mergeRecording, RECORDING_FILE, type DiscoveryRecording } from "./recording.ts";
import { buildDiscoveryTimings } from "./timings.ts";

export interface DiscoverOptions {
  env: EnvConfig;
  onlyUsers?: string[];
  onlyPages?: string[];
  maxCompanies?: number;
  headed?: boolean;
  /** Start the catalog fresh even when --users / --pages limit the run (default: merge into the previous one). */
  replace?: boolean;
  log: (msg: string) => void;
}

export interface DiscoverResult {
  catalog: Catalog;
  file: string;
  reportFile: string;
  /** True when this run was merged into the previous recording. */
  merged: boolean;
  backupDir?: string;
}

export function pageUrl(env: EnvConfig, companyId: string, pagePath: string): string {
  return `${env.webBaseUrl}/${env.lang}/retailer/${companyId}/${pagePath}`;
}

/** Parents come before children so detail pages can click through from them (any depth). */
export function orderPages(pages: PageConfig[]): PageConfig[] {
  const depth = (p: PageConfig, seen = new Set<string>()): number => {
    if (!p.detailFrom || seen.has(p.id)) return 0;
    seen.add(p.id);
    const parent = pages.find((x) => x.id === p.detailFrom!.page);
    return parent ? 1 + depth(parent, seen) : 1;
  };
  return pages
    .map((p, i) => ({ p, i, d: depth(p) }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .map((x) => x.p);
}

/** Selected pages plus every page needed to click through to them. */
export function withParents(all: PageConfig[], ids: string[]): PageConfig[] {
  const keep = new Set<string>();
  const add = (id: string) => {
    if (keep.has(id)) return;
    const p = all.find((x) => x.id === id);
    if (!p) return;
    keep.add(id);
    if (p.detailFrom) add(p.detailFrom.page);
  };
  ids.forEach(add);
  return all.filter((p) => keep.has(p.id));
}

function landedOn(env: EnvConfig, url: string, page: PageConfig): boolean {
  const { rest } = pagePathFromUrl(url, env.lang);
  return pagePathRegex(page.path).test(rest);
}

export async function discover(opts: DiscoverOptions): Promise<DiscoverResult> {
  const { env, log } = opts;
  const settings = loadSettings();
  const interactions = loadInteractions();
  const allPages = loadPages();
  const pages = orderPages(opts.onlyPages ? withParents(allPages, opts.onlyPages) : allPages);
  const users = loadUsers().filter((u) => !opts.onlyUsers || opts.onlyUsers.includes(u.key));
  const guard = compileGuard({
    auth0Host: new URL(env.auth0Domain).host,
    allowlist: loadAllowlist(),
    blockedThirdPartyHosts: settings.blockedThirdPartyHosts,
  });
  const matcher = createRouteMatcher(loadGatewayRoutes(expandHome(env.gatewayConfigDir ?? settings.gatewayConfigDir)));
  log(`Gateway routes loaded: ${matcher.size}`);

  const maxCompanies = opts.maxCompanies ?? settings.discovery.maxCompaniesPerUser;
  const visitOpts = { quietMs: settings.browser.readyQuietMs, timeoutMs: settings.discovery.navigationTimeoutMs, log: (m: string) => log(`    ${m}`) };

  const browser = await chromium.launch({ headless: !opts.headed });
  const recorded: RecordedRequest[] = [];
  const pageInfo = new Map<string, CatalogPage>(pages.map((p) => [p.id, { id: p.id, reached: false, urls: [], interactions: [], endpoints: [] }]));
  const blockedAgg = new Map<string, BlockedRequest>();
  const allSteps: (VisitStep & { user: string; companyId: string })[] = [];
  const covered = new Set<string>();

  try {
    const sessions = await ensureSessions(browser, env, users, 600, log);
    for (const user of users) {
      const session = sessions[user.key]!;
      const companies = session.companies.slice(0, maxCompanies);
      const { context, blocked } = await newGuardedContext(browser, guard, session.storageStatePath);
      const page = await context.newPage();
      const tracker = new RequestTracker(page, { gatewayBaseUrls: env.gatewayBaseUrls, inspectBodies: true });

      for (const companyId of companies) {
        log(`${user.key} / company ${companyId}`);
        for (const p of pages) {
          const blockedBefore = blocked.length;
          covered.add(coverKey(user.key, companyId, p.id));
          const info = pageInfo.get(p.id)!;
          const pageInteractions = resolveInteractions(interactions, p.id);
          let steps: VisitStep[] = [];
          let reached = false;

          if (!p.detailFrom) {
            steps = await visitPage(page, tracker, p.id, pageUrl(env, companyId, p.path), pageInteractions, visitOpts);
            reached = landedOn(env, steps[0]!.url, p);
          } else {
            const from = allPages.find((x) => x.id === p.detailFrom!.page);
            if (!from) {
              info.note = `detailFrom page "${p.detailFrom.page}" not found in pages.json`;
              continue;
            }
            // A detail-of-detail page starts from the concrete URL recorded for its parent in this company.
            const fromUrl = from.detailFrom
              ? pageInfo.get(from.id)?.urls.find((u) => u.user === user.key && u.companyId === companyId)?.url
              : pageUrl(env, companyId, from.path);
            if (!fromUrl) {
              if (!info.reached) info.note = `not reached: parent page "${from.id}" was not reached for this company`;
              log(`  MISS ${p.id}  (parent ${from.id} not reached)`);
              continue;
            }
            await measureStep(page, tracker, from.id, "load", async () => {
              await page.goto(fromUrl, { waitUntil: "load", timeout: visitOpts.timeoutMs });
            }, visitOpts);
            const load = await measureStep(page, tracker, p.id, "load", async () => {
              if (!(await clickFirstRow(page, p.detailFrom!.clickSelector))) throw new Error("no clickable first row");
              await page.waitForURL((u) => landedOn(env, u.toString(), p), { timeout: 15_000 });
            }, visitOpts);
            steps = [load];
            reached = !load.error && landedOn(env, load.url, p);
            if (reached && pageInteractions && !load.timedOut) {
              await runInteractions(page, pageInteractions, async (label, action) => {
                const step = await measureStep(page, tracker, p.id, label, action, visitOpts);
                steps.push(step);
                return !step.timedOut;
              }, visitOpts.log);
            }
          }

          if (reached) {
            info.reached = true;
            info.urls.push({ user: user.key, companyId, url: steps[0]!.url });
            for (const s of steps) if (!info.interactions.includes(s.interaction)) info.interactions.push(s.interaction);
          } else if (!info.reached) {
            info.note = steps[0]?.error ? `not reached: ${steps[0].error}` : `not reached: landed on ${pagePathFromUrl(steps[0]?.url ?? "", env.lang).rest || steps[0]?.url}`;
          }

          for (const s of steps) {
            allSteps.push({ ...s, user: user.key, companyId });
            for (const c of s.calls) {
              recorded.push({
                user: user.key,
                companyId,
                page: s.page,
                interaction: s.interaction,
                method: c.method,
                url: c.url,
                body: c.body,
                headers: c.headers,
                status: c.status,
                durationMs: c.durationMs,
                totalCount: c.totalCount,
              });
            }
          }
          aggregateBlocked(blockedAgg, blocked.slice(blockedBefore), p.id, steps);

          const calls = steps.reduce((n, s) => n + s.calls.length, 0);
          const slowest = Math.max(...steps.map((s) => s.readyMs));
          log(`  ${reached ? "ok  " : "MISS"} ${p.id}  steps=${steps.length} calls=${calls} slowest=${slowest}ms${blocked.length > blockedBefore ? ` blocked=${blocked.length - blockedBefore}` : ""}`);
          for (const s of steps.filter((x) => x.timedOut)) log(`         not ready after ${Math.round(s.readyMs / 1000)}s (${s.interaction}): ${s.busy}`);
        }
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }

  const dir = catalogDir(env.name);
  const thisRun: DiscoveryRecording = {
    version: 1,
    env: env.name,
    updatedAt: new Date().toISOString(),
    users: users.map((u) => u.key),
    covered: [...covered],
    recorded,
    steps: allSteps.map(({ calls, ...s }) => ({ ...s, calls: calls.length })),
    pages: [...pageInfo.values()],
    blocked: [...blockedAgg.values()].sort((a, b) => b.count - a.count),
  };
  // A run limited by --users / --pages only replaces what it visited; anything else keeps its earlier recording.
  const partial = !opts.replace && Boolean(opts.onlyUsers || opts.onlyPages);
  const previous = partial ? loadRecording(dir) : undefined;
  if (partial && !previous && fs.existsSync(path.join(dir, "catalog.json"))) {
    log(`No ${RECORDING_FILE} from an earlier discovery to merge into (made before v0.1.8): this run replaces the catalog.`);
  }
  const final = previous ? mergeRecording(previous, thisRun) : thisRun;
  const backupDir = backupCatalog(dir);

  const catalog = buildCatalog({
    env: env.name,
    webBaseUrl: env.webBaseUrl,
    gatewayBaseUrls: env.gatewayBaseUrls,
    users: final.users,
    recorded: final.recorded,
    pages: final.pages,
    blocked: final.blocked,
    matcher,
    maxSamplesPerUserPerEndpoint: settings.discovery.maxSamplesPerUserPerEndpoint,
    maxVariantsPerEndpoint: settings.discovery.maxVariantsPerEndpoint,
    searchTerms: settings.discovery.searchTerms,
  });
  const file = path.join(dir, "catalog.json");
  writeJson(file, catalog);
  writeJson(path.join(dir, RECORDING_FILE), final);
  writeJson(path.join(dir, "discovery-steps.json"), final.steps);

  // Baseline report: how long each API took with no load, for this run only.
  const timings = buildDiscoveryTimings({
    env: env.name,
    users: users.map((u) => u.key),
    recorded,
    steps: allSteps,
    matcher,
    slowCallMs: settings.discovery.slowCallMs ?? 2000,
  });
  const reportDir = path.join(dirs.runs, `${timestamp()}-${env.name}-discovery`);
  fs.mkdirSync(reportDir, { recursive: true });
  writeJson(path.join(reportDir, "timings.json"), timings);
  const reportFile = path.join(reportDir, "discovery.html");
  fs.writeFileSync(reportFile, renderDiscoveryReport(timings));
  return { catalog, file, reportFile, merged: Boolean(previous), backupDir };
}

function aggregateBlocked(agg: Map<string, BlockedRequest>, events: BlockedEvent[], pageId: string, steps: VisitStep[]): void {
  for (const e of events) {
    const u = new URL(e.url);
    const tpl = templatePath(u.pathname);
    const key = `${e.method} ${u.host}${tpl}`;
    const step = [...steps].reverse().find((s) => s.startedAt <= e.at);
    const existing = agg.get(key);
    if (existing) {
      existing.count++;
      continue;
    }
    agg.set(key, {
      method: e.method,
      url: e.url,
      pathTemplate: tpl,
      page: pageId,
      interaction: step?.interaction ?? "load",
      bodySample: e.body?.slice(0, 500),
      count: 1,
      suggestedAllowlistEntry: {
        method: e.method,
        path: "^" + tpl.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{[a-z]+\}/g, "[^/]+") + "$",
        reviewed: false,
      },
    });
  }
}
