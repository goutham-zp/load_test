# dxp-loadtest

Read-only load testing for the DXP retailer portal: k6 drives API load in steps up to the breaking point while
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

Try it locally first: `npm run mock` in one terminal, then use `--env mock` (any email, password `pw`).

Checks: `npm run check` (type-check + unit tests).
