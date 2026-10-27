import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { advanceStates, emergencyReason, nothingLeftToClimb, type ServiceState } from "../analysis/evaluate.ts";
import { emptyStats } from "../analysis/stats.ts";
import { ensureSessions, sessionsOf, writeK6Tokens, type UserSession } from "../browser/session.ts";
import { catalogSignature } from "../catalog/build.ts";
import type { Catalog } from "../catalog/types.ts";
import { loadApp, loadInteractions, loadServices, loadSettings, loadUsers, readJson, writeJson } from "../config/load.ts";
import { envHosts, hostsOutsideEnv } from "../config/safety.ts";
import type { AppProfile, EnvConfig, User } from "../config/types.ts";
import { envMatcher } from "../gateway/routes.ts";
import { envGuard } from "../guard/readonly.ts";
import { parseK6Output, startK6, writeJourneysFile, writePlanFile, type K6Handle } from "../load/k6runner.ts";
import { buildJourneys, buildLoadPlan, estimateUserRates, stepRates, type LoadPlan, type PlanFilters } from "../load/plan.ts";
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
  /** Users mode: virtual users per step (replaces steps), each opening pages with thinkTimeSec between them. */
  vus?: number[];
  thinkTimeSec?: number;
  /** Users mode: seconds over which each step's users arrive; requests in that time are left out of the figures. */
  rampUpSec?: number;
  /** Logins per account; each has its own token and so its own per-token rate-limit bucket. */
  sessionsPerUser?: number;
  /** Logins running at once. */
  loginConcurrency?: number;
}

export const DEFAULT_THINK_TIME_SEC = 10;

export function loadCatalog(env: Pick<EnvConfig, "name" | "webBaseUrl" | "gatewayBaseUrls">, app?: AppProfile): Catalog {
  const file = path.join(catalogDir(env.name), "catalog.json");
  if (!fs.existsSync(file)) throw new Error(`No catalog for "${env.name}". Run: npm run lt -- discover --env ${env.name}`);
  const catalog = readJson<Catalog>(file);
  const made = catalog.app ?? "retailer";
  if (app && made !== app.name) throw new Error(`The ${env.name} catalog was discovered for app "${made}", but the env is now app "${app.name}". Run discover again.`);
  const outside = hostsOutsideEnv(catalogUrls(catalog), env);
  if (outside.length) {
    throw new Error(
      `The ${env.name} catalog would send requests to ${outside.join(", ")}, which envs/${env.name}.json doesn't name: it was ` +
        `discovered against another deployment. Run discover again for this env, or keep one env name per deployment.`
    );
  }
  return catalog;
}

/** Every URL a catalog replays or visits: endpoint samples and page URLs. */
export function catalogUrls(catalog: Pick<Catalog, "endpoints" | "pages">): string[] {
  return [...catalog.endpoints.flatMap((e) => e.samples.map((s) => s.url)), ...catalog.pages.flatMap((p) => p.urls.map((u) => u.url))];
}

/**
 * The .env users the catalog was recorded with. Fails before logging in when one has no credentials here (e.g. a
 * catalog copied to another machine whose .env has fewer users).
 */
export function catalogUsers(env: Pick<EnvConfig, "userPrefix">, catalog: Pick<Catalog, "users">): User[] {
  const users = loadUsers(env);
  const missing = catalog.users.filter((k) => !users.some((u) => u.key === k));
  if (missing.length) {
    const prefix = env.userPrefix ?? "LT_USER_";
    const vars = missing.map((k) => `${prefix}${k.replace(/^user/, "")}_EMAIL / _PASSWORD`).join(", ");
    throw new Error(`The catalog was recorded with ${missing.join(", ")}, but .env on this machine has no credentials for them (${vars}). Add them, or run discover again with the users this .env has.`);
  }
  return users.filter((u) => catalog.users.includes(u.key));
}

