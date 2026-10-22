import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import zlib from "node:zlib";
import { StatsBuilder, type Stats } from "../analysis/stats.ts";
import { writeJson } from "../config/load.ts";
import { dirs } from "../paths.ts";
import type { RunResults } from "../run/results.ts";
import type { Journey, LoadPlan } from "./plan.ts";

export interface StepInput {
  /** load: requests per second per service. smoke: each slot once. users: `vus` virtual users opening pages. */
  mode: "load" | "smoke" | "users";
  rates: Record<string, number>;
  /** Users mode: virtual users in this step and seconds each waits between pages (varied +-50%). */
  vus?: number;
  thinkSec?: number;
  durationSec: number;
  timeoutSec: number;
  maxVUs: number;
  /** Smoke mode: seconds to sleep between requests, per service (keeps each service under its limit). */
  smokePace: Record<string, number>;
}

/**
 * Writes the plan k6 replays (plan.json) plus a small index (plan-index.json: names and slot counts). Every k6 VU
 * reads the index; the slots are loaded once into SharedArrays, so memory does not grow with the VU count.
 * Kept in the run folder; contains no tokens.
 */
export function writePlanFile(runDir: string, plan: LoadPlan): string {
  const file = path.join(runDir, "plan.json");
  writeJson(file, { services: plan.services.map((s) => ({ name: s.name, slots: s.slots })) });
  writeJson(planIndexFile(file), { services: plan.services.map((s) => ({ name: s.name, slots: s.slots.length })) });
  return file;
}

/**
 * Users mode: the journeys (journeys.json, loaded once into a SharedArray) and a small index of journey numbers per
 * token (journeys-index.json), next to plan.json. Contains no tokens.
 */
export function writeJourneysFile(runDir: string, journeys: Journey[]): string {
  const file = path.join(runDir, "journeys.json");
  writeJson(file, { journeys });
  const byToken: Record<string, number[]> = {};
  journeys.forEach((j, i) => (byToken[j.token] ??= []).push(i));
  writeJson(file.replace(/\.json$/, "-index.json"), { tokens: Object.keys(byToken).sort(), byToken });
  return file;
}

export function planIndexFile(planFile: string): string {
  return planFile.replace(/\.json$/, "-index.json");
}

export interface K6Handle {
  child: ChildProcess;
  done: Promise<number>;
  outFile: string;
  summaryFile: string;
}

