// k6 script for one load step. All planning happens in Node; this file only replays planned requests.
// Inputs (env): LT_PLAN (slots per service), LT_PLAN_INDEX (service names and slot counts), LT_STEP (rates, duration,
// mode), LT_TOKENS (token key -> token, or a list when an account has several sessions), LT_SUMMARY.
// Users mode adds LT_JOURNEYS (pages with their calls) and LT_JOURNEYS_INDEX (journey numbers per token key, grouped
// by page).
import http from "k6/http";
import exec from "k6/execution";
import { sleep } from "k6";
import { SharedArray } from "k6/data";
import { Counter } from "k6/metrics";
import { pickJourney, vusOnToken } from "./pick.js";

// Every VU runs this init code. Only the small index is parsed per VU; the slots live once in SharedArrays (the
// callback runs once), so memory stays flat when slow responses push the VU count into the hundreds.
const plan = JSON.parse(open(__ENV.LT_PLAN_INDEX));
const slotsByService = plan.services.map(
  (svc, idx) => new SharedArray("slots-" + idx, () => JSON.parse(open(__ENV.LT_PLAN)).services[idx].slots)
);
const step = JSON.parse(open(__ENV.LT_STEP));
const tokens = JSON.parse(open(__ENV.LT_TOKENS));
const usersMode = step.mode === "users";
const journeyIndex = usersMode ? JSON.parse(open(__ENV.LT_JOURNEYS_INDEX)) : null;
const journeys = usersMode ? new SharedArray("journeys", () => JSON.parse(open(__ENV.LT_JOURNEYS)).journeys) : null;

const READ_METHODS = { GET: true, HEAD: true, OPTIONS: true };
const throttled = new Counter("lt_throttled");
const refused = new Counter("lt_refused");
const visits = new Counter("lt_visits");

const scenarios = {};
if (usersMode) {
  // With rampSec the users arrive over that many seconds (as real users do), then all of them run for durationSec.
  scenarios.users = step.rampSec > 0
    ? {
        executor: "ramping-vus",
        startVUs: 0,
        stages: [
          { duration: `${step.rampSec}s`, target: step.vus },
          { duration: `${step.durationSec}s`, target: step.vus },
        ],
        gracefulRampDown: "15s",
        gracefulStop: "15s",
        exec: "user",
      }
    : {
        executor: "constant-vus",
        vus: step.vus,
        duration: `${step.durationSec}s`,
        gracefulStop: "15s",
        exec: "user",
      };
}
plan.services.forEach((svc, idx) => {
  if (usersMode) return;
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

// A token key's token; with several sessions per account, `n` picks which one (rotating).
function tokenFor(key, n) {
  const t = tokens[key];
  return Array.isArray(t) ? t[n % t.length] : t;
}

function noteThrottle(res, svcName, tpl) {
  if (res.status !== 429) return;
  let source = "unknown";
  if (headerValue(res.headers, "X-RateLimit-Limit") || headerValue(res.headers, "RateLimit-Limit")) source = "gateway";
  else if (headerValue(res.headers, "Retry-After")) source = "service";
  throttled.add(1, { svc: svcName, tpl, source });
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
  const headers = Object.assign({}, slot.headers, { Authorization: "Bearer " + tokenFor(slot.token || slot.user, exec.scenario.iterationInTest) });
  const res = http.request(slot.method, slot.url, slot.body === undefined ? null : slot.body, {
    headers,
    timeout: `${step.timeoutSec}s`,
    tags: { svc: svc.name, tpl: slot.tpl, variant: slot.variant, user: slot.user },
  });
  noteThrottle(res, svc.name, slot.tpl);
}

export function load() {
  send(exec.scenario.iterationInTest);
}

// Users mode: each virtual user keeps one account session (VUs spread over token keys, then over sessions), opens a
// page by sending all its recorded calls at once (as a browser does), then waits the think time (+-50%) and repeats.
// The VUs of a token key start on different pages spread over all its pages (see pick.js).
export function user() {
  const vu = exec.vu.idInTest - 1;
  const keys = journeyIndex.tokens;
  const tokenIndex = vu % keys.length;
  const key = keys[tokenIndex];
  const session = Math.floor(vu / keys.length);
  const pages = journeyIndex.byToken[key];
  const journey = journeys[pickJourney(pages, session, vusOnToken(step.vus, keys.length, tokenIndex), exec.vu.iterationInScenario)];
  const batch = [];
  const sent = [];
  for (const r of journey.requests) {
    if (!READ_METHODS[r.method] && !r.allowlisted) {
      refused.add(1, { svc: r.svc, tpl: r.tpl });
      continue;
    }
    batch.push({
      method: r.method,
      url: r.url,
      body: r.body === undefined ? null : r.body,
      params: {
        headers: Object.assign({}, r.headers, { Authorization: "Bearer " + tokenFor(key, session) }),
        timeout: `${step.timeoutSec}s`,
        tags: { svc: r.svc, tpl: r.tpl, variant: r.variant, user: r.user, page: journey.page },
      },
    });
    sent.push(r);
  }
  visits.add(1, { page: journey.page });
  const responses = http.batch(batch);
  responses.forEach((res, i) => noteThrottle(res, sent[i].svc, sent[i].tpl));
  sleep(step.thinkSec * (0.5 + Math.random()));
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
