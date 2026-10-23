# Changelog

## Unreleased

- **Logins survive a slow login page.** The app's login page loads its scripts before it redirects to Auth0. On test
  (23 Oct 2026) that took 30 s to over 60 s: the page stayed on "Loading your experience" while its script files
  downloaded slowly, and a login failed with "no login form appeared within 60s". The first login screen now gets
  180 s; a failed login is tried once more (not when Auth0 rejects the credentials, so an account isn't locked out);
  and the error says what the page showed.

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
