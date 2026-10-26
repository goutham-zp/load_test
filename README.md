# dxp-loadtest

Read-only load testing for the DXP retailer portal (DXP.Web) and FMS_UI: k6 drives API load in steps up to the breaking point while
headless browsers measure real page timings, then an HTML report ranks the slowest pages and endpoints (mapped to
their backend service). `compare` diffs two runs, e.g. Oracle vs Postgres deployments.

Full guide: `~/Documents/obsidian/Work/_g_docs/dxp-loadtest/usage.md`

```bash
scripts/setup.sh                                  # k6, deps, Chromium; creates .env
cp envs/example-postgres.json envs/pg-test.json   # fill URLs, rename "name"
npm run lt -- discover --env pg-test              # record pages + API calls -> catalogs/pg-test/
npm run lt -- smoke    --env pg-test              # every endpoint + page once; must pass
npm run lt -- run      --env pg-test --label baseline
npm run lt -- compare  <runA> <runB>
```

Each env names its app (`"app": "retailer"` or `"fms"`); the app's pages, interactions, selectors and login live in
`config/apps/<app>/`. FMS_UI starts from `envs/pg-fms.json`.

Try it locally first: `npm run mock` in one terminal, then use `--env mock` (retailer) or `--env mock-fms` (FMS_UI-style
company tokens). Any email, password `pw`.

Checks: `npm run check` (type-check + unit tests).


1. Get a machine or pod. Size it from section 3. It needs to reach pg-dxp.app.fintech.com, pg-apis.app.fintech.com and fintech-prod.us.auth0.com.
2. Install the tool:
git clone <your dxp-loadtest remote> && cd dxp-loadtest
scripts/setup.sh                    # Node 22+ required; installs k6, Chromium + system libs, npm ci
npm run check                       # 55 tests should pass
3. Clone the gateway config:
scripts/clone-gateway-config.sh ~/api_gateway     # asks for the PAT
echo 'export LT_GATEWAY_CONFIG_DIR=~/api_gateway' >> ~/.bashrc
   It should end with about 208 service.json files.
4. Copy across the files git doesn't have. Run this from your laptop:
scp .env server:dxp-loadtest/
scp -r catalogs/pg-test server:dxp-loadtest/catalogs/
   The other option is to skip copying the catalog and run discover on the server.
5. Open a session that survives SSH drops:
tmux new -s lt
ulimit -n 65536
6. Smoke, then a short trial:
npm run lt -- smoke --env pg-test --allow-prod-like
npm run lt -- run --env pg-test --allow-prod-like --label trial --steps 5,10 --step-duration 60 --browsers 2 --yes
   Each command asks you to type pg-test.
7. Full run. Tell the pg-test owners first.
npm run lt -- run --env pg-test --allow-prod-like --label baseline --yes
   You can detach with Ctrl-b d and reattach later with tmux attach -t lt.
8. Get the results back:
scp -r server:dxp-loadtest/runs/<time>-pg-test-baseline .
   Then open report.html.