/** Company-token apps: the companies each user's samples use, so logins cover exactly what will be replayed. */
export function catalogCompanies(catalog: Catalog): Record<string, string[]> | undefined {
  if (catalog.tokenScope !== "company") return undefined;
  const out: Record<string, string[]> = {};
  for (const e of catalog.endpoints) {
    for (const s of e.samples) {
      const list = (out[s.user] ??= []);
      if (!list.includes(s.companyId)) list.push(s.companyId);
    }
  }
  return out;
}

/** Fails before any load is sent when a planned request has no token (a company the user can no longer open). */
export function assertTokensFor(plan: LoadPlan, sessions: Record<string, UserSession>): void {
  const have = new Set(Object.values(sessions).map((s) => s.tokenKey ?? s.key));
  const missing = [...new Set(plan.services.flatMap((s) => s.slots.map((r) => r.token)))].filter((k) => !have.has(k));
  if (missing.length) {
    throw new Error(`No login for ${missing.length} planned token(s): ${missing.slice(0, 5).join(", ")}. The users may have lost access to these companies; run discover again.`);
  }
}

export function sessionList(sessions: Record<string, UserSession>, users: { key: string }[]): UserSession[] {
  return users.flatMap((u) => sessionsOf(sessions, u.key));
}

/** TLS certificate checks Node's fetch fails on hosts with an internal CA or an incomplete chain (devfms, 25 Oct 2026). */
const CERT_ERRORS = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/**
 * Why the environment looks down (its web host or Auth0 failing or 5xx), or undefined when it is up. A host counts as
 * down only when every attempt fails. A certificate Node can't verify still means the host answered: the browsers and
 * k6 skip certificate checks too, and dev's web host (internal CA) failed this check before every step 2.
 */
export async function environmentReachable(
  env: Pick<EnvConfig, "webBaseUrl" | "auth0Domain">,
  fetchFn: typeof fetch = fetch,
  attempts = 3,
  waitMs = 5_000
): Promise<string | undefined> {
  for (const url of [env.webBaseUrl, env.auth0Domain]) {
    let problem: string | undefined;
    for (let i = 1; i <= attempts; i++) {
      try {
        const res = await fetchFn(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(15_000) });
        problem = res.status >= 500 ? `${url} returned ${res.status}` : undefined;
      } catch (e) {
        const code = ((e as Error & { cause?: { code?: string } }).cause?.code) ?? "";
        // Node's message is only "fetch failed"; the cause code says why (connect timeout, DNS, reset).
        problem = CERT_ERRORS.has(code) ? undefined : `${url} unreachable (${(e as Error).message}${code ? `: ${code}` : ""})`;
      }
      if (!problem) break;
      if (i < attempts) await new Promise((r) => setTimeout(r, waitMs));
    }
    if (problem) return `${problem}, ${attempts} attempts`;
  }
  return undefined;
}

