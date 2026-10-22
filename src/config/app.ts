import type { AppProfile, EnvConfig } from "./types.ts";

const withLang = (template: string, lang: string) => template.replaceAll("{lang}", lang);

/** The URL of an app page for one company. */
export function pageUrl(app: AppProfile, env: Pick<EnvConfig, "webBaseUrl" | "lang">, companyId: string, pagePath: string): string {
  return app.pageUrl
    .replace("{web}", env.webBaseUrl)
    .replaceAll("{lang}", env.lang)
    .replace("{company}", encodeURIComponent(companyId))
    .replace("{path}", pagePath)
    .replace(/\/+$/, "");
}

/** Splits a page URL into its app page path and, when the URL carries one, the company. */
export function pagePathFromUrl(app: AppProfile, lang: string, url: string): { companyId?: string; rest: string } {
  const u = new URL(url);
  const m = u.pathname.match(new RegExp(withLang(app.pagePattern, lang)));
  if (!m) return { rest: u.pathname };
  return { companyId: m.groups?.company, rest: (m.groups?.path ?? "").replace(/\/$/, "") };
}

export function loginPath(app: AppProfile, env: Pick<EnvConfig, "loginPath" | "lang">): string {
  return env.loginPath ?? withLang(app.loginPath, env.lang);
}

/** Key of the API token a request runs with: the user, or the user and company for company-token apps. */
export function tokenKeyFor(scope: AppProfile["tokenScope"], user: string, companyId: string): string {
  return scope === "company" ? `${user}|${companyId}` : user;
}

export function busySelector(app: AppProfile): string {
  return app.busySelectors.join(", ");
}

export function companyRouteRegex(pattern: string, lang: string): RegExp {
  return new RegExp(withLang(pattern, lang));
}
