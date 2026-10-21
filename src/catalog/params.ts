import { templateSegment } from "./normalize.ts";
import type { DimensionKind, JsonPrimitive, ParamDimension, ParamLocation, Sample, Variant } from "./types.ts";

const KIND_PATTERNS: [DimensionKind, RegExp][] = [
  ["page", /^(page|pageno|pagenumber|pagenum|pageindex|currentpage|pg)$/i],
  ["offset", /^(offset|skip|startindex|startrow)$/i],
  ["size", /^(size|limit|pagesize|perpage|take|rows|maxresults|recordsperpage|itemsperpage)$/i],
  ["direction", /^(sortorder|sortdir|sortdirection|direction|dir|order|orderdir|orderdirection|isascending|ascending|isdescending|descending)$/i],
  ["sort", /^(sort|sortby|sortfield|sortcolumn|sortkey|sortname|sortexpression|orderby|order_by|sort_by|orderfield|ordercolumn)$/i],
  ["search", /^(search|searchtext|searchterm|searchstring|searchkey|searchvalue|query|q|keyword|keywords|term|filtertext|globalsearch)$/i],
];

const DATE_FROM_NAME = /(^|[^a-z])?(from|start|begin)(date|dt)?$|^(from|start|begin)/i;
const DATE_TO_NAME = /(^|[^a-z])?(to|end|until)(date|dt)?$|^(to|end|until)/i;

export function locationLabel(loc: ParamLocation): string {
  return loc.in === "query" ? loc.name : loc.path.join(".");
}

function locationName(loc: ParamLocation): string {
  return loc.in === "query" ? loc.name : loc.path[loc.path.length - 1]!;
}

function locationId(loc: ParamLocation): string {
  return `${loc.in}:${locationLabel(loc)}`;
}

// ---------------------------------------------------------------------------
// Dates

type DateFormat = "iso-date" | "iso-datetime" | "us";

export function parseDateValue(v: JsonPrimitive): { date: Date; format: DateFormat; raw: string } | undefined {
  if (typeof v !== "string") return undefined;
  let m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return { date: new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!)), format: "iso-date", raw: v };
  m = v.match(/^(\d{4})-(\d{2})-(\d{2})T/);
  if (m && !Number.isNaN(Date.parse(v))) return { date: new Date(v), format: "iso-datetime", raw: v };
  m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return { date: new Date(Date.UTC(+m[3]!, +m[1]! - 1, +m[2]!)), format: "us", raw: v };
  return undefined;
}

/** Shifts a date string by calendar years and/or days, keeping its original format. */
export function shiftDate(v: string, by: { years?: number; days?: number }): string | undefined {
  const parsed = parseDateValue(v);
  if (!parsed) return undefined;
  const d = new Date(parsed.date.getTime() + (by.days ?? 0) * 86_400_000);
  if (by.years) d.setUTCFullYear(d.getUTCFullYear() + by.years);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (parsed.format === "iso-date") return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  if (parsed.format === "us") return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${d.getUTCFullYear()}`;
  // Keep the original time-of-day suffix so the backend parses it the same way.
  const suffix = parsed.raw.slice(10);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}${suffix}`;
}

// ---------------------------------------------------------------------------
// Reading params from samples

export function readParams(sample: Sample): Map<string, { location: ParamLocation; value: JsonPrimitive }> {
  const out = new Map<string, { location: ParamLocation; value: JsonPrimitive }>();
  const url = new URL(sample.url);
  for (const [name, value] of url.searchParams) {
    const location: ParamLocation = { in: "query", name };
    out.set(locationId(location), { location, value });
  }
  if (sample.body) {
    let body: unknown;
    try {
      body = JSON.parse(sample.body);
    } catch {
      body = undefined;
    }
    const walk = (node: unknown, path: string[], depth: number) => {
      if (depth > 4 || node === null || typeof node !== "object" || Array.isArray(node)) return;
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        const p = [...path, k];
        if (v === null || ["string", "number", "boolean"].includes(typeof v)) {
          const location: ParamLocation = { in: "body", path: p };
          out.set(locationId(location), { location, value: v as JsonPrimitive });
        } else {
          walk(v, p, depth + 1);
        }
      }
    };
    walk(body, [], 0);
  }
  return out;
}