export function startK6(stepDir: string, planFile: string, tokensFile: string, input: StepInput, log: (m: string) => void): K6Handle {
  fs.mkdirSync(stepDir, { recursive: true });
  const stepFile = path.join(stepDir, "step.json");
  writeJson(stepFile, input);
  const outFile = path.join(stepDir, "k6.json.gz");
  const summaryFile = path.join(stepDir, "k6-summary.json");
  const child = spawn("k6", ["run", "--quiet", "--no-usage-report", "--out", `json=${outFile}`, dirs.k6Script], {
    env: {
      ...process.env,
      LT_PLAN: planFile,
      LT_PLAN_INDEX: planIndexFile(planFile),
      LT_STEP: stepFile,
      LT_TOKENS: tokensFile,
      LT_SUMMARY: summaryFile,
      ...(input.mode === "users" ? { LT_JOURNEYS: path.join(path.dirname(planFile), "journeys.json"), LT_JOURNEYS_INDEX: path.join(path.dirname(planFile), "journeys-index.json") } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
    // Own process group: a terminal Ctrl-C reaches only us, and we forward exactly one SIGINT to k6.
    detached: true,
  });
  const logFile = fs.createWriteStream(path.join(stepDir, "k6.log"));
  child.stdout?.pipe(logFile);
  child.stderr?.on("data", (d: Buffer) => {
    logFile.write(d);
    const text = d.toString().trim();
    if (/level=(error|warning)/.test(text) && !/Request Failed/.test(text)) log(`k6: ${text.split("\n")[0]}`);
  });
  const done = new Promise<number>((resolve, reject) => {
    child.on("error", (err) => reject(new Error(`could not start k6 (${err.message}). Is it installed? Run: npm run lt -- setup`)));
    child.on("close", (code) => {
      logFile.end();
      resolve(code ?? 0);
    });
  });
  return { child, done, outFile, summaryFile };
}

export interface K6StepResult {
  windowSec: number;
  all: Stats;
  services: Map<string, Stats>;
  endpoints: Map<string, { service: string; stats: Stats; failures: Record<string, number> }>;
  /** Pages opened per page id (users mode). */
  visits: Record<string, number>;
  /** True when the output has no lt_visits counter (older runs): visits are then the most calls of any one API per page. */
  visitsEstimated: boolean;
  variants: Map<string, { service: string; tpl: string; variant: string; stats: Stats }>;
  throttledBySource: Record<string, number>;
  throttledByService: Map<string, Record<string, number>>;
  droppedByService: Map<string, number>;
  refused: number;
}

interface Point {
  metric: string;
  type: string;
  data: { time: string; value: number; tags?: Record<string, string> };
}

/** Why a call failed, from its status and k6's error_code (https://grafana.com/docs/k6/latest/javascript-api/error-codes/). */
export function failureReason(status: number, errorCode?: string): string | undefined {
  if (status === 429) return "HTTP 429 (rate limited)";
  if (status >= 400) return `HTTP ${status}`;
  if (status !== 0) return undefined;
  const code = Number(errorCode);
  if (code === 1050) return "Timed out (no response)";
  if (code === 1211) return "Connect timed out";
  if (code === 1212) return "Connection refused";
  if (code === 1220 || code === 1201) return "Connection reset by server";
  if (code >= 1100 && code < 1200) return "DNS lookup failed";
  if (code >= 1300 && code < 1400) return "TLS error";
  if (code >= 1600 && code < 1700) return "HTTP/2 error";
  return errorCode ? `Request failed (k6 error ${errorCode})` : "Request failed (no response)";
}

/** Streams k6's gzipped JSON output and aggregates per service, endpoint and parameter variant. */
export async function parseK6Output(outFile: string, plan: LoadPlan): Promise<K6StepResult> {
  const all = new StatsBuilder();
  const services = new Map<string, StatsBuilder>();
  const endpoints = new Map<string, { service: string; b: StatsBuilder; failures: Record<string, number> }>();
  const visits: Record<string, number> = {};
  const callsPerPage = new Map<string, Map<string, number>>();
  const variants = new Map<string, { service: string; tpl: string; variant: string; b: StatsBuilder }>();
  const throttledBySource: Record<string, number> = {};
  const throttledByService = new Map<string, Record<string, number>>();
  const droppedByService = new Map<string, number>();
  let refused = 0;
  let first = Infinity;
  let last = 0;

  if (fs.existsSync(outFile)) {
    const gunzip = zlib.createGunzip();
    // An interrupted k6 can leave a truncated gzip; keep everything read up to that point.
    gunzip.on("error", () => gunzip.end());
    const rl = readline.createInterface({ input: fs.createReadStream(outFile).pipe(gunzip), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.includes("\"Point\"")) continue;
      let p: Point;
      try {
        p = JSON.parse(line);
      } catch {
        continue;
      }
      const tags = p.data.tags ?? {};
      if (p.metric === "http_req_duration") {
        const status = Number(tags.status ?? 0);
        const svc = tags.svc ?? "?";
        const tpl = tags.tpl ?? "?";
        const variant = tags.variant ?? "base";
        const t = Date.parse(p.data.time);
        first = Math.min(first, t);
        last = Math.max(last, t);
        all.add(status, p.data.value);
        if (!services.has(svc)) services.set(svc, new StatsBuilder());
        services.get(svc)!.add(status, p.data.value);
        if (!endpoints.has(tpl)) endpoints.set(tpl, { service: svc, b: new StatsBuilder(), failures: {} });
        const ep = endpoints.get(tpl)!;
        ep.b.add(status, p.data.value);
        const reason = failureReason(status, tags.error_code);
        if (reason) ep.failures[reason] = (ep.failures[reason] ?? 0) + 1;
        if (tags.page) {
          const calls = callsPerPage.get(tags.page) ?? new Map<string, number>();
          calls.set(tpl, (calls.get(tpl) ?? 0) + 1);
          callsPerPage.set(tags.page, calls);
        }
        const vk = `${tpl}\u0000${variant}`;
        if (!variants.has(vk)) variants.set(vk, { service: svc, tpl, variant, b: new StatsBuilder() });
        variants.get(vk)!.b.add(status, p.data.value);
      } else if (p.metric === "lt_throttled") {
        const source = tags.source ?? "unknown";
        throttledBySource[source] = (throttledBySource[source] ?? 0) + p.data.value;
        const svc = tags.svc ?? "?";
        const rec = throttledByService.get(svc) ?? {};
        rec[source] = (rec[source] ?? 0) + p.data.value;
        throttledByService.set(svc, rec);
      } else if (p.metric === "dropped_iterations") {
        const idx = Number((tags.scenario ?? "").replace(/^s/, ""));
        const svc = plan.services[idx]?.name;
        if (svc) droppedByService.set(svc, (droppedByService.get(svc) ?? 0) + p.data.value);
      } else if (p.metric === "lt_visits") {
        const page = tags.page ?? "?";
        visits[page] = (visits[page] ?? 0) + p.data.value;
      } else if (p.metric === "lt_refused") {
        refused += p.data.value;
      }
    }
  }

  const windowSec = last > first ? (last - first) / 1000 : 0;
  const visitsEstimated = Object.keys(visits).length === 0 && callsPerPage.size > 0;
  if (visitsEstimated) for (const [page, calls] of callsPerPage) visits[page] = Math.max(...calls.values());
  return {
    windowSec,
    all: all.build(windowSec),
    services: new Map([...services].map(([k, b]) => [k, b.build(windowSec)])),
    endpoints: new Map([...endpoints].map(([k, v]) => [k, { service: v.service, stats: v.b.build(windowSec), failures: v.failures }])),
    visits,
    visitsEstimated,
    variants: new Map([...variants].map(([k, v]) => [k, { service: v.service, tpl: v.tpl, variant: v.variant, stats: v.b.build(windowSec) }])),
    throttledBySource,
    throttledByService,
    droppedByService,
    refused,
  };
}

/**
 * Fills in what older results.json files lack (failure reasons, timeouts, page visits, the request timeout) from each
 * step's raw k6 output, so re-rendering an old run's report shows them. results.json itself is left unchanged.
 */
export async function backfillResults(runDir: string, r: RunResults): Promise<void> {
  for (const step of r.steps) {
    const stepDir = path.join(runDir, `step-${String(step.index + 1).padStart(2, "0")}`);
    const outFile = path.join(stepDir, "k6.json.gz");
    if (r.meta.requestTimeoutSec === undefined && fs.existsSync(path.join(stepDir, "step.json"))) {
      r.meta.requestTimeoutSec = (JSON.parse(fs.readFileSync(path.join(stepDir, "step.json"), "utf8")) as { timeoutSec?: number }).timeoutSec;
    }
    if (step.endpoints.some((e) => e.failures) || !fs.existsSync(outFile)) continue;
    // The plan is only used to name dropped iterations, which aren't backfilled.
    const res = await parseK6Output(outFile, { services: [] } as unknown as LoadPlan);
    for (const e of step.endpoints) {
      const fresh = res.endpoints.get(e.key);
      if (!fresh) continue;
      e.failures = fresh.failures;
      e.stats.timeouts = fresh.stats.timeouts;
    }
    step.overall.timeouts = res.all.timeouts;
    if (r.meta.mode === "users" && !step.visits) {
      step.visits = res.visits;
      step.visitsEstimated = res.visitsEstimated;
    }
  }
}
