# Changelog

## 0.2.0 — 2026-10-21

FMS_UI support (company tokens) next to the DXP.Web retailer portal.

- **Apps.** Each env names its app (`"app"`, default `retailer`). Everything that drives the browser comes from
  `config/apps/<app>/`: `app.json` (page URL pattern, login, token key and scope, loading indicators, selectors, auth
  calls), `pages.json` and `interactions.json`. The retailer config moved there unchanged; on the mock its catalog is
  identical to before (same endpoints, samples, variants, pages and interactions).
- **Company-token login (fms).** Auth0 through the app's own `/login` page, then the company list and one token exchange
  per company. One saved session per user + company; `login`/`discover` take `--max-companies`.
- **Load per company token.** Catalog samples are capped per token; each planned request carries its token key
  (`user|company`) and k6 sends that token. `smoke`/`run` log in to exactly the catalog's companies and stop before
  sending load if a token is missing. Rate ceilings of token-keyed services count tokens instead of users.
- **Read-only guard:** the app's declared auth calls (FMS token exchange and refresh) are allowed as `auth` in the browser
  and never recorded or replayed. FMS logins run in a guarded browser.
- **API hosts:** discovery reports fetch/XHR hosts outside `gatewayBaseUrls` (`untrackedHosts` in the catalog).
  `hostServices` in an env maps directly-called hosts to a service; their endpoint keys carry the service.
- **Ready check** uses the app's loading indicators and also looks inside iframes (FMS_UI embeds DXP.Web reports).
- **Interactions** use the app's selectors; FMS covers `th.sortable-header`, the `>` pager button, Kendo grids and
  bootstrap tabs. Pages can be limited to `companyTypes` (from the company token's claim).
- **Login form** handles username-only screens before the password (the app's own page, Auth0 identifier-first).
- Reports show the app; `compare` warns when two runs are from different apps.
- New `envs/pg-fms.json` starting point (pg-fms-ui.app.fintech.com), `envs/mock-fms.json` and an FMS-style mock.
- **Users per env:** `userPrefix` in an env (e.g. `LT_FMS_USER_`) reads that env's users from `.env`, so FMS_UI and
  retailer users live side by side. Keys stay `user1`, `user2`, ...
- **No auth host needed up front:** when the token-exchange URL is unknown, the FMS login clicks the first company in
  the app's picker (`pickerSelector`), takes the URL from the app's own exchange call, waits for the app's reload, then
  exchanges for each chosen company itself.
- **FMS username lookup allowed:** after the username, FMS_UI POSTs `/v1/users/authPortal` to ask whether the user signs
  in through Auth0. The guard blocked it and the app sent the browser back to `/login`; it is now an FMS auth call.
  The mock makes the same call. `envs/pg-fms.json` points at the Auth0 tenant the app actually redirects to.
- **Auth0 decoy button:** Auth0's newer login screens put a hidden `aria-hidden` Continue button under the input, first
  in the page; the login clicked it and timed out. Submit now skips hidden and `aria-hidden` buttons (the mock has the
  decoy too). After a submit, a URL change also counts as the next screen, so going from the app's username page to
  Auth0's (which has its own username field) no longer waits 30s.
- **FMS calls through the gateway:** with its KrakenD flag on, FMS_UI drops `api/` and adds a router prefix
  (`/api/v1/auth2/auth0Validation` -> `/fms/v1/auth2/auth0Validation`). The login and the guard's auth calls now match
  both forms; before, the login missed the app's exchange and failed with "found no companies".
- **Users without a company list:** FMS_UI lists companies only behind a feature flag and when the user has no default
  company; otherwise it swaps straight to the default. The login then reads the list next to the exchange (same
  gateway prefix) for `--max-companies` above 1, or keeps the app's default company. The mock has such a user
  (`default…` email) and serves the list through the gateway.
- **`scripts/clone-gateway-config.sh`:** clones or updates the 4 API gateway config repos the tool reads (`fms`,
  `data-platform`, `fintech-platforms`, `platform-engineering-internal`; not the `-opm`/`-demo` copies) with a PAT,
  shallow, without storing the PAT anywhere. For headless servers.
- **Catalogs and sessions are tied to the env's hosts.** `smoke` and `run` refuse a catalog whose requests or pages
  go to hosts the env file doesn't name (an env file repointed to another deployment would otherwise replay the old
  deployment, past the production check). A partial `discover` replaces such a catalog instead of merging into it.
  Saved logins remember the web host and are not reused after the env points elsewhere.
- **Production check knows glued names:** a host whose first label starts with an environment (`uatfms`, `devfms`)
  is treated like `uat-fms`; `prdfms`/`prodfms` still count as production, and plain `fms` stays production-like.
- **FMS exchange body:** the login repeats the app's own exchange body (FMS_UI sends `requestedBy: 3`; without it the
  exchange answers 400), changing only the token and company. `exchangeExtraBody` in the profile covers the case where
  the app's call isn't seen.
- **FMS company type:** FMS company tokens carry no type claim. The login repeats the app's own company call
  (`companyInfoPath`, `/configuration/redirect`) with each company token and reads `companyTypeField`
  (`result.companyType`), so pages' `companyTypes` filtering works.
- **Ready check waits for the app to start.** Quiet is measured from the end of the action (the load event), not the
  start of the step, and an app can set `loadSettleMs` (FMS: 3000) as the minimum wait after a page load: FMS_UI waits
  over a second for feature flags before its first API call, so pages were declared ready with 0 calls and their calls
  leaked into the next page. In-flight calls are also forgotten when a new document's response arrives (the old page
  keeps running until then). Ready times are unchanged in meaning: the last activity.
- **FMS allowlist:** `invoices/distributor/summary` and `v1.3/fms/invoicesummary` approved as reads (handlers and
  procedures read); `relationships/distributors/locations/potential` stays blocked (fills a zip-code table from an
  external API). `envs/pg-fms.json` adds the directly called `uat-stagedinvoice-api` host.
- **Hung calls are reported.** A call still open when its step times out is now recorded as "no response" with the time
  waited (before, the next page cancelled it and it vanished). It shows in `discovery.html` (red), in the catalog's
  failures and the discover summary, and in the run report's "endpoints not loaded" with the reason
  `no successful sample during discovery (no response)`; in load runs the browser layer's page breakdown names it.
  A host added to `gatewayBaseUrls` is no longer listed as untracked from an older merged recording.

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
