import type { AllowlistEntry } from "../config/types.ts";

export type GuardDecision =
  | { action: "allow"; reason: "read-method" | "auth0" | "allowlisted" }
  | { action: "block"; reason: "third-party" | "write" };

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface GuardRules {
  /** host[:port] of Auth0 */
  auth0Host: string;
  allowlist: AllowlistEntry[];
  blockedThirdPartyHosts: string[];
}

export interface CompiledGuard {
  decide(method: string, url: string): GuardDecision;
  isAllowlisted(method: string, pathname: string): boolean;
}

export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();
  return h === p || h.endsWith("." + p);
}

export function compileGuard(rules: GuardRules): CompiledGuard {
  const allow = rules.allowlist
    .filter((e) => e.reviewed)
    .map((e) => ({ method: e.method.toUpperCase(), re: new RegExp(e.path) }));
  const isAllowlisted = (method: string, pathname: string) =>
    allow.some((a) => a.method === method.toUpperCase() && a.re.test(pathname));

  return {
    isAllowlisted,
    decide(method, url) {
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        return { action: "allow", reason: "read-method" };
      }
      if (u.protocol === "data:" || u.protocol === "blob:") return { action: "allow", reason: "read-method" };
      if (rules.blockedThirdPartyHosts.some((h) => hostMatches(u.hostname, h))) return { action: "block", reason: "third-party" };
      const m = method.toUpperCase();
      if (READ_METHODS.has(m)) return { action: "allow", reason: "read-method" };
      if (hostMatches(u.host, rules.auth0Host)) return { action: "allow", reason: "auth0" };
      if (isAllowlisted(m, u.pathname)) return { action: "allow", reason: "allowlisted" };
      return { action: "block", reason: "write" };
    },
  };
}

/** Methods the k6 layer may send. Anything else must be allowlisted. */
export function isReplayable(guard: CompiledGuard, method: string, url: string): boolean {
  const m = method.toUpperCase();
  if (READ_METHODS.has(m)) return true;
  return guard.isAllowlisted(m, new URL(url).pathname);
}
