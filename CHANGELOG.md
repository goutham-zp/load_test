# Changelog

## Unreleased

- **FMS discovery visits only the pages each account's nav bar links to.** It opened every page in `pages.json` by its
  URL, so it recorded pages real users can't reach: `/payment-preferences` is a route anyone can type, but its menu
  entry shows only to a retailer admin with AP payments on, and the distributor catalogs still got its calls (the dev
  team confirmed users don't navigate there). Discovery now opens the landing page per account, opens every nav
  dropdown (`navigation` in `config/apps/fms/app.json`), and visits only pages linked there plus the landing page.
  Detail pages reached by clicking a grid row are skipped. If the nav bar can't be read, discovery stops instead of
  visiting everything. `discover --all-pages` keeps the old behaviour. Re-run `discover --replace` to drop pages from
  an existing catalog. Apps without a `navigation` config (retailer/DXP) are unchanged.
- **FMS `pages.json` gains the nav bar view pages it was missing:** final-confirmations, invoice-documents inbox,
  complete and archive, managepocontacts, my-products, nonreg-invoice-details and fms-products/catalog-exceptions.
  Form pages in the nav bar (add-new-user, company/edit, banking, change-password, ...) are still not visited.
- **401 and 403 under load now count as errors.** They were "client errors", kept out of the error rate: on UAT FMS
  (26 Oct 2026) a run got 401 on 78-95% of calls and said "errors 0.0%". Every replayed sample succeeded at discovery,
  so an auth rejection during load is a failure. Other 4xx stay client errors (variants can legitimately return them).
- **A run or discovery with fewer logins than the previous one no longer uses stale tokens.** Logins beyond
  `--sessions-per-user` stayed in the saved sessions without being refreshed, and k6 got every saved token: a 1-login
  run after a 4-login run sent 3 of every 4 calls with an expired token (that was the 401s above, not a limit in the
  API), and discovery visited every page once per saved login. Extra logins are now dropped first.
- **`run --date-range FROM,TO`** sets every date-range field (startDate/endDate, fromDate/toDate, ...; query or JSON
  body at any depth) of every replayed request to one range, in the format each request uses (ISO date, ISO date-time
  with its time suffix, MM/DD/YYYY). Only the base variant is sent. Shown in the run report.
- **Reviewed reads (dev build):** `POST /fms/v1.1/retailers/fms/relationships/{filtered,active}` and
  `POST /fms/v1.3/reports/activity/pending/retailer` are on the read allowlist after reading their Oracle dev procedures.
- **`run --set key=value,...`** replaces top-level JSON body fields in every replayed request that has them, e.g. another
  team's date range: `--set startDate=2025-01-01T00:00:00Z,endDate=2025-01-31T00:00:00Z`. Fields a body doesn't have
  are not added; only the base variant is sent. The values are listed in the run report.
- **FMS invoices-details detailed download is recorded and replayable.** Discovery opens DOWNLOAD CSV and clicks
  "Detailed with headers"; `POST /fms/invoice/v1/invoice/distributor/lineItems/download` is on the read allowlist
  (backend reviewed: one SELECT, no writes).
- **New envs `ora-dev-fms-retailer` and `ora-dev-fms-distributor`:** FMS_UI on dev (devfms.fintech.com) with the Oracle
  backend, labelled `"kind": "oracle"`, one per role so the two are run and reported separately. Each has its own users
  (`LT_FMSORADEV_RET_USER_<n>_*` and `LT_FMSORADEV_DIST_USER_<n>_*` in `.env`, listed in `.env.example`), so neither
  run can pick up the other role's account.
- **New envs `ora-dev-dxp` and `pg-uat-dxp`** for the DXP retailer portal Oracle-vs-Postgres comparison:
  `ora-dev-dxp` is dev-dxp.app.fintech.com (Oracle backend, `LT_DXPDEV_USER_<n>_*`, now in `.env.example`), and
  `pg-uat-dxp` is test-dxp.app.fintech.com (Postgres UAT backends, `LT_USER_<n>_*`). They are on different Auth0
  tenants, so each side is a different account and company. Discover both with `--users user1 --max-companies 1`.
- **An emergency stop for an unreachable host now says why.** The 26 Oct UAT FMS run stopped after its last step
  with "uatfms.fintech.com unreachable (fetch failed), 3 attempts": Node's fetch message hides the network error. The
  stop reason now adds the error code (for example `UND_ERR_CONNECT_TIMEOUT`, `ENOTFOUND`, `ECONNRESET`).
- **The check between steps no longer stops healthy runs on hosts with an internal certificate.** Between steps the
  run checks that the web host and Auth0 are up. On dev (25 Oct 2026) it stopped every run after step 1 (0% errors,
  no k6 network errors) with "devfms.fintech.com unreachable (fetch failed)": Node's fetch rejects that host's
  certificate (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`, internal CA or incomplete chain), while curl, the browsers and k6
  reach it. A certificate Node can't verify now counts as up (the browsers and k6 skip certificate checks too), and a
  host counts as down only when 3 attempts, 5 s apart, all fail or answer 5xx.
- **FMS legacy (non-Auth0) logins.** On dev (25 Oct 2026) the FMS accounts are not on Auth0: the app's authPortal
  sends them to its own `POST /v1/auth2/login`, which stores a company token (`access_token`) for the account's
  default company with no `auth0Token`, so the login waited 90 s and failed. With `login.legacy` in the FMS profile,
  the login now also accepts the app's own company token, reads the company from its claims (`companyId`,
  `unique_name`) and saves that one session; `POST /v1/auth2/login` is an allowed auth call (never replayed). Auth0
  accounts work as before.
- **Users mode visits every page, not just the first few.** Each virtual user started at its own number in the
  token's journey list (in catalog order, 3 samples per page) and moved one entry per visit, so a step only reached
  the top of the list: the 25 Oct FMS trial opened 12 of 61 pages at 25 users and 19 at 50 (billing, PO,
  relationships, catalogs, settings and the retailer reports never loaded). The VUs of an account now start on pages
  spread over all its pages and move one page per visit (`src/load/k6/pick.js`), so every page is opened within
  pages ÷ VUs visits; each lap takes a page's next sample. Earlier users-mode results covered only those first pages.
- **An account only opens pages it reached in discovery.** A page lists the shared menu calls too, so a distributor
  also got journeys on retailer pages (retailer-dashboard), replaying only the menu calls. Journeys now follow the
  page's recorded visits (`urls`); catalogs without them behave as before.
- **Logins survive a slow login page.** The app's login page loads its scripts before it redirects to Auth0. On test
  (23 Oct 2026) that took 30 s to over 60 s: the page stayed on "Loading your experience" while its script files
  downloaded slowly, and a login failed with "no login form appeared within 60s". The first login screen now gets
  180 s; a failed login is tried once more (not when Auth0 rejects the credentials, so an account isn't locked out);
  and the error says what the page showed.
- **The verdict names the service that broke.** When only one service crossed a limit, the verdict said e.g. "too
  slow: p95 4.91 s (limit 10.0 s)", quoting all calls' p95, which was under the limit. It now names the service and
  its own figure: "too slow: fms/banking-apis 10.7 s p95 (limit 10.0 s; all calls 4.91 s)".
- **FMS pages load their grid and report data.** FMS_UI fetches most grids and reports with POSTs, and all 39 were
  blocked, so the FMS catalog held mostly the menu and count calls every page repeats. 38 of them, plus
  `billing/summary`, `billing/details` and `billing/invoices` (seen once the billing pages got their periods), are now
  in `config/read-allowlist.json` as reviewed reads:
  each traced from the controller to its procedure (or EF, OpenSearch and file reads), and every procedure checked on
  UAT for INSERT/UPDATE/DELETE and for calls to routines that write.
  `distributors/locations/potential` stays blocked: for an unknown ZIP code it calls API Ninjas and inserts the ZIP.
- **`envs/pg-fms.json` includes the banking API host** the banking-activity page calls directly
  (`uat-banking-api.app.fintech.com`, mapped to `fms/banking-apis`).
- **The dev FMS build's newer read POSTs.** Dev calls newer versions of some reads: staged-invoice
  `v1.1 search/retailer`, PO `v1.1 purchaseorders/totals`, relationships `v1.1 retailers/relationships/tradingpartners`
  and banking `v1.1 .../retailer/summary/compressed` are allowlisted (handlers traced on `master_postgres`, procedures
  checked on UAT). Three stay blocked and are recorded unreviewed: relationships `v1.1 .../filtered` and `.../active`
  (`fast.get_company_relationships_v2`) and banking `v1.3 .../pending/retailer`
  (`pkg_fms_pending_bankactivity.retailer_activity_paginated_v3`), because their procedures exist only on dev and the
  dev database could not be read.

## 0.3.0 — 2026-10-22

Users mode: load expressed as simultaneous users instead of requests per second.

- **`run --vus 100,250,500,1000 [--think-time 10]`.** Each step runs that many k6 virtual users. Each one opens a
  page (all of the page's recorded calls at once, as a browser does), waits the think time (+-50%) and opens the next.
  Pages come from the catalog's reached pages ("journeys": one per page and token, rotating samples), so no new
  discovery or smoke is needed. Services are judged on the rate they actually got; one that breaks keeps getting what
  the users send (it can't be held back), and the report and log say at how many users it broke.
- **`--sessions-per-user N`** (run and login). Each account logs in N times; every login has its own token, which the
  services' per-token rate limits (`ClientIdHeader: Authorization`) treat as a separate client, as with real users.
  k6 rotates the tokens (users mode: each virtual user keeps one session); ceilings of token-keyed services scale
  with the sessions. The run's start lists each service's expected rate at the peak and flags any above its ceiling.
- Report, log and `compare` speak in users for users-mode runs (step labels, breaking point, steps table, run
  details with think time and sessions); `compare` warns when the two runs used different modes or think times.
- **`run --exclude-service a,b`** leaves services out of the load (plan and users-mode journeys), e.g. one that is
  already down; its endpoints are listed as excluded with the reason. Pages in the browser layer still call it.
- **Parallel logins.** Sessions log in several at a time (`--login-concurrency`, default 6; login and run), each in
  its own browser context, and each is saved as soon as it finishes, so an interrupted login keeps its progress. On
  test, 6 logins took ~60 s instead of ~3.5 min. Failed logins are listed together after the others finish.
- **Distinct tokens per session.** Auth0 tokens carry no unique id: two logins of one account finishing in the same
  second got the identical token (seen on test), which would share one rate-limit bucket. Such sessions are logged in
  again, staggered, until every session of the account has its own token.
- **Simpler run report.** It has three parts:
  - A short verdict: where the run broke, and the throughput ceiling (a step where the load grew by half or more but
    the requests served stayed flat).
  - The load steps table: calls made, req/s served, p50, p95, errors, and OK or broke for each step. A broken step
    says which limit it crossed ("Too slow", "Too many errors" or both), and the verdict gives the numbers
    (e.g. "too slow: p95 32.3 s (limit 10.0 s); no calls failed"), so a step can't look broken without saying why.
  - The full list of API calls for a chosen step (default: the breaking step). Each row shows the pages that call the
    API, the calls made, avg/p50/p95/max, timed out, 5xx and 4xx; it is sortable.

  Run setup, the APIs not loaded, and notes are folded away. Charts, tiles, per-page browser timings, parameter
  variants and rate-limit ceilings are no longer shown; results.json still has them. Regenerate an old run's report
  with `report runs/<dir>`.
- **Why calls failed.** Each API row shows the failed calls and the reasons, built from the status and k6's
  `error_code`, e.g. "63 × Timed out (no response in 60s)", "2 × HTTP 503", "1 × Connection refused". Stats also
  count calls with no response (status 0) as `timeouts`, in addition to counting them in errors.
- **Page visits** (users mode). k6 counts every page a virtual user opens (`lt_visits`). The steps table shows the
  visits for each step, and each API row shows how often each of its pages was opened (`home ×6`), so the call counts
  can be traced back.
- `report <runDir>` reads the failure reasons and page visits for older runs from each step's `k6.json.gz`.
  For runs made before the counter existed, visits are estimated: the most calls of any one API on that page.
  results.json is left unchanged. New runs record the request timeout in the run meta.

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
- **DXP allowlist (test env):** approved as reads after reading their handlers: `v3/tasks`, `rpc/v3 catalog-feed
  product-view / vendor-view`, `payment-activity/summary/list`, `v2.1/retailer/scanned-invoices`,
  `retailers/relationships/pending`, `billing plan-card-features`, `productcatalogsettings/getcategorybyglcode` and
  `contacts/list`. Still blocked: SignalR negotiate, `users/preferences`, `auditlog/search`, `ap-vendor/relationship`.
- Discovery no longer lists the app's own web host as an untracked API host (Next.js page-data fetches).
- `smoke` / `run` stop before logging in when the catalog's users have no credentials in this machine's `.env`
  (a catalog copied to a server whose `.env` has fewer users), naming the missing `LT_USER_<n>` variables. Before,
  only the found users logged in and the error blamed lost company access.
- `smoke.json` lists each failing page's failed API calls (method, URL, status), not just a count.
- Saved logins remember the account's email and are not reused when `.env` maps the user key to another account
  (a machine whose `LT_USER_1` differs from the one discovery used logged in the wrong account and got 400s).

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
