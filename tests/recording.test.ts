import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RecordedRequest } from "../src/catalog/types.ts";
import { backupCatalog, coverKey, KEEP_BACKUPS, mergeRecording, type DiscoveryRecording } from "../src/discover/recording.ts";

function rec(user: string, companyId: string, page: string, url: string): RecordedRequest {
  return { user, companyId, page, interaction: "load", method: "GET", url, headers: {}, status: 200, durationMs: 100 };
}

function recording(users: string[], visits: [string, string, string][], tag: string): DiscoveryRecording {
  const pageIds = [...new Set(visits.map((v) => v[2]))];
  return {
    version: 1,
    env: "pg-test",
    updatedAt: "2026-10-21T00:00:00.000Z",
    users,
    covered: visits.map(([u, c, p]) => coverKey(u, c, p)),
    recorded: visits.map(([u, c, p]) => rec(u, c, p, `https://gw/${p}/${tag}`)),
    steps: visits.map(([u, c, p]) => ({ user: u, companyId: c, page: p, interaction: "load", url: "", startedAt: 0, readyMs: 1, timedOut: false, calls: 1 })),
    pages: pageIds.map((id) => ({
      id,
      reached: true,
      urls: visits.filter((v) => v[2] === id).map(([u, c]) => ({ user: u, companyId: c, url: `https://web/${c}/${id}` })),
      interactions: ["load"],
      endpoints: [],
    })),
    blocked: pageIds.map((id) => ({ method: "POST", url: `https://gw/${id}/${tag}`, pathTemplate: `/${id}/${tag}`, page: id, interaction: "load", count: 1, suggestedAllowlistEntry: { method: "POST", path: "x", reviewed: false } })),
  };
}

describe("merging a partial discovery", () => {
  const prev = recording(["user1"], [["user1", "c1", "home"], ["user1", "c2", "home"], ["user1", "c1", "invoices"]], "old");

  it("adds a new user and keeps the earlier user's data", () => {
    const merged = mergeRecording(prev, recording(["user2"], [["user2", "c9", "home"], ["user2", "c9", "invoices"]], "new"));
    expect(merged.users).toEqual(["user1", "user2"]);
    expect(merged.recorded).toHaveLength(5);
    expect(merged.pages.find((p) => p.id === "home")!.urls.map((u) => u.user)).toEqual(["user1", "user1", "user2"]);
  });

  it("replaces only the user + company + page combinations it visited", () => {
    const merged = mergeRecording(prev, recording(["user1"], [["user1", "c1", "home"]], "new"));
    const urls = merged.recorded.map((r) => `${r.companyId} ${r.url}`).sort();
    expect(urls).toEqual(["c1 https://gw/home/new", "c1 https://gw/invoices/old", "c2 https://gw/home/old"]);
    expect(merged.steps).toHaveLength(3);
    expect(merged.pages.find((p) => p.id === "home")!.urls).toHaveLength(2);
  });

  it("refreshes the blocked-write list of revisited pages only", () => {
    const merged = mergeRecording(prev, recording(["user1"], [["user1", "c1", "home"]], "new"));
    expect(merged.blocked.map((b) => b.pathTemplate).sort()).toEqual(["/home/new", "/invoices/old"]);
  });

  it("marks a page not reached when its only visit now failed", () => {
    const next = recording(["user1"], [["user1", "c1", "invoices"]], "new");
    next.pages = [{ id: "invoices", reached: false, note: "not reached: timeout", urls: [], interactions: [], endpoints: [] }];
    next.recorded = [];
    const page = mergeRecording(prev, next).pages.find((p) => p.id === "invoices")!;
    expect(page.reached).toBe(false);
    expect(page.note).toBe("not reached: timeout");
  });
});

describe("catalog backups", () => {
  it("copies the current files and keeps only the newest folders", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lt-backup-"));
    expect(backupCatalog(dir)).toBeUndefined();
    fs.writeFileSync(path.join(dir, "catalog.json"), "{}");
    fs.writeFileSync(path.join(dir, "recording.json"), "{}");
    const first = backupCatalog(dir, new Date(2026, 9, 21, 10, 0, 0))!;
    expect(fs.readdirSync(first).sort()).toEqual(["catalog.json", "recording.json"]);
    expect(backupCatalog(dir, new Date(2026, 9, 21, 10, 0, 0))).toBe(`${first}-2`);
    for (let i = 1; i <= KEEP_BACKUPS + 2; i++) backupCatalog(dir, new Date(2026, 9, 21, 11, i, 0));
    const kept = fs.readdirSync(path.join(dir, "backups")).sort();
    expect(kept).toHaveLength(KEEP_BACKUPS);
    expect(kept.at(-1)).toBe("20261021-111200");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
