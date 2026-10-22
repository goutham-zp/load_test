export type Outcome = "ok" | "error" | "throttled" | "clientError";

/** 5xx and status 0 (timeouts, connection errors) are errors; 429 is throttling and kept apart. */
export function classifyStatus(status: number): Outcome {
  if (status === 429) return "throttled";
  if (status === 0 || status >= 500) return "error";
  if (status >= 400) return "clientError";
  return "ok";
}

export interface Stats {
  /** All requests including throttled. */
  n: number;
  ok: number;
  errors: number;
  throttled: number;
  clientErrors: number;
  /** Status 0: no response before the timeout, or the connection failed. Counted in errors too. Absent in old results. */
  timeouts?: number;
  /** errors / (n - throttled) */
  errorRate: number;
  /** Latency percentiles over non-throttled requests, ms. */
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
  /** Achieved request rate (all requests) over the window, req/s. */
  rps: number;
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

/** Accumulates samples, then summarises. */
export class StatsBuilder {
  private durations: number[] = [];
  private counts = { n: 0, ok: 0, errors: 0, throttled: 0, clientErrors: 0, timeouts: 0 };

  add(status: number, durationMs: number): void {
    this.counts.n++;
    const o = classifyStatus(status);
    if (o === "throttled") {
      this.counts.throttled++;
      return;
    }
    this.durations.push(durationMs);
    if (o === "ok") this.counts.ok++;
    else if (o === "error") {
      this.counts.errors++;
      if (status === 0) this.counts.timeouts++;
    }
    else this.counts.clientErrors++;
  }

  build(windowSec: number): Stats {
    const sorted = [...this.durations].sort((a, b) => a - b);
    const effective = this.counts.n - this.counts.throttled;
    const sum = sorted.reduce((a, b) => a + b, 0);
    return {
      ...this.counts,
      errorRate: effective > 0 ? this.counts.errors / effective : 0,
      p50: round(percentile(sorted, 50)),
      p95: round(percentile(sorted, 95)),
      p99: round(percentile(sorted, 99)),
      max: round(sorted[sorted.length - 1] ?? 0),
      mean: round(sorted.length ? sum / sorted.length : 0),
      rps: windowSec > 0 ? Math.round((this.counts.n / windowSec) * 100) / 100 : 0,
    };
  }
}

function round(n: number): number {
  return Math.round(n);
}

export function emptyStats(): Stats {
  return new StatsBuilder().build(0);
}