export async function runLoadTest(opts: RunOptions): Promise<string> {
  const { env, log } = opts;
  const settings = loadSettings();
  const app = loadApp(env);
  const catalog = loadCatalog(env, app);
  const users = catalogUsers(env, catalog);
  if (users.length === 0) throw new Error("None of the catalog's users are configured in .env.");
  const guard = envGuard(env, app);
  const services = loadServices(env);
  const sessionsPerUser = Math.max(1, opts.sessionsPerUser ?? 1);
  const usersMode = !!opts.vus?.length;
  const thinkSec = opts.thinkTimeSec ?? DEFAULT_THINK_TIME_SEC;
  const plan = buildLoadPlan(catalog, guard, services, settings.load.safetyFactor, opts.filters, sessionsPerUser);
  const journeys = usersMode ? buildJourneys(catalog, guard, opts.filters) : [];
  if (usersMode && journeys.length === 0) throw new Error("Users mode: no reached page has replayable calls to visit.");
  if (plan.services.length === 0) {
    const services = [...new Set(catalog.endpoints.map((e) => e.service))].sort().join(", ");
    const pages = catalog.pages.filter((p) => p.reached).map((p) => p.id).join(", ");
    throw new Error(`Nothing to load: no replayable catalog endpoints match the filters.\n  services: ${services}\n  pages: ${pages}`);
  }
  const matcher = envMatcher(env, settings.gatewayConfigDir);

  const steps = usersMode ? opts.vus! : (opts.steps ?? settings.load.stepsRps);
  const unit = usersMode ? "users" : "req/s";
  const stepDurationSec = opts.stepDurationSec ?? settings.load.stepDurationSec;
  const browsers = opts.browsers ?? settings.browser.workers;

  log(`Environment: ${env.name} (${env.kind}, app ${app.name})  hosts: ${envHosts(env).join(", ")}`);
  log(`Users: ${users.length}${sessionsPerUser > 1 ? ` x ${sessionsPerUser} sessions` : ""}  endpoints: ${plan.totalEndpoints}  services: ${plan.services.length}  browsers: ${browsers}`);
  if (usersMode) {
    log(`Steps (virtual users): ${steps.join(", ")}  x ${stepDurationSec}s each${opts.rampUpSec ? ` after a ${opts.rampUpSec}s ramp-up (not measured)` : ""}, ${thinkSec}s think time between pages, ${journeys.length} page journeys  -> up to ~${Math.round((steps.length * (stepDurationSec + 30)) / 60)} min`);
  } else {
    log(`Steps (total req/s): ${steps.join(", ")}  x ${stepDurationSec}s each  -> up to ~${Math.round((steps.length * (stepDurationSec + 30)) / 60)} min`);
  }
  // Users mode sends whatever the users cause; show where the peak would pass a service's per-token ceiling (429s).
  const peak = usersMode ? estimateUserRates(journeys, Math.max(...steps), thinkSec) : undefined;
  for (const s of plan.services) {
    const est = peak?.get(s.name);
    const over = est !== undefined && est > s.cap;
    log(`  ${s.name.padEnd(42)} endpoints=${String(s.endpoints.length).padStart(3)} users=${s.users.length}${s.tokens !== s.users.length ? ` tokens=${s.tokens}` : ""} cap=${fmtRate(s.cap)} req/s${est !== undefined ? `  ~${fmtRate(est)} req/s at ${Math.max(...steps)} users${over ? "  ABOVE CEILING: expect 429s (more --sessions-per-user)" : ""}` : ""}${s.limitsVerified ? "" : " (limit unverified)"}`);
  }
  if (plan.excluded.length) log(`Excluded endpoints: ${plan.excluded.length} (listed in the report)`);
  if (!opts.yes && !(await confirm("Start the load test? [y/N]"))) throw new Error("Cancelled.");

  const runDir = path.join(dirs.runs, `${timestamp()}-${env.name}${opts.label ? "-" + slug(opts.label) : ""}`);
  fs.mkdirSync(runDir, { recursive: true });
  const planFile = writePlanFile(runDir, plan);
  if (usersMode) writeJourneysFile(runDir, journeys);
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
    const ensureOpts = { companies: catalogCompanies(catalog), sessionsPerUser, loginConcurrency: opts.loginConcurrency };
    let sessions = await ensureSessions(browser, env, app, guard, users, horizon, log, ensureOpts);
    assertTokensFor(plan, sessions);
    if (browsers > 0) {
      layer = new BrowserLayer({
        browser,
        env,
        app,
        guard,
        sessions: sessionList(sessions, users),
        catalog,
        interactions: loadInteractions(app),
        settings,
        workers: browsers,
        onlyPage: opts.filters.onlyPage,
        log,
      });
      await layer.start();
    }

    for (let i = 0; i < steps.length; i++) {
      if (aborted) break;
      sessions = await ensureSessions(browser, env, app, guard, users, horizon, log, ensureOpts);
      assertTokensFor(plan, sessions);
      const tokensFile = writeK6Tokens(env.name, sessions);
      // Users mode: "rates" are only the expected request rates (the users decide); nothing is capped or held.
      const rates = usersMode
        ? new Map([...estimateUserRates(journeys, steps[i]!, thinkSec)].map(([k, r]) => [k, { rate: r, wanted: r, capped: false, held: false }]))
        : stepRates(plan, steps[i]!, held);
      const totalRate = [...rates.values()].reduce((a, r) => a + r.rate, 0);
      if (totalRate <= 0) {
        endReason = "no service left to load";
        break;
      }
      log(
        usersMode
          ? `Step ${i + 1}/${steps.length}: ${steps[i]} virtual users (~${fmtRate(totalRate)} req/s expected) for ${stepDurationSec}s`
          : `Step ${i + 1}/${steps.length}: target ${steps[i]} req/s, actual planned ${fmtRate(totalRate)} req/s for ${stepDurationSec}s`
      );

      const stepDir = path.join(runDir, `step-${String(i + 1).padStart(2, "0")}`);
      health.reset();
      const blockedBefore = layer?.blockedWrites ?? 0;
      const stepStart = new Date().toISOString();
      if (layer) layer.active = true;
      current = startK6(stepDir, planFile, tokensFile, {
        mode: usersMode ? "users" : "load",
        vus: usersMode ? steps[i] : undefined,
        thinkSec: usersMode ? thinkSec : undefined,
        rampSec: usersMode ? opts.rampUpSec : undefined,
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

      const result = await parseK6Output(path.join(stepDir, "k6.json.gz"), plan, { excludeFirstSec: usersMode ? opts.rampUpSec : undefined });
      if (result.all.n === 0) {
        endReason = `k6 produced no results (exit code ${exitCode}); see ${path.join(stepDir, "k6.log")}`;
        aborted ??= endReason;
        break;
      }
      const outcomes = plan.services
        .filter((s) => (rates.get(s.name)?.rate ?? 0) > 0)
        .map((s) => {
          const r = rates.get(s.name)!;
          const stats = result.services.get(s.name) ?? emptyStats();
          // Users mode: judge the rate the service actually got.
          return { name: s.name, rate: usersMode ? stats.rps : r.rate, capped: r.capped, held: r.held, stats };
        });
      const { newlyBroken } = advanceStates(states, i, outcomes, settings.break);
      for (const name of newlyBroken) {
        const st = states.get(name)!;
        if (usersMode) {
          // Every page that calls it keeps calling it: it can't be held back without changing what users do.
          log(`  BROKE: ${name} at ${steps[i]} users (${fmtRate(st.brokeAtRate ?? 0)} req/s, ${st.reasons.join(", ")})`);
          continue;
        }
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
        endpoints: [...result.endpoints].map(([key, v]) => ({ key, service: v.service, stats: v.stats, failures: v.failures })),
        variants: [...result.variants.values()].map((v) => ({ key: v.tpl, service: v.service, variant: v.variant, stats: v.stats })),
        pages: aggregatePages(stepVisits, matcher),
        visits: usersMode ? result.visits : undefined,
        visitsEstimated: usersMode ? result.visitsEstimated : undefined,
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
      app: app.name,
      envKind: env.kind,
      webBaseUrl: env.webBaseUrl,
      label: opts.label,
      startedAt,
      endedAt: new Date().toISOString(),
      runner: { host: os.hostname(), platform: `${os.platform()} ${os.arch()}`, cpus: os.cpus().length, memGb: Math.round(os.totalmem() / 1e9) },
      versions: { node: process.version, k6: k6Version(), playwright: playwrightVersion() },
      catalogCreatedAt: catalog.createdAt,
      catalogSignature: catalogSignature(catalog),
      filters: { onlyPage: opts.filters.onlyPage, onlyEndpoint: opts.filters.onlyEndpoint, onlyService: opts.filters.onlyService, excludeServices: opts.filters.excludeServices, bodySet: opts.filters.bodySet, dateRange: opts.filters.dateRange },
      stepsPlanned: steps,
      mode: usersMode ? "users" : "rate",
      thinkTimeSec: usersMode ? thinkSec : undefined,
      rampUpSec: usersMode ? opts.rampUpSec : undefined,
      sessionsPerUser,
      stepDurationSec,
      requestTimeoutSec: settings.load.requestTimeoutSec,
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
  if (systemBreak) log(`System breaking point: step ${systemBreak.step + 1} (${systemBreak.targetRps} ${unit}), first to break: ${systemBreak.services.join(", ")}`);
  log(`Report: ${path.join(runDir, "report.html")}`);
  return runDir;
}
