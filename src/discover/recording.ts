import fs from "node:fs";
import path from "node:path";
import type { BlockedRequest, CatalogPage, RecordedRequest, UntrackedHost } from "../catalog/types.ts";
import { readJson } from "../config/load.ts";
import { timestamp } from "../util.ts";

/** A measured step as stored on disk (the call list is reduced to a count; the calls are in `recorded`). */
export interface StoredStep {
  user: string;
  companyId: string;
  page: string;
  interaction: string;
  url: string;
  startedAt: number;
  readyMs: number;
  timedOut: boolean;
  calls: number;
  [extra: string]: unknown;
}

/**
 * Everything discovery saw, kept next to the catalog so a partial run (--users / --pages / --max-companies) can be
 * merged into it. The catalog is always rebuilt from this, never merged directly.
 */
export interface DiscoveryRecording {
  version: 1;
  env: string;
  updatedAt: string;
  users: string[];
  /** "user|companyId|pageId" combinations visited; a later run that visits one replaces its data. */
  covered: string[];
  recorded: RecordedRequest[];
  steps: StoredStep[];
  pages: CatalogPage[];
  blocked: BlockedRequest[];
  untrackedHosts?: UntrackedHost[];
}

export const RECORDING_FILE = "recording.json";
export const KEEP_BACKUPS = 10;
const BACKED_UP = ["catalog.json", RECORDING_FILE, "discovery-steps.json"];

export function coverKey(user: string, companyId: string, page: string): string {
  return `${user}|${companyId}|${page}`;
}

export function loadRecording(dir: string): DiscoveryRecording | undefined {
  const file = path.join(dir, RECORDING_FILE);
  return fs.existsSync(file) ? readJson<DiscoveryRecording>(file) : undefined;
}

/**
 * Adds a partial run to an earlier recording. For every user + company + page the new run visited, its data replaces
 * the old; everything it did not visit is kept as it was.
 */
export function mergeRecording(prev: DiscoveryRecording, next: DiscoveryRecording): DiscoveryRecording {
  const covered = new Set(next.covered);
  const replaced = (user: string, companyId: string, page: string) => covered.has(coverKey(user, companyId, page));
  const revisitedPages = new Set(next.covered.map((k) => k.split("|")[2]));

  const pages = new Map<string, CatalogPage>();
  for (const p of prev.pages) pages.set(p.id, { ...p, urls: p.urls.filter((u) => !replaced(u.user, u.companyId, p.id)) });
  for (const p of next.pages) {
    const old = pages.get(p.id);
    const urls = [...(old?.urls ?? []), ...p.urls];
    pages.set(p.id, {
      ...p,
      reached: urls.length > 0,
      note: urls.length > 0 ? undefined : (p.note ?? old?.note),
      urls,
      interactions: [...new Set([...(old?.interactions ?? []), ...p.interactions])],
    });
  }

  return {
    version: 1,
    env: next.env,
    updatedAt: next.updatedAt,
    users: [...new Set([...prev.users, ...next.users])],
    covered: [...new Set([...prev.covered, ...next.covered])],
    recorded: [...prev.recorded.filter((r) => !replaced(r.user, r.companyId, r.page)), ...next.recorded],
    steps: [...prev.steps.filter((s) => !replaced(s.user, s.companyId, s.page)), ...next.steps],
    pages: [...pages.values()],
    // Blocked writes carry no user, so a page's list is replaced whenever any user revisits that page.
    blocked: [...prev.blocked.filter((b) => !revisitedPages.has(b.page)), ...next.blocked].sort((a, b) => b.count - a.count),
    untrackedHosts: mergeUntracked(prev.untrackedHosts ?? [], next.untrackedHosts ?? []),
  };
}

function mergeUntracked(a: UntrackedHost[], b: UntrackedHost[]): UntrackedHost[] {
  const byOrigin = new Map<string, UntrackedHost>();
  for (const h of [...a, ...b]) {
    const agg = byOrigin.get(h.origin) ?? { ...h, count: 0 };
    agg.count += h.count;
    byOrigin.set(h.origin, agg);
  }
  return [...byOrigin.values()].sort((x, y) => y.count - x.count);
}

/** Copies the current catalog files into backups/<time>/ and keeps the newest KEEP_BACKUPS folders. */
export function backupCatalog(dir: string, now = new Date()): string | undefined {
  const present = BACKED_UP.filter((f) => fs.existsSync(path.join(dir, f)));
  if (!present.length) return undefined;
  const root = path.join(dir, "backups");
  const base = `${timestamp(now)}${String(now.getSeconds()).padStart(2, "0")}`;
  let target = path.join(root, base);
  for (let i = 2; fs.existsSync(target); i++) target = path.join(root, `${base}-${i}`);
  fs.mkdirSync(target, { recursive: true });
  for (const f of present) fs.copyFileSync(path.join(dir, f), path.join(target, f));

  const all = fs.readdirSync(root).filter((d) => fs.statSync(path.join(root, d)).isDirectory()).sort();
  for (const old of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) fs.rmSync(path.join(root, old), { recursive: true, force: true });
  return target;
}
