export type JsonPrimitive = string | number | boolean | null;

/** One API call captured from the browser during discovery. */
export interface RecordedRequest {
  user: string;
  companyId: string;
  page: string;
  interaction: string;
  method: string;
  url: string;
  body?: string;
  /** Headers worth replaying (Authorization is never stored). */
  headers: Record<string, string>;
  status: number;
  durationMs: number;
  /** Total row count found in the JSON response, used to bound deep pagination. */
  totalCount?: number;
}

export type ParamLocation = { in: "query"; name: string } | { in: "body"; path: string[] };

export type DimensionKind =
  | "page"
  | "offset"
  | "size"
  | "sort"
  | "direction"
  | "search"
  | "dateFrom"
  | "dateTo"
  | "filter";

export interface ParamDimension {
  location: ParamLocation;
  label: string;
  kind: DimensionKind;
  observed: JsonPrimitive[];
  /** Values the load test cycles through (one-at-a-time against the base sample). */
  values: JsonPrimitive[];
}

export interface Variant {
  label: string;
  set: { location: ParamLocation; value: JsonPrimitive }[];
}

export interface Sample {
  user: string;
  companyId: string;
  url: string;
  body?: string;
  headers: Record<string, string>;
}

export interface CatalogEndpoint {
  key: string;
  method: string;
  pathTemplate: string;
  service: string;
  servicePath?: string;
  matchedRoute: boolean;
  pages: string[];
  samples: Sample[];
  dimensions: ParamDimension[];
  variants: Variant[];
  observedStatuses: Record<string, number>;
  discoveryMedianMs: number;
}

export interface CatalogPage {
  id: string;
  reached: boolean;
  note?: string;
  urls: { user: string; companyId: string; url: string }[];
  interactions: string[];
  endpoints: string[];
}

export interface BlockedRequest {
  method: string;
  url: string;
  pathTemplate: string;
  page: string;
  interaction: string;
  bodySample?: string;
  count: number;
  suggestedAllowlistEntry: { method: string; path: string; reviewed: false };
}

/** API-style calls seen on hosts outside the env's gatewayBaseUrls (not recorded, so not load tested). */
export interface UntrackedHost {
  origin: string;
  count: number;
  example: string;
}

export interface Catalog {
  version: 1;
  env: string;
  /** The app the catalog was discovered from (absent in catalogs made before apps existed: "retailer"). */
  app?: string;
  /** "company": samples run with a per-company token, keyed user|companyId (absent: "user"). */
  tokenScope?: "user" | "company";
  createdAt: string;
  webBaseUrl: string;
  gatewayBaseUrls: string[];
  users: string[];
  endpoints: CatalogEndpoint[];
  pages: CatalogPage[];
  /** Requests the read-only guard blocked during discovery. */
  blocked: BlockedRequest[];
  /** Non-2xx responses seen during discovery, per endpoint key. */
  failures: { key: string; status: number; count: number }[];
  untrackedHosts?: UntrackedHost[];
}
