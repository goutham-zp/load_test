import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { ROOT } from "./paths.ts";

export function log(msg: string): void {
  const t = new Date().toISOString().slice(11, 19);
  process.stdout.write(`[${t}] ${msg}\n`);
}

export async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

export async function ask(question: string): Promise<string> {
  if (!process.stdin.isTTY) return "";
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(`${question} `)).trim();
  } finally {
    rl.close();
  }
}

export function k6Version(): string {
  try {
    return execFileSync("k6", ["version"], { encoding: "utf8" }).trim().split("\n")[0]!;
  } catch {
    return "not installed";
  }
}

export function playwrightVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "node_modules", "playwright", "package.json"), "utf8"));
    return pkg.version as string;
  } catch {
    return "unknown";
  }
}

export function timestamp(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

export function fmtRate(r: number): string {
  if (!Number.isFinite(r)) return "unlimited";
  if (r >= 10) return r.toFixed(0);
  if (r >= 1) return r.toFixed(1);
  return r.toFixed(3);
}
