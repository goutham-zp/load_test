import os from "node:os";

export interface RunnerHealth {
  cpuAvg: number;
  cpuMax: number;
  memMaxPct: number;
}

function cpuTimes(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

/** Samples this machine's CPU and memory so a saturated runner isn't mistaken for a slow server. */
export class HealthSampler {
  private timer?: NodeJS.Timeout;
  private prev = cpuTimes();
  private cpu: number[] = [];
  private mem: number[] = [];

  start(intervalMs = 2000): void {
    this.timer = setInterval(() => this.sample(), intervalMs);
    this.timer.unref();
  }

  private sample(): void {
    const now = cpuTimes();
    const total = now.total - this.prev.total;
    const idle = now.idle - this.prev.idle;
    this.prev = now;
    if (total > 0) this.cpu.push(Math.round((1 - idle / total) * 100));
    this.mem.push(Math.round((1 - os.freemem() / os.totalmem()) * 100));
  }

  reset(): void {
    this.cpu = [];
    this.mem = [];
    this.prev = cpuTimes();
  }

  summary(): RunnerHealth {
    const avg = this.cpu.length ? Math.round(this.cpu.reduce((a, b) => a + b, 0) / this.cpu.length) : 0;
    return { cpuAvg: avg, cpuMax: Math.max(0, ...this.cpu), memMaxPct: Math.max(0, ...this.mem) };
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
