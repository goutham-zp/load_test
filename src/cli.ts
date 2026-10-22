import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { ensureSessions, loadSessions, saveSessions, sessionsOf } from "./browser/session.ts";
import { loadApp, loadEnv, loadSettings, loadUsers, readJson, writeJson } from "./config/load.ts";
import { prodLikeHosts } from "./config/safety.ts";
import type { EnvConfig } from "./config/types.ts";
import { discover } from "./discover/discover.ts";
import { envMatcher } from "./gateway/routes.ts";
import { envGuard } from "./guard/readonly.ts";
import { dirs, ROOT } from "./paths.ts";
import { computeComparison, renderComparison } from "./report/compare.ts";
import { renderRunReport } from "./report/runReport.ts";
import { renderDiscoveryReport } from "./report/discoveryReport.ts";
import type { DiscoveryTimings } from "./discover/timings.ts";
import type { RunResults } from "./run/results.ts";
import { runLoadTest } from "./run/run.ts";
import { smoke } from "./run/smoke.ts";
import { ask, k6Version, log } from "./util.ts";

const HELP = `dxp-loadtest — read-only load testing for the DXP retailer portal

Usage: npm run lt -- <command> [options]

Commands
  setup                        Check/install k6 and Playwright Chromium
  login     --env <name>       Log the users in (headless) and save sessions
  discover  --env <name>       Crawl pages + interactions, record API calls, write the catalog
            [--users user1,user2] [--pages id1,id2] [--max-companies N] [--headed]
            With --users or --pages, the run is merged into the previous catalog
            (add --replace to start fresh). The previous catalog is always backed up.
  smoke     --env <name>       Every endpoint once + every page once; must pass before run
  run       --env <name>       Stepped load test (k6) with browsers measuring pages
            [--label text] [--only-page id | --only-endpoint text | --only-service name]
            [--steps 5,10,25] [--step-duration 180] [--browsers 5]
            [--stop-at-first-break] [--yes]
  report    <runDir>           Re-render a run's report.html (or a discovery's discovery.html)
  compare   <runDirA> <runDirB> [--out file.html]
  routes    <method> <path>    Show which gateway route/service a path maps to

Global
  --allow-prod-like            Required (plus typed confirmation) for hosts that look like production
`;

async function guardProd(env: EnvConfig, allow: boolean): Promise<void> {
  const prod = prodLikeHosts(env);
  if (prod.length === 0) return;
  if (!allow) {
    throw new Error(`Env "${env.name}" has production-like hosts (${prod.join(", ")}). Refusing. Use --allow-prod-like if you really mean it.`);
  }
  const typed = await ask(`Hosts ${prod.join(", ")} look like PRODUCTION. Type the env name (${env.name}) to continue:`);
  if (typed !== env.name) throw new Error("Not confirmed.");
}

function list(v: unknown): string[] | undefined {
  return typeof v === "string" && v.length ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
}

function resolveRunDir(p: string, file = "results.json"): string {
  const candidates = [p, path.join(dirs.runs, p), path.join(ROOT, p)];
  const found = candidates.find((c) => fs.existsSync(path.join(c, file)));
  if (!found) throw new Error(`No ${file} in ${p} (also looked under runs/).`);
  return path.resolve(found);
}