export function classify(name: string, values: JsonPrimitive[]): DimensionKind | undefined {
  for (const [kind, re] of KIND_PATTERNS) if (re.test(name)) return kind;
  const isDate = values.length > 0 && values.every((v) => v === null || v === "" || parseDateValue(v));
  if (isDate && values.some((v) => parseDateValue(v))) {
    if (DATE_FROM_NAME.test(name)) return "dateFrom";
    if (DATE_TO_NAME.test(name)) return "dateTo";
  }
  return undefined;
}

function distinct(values: JsonPrimitive[]): JsonPrimitive[] {
  const seen = new Set<string>();
  const out: JsonPrimitive[] = [];
  for (const v of values) {
    const k = JSON.stringify(v);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

function asNumber(v: JsonPrimitive): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^-?\d+$/.test(v)) return Number(v);
  return undefined;
}

/** Keeps the original representation: numbers stay numbers, numeric strings stay strings. */
function like(original: JsonPrimitive, n: number): JsonPrimitive {
  return typeof original === "string" ? String(n) : n;
}

const DIRECTION_FLIPS: Record<string, string> = {
  asc: "desc",
  desc: "asc",
  ASC: "DESC",
  DESC: "ASC",
  Asc: "Desc",
  Desc: "Asc",
  ascending: "descending",
  descending: "ascending",
  true: "false",
  false: "true",
  "0": "1",
  "1": "0",
};

export interface DimensionContext {
  maxTotalCount?: number;
  searchTerms: string[];
}

/** Finds paging/sort/filter/date/search parameters across an endpoint's samples and picks values to vary. */
export function detectDimensions(samples: Sample[], ctx: DimensionContext): ParamDimension[] {
  type Entry = { location: ParamLocation; values: JsonPrimitive[]; byGroup: Map<string, Set<string>> };
  const byLoc = new Map<string, Entry>();
  for (const s of samples) {
    const group = `${s.user}|${s.companyId}`;
    for (const [id, p] of readParams(s)) {
      const entry: Entry = byLoc.get(id) ?? { location: p.location, values: [], byGroup: new Map() };
      entry.values.push(p.value);
      const set = entry.byGroup.get(group) ?? new Set<string>();
      set.add(JSON.stringify(p.value));
      entry.byGroup.set(group, set);
      byLoc.set(id, entry);
    }
  }

  const dims: ParamDimension[] = [];
  for (const { location, values, byGroup } of byLoc.values()) {
    const observed = distinct(values);
    const name = locationName(location);
    let kind = classify(name, observed);
    if (!kind && isGenericFilter(observed, byGroup)) kind = "filter";
    if (!kind) continue;
    dims.push({ location, label: locationLabel(location), kind, observed, values: [] });
  }

  const size = dims.find((d) => d.kind === "size");
  const pageSize = size ? Math.max(...size.observed.map((v) => asNumber(v) ?? 0)) : undefined;

  for (const d of dims) d.values = generateValues(d, { ...ctx, pageSize: pageSize || undefined });
  return dims;
}

/**
 * A param counts as a generic filter only if it varies within one user's company (so it was changed by an
 * interaction, not because users differ) and its values are not IDs (which would leak across companies).
 */
function isGenericFilter(observed: JsonPrimitive[], byGroup: Map<string, Set<string>>): boolean {
  if (observed.length < 2) return false;
  const variesWithinGroup = [...byGroup.values()].some((s) => s.size > 1);
  if (!variesWithinGroup) return false;
  return observed.every((v) => v === null || typeof v === "boolean" || (typeof v === "string" && templateSegment(v) === v));
}

const PAGE_STEPS = [0, 1, 4, 19, 49, 99];

