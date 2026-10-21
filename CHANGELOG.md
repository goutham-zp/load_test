# Changelog

## 0.1.8 — 2026-10-21

- Discovery backs up the current `catalog.json`, `recording.json` and `discovery-steps.json` to
  `catalogs/<env>/backups/<time>/` before writing (newest 10 kept, git-ignored).
- Partial discovery runs merge instead of replacing. With `--users` or `--pages`, each user + company + page the run
  visits replaces its earlier data and everything else is kept, so `--users user2` adds a user and `--pages home`
  refreshes one page. Blocked-write suggestions are refreshed for revisited pages. `--replace` starts fresh; a run
  without `--users`/`--pages` always replaces.
- New `catalogs/<env>/recording.json`: every recorded call, the visited combinations, pages and blocked writes. The
  catalog is rebuilt from it after a merge, so samples, variants and medians stay consistent.

## 0.1.7 — 2026-10-21

- Simpler discovery report: a single API list (calls, median, slowest, response codes). Calls to the same API with
  different values are grouped; expand a row to see each URL with its own times and the users that called it. The
  tiles, per-user table and page table are gone from the HTML (page ready times remain in `timings.json`).
- `timings.json` now stores per-URL timings (`urls`) and response counts (`statuses`) for each API.
- All HTML reports use the DXP.Web light theme colours and font, and stay light when the OS is in dark mode.

## 0.1.6 — 2026-10-21

- Discovery now also writes a no-load timing report, `runs/<time>-<env>-discovery/discovery.html` (data in
  `timings.json`). It covers every endpoint's calls, p50, p95, max and failures, broken down per user with the slowest
  call (user, company, page, URL), plus page and interaction ready times per user.
- Endpoints with a median at or above `discovery.slowCallMs` (default 2,000 ms) are flagged "Slow without load": they
  are slow before any load is applied.
- `report <dir>` re-renders a discovery report as well as a run report.

## 0.1.5 — 2026-10-21

- Fix: one page timing out made every later page in discovery (and in the run's browser layer) time out too. Calls
  still running when the browser left a page were cancelled, but Playwright did not report the cancellation for
  requests going through the read-only guard's routing, so the tracker counted them as in flight forever. The tracker
  now drops all pending calls when the main frame starts loading a new document. Reproduced on pg-test (Insights →
  settings/users): before, 3 phantom calls in flight; after, 0.

## 0.1.4 — 2026-10-21

- k6 memory fix: the plan used to be parsed into every VU, so memory grew with the VU count. That count rises with
  latency: at ~8 s per response, 100 req/s needs ~800 VUs. The script now reads a small `plan-index.json` per VU and keeps
  the request slots once in `SharedArray`s. Measured with a 5 MB plan and 306 VUs against a 5 s server: peak memory
  fell from 3,323 MB to 161 MB at the same request count.

## 0.1.3 — 2026-10-21

- Read allowlist: verified 9 more endpoints against their backend repos (DXP_Platform_Server, Tasks_API, Contacts_API,
  data-insights-api-node, data-productcatalog-api). For Contacts, the stored procedures were also checked on
  `pg_preprod`, and they contain no DML. Every approved entry is now backed by backend code.
- Approved `invoices/vendorslist` and `vendor/relationships` after checking Data Engineering's
  `data-relationship-api`, the repo with the OPM pipelines. Both read through `VendorReadRepository`, and the data-access
  project has no Mongo writes. `data-vendors-api` is an old copy.
- Still blocked: `auditlog/search` and `locations/list` (no backend repo found yet).
- `config/services.json`: added rate limits for task-apis (800/s), contacts-apis (30/s), data-productcatalog-apis
  (50/s), data-insights-node-apis and the DXP platform server (`unknown:api`; neither has a limiter), and
  data-relationships-apis (50/s, from data-relationship-api).
- Also approved `catalog-feed` v2 (the app falls back to it when v3 returns 404) and `product-catalog/retailer/settings/grid`, both read-only in Retailer_Product_Catalog_API.
- `_g_scripts/scan-handler.py`: flags write-like calls in a MediatR handler and in the methods it calls.

## 0.1.2 — 2026-10-21

- Read allowlist: reviewed the POSTs blocked during the first pg-test discovery. 18 reads are verified against backend
  code and approved; each entry's `note` records the evidence. 12 more are reads only according to the frontend; they stay
  blocked until their backends are checked.
  - **Writes that stay blocked:**
    - `POST /fms/users/preferences`
    - `PATCH /fms/tasks`
    - `POST /fms/retailer/invoice/download-invoice` (file export)
    - `POST /fms/v3/ap/location/ap-vendor/relationship` (looks like a read, but inserts a vendor-store row when missing)
- Discovery and smoke now say why a page never became ready: the API calls still in flight, or which loading indicator
  was visible.
- Third-party list: added Chameleon (`trychameleon.com`), Contentsquare, HubSpot and Google Ads hosts. They used to be
  counted as blocked writes.
- `envs/pg-test.json`: added the DXP platform server (`<web>/api/`) to `gatewayBaseUrls`, so calls like
  `policies/checkaccess` are recorded.

## 0.1.1 — 2026-10-21

- Fix: login failed with "logged in but found no company id" for users with several companies. The app stays on
  "Select Company" (no `/retailer/<id>` in the URL), so the tool relied only on seeing the app's `/users/data` call.
  Now it waits up to 30 s for that call. If the call isn't seen, the tool fetches `/fms/v2.1/users/data` itself on
  each gateway base URL, with retries. The error message now names the page it landed on and each attempt that failed.
- Mock: `MOCK_LANDING=select|select-nodata` simulates the Select Company landing.

## 0.1.0 — 2026-10-20

First version.

- `discover`: headless Auth0 login per user, crawls retailer pages (list pages, click-through detail pages, scripted
  tabs/sort/pagination/search), records API calls, maps them to gateway services via `~/Documents/work/api_gateway`,
  detects paging/sort/filter/date/search parameters and builds per-endpoint variants.
- Read-only guard: only GET/HEAD/OPTIONS, Auth0, and reviewed `config/read-allowlist.json` entries reach the backends;
  blocked writes are listed with allowlist suggestions. Third-party analytics are blocked.
- `smoke`: every endpoint once per user (paced under rate limits) plus every page once.
- `run`: stepped k6 load (one k6 run per step), equal rate per endpoint, self-throttled under each service's rate
  limit (`config/services.json`, multi-window, per-token or per-IP), broken services held at their last healthy rate,
  emergency stop, Ctrl-C finishes the step and still reports; browser layer measures page/interaction readiness under load.
- Reports: self-contained `report.html` per run and `compare` report (regressions first, fairness checks).
- Prod-like hosts refused unless `--allow-prod-like` plus typed confirmation.
- Mock DXP (`npm run mock`, `--env mock`) for trying the tool without a real environment; Dockerfile for headless servers.
