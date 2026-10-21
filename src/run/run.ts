import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { advanceStates, emergencyReason, nothingLeftToClimb, type ServiceState } from "../analysis/evaluate.ts";
import { emptyStats } from "../analysis/stats.ts";
import { ensureSessions, writeK6Tokens } from "../browser/session.ts";
import { catalogSignature } from "../catalog/build.ts";
import type { Catalog } from "../catalog/types.ts";
import { loadAllowlist, loadInteractions, loadServices, loadSettings, loadUsers, readJson, writeJson } from "../config/load.ts";
import { envHosts } from "../config/safety.ts";
import type { EnvConfig } from "../config/types.ts";
import { createRouteMatcher, loadGatewayRoutes } from "../gateway/routes.ts";
import { compileGuard } from "../guard/readonly.ts";
import { parseK6Output, startK6, writePlanFile, type K6Handle } from "../load/k6runner.ts";
import { buildLoadPlan, stepRates, type PlanFilters } from "../load/plan.ts";
import { catalogDir, dirs, expandHome } from "../paths.ts";
import { renderRunReport } from "../report/runReport.ts";
import { confirm, fmtRate, k6Version, playwrightVersion, slug, timestamp } from "../util.ts";
import { BrowserLayer } from "./browserLayer.ts";
import { HealthSampler } from "./health.ts";
import { aggregatePages, type RunResults, type StepRecord } from "./results.ts";
import { buildWarnings } from "./warnings.ts";

export interface RunOptions {
  env: EnvConfig;
  label?: string;
  filters: PlanFilters;
  steps?: number[];
  stepDurationSec?: number;
  browsers?: number;
  stopAtFirstBreak: boolean;
  yes: boolean;
  log: (m: string) => void;
}

export function loadCatalog(envName: string): Catalog {
  const file = path.join(catalogDir(envName), "catalog.json");
  if (!fs.existsSync(file)) throw new Error(`No catalog for "${envName}". Run: npm run lt -- discover --env ${envName}`);
  return readJson<Catalog>(file);
}

async function environmentReachable(env: EnvConfig): Promise<string | undefined> {
  for (const url of [env.webBaseUrl, env.auth0Domain]) {
    try {
      const res = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(15_000) });
      if (res.status >= 500) return `${url} returned ${res.status}`;
    } catch (e) {
      return `${url} unreachable (${(e as Error).message})`;
    }
  }
  return undefined;
}

