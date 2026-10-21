import type { RouteMatcher } from "../gateway/routes.ts";
import { endpointKey, templatePath } from "./normalize.ts";
import { buildVariants, detectDimensions } from "./params.ts";
import type { BlockedRequest, Catalog, CatalogEndpoint, CatalogPage, RecordedRequest, Sample } from "./types.ts";

export interface BuildCatalogInput {
  env: string;
  webBaseUrl: string;
  gatewayBaseUrls: string[];
  users: string[];
  recorded: RecordedRequest[];
  pages: CatalogPage[];
  blocked: BlockedRequest[];
  matcher: RouteMatcher;
  maxSamplesPerUserPerEndpoint: number;
  maxVariantsPerEndpoint: number;
  searchTerms: string[];
}

export function isSuccess(status: number): boolean {
  return (status >= 200 && status < 300) || status === 304;
}

/** Service name for a path the gateway config doesn't know: "unknown:<first segment>". */
export function unknownService(pathname: string): string {
  const first = pathname.split("/").filter(Boolean)[0] ?? "root";
  return `unknown:${first}`;
}

export function resolveEndpoint(
  matcher: RouteMatcher,
  method: string,
  url: string
): { key: string; pathTemplate: string; service: string; servicePath?: string; matchedRoute: boolean } {
  const pathname = new URL(url).pathname;
  const route = matcher.match(method, pathname);
  if (route) {
    return {
      key: endpointKey(method, route.gatewayPath),
      pathTemplate: route.gatewayPath,
      service: route.service,
      servicePath: route.servicePath,
      matchedRoute: true,
    };
  }
  const pathTemplate = templatePath(pathname);
  return { key: endpointKey(method, pathTemplate), pathTemplate, service: unknownService(pathname), matchedRoute: false };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

export function buildCatalog(input: BuildCatalogInput): Catalog {
  const groups = new Map<
    string,
    {
      meta: ReturnType<typeof resolveEndpoint>;
      method: string;
      records: RecordedRequest[];
    }
  >();
  for (const r of input.recorded) {
    const meta = resolveEndpoint(input.matcher, r.method, r.url);
    const g = groups.get(meta.key) ?? { meta, method: r.method.toUpperCase(), records: [] };
    g.records.push(r);
    groups.set(meta.key, g);
  }

  const failures: Catalog["failures"] = [];
  const endpoints: CatalogEndpoint[] = [];
  for (const { meta, method, records } of groups.values()) {
    const observedStatuses: Record<string, number> = {};
    for (const r of records) observedStatuses[r.status] = (observedStatuses[r.status] ?? 0) + 1;
    for (const [status, count] of Object.entries(observedStatuses)) {
      if (!isSuccess(Number(status))) failures.push({ key: meta.key, status: Number(status), count });
    }

    const ok = records.filter((r) => isSuccess(r.status));
    const samples: Sample[] = [];
    const seen = new Set<string>();
    const perUser = new Map<string, number>();
    for (const r of ok) {
      const id = `${r.user}|${r.url}|${r.body ?? ""}`;
      if (seen.has(id)) continue;
      const n = perUser.get(r.user) ?? 0;
      if (n >= input.maxSamplesPerUserPerEndpoint) continue;
      seen.add(id);
      perUser.set(r.user, n + 1);
      samples.push({ user: r.user, companyId: r.companyId, url: r.url, body: r.body, headers: r.headers });
    }

    const totals = ok.map((r) => r.totalCount).filter((n): n is number => typeof n === "number");
    const dimensions = detectDimensions(samples, {
      maxTotalCount: totals.length ? Math.max(...totals) : undefined,
      searchTerms: input.searchTerms,
    });
    const variants = buildVariants(dimensions, samples[0], input.maxVariantsPerEndpoint);

    endpoints.push({
      key: meta.key,
      method,
      pathTemplate: meta.pathTemplate,
      service: meta.service,
      servicePath: meta.servicePath,
      matchedRoute: meta.matchedRoute,
      pages: [...new Set(records.map((r) => r.page))].sort(),
      samples,
      dimensions,
      variants,
      observedStatuses,
      discoveryMedianMs: Math.round(median(ok.map((r) => r.durationMs))),
    });
  }
  endpoints.sort((a, b) => a.key.localeCompare(b.key));

  const pages = input.pages.map((p) => ({
    ...p,
    endpoints: endpoints.filter((e) => e.pages.includes(p.id)).map((e) => e.key),
  }));

  return {
    version: 1,
    env: input.env,
    createdAt: new Date().toISOString(),
    webBaseUrl: input.webBaseUrl,
    gatewayBaseUrls: input.gatewayBaseUrls,
    users: input.users,
    endpoints,
    pages,
    blocked: input.blocked,
    failures: failures.sort((a, b) => b.count - a.count),
  };
}

/** Endpoint keys only: used to warn when two runs being compared used different request sets. */
export function catalogSignature(catalog: Catalog): string[] {
  return catalog.endpoints.filter((e) => e.samples.length > 0).map((e) => e.key).sort();
}
