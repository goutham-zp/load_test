import type { EnvConfig } from "./types.ts";

const NON_PROD_MARKERS = new Set([
  "dev",
  "qa",
  "test",
  "uat",
  "stg",
  "stage",
  "staging",
  "opm",
  "pre",
  "preprd",
  "preprod",
  "sandbox",
  "perf",
  "load",
  "localhost",
]);

const PROD_MARKERS = new Set(["prd", "prod", "production"]);

// Markers also count when glued to the front of the first label, as in devfms / uatfms (with fms for production).
const NON_PROD_PREFIXES = ["dev", "qa", "test", "uat", "stg", "stage", "staging", "perf", "sandbox"];
const PROD_PREFIXES = ["prd", "prod"];

/** A host is prod-like when it carries a prod marker without "pre", or carries no non-prod marker at all. */
export function isProdLikeHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || /^127\.|^0\.0\.0\.0$|^\[?::1\]?$/.test(h)) return false;
  const tokens = h.split(/[.\-_]/);
  const first = h.split(".")[0]!;
  const glued = (prefixes: string[]) => prefixes.some((m) => first.startsWith(m) && first.length > m.length);
  const hasNonProd = tokens.some((t) => NON_PROD_MARKERS.has(t)) || glued(NON_PROD_PREFIXES);
  const hasProd = tokens.some((t) => PROD_MARKERS.has(t)) || glued(PROD_PREFIXES);
  if (hasProd) return !tokens.includes("pre") && !tokens.includes("preprd") && !tokens.includes("preprod");
  return !hasNonProd;
}

export function envHosts(env: EnvConfig): string[] {
  const urls = [env.webBaseUrl, env.auth0Domain, ...env.gatewayBaseUrls];
  return [...new Set(urls.map((u) => new URL(u).hostname))];
}

/**
 * Hosts among `urls` that the env doesn't name as its web or gateway host: requests recorded against another
 * deployment. Replaying them would send load somewhere the env file (and its production check) never mentions.
 */
export function hostsOutsideEnv(urls: Iterable<string>, env: Pick<EnvConfig, "webBaseUrl" | "gatewayBaseUrls">): string[] {
  const host = (u: string) => new URL(u).host;
  const named = new Set([env.webBaseUrl, ...env.gatewayBaseUrls].map(host));
  return [...new Set([...urls].map(host))].filter((h) => !named.has(h)).sort();
}

export function prodLikeHosts(env: EnvConfig): string[] {
  return envHosts(env).filter(isProdLikeHost);
}
