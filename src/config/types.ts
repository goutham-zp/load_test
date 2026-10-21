export type EnvKind = "oracle" | "postgres" | "other";

export interface EnvConfig {
  name: string;
  kind: EnvKind;
  /** Origin of the Next.js web app, e.g. https://test-opm-dxp.app.fintech.com */
  webBaseUrl: string;
  lang: string;
  /** Path the login flow starts from (defaults to /<lang>/retailer). */
  loginPath?: string;
  /** URL prefixes whose requests are API calls to record and load (gateway origins, DXP platform server, ...). */
  gatewayBaseUrls: string[];
  /** Auth0 origin. Non-GET requests to it are allowed (token refresh). */
  auth0Domain: string;
  /** Override settings.gatewayConfigDir for this env (e.g. the mock env). */
  gatewayConfigDir?: string;
  /** Per-env overrides merged over config/services.json entries (e.g. pod counts). */
  services?: Record<string, Partial<ServiceConfig>>;
}

export type RateLimitKey = "token" | "ip" | "shared";

export interface RateRule {
  perSeconds: number;
  limit: number;
}

export interface ServiceConfig {
  repo?: string;
  pods: number;
  key: RateLimitKey;
  /** Empty array means no known rate limit. */
  limits: RateRule[];
  /** False when the limit is a guess (no appsettings found). */
  limitsVerified: boolean;
}

export interface ServicesFile {
  defaultUnknown: ServiceConfig;
  services: Record<string, Partial<ServiceConfig>>;
}

export interface Settings {
  gatewayConfigDir: string;
  backendsDir: string;
  discovery: {
    maxCompaniesPerUser: number;
    navigationTimeoutMs: number;
    maxSamplesPerUserPerEndpoint: number;
    maxVariantsPerEndpoint: number;
    searchTerms: string[];
    /** Median at or above this marks an endpoint "slow without load" in the discovery report (default 2000). */
    slowCallMs?: number;
  };
  load: {
    stepsRps: number[];
    stepDurationSec: number;
    safetyFactor: number;
    requestTimeoutSec: number;
    maxVUsPerService: number;
  };
  break: {
    errorRate: number;
    p95Ms: number;
    minRequests: number;
  };
  emergency: {
    errorRate: number;
  };
  browser: {
    workers: number;
    readyQuietMs: number;
    readyTimeoutMs: number;
    runInteractions: boolean;
  };
  tokenRefreshMarginSec: number;
  blockedThirdPartyHosts: string[];
}

export interface PageConfig {
  id: string;
  /** Path under /<lang>/retailer/<companyId>/, may contain {placeholders} for detail pages. */
  path: string;
  /** Detail pages are reached by clicking the first row of this list page. */
  detailFrom?: {
    page: string;
    clickSelector?: string;
  };
  /** Pages under the (standalone) route group use the same URL shape; kept for clarity. */
  enabled?: boolean;
}

export interface GridInteraction {
  /** How many times to press "next page". */
  nextPages?: number;
  /** How many sortable columns to sort by (first N visible). */
  sortColumns?: number;
}

export type InteractionStep =
  | { action: "click"; selector: string; label: string }
  | { action: "fill"; selector: string; value: string; label: string }
  | { action: "select"; selector: string; value: string; label: string };

export interface PageInteractions {
  /** "auto" clicks every [role=tab] on the page. */
  tabs?: "auto" | string[];
  grid?: GridInteraction;
  /** Terms typed into the page's search box. */
  search?: { selector?: string; terms: string[] };
  /** Explicit steps for bespoke pages. Each step is measured separately. */
  steps?: InteractionStep[];
}

export interface InteractionsFile {
  defaults: PageInteractions;
  pages: Record<string, PageInteractions | "default" | "none">;
}

export interface AllowlistEntry {
  method: string;
  /** Regex matched against the URL pathname. */
  path: string;
  note?: string;
  /** Unreviewed entries are ignored by the guard. */
  reviewed: boolean;
}

export interface User {
  key: string;
  email: string;
  password: string;
}