export async function runLoadTest(opts: RunOptions): Promise<string> {
  const { env, log } = opts;
  const settings = loadSettings();
  const catalog = loadCatalog(env.name);
  const users = loadUsers().filter((u) => catalog.users.includes(u.key));
  if (users.length === 0) throw new Error("None of the catalog's users are configured in .env.");
  const guard = compileGuard({ auth0Host: new URL(env.auth0Domain).host, allowlist: loadAllowlist(), blockedThirdPartyHosts: settings.blockedThirdPartyHosts });
  const services = loadServices(env);
  const plan = buildLoadPlan(catalog, guard, services, settings.load.safetyFactor, opts.filters);
  if (plan.services.length === 0) {
    const services = [...new Set(catalog.endpoints.map((e) => e.service))].sort().join(", ");
    const pages = catalog.pages.filter((p) => p.reached).map((p) => p.id).join(", ");
    throw new Error(`Nothing to load: no replayable catalog endpoints match the filters.\n  services: ${services}\n  pages: ${pages}`);
  }
  const matcher = createRouteMatcher(loadGatewayRoutes(expandHome(env.gatewayConfigDir ?? settings.gatewayConfigDir)));

  const steps = opts.steps ?? settings.load.stepsRps;
  const stepDurationSec = opts.stepDurationSec ?? settings.load.stepDurationSec;
  const browsers = opts.browsers ?? settings.browser.workers;

  log(`Environment: ${env.name} (${env.kind})  hosts: ${envHosts(env).join(", ")}`);
  log(`Users: ${users.length}  endpoints: ${plan.totalEndpoints}  services: ${plan.services.length}  browsers: ${browsers}`);
  log(`Steps (total req/s): ${steps.join(", ")}  x ${stepDurationSec}s each  -> up to ~${Math.round((steps.length * (stepDurationSec + 30)) / 60)} min`);
  for (const s of plan.services) {
    log(`  ${s.name.padEnd(42)} endpoints=${String(s.endpoints.length).padStart(3)} users=${s.users.length} cap=${fmtRate(s.cap)} req/s${s.limitsVerified ? "" : " (limit unverified)"}`);
  }
  if (plan.excluded.length) log(`Excluded endpoints: ${plan.excluded.length} (listed in the report)`);
  if (!opts.yes && !(await confirm("Start the load test? [y/N]"))) throw new Error("Cancelled.");

  const runDir = path.join(dirs.runs, `${timestamp()}-${env.name}${opts.label ? "-" + slug(opts.label) : ""}`);
  fs.mkdirSync(runDir, { recursive: true });
  const planFile = writePlanFile(runDir, plan);
  const startedAt = new Date().toISOString();

  const browser = await chromium.launch({ headless: true });
  const health = new HealthSampler();
  health.start();
  let current: K6Handle | undefined;
  let aborted: string | undefined;
  let firstInterrupt = 0;
  const onSigint = () => {
    // A terminal Ctrl-C can arrive twice (shell process group + tsx relaying it); treat a burst as one.
    if (firstInterrupt && Date.now() - firstInterrupt > 1500) {
      current?.child.kill("SIGKILL");
      process.exit(130);
    }
    if (firstInterrupt) return;
    firstInterrupt = Date.now();
    aborted = "interrupted (Ctrl-C)";
    log("Stopping after the current step (press Ctrl-C again to quit immediately)...");
    current?.child.kill("SIGINT");
  };
  process.on("SIGINT", onSigint);

  const states = new Map<string, ServiceState>(plan.services.map((s) => [s.name, { name: s.name, status: "climbing", reasons: [] }]));
  const held = new Map<string, number>();
  const records: StepRecord[] = [];
  let systemBreak: RunResults["systemBreak"];
  let endReason = "all steps completed";
  let layer: BrowserLayer | undefined;

  try {
    const horizon = stepDurationSec + 120 + settings.tokenRefreshMarginSec;
    let sessions = await ensureSessions(browser, env, users, horizon, log);
    if (browsers > 0) {
      layer = new BrowserLayer({
        browser,
        env,
        guard,
        sessions: users.map((u) => sessions[u.key]!),
        catalog,
        interactions: loadInteractions(),
        settings,
        workers: browsers,
        onlyPage: opts.filters.onlyPage,
        log,
      });
      await layer.start();
    }

    for (let i = 0; i < steps.length; i++) {
      if (aborted) break;
      sessions = await ensureSessions(browser, env, users, horizon, log);
      const tokensFile = writeK6Tokens(env.name, sessions);
      const rates = stepRates(plan, steps[i]!, held);
      const totalRate = [...rates.values()].reduce((a, r) => a + r.rate, 0);
      if (totalRate <= 0) {
        endReason = "no service left to load";
        break;
      }
      log(`Step ${i + 1}/${steps.length}: target ${steps[i]} req/s, actual planned ${fmtRate(totalRate)} req/s for ${stepDurationSec}s`);

      const stepDir = path.join(runDir, `step-${String(i + 1).padStart(2, "0")}`);
      health.reset();
      const blockedBefore = layer?.blockedWrites ?? 0;
      const stepStart = new Date().toISOString();
      if (layer) layer.active = true;
      current = startK6(stepDir, planFile, tokensFile, {
        mode: "load",
        rates: Object.fromEntries([...rates].map(([k, v]) => [k, v.rate])),
        durationSec: stepDurationSec,
        timeoutSec: settings.load.requestTimeoutSec,
        maxVUs: settings.load.maxVUsPerService,
        smokePace: {},
      }, log);
      const exitCode = await current.done;
      current = undefined;
      if (layer) layer.active = false;
      const stepEnd = new Date().toISOString();

      const result = await parseK6Output(path.join(stepDir, "k6.json.gz"), plan);
      if (result.all.n === 0) {
        endReason = `k6 produced no results (exit code ${exitCode}); see ${path.join(stepDir, "k6.log")}`;
        aborted ??= endReason;
        break;
      }
      const outcomes = plan.services
        .filter((s) => (rates.get(s.name)?.rate ?? 0) > 0)
        .map((s) => {
          const r = rates.get(s.name)!;
          return { name: s.name, rate: r.rate, capped: r.capped, held: r.held, stats: result.services.get(s.name) ?? emptyStats() };
        });
      const { newlyBroken } = advanceStates(states, i, outcomes, settings.break);
      for (const name of newlyBroken) {
        const st = states.get(name)!;
        held.set(name, st.heldRate ?? 0);
        log(`  BROKE: ${name} at ${fmtRate(st.brokeAtRate ?? 0)} req/s (${st.reasons.join(", ")}); holding at ${fmtRate(st.heldRate ?? 0)} req/s`);
      }
      if (newlyBroken.length && !systemBreak) systemBreak = { step: i, targetRps: steps[i]!, services: newlyBroken };

      const stepVisits = layer ? layer.visitsWithin(Date.parse(stepStart), Date.parse(stepEnd)) : [];
      const record: StepRecord = {
        index: i,
        targetRps: steps[i]!,
        startedAt: stepStart,
        endedAt: stepEnd,
        windowSec: result.windowSec,
        overall: result.all,
        services: plan.services
          .filter((s) => rates.has(s.name))
          .map((s) => {
            const r = rates.get(s.name)!;
            return {
              name: s.name,
              plannedRps: r.rate,
              wantedRps: r.wanted,
              cap: Number.isFinite(s.cap) ? s.cap : null,
              capped: r.capped,
              held: r.held,
              stats: result.services.get(s.name) ?? emptyStats(),
              dropped: result.droppedByService.get(s.name) ?? 0,
              throttled: result.throttledByService.get(s.name) ?? {},
              broke: newlyBroken.includes(s.name) ? states.get(s.name)!.reasons : undefined,
            };
          }),
        endpoints: [...result.endpoints].map(([key, v]) => ({ key, service: v.service, stats: v.stats })),
        variants: [...result.variants.values()].map((v) => ({ key: v.tpl, service: v.service, variant: v.variant, stats: v.stats })),
        pages: aggregatePages(stepVisits, matcher),
        runner: health.summary(),
        refused: result.refused,
        blockedWrites: (layer?.blockedWrites ?? 0) - blockedBefore,
        k6ExitCode: exitCode,
      };
      records.push(record);
      const o = result.all;
      log(`  done: ${o.n} requests, ${o.rps} req/s, p95 ${o.p95} ms, errors ${(o.errorRate * 100).toFixed(1)}%, 429s ${o.throttled}, browser visits ${stepVisits.length}, runner CPU max ${record.runner.cpuMax}%`);
      writeJson(path.join(stepDir, "step-result.json"), record);

      const emergency = emergencyReason(result.all, settings.emergency) ?? (await environmentReachable(env));
      if (emergency) {
        record.emergency = emergency;
        aborted = `emergency stop: ${emergency}`;
        log(`EMERGENCY STOP: ${emergency}`);
        break;
      }
      if (opts.stopAtFirstBreak && newlyBroken.length) {
        endReason = "stopped at first break (--stop-at-first-break)";
        break;
      }
      if (nothingLeftToClimb(states)) {
        endReason = "every service is broken or at its rate-limit ceiling";
        break;
      }
    }
  } catch (e) {
    // Keep the steps already measured: report them with the failure as the end reason.
    if (records.length === 0) throw e;
    aborted = `failed: ${(e as Error).message.split("\n")[0]}`;
    log(`ERROR during run: ${(e as Error).message}`);
  } finally {
    process.off("SIGINT", onSigint);
    await layer?.stop();
    health.stop();
    await browser.close();
  }

  const svcCfgs = plan.services.map((s) => {
    const cfg = services.get(s.name);
    return {
      name: s.name,
      endpoints: s.endpoints.length,
      users: s.users.length,
      cap: Number.isFinite(s.cap) ? s.cap : null,
      limitsVerified: s.limitsVerified,
      knownService: s.knownService,
      repoPath: cfg.repo ? path.join(expandHome(settings.backendsDir), cfg.repo) : undefined,
    };
  });

  const results: RunResults = {
    meta: {
      tool: "dxp-loadtest",
      kind: "run",
      env: env.name,
      envKind: env.kind,
      webBaseUrl: env.webBaseUrl,
      label: opts.label,
      startedAt,
      endedAt: new Date().toISOString(),
      runner: { host: os.hostname(), platform: `${os.platform()} ${os.arch()}`, cpus: os.cpus().length, memGb: Math.round(os.totalmem() / 1e9) },
      versions: { node: process.version, k6: k6Version(), playwright: playwrightVersion() },
      catalogCreatedAt: catalog.createdAt,
      catalogSignature: catalogSignature(catalog),
      filters: { onlyPage: opts.filters.onlyPage, onlyEndpoint: opts.filters.onlyEndpoint, onlyService: opts.filters.onlyService },
      stepsPlanned: steps,
      stepDurationSec,
      browsers,
      users: users.length,
      stopAtFirstBreak: opts.stopAtFirstBreak,
      breakRules: settings.break,
      safetyFactor: settings.load.safetyFactor,
      endReason: aborted ?? endReason,
    },
    plan: { services: svcCfgs, excluded: plan.excluded, totalEndpoints: plan.totalEndpoints },
    steps: records,
    services: [...states.values()],
    systemBreak,
    endpointsMeta: Object.fromEntries(catalog.endpoints.map((e) => [e.key, { service: e.service, servicePath: e.servicePath, pages: e.pages }])),
    pagesMeta: catalog.pages.map((p) => ({ id: p.id, reached: p.reached, interactions: p.interactions, note: p.note })),
    warnings: [],
  };
  results.warnings = buildWarnings(results, catalog);
  writeJson(path.join(runDir, "results.json"), results);
  fs.writeFileSync(path.join(runDir, "report.html"), renderRunReport(results));
  log(`Finished: ${results.meta.endReason}`);
  if (systemBreak) log(`System breaking point: step ${systemBreak.step + 1} (${systemBreak.targetRps} req/s target), first to break: ${systemBreak.services.join(", ")}`);
  log(`Report: ${path.join(runDir, "report.html")}`);
  return runDir;
}
