// k6 script for one load step. All planning happens in Node; this file only replays planned requests.
// Inputs (env): LT_PLAN (slots per service), LT_PLAN_INDEX (service names and slot counts), LT_STEP (rates, duration,
// mode), LT_TOKENS (user -> token), LT_SUMMARY.
import http from "k6/http";
import exec from "k6/execution";
import { sleep } from "k6";
import { SharedArray } from "k6/data";
import { Counter } from "k6/metrics";

// Every VU runs this init code. Only the small index is parsed per VU; the slots live once in SharedArrays (the
// callback runs once), so memory stays flat when slow responses push the VU count into the hundreds.
const plan = JSON.parse(open(__ENV.LT_PLAN_INDEX));
const slotsByService = plan.services.map(
  (svc, idx) => new SharedArray("slots-" + idx, () => JSON.parse(open(__ENV.LT_PLAN)).services[idx].slots)
);
const step = JSON.parse(open(__ENV.LT_STEP));
const tokens = JSON.parse(open(__ENV.LT_TOKENS));

const READ_METHODS = { GET: true, HEAD: true, OPTIONS: true };
const throttled = new Counter("lt_throttled");
const refused = new Counter("lt_refused");

const scenarios = {};
plan.services.forEach((svc, idx) => {
  const rps = step.rates[svc.name] || 0;
  if (rps <= 0 || svc.slots === 0) return;
  const env = { LT_SVC: String(idx) };
  if (step.mode === "smoke") {
    scenarios["s" + idx] = {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: svc.slots,
      maxDuration: `${Math.max(60, Math.ceil(svc.slots * ((step.smokePace[svc.name] || 0.5) + step.timeoutSec)))}s`,
      exec: "smoke",
      env,
    };
    return;
  }
  scenarios["s" + idx] = {
    executor: "constant-arrival-rate",
    rate: Math.max(1, Math.round(rps * 60)),
    timeUnit: "1m",
    duration: `${step.durationSec}s`,
    preAllocatedVUs: Math.min(step.maxVUs, Math.max(2, Math.ceil(rps * 2))),
    maxVUs: Math.min(step.maxVUs, Math.max(10, Math.ceil(rps * step.timeoutSec))),
    gracefulStop: "10s",
    exec: "load",
    env,
  };
});

export const options = {
  scenarios,
  discardResponseBodies: true,
  insecureSkipTLSVerify: true,
  userAgent: "dxp-loadtest/0.1 (k6)",
  systemTags: ["status", "method", "error_code", "scenario"],
  summaryTrendStats: ["avg", "p(50)", "p(95)", "p(99)", "max"],
};

function headerValue(headers, name) {
  const lower = name.toLowerCase();
  for (const k in headers) if (k.toLowerCase() === lower) return headers[k];
  return undefined;
}

function send(slotIndex) {
  const idx = Number(__ENV.LT_SVC);
  const svc = plan.services[idx];
  const slot = slotsByService[idx][slotIndex % svc.slots];
  if (!READ_METHODS[slot.method] && !slot.allowlisted) {
    // Defence in depth: the planner never produces these.
    refused.add(1, { svc: svc.name, tpl: slot.tpl });
    return;
  }
  // slot.token is the user, or user|company when each company has its own token (plans before it existed: user).
  const headers = Object.assign({}, slot.headers, { Authorization: "Bearer " + tokens[slot.token || slot.user] });
  const res = http.request(slot.method, slot.url, slot.body === undefined ? null : slot.body, {
    headers,
    timeout: `${step.timeoutSec}s`,
    tags: { svc: svc.name, tpl: slot.tpl, variant: slot.variant, user: slot.user },
  });
  if (res.status === 429) {
    let source = "unknown";
    if (headerValue(res.headers, "X-RateLimit-Limit") || headerValue(res.headers, "RateLimit-Limit")) source = "gateway";
    else if (headerValue(res.headers, "Retry-After")) source = "service";
    throttled.add(1, { svc: svc.name, tpl: slot.tpl, source });
  }
}

export function load() {
  send(exec.scenario.iterationInTest);
}

export function smoke() {
  send(exec.scenario.iterationInTest);
  sleep(step.smokePace[plan.services[Number(__ENV.LT_SVC)].name] || 0.5);
}

export function handleSummary(data) {
  const out = {};
  out[__ENV.LT_SUMMARY] = JSON.stringify({
    dropped_iterations: data.metrics.dropped_iterations ? data.metrics.dropped_iterations.values : null,
    http_reqs: data.metrics.http_reqs ? data.metrics.http_reqs.values : null,
    vus_max: data.metrics.vus_max ? data.metrics.vus_max.values : null,
  });
  return out;
}