async function setup(): Promise<void> {
  const k6 = k6Version();
  if (k6 === "not installed") {
    log("k6 is not installed.");
    if (process.platform === "darwin") log("Install with: brew install k6");
    else log("Install from https://grafana.com/docs/k6/latest/set-up/install-k6/ (or use the Dockerfile).");
  } else log(`k6: ${k6}`);
  log("Installing Playwright Chromium (headless shell)...");
  const args = ["playwright", "install", "chromium"];
  if (process.platform === "linux") args.push("--with-deps");
  const res = spawnSync("npx", args, { stdio: "inherit", cwd: ROOT });
  if (res.status !== 0) throw new Error("Playwright browser install failed.");
  if (!fs.existsSync(path.join(ROOT, ".env"))) {
    fs.copyFileSync(path.join(ROOT, ".env.example"), path.join(ROOT, ".env"));
    log("Created .env from .env.example; fill in the users.");
  }
  log("Setup done.");
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      env: { type: "string" },
      users: { type: "string" },
      pages: { type: "string" },
      "max-companies": { type: "string" },
      headed: { type: "boolean", default: false },
      replace: { type: "boolean", default: false },
      label: { type: "string" },
      "only-page": { type: "string" },
      "only-endpoint": { type: "string" },
      "only-service": { type: "string" },
      steps: { type: "string" },
      "step-duration": { type: "string" },
      browsers: { type: "string" },
      "stop-at-first-break": { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      out: { type: "string" },
      "allow-prod-like": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  const [cmd, ...rest] = positionals;
  if (!cmd || values.help) {
    process.stdout.write(HELP);
    return;
  }

  const needEnv = async (): Promise<EnvConfig> => {
    if (!values.env) throw new Error(`--env is required for "${cmd}".`);
    const env = loadEnv(values.env);
    await guardProd(env, values["allow-prod-like"]);
    return env;
  };

  switch (cmd) {
    case "setup":
      await setup();
      return;

    case "login": {
      const env = await needEnv();
      const users = loadUsers(env);
      const app = loadApp(env);
      const sessions = loadSessions(env.name);
      for (const u of users) for (const sess of sessionsOf(sessions, u.key)) delete sessions[sess.key];
      saveSessions(env.name, sessions);
      const browser = await chromium.launch({ headless: !values.headed });
      try {
        const maxCompanies = values["max-companies"] ? Number(values["max-companies"]) : loadSettings().discovery.maxCompaniesPerUser;
        await ensureSessions(browser, env, app, envGuard(env, app), users, 0, log, { maxCompanies });
      } finally {
        await browser.close();
      }
      return;
    }

    case "discover": {
      const env = await needEnv();
      const { catalog, file, reportFile, merged, backupDir } = await discover({
        env,
        onlyUsers: list(values.users),
        onlyPages: list(values.pages),
        maxCompanies: values["max-companies"] ? Number(values["max-companies"]) : undefined,
        headed: values.headed,
        replace: values.replace,
        log,
      });
      if (backupDir) log(`Previous catalog backed up to ${backupDir}`);
      if (merged) log(`Merged into the previous catalog: only the users/pages/companies visited now were replaced.`);
      const withSamples = catalog.endpoints.filter((e) => e.samples.length);
      const variants = withSamples.reduce((a, e) => a + e.variants.length, 0);
      log(`Catalog: ${file}`);
      log(`  endpoints: ${catalog.endpoints.length} (${withSamples.length} with successful samples, ${variants} variants)`);
      log(`  pages reached: ${catalog.pages.filter((p) => p.reached).length}/${catalog.pages.length}`);
      for (const p of catalog.pages.filter((x) => !x.reached)) log(`    not reached: ${p.id} — ${p.note ?? ""}`);
      const unmatched = withSamples.filter((e) => !e.matchedRoute);
      if (unmatched.length) log(`  endpoints not in gateway config: ${unmatched.length} (grouped as unknown:*)`);
      if (catalog.failures.length) log(`  non-2xx responses seen: ${catalog.failures.map((f) => `${f.key} ${f.status === 0 ? "no response " : f.status}×${f.count}`).slice(0, 10).join("; ")}`);
      for (const h of catalog.untrackedHosts ?? []) {
        log(`  API calls to a host not in gatewayBaseUrls (not recorded): ${h.origin}  ${h.count}× e.g. ${h.example}`);
      }
      if (catalog.untrackedHosts?.length) log(`  Add the API hosts to gatewayBaseUrls in envs/${catalog.env}.json (and hostServices for direct ones), then re-run discover.`);
      if (catalog.blocked.length) {
        log(`  writes blocked by the read-only guard: ${catalog.blocked.length}. If any are really reads (search/report POSTs),`);
        log(`  copy their suggestedAllowlistEntry into config/read-allowlist.json with "reviewed": true, then re-run discover:`);
        for (const b of catalog.blocked.slice(0, 15)) log(`    ${b.method} ${b.pathTemplate}  (page ${b.page}, ${b.count}×)`);
      }
      log(`API timings without load: ${reportFile}`);
      return;
    }

    case "smoke": {
      const env = await needEnv();
      const r = await smoke(env, log);
      for (const f of r.endpointFailures) log(`  FAIL ${f.key}: ${f.ok}/${f.n} ok (5xx/timeout ${f.errors}, 4xx ${f.clientErrors}, 429 ${f.throttled})`);
      for (const f of r.pageFailures) log(`  FAIL page ${f.page}: ${f.problem}`);
      if (r.blockedWrites.length) log(`  ${r.blockedWrites.length} writes were blocked in the browser (see smoke.json).`);
      log(`${r.passed ? "SMOKE PASSED" : "SMOKE FAILED"} — ${path.join(r.runDir, "smoke.html")}`);
      if (!r.passed) process.exitCode = 1;
      return;
    }

    case "run": {
      const env = await needEnv();
      const steps = list(values.steps)?.map(Number);
      if (steps?.some((s) => !Number.isFinite(s) || s <= 0)) throw new Error("--steps must be positive numbers, e.g. 5,10,25");
      const only = [values["only-page"], values["only-endpoint"], values["only-service"]].filter(Boolean);
      if (only.length > 1) throw new Error("Use only one of --only-page, --only-endpoint, --only-service.");
      await runLoadTest({
        env,
        label: values.label,
        filters: { onlyPage: values["only-page"], onlyEndpoint: values["only-endpoint"], onlyService: values["only-service"] },
        steps,
        stepDurationSec: values["step-duration"] ? Number(values["step-duration"]) : undefined,
        browsers: values.browsers !== undefined ? Number(values.browsers) : undefined,
        stopAtFirstBreak: values["stop-at-first-break"],
        yes: values.yes,
        log,
      });
      return;
    }

    case "report": {
      if (!rest[0]) throw new Error("Usage: report <runDir>");
      const discoveryDir = [rest[0], path.join(dirs.runs, rest[0])].find((c) => fs.existsSync(path.join(c, "timings.json")));
      if (discoveryDir) {
        const timings = readJson<DiscoveryTimings>(path.join(discoveryDir, "timings.json"));
        fs.writeFileSync(path.join(discoveryDir, "discovery.html"), renderDiscoveryReport(timings));
        log(`Report: ${path.resolve(discoveryDir, "discovery.html")}`);
        return;
      }
      const dir = resolveRunDir(rest[0]);
      const results = readJson<RunResults>(path.join(dir, "results.json"));
      fs.writeFileSync(path.join(dir, "report.html"), renderRunReport(results));
      log(`Report: ${path.join(dir, "report.html")}`);
      return;
    }

    case "compare": {
      if (rest.length < 2) throw new Error("Usage: compare <runDirA> <runDirB> [--out file.html]");
      const a = readJson<RunResults>(path.join(resolveRunDir(rest[0]!), "results.json"));
      const b = readJson<RunResults>(path.join(resolveRunDir(rest[1]!), "results.json"));
      const c = computeComparison(a, b);
      const out = values.out ?? path.join(dirs.runs, `compare-${path.basename(resolveRunDir(rest[0]!))}-vs-${path.basename(resolveRunDir(rest[1]!))}.html`);
      fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
      fs.writeFileSync(out, renderComparison(a, b, c));
      writeJson(out.replace(/\.html$/, "") + ".json", {
        a: rest[0],
        b: rest[1],
        commonSteps: c.commonSteps,
        mismatches: c.mismatches,
        endpoints: Object.fromEntries([...c.endpoints].map(([k, v]) => [c.commonSteps[k]!.targetRps, v])),
      });
      for (const m of c.mismatches) log(`  note: ${m}`);
      log(`Comparison: ${path.resolve(out)}`);
      return;
    }

    case "routes": {
      const [method, p] = rest;
      if (!method || !p) throw new Error("Usage: routes <METHOD> <path>");
      const settings = loadSettings();
      const env = values.env ? loadEnv(values.env) : undefined;
      const matcher = envMatcher(env ?? {}, settings.gatewayConfigDir);
      const direct = p.startsWith("http") ? matcher.hostService(p) : undefined;
      if (direct) {
        log(`${direct}  (direct host, from hostServices in envs/${env!.name}.json)`);
        return;
      }
      const r = matcher.match(method, p.startsWith("http") ? new URL(p).pathname : p);
      log(r ? `${r.service}  ${r.method} ${r.gatewayPath} -> ${r.host}${r.servicePath}` : "No matching gateway route.");
      return;
    }

    default:
      process.stdout.write(HELP);
      process.exitCode = 1;
  }
}

main().catch((err: Error) => {
  log(`ERROR: ${err.message}`);
  process.exitCode = 1;
});

