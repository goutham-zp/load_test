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

/** A host is prod-like when it carries a prod marker without "pre", or carries no non-prod marker at all. */
export function isProdLikeHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || /^127\.|^0\.0\.0\.0$|^\[?::1\]?$/.test(h)) return false;
  const tokens = h.split(/[.\-_]/);
  const hasNonProd = tokens.some((t) => NON_PROD_MARKERS.has(t));
  const hasProd = tokens.some((t) => PROD_MARKERS.has(t));
  if (hasProd) return !tokens.includes("pre") && !tokens.includes("preprd") && !tokens.includes("preprod");
  return !hasNonProd;
}

export function envHosts(env: EnvConfig): string[] {
  const urls = [env.webBaseUrl, env.auth0Domain, ...env.gatewayBaseUrls];
  return [...new Set(urls.map((u) => new URL(u).hostname))];
}

export function prodLikeHosts(env: EnvConfig): string[] {
  return envHosts(env).filter(isProdLikeHost);
}
