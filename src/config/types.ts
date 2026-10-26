export type EnvKind = "oracle" | "postgres" | "other";

export interface EnvConfig {
  name: string;
  kind: EnvKind;
  /** Which web app this env serves: a folder under config/apps/ (default "retailer", the DXP.Web retailer portal). */
  app?: string;
  /** Origin of the web app, e.g. https://test-opm-dxp.app.fintech.com */
  webBaseUrl: string;
  lang: string;
  /** Path the login flow starts from (defaults to the app's loginPath). */
  loginPath?: string;
  /** URL prefixes whose requests are API calls to record and load (gateway origins, DXP platform server, ...). */
  gatewayBaseUrls: string[];
  /** Auth0 origin. Non-GET requests to it are allowed (token refresh). */
  auth0Domain: string;
  /** Override settings.gatewayConfigDir for this env (e.g. the mock env). */
  gatewayConfigDir?: string;
  /** Per-env overrides merged over config/services.json entries (e.g. pod counts). */
  services?: Record<string, Partial<ServiceConfig>>;
  /**
   * Service names for API hosts the app calls directly, not through a gateway route: URL prefix -> service name
   * (a services.json key). Unmapped calls on such hosts fall back to "unknown:<first path segment>".
   */
  hostServices?: Record<string, string>;
  /** Company-token apps (FMS_UI): base URL of the auth API that swaps the Auth0 token for a company token. */
  authApiBaseUrl?: string;
  /** Company-token apps (FMS_UI): base URL of the users API that lists the user's companies. */
  usersApiBaseUrl?: string;
  /** .env prefix of this env's users (default "LT_USER_", read as <prefix><n>_EMAIL / _PASSWORD), e.g. "LT_FMS_USER_". */
  userPrefix?: string;
}

/** Selectors the interactions use to find tabs, sortable grid headers, the next-page button, search and rows. */
export interface AppSelectors {
  tab: string;
  sortableHeader: string;
  nextPage: string;
  searchBox: string;
  /** Tried in order to click into the first row of a list page. */
  firstRow: string[];
}

/** DXP.Web: one Auth0 token per user; companies come from the app's /users/data call. */
export interface UsersDataLogin {
  kind: "users-data";
  /** Path of the companies call on a gateway base URL. */
  usersDataPath: string;
  /** Regex (on the URL pathname, {lang} substituted) of the page a single-company user lands on; group 1 = company. */
  companyRoute: string;
}

/** FMS_UI: Auth0 login, then one API token per company from the auth API's token exchange. */
export interface CompanyExchangeLogin {
  kind: "company-exchange";
  /** localStorage key of the Auth0 token the app keeps. */
  auth0TokenKey: string;
  /** Path (on usersApiBaseUrl) listing the companies the Auth0 user can open. */
  companiesPath: string;
  /** Path (on authApiBaseUrl) that swaps { token, wwwLogin } for a company token. */
  exchangePath: string;
  /** Response headers carrying the company access and refresh tokens. */
  accessTokenHeader: string;
  refreshTokenHeader: string;
  /** localStorage key for the refresh token. */
  refreshTokenKey: string;
  /** Extra fields the exchange body needs besides token and wwwLogin (the app's own call, when seen, wins). */
  exchangeExtraBody?: Record<string, unknown>;
  /** Extra localStorage values the app sets after a company is chosen. */
  extraStorage?: Record<string, string>;
  /** JWT claim of the company token naming the company type (matched against pages' companyTypes). */
  companyTypeClaim?: string;
  /**
   * When the token has no such claim: the GET the app makes after its exchange to learn the company (path in the
   * direct /api/... form, matched like the other paths) and the dot path of the type in its JSON. The tool repeats
   * the app's call with each company token.
   */
  companyInfoPath?: string;
  companyTypeField?: string;
  /**
   * The app's company picker button. When the exchange URL is unknown (no authApiBaseUrl, the app didn't call it), the
   * first one is clicked so the app makes the exchange call itself and the URL can be read from it.
   */
  pickerSelector?: string;
  /**
   * Accounts not on Auth0 (FMS legacy login, e.g. dev users on 25 Oct 2026): the app checks the email (authPortal),
   * takes the password itself at its own login call and stores a company token for the account's default company
   * straight away, with no Auth0 token. That token is used as it is; the claims name its company.
   */
  legacy?: {
    /** JWT claim of the company token with the company id (the ftsId), and the one with its login (wwwLogin). */
    companyIdClaim: string;
    loginClaim: string;
  };
}

/** How the tool drives one web app: config/apps/<name>/app.json, next to its pages.json and interactions.json. */
export interface AppProfile {
  name: string;
  /** Page URL template: {web}, {lang}, {company}, {path}. */
  pageUrl: string;
  /** Regex on a URL pathname with a named group "path" (and "company" when the URL carries it); {lang} substituted. */
  pagePattern: string;
  /** Where login starts ({lang} substituted). */
  loginPath: string;
  /** localStorage key of the token the app sends to its APIs. */
  tokenKey: string;
  /** "user": one API token per user. "company": one per user and company (the token selects the company). */
  tokenScope: "user" | "company";
  login: UsersDataLogin | CompanyExchangeLogin;
  /** Loading indicators: a page is busy while any is visible (in any frame). */
  busySelectors: string[];
  /**
   * A page load is not ready sooner than this after the load event, for apps that wait before their first API call
   * (FMS_UI fetches feature flags from a host that isn't load tested first). Only the wait grows: ready time is still
   * the last activity. Default: no minimum.
   */
  loadSettleMs?: number;
  selectors: AppSelectors;
  /** Non-GET calls the app makes to log in or refresh its token: let through the guard, never recorded or replayed. */
  authCalls?: { method: string; path: string }[];
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
  /** The app's page path ({path} in its pageUrl), may contain {placeholders} for detail pages. */
  path: string;
  /** Only visit for these company types (company-token apps; from the token's companyTypeClaim). */
  companyTypes?: string[];
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