function generateValues(d: ParamDimension, ctx: DimensionContext & { pageSize?: number }): JsonPrimitive[] {
  const first = d.observed.find((v) => v !== null && v !== "") ?? d.observed[0] ?? null;
  switch (d.kind) {
    case "page": {
      const nums = d.observed.map(asNumber).filter((n): n is number => n !== undefined);
      if (nums.length === 0) return d.observed;
      const base = Math.min(...nums) <= 0 ? 0 : 1;
      const lastPage =
        ctx.maxTotalCount !== undefined && ctx.pageSize ? base + Math.max(0, Math.ceil(ctx.maxTotalCount / ctx.pageSize) - 1) : undefined;
      const limit = lastPage ?? base + 19;
      return distinct(PAGE_STEPS.map((s) => base + s).filter((p) => p <= limit).map((p) => like(first, p)));
    }
    case "offset": {
      if (!ctx.pageSize) return d.observed;
      const total = ctx.maxTotalCount;
      const offsets = PAGE_STEPS.map((s) => s * ctx.pageSize!).filter((o) => (total === undefined ? o <= 19 * ctx.pageSize! : o < total || o === 0));
      return distinct(offsets.map((o) => like(first, o)));
    }
    case "direction": {
      const flips = d.observed.map((v) => DIRECTION_FLIPS[String(v)]).filter((v): v is string => v !== undefined);
      const extra = flips.map((f) => (typeof first === "boolean" ? f === "true" : typeof first === "number" ? Number(f) : f));
      return distinct([...d.observed, ...extra]);
    }
    case "search":
      return distinct([...d.observed.filter((v) => v !== null && v !== ""), ...ctx.searchTerms]);
    case "dateFrom": {
      const base = d.observed.find((v) => parseDateValue(v));
      if (typeof base !== "string") return d.observed;
      const wide = [-1, -2].map((years) => shiftDate(base, { years })).filter((v): v is string => v !== undefined);
      return distinct([...d.observed, ...wide]);
    }
    case "size":
    case "dateTo":
      return d.observed;
    case "sort":
    case "filter":
      return d.observed;
  }
}

const VARIED_KINDS = new Set<DimensionKind>(["page", "offset", "sort", "direction", "search", "dateFrom", "filter"]);

function short(v: JsonPrimitive): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 24 ? s.slice(0, 21) + "..." : s;
}

/** Base variant plus one-at-a-time changes per dimension, interleaved across dimensions, capped at max. */
export function buildVariants(dims: ParamDimension[], base: Sample | undefined, max: number): Variant[] {
  const variants: Variant[] = [{ label: "base", set: [] }];
  if (!base) return variants;
  const baseParams = readParams(base);
  const perDim: Variant[][] = [];
  for (const d of dims) {
    if (!VARIED_KINDS.has(d.kind)) continue;
    const baseValue = baseParams.get(locationId(d.location))?.value;
    const list = d.values
      .filter((v) => JSON.stringify(v) !== JSON.stringify(baseValue) && String(v) !== String(baseValue))
      .map((v) => ({ label: `${d.label}=${short(v)}`, set: [{ location: d.location, value: v }] }));
    if (list.length) perDim.push(list);
  }
  for (let i = 0; variants.length < max; i++) {
    let added = false;
    for (const list of perDim) {
      if (i < list.length && variants.length < max) {
        variants.push(list[i]!);
        added = true;
      }
    }
    if (!added) break;
  }
  return variants;
}

/** Applies a variant to a sample, returning the concrete URL and body to send. */
export function applyVariant(sample: Sample, variant: Variant): { url: string; body?: string } {
  if (variant.set.length === 0) return { url: sample.url, body: sample.body };
  const url = new URL(sample.url);
  let body: unknown;
  if (sample.body) {
    try {
      body = JSON.parse(sample.body);
    } catch {
      body = undefined;
    }
  }
  for (const { location, value } of variant.set) {
    if (location.in === "query") {
      url.searchParams.set(location.name, value === null ? "" : String(value));
    } else if (body && typeof body === "object") {
      let node = body as Record<string, unknown>;
      for (const key of location.path.slice(0, -1)) {
        if (typeof node[key] !== "object" || node[key] === null) node[key] = {};
        node = node[key] as Record<string, unknown>;
      }
      node[location.path[location.path.length - 1]!] = value;
    }
  }
  return { url: url.toString(), body: body === undefined ? sample.body : JSON.stringify(body) };
}
