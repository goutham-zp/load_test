// A tiny fake DXP (Auth0 + web apps + API gateway) for verifying the tool end to end without a real environment.
// Run: npm run mock   then use --env mock (retailer) or --env mock-fms (FMS_UI-style).  Users: any email, password "pw".
import http from "node:http";

const WEB = 4100;
const AUTH = 4101;
const GW = 4102;
const FMS_WEB = 4103;
const USERS_API = 4104;
const CONFIG_HOST = 4105;
const webOrigin = `http://localhost:${WEB}`;
const authOrigin = `http://localhost:${AUTH}`;
const gwOrigin = `http://localhost:${GW}`;
const fmsOrigin = `http://localhost:${FMS_WEB}`;
const usersOrigin = `http://localhost:${USERS_API}`;
const configOrigin = `http://localhost:${CONFIG_HOST}`;
// Slowdown multiplier, e.g. MOCK_SLOW=2 to simulate a slower deployment for compare.
const SLOW = Number(process.env.MOCK_SLOW ?? "1");
// Landing after login: "auto" (straight to the first company), "select" (stay on a Select Company page, like a
// multi-company user), "select-nodata" (Select Company without the app ever calling /users/data).
const LANDING = process.env.MOCK_LANDING ?? "auto";

function b64url(s: string): string {
  return Buffer.from(s).toString("base64url");
}

function makeToken(email: string, extra: Record<string, string> = {}): string {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return `${b64url(JSON.stringify({ alg: "none" }))}.${b64url(JSON.stringify({ sub: email, exp, ...extra }))}.sig`;
}

function claims(auth: string | undefined): Record<string, unknown> | undefined {
  const t = auth?.replace(/^Bearer /, "");
  if (!t) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(t.split(".")[1]!, "base64url").toString());
    return payload.exp * 1000 > Date.now() ? payload : undefined;
  } catch {
    return undefined;
  }
}

function tokenOk(auth: string | undefined): string | undefined {
  return claims(auth) ? auth!.replace(/^Bearer /, "") : undefined;
}

// FMS_UI-style companies: each has its own login (wwwLogin) and gets its own API token.
const FMS_COMPANIES = [
  { ftsId: 2001, userName: "ret_a", companyName: "Retail A", type: "Retailer", childCompanies: [] as unknown[] },
  { ftsId: 3001, userName: "dist_b", companyName: "Dist B", type: "Distributor", childCompanies: [] as unknown[] },
];

const corsFor = (extra: Record<string, string> = {}) => ({
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, retailerftsid, content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  ...extra,
});

// ---------------------------------------------------------------------------- Auth0

http
  .createServer((req, res) => {
    const url = new URL(req.url!, authOrigin);
    if (url.pathname === "/authorize") {
      const redirect = url.searchParams.get("redirect_uri") ?? webOrigin;
      const err = url.searchParams.get("error");
      const hint = (url.searchParams.get("login_hint") ?? "").replace(/"/g, "");
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><html><body><form method="post" action="/login">
<input type="hidden" name="redirect_uri" value="${redirect}">
<div style="position:relative"><button type="submit" name="action" tabindex="-1" aria-hidden="true" style="position:absolute;top:0;left:0">Continue</button><input id="username" name="username" value="${hint}" style="position:relative;z-index:1"></div><input id="password" name="password" type="password">
${err ? `<div id="error-element-password">Wrong email or password</div>` : ""}
<button type="submit" name="action" data-action-button-primary="true">Continue</button></form></body></html>`);
      return;
    }
    if (url.pathname === "/login" && req.method === "POST") {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const f = new URLSearchParams(body);
        const redirect = f.get("redirect_uri") ?? webOrigin;
        if (f.get("password") !== "pw") {
          res.writeHead(302, { location: `/authorize?error=1&redirect_uri=${encodeURIComponent(redirect)}` });
          res.end();
          return;
        }
        res.writeHead(302, { location: `${redirect}#token=${makeToken(f.get("username") ?? "user")}` });
        res.end();
      });
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("mock auth0");
  })
  .listen(AUTH);

// ---------------------------------------------------------------------------- Web app

const APP_JS = `
const GW = "${gwOrigin}";
const AUTH = "${authOrigin}";
const LANDING = "${LANDING}";
const app = document.getElementById("app");
if (location.hash.startsWith("#token=")) { localStorage.setItem("token", location.hash.slice(7)); history.replaceState(null, "", location.pathname + location.search); }
const token = localStorage.getItem("token");
if (!token) location.href = AUTH + "/authorize?redirect_uri=" + encodeURIComponent(location.origin + "/en/retailer");
const parts = location.pathname.split("/").filter(Boolean); // en, retailer, cid, ...page
const cid = parts[2];
const pagePath = parts.slice(3).join("/");
async function api(method, path, body) {
  const res = await fetch(GW + path, { method, headers: { Authorization: "Bearer " + localStorage.getItem("token"), retailerftsid: cid || "", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401) { localStorage.removeItem("token"); location.reload(); }
  return res.ok ? res.json() : { error: res.status };
}
function spinner(on) {
  let s = document.getElementById("spin");
  if (on && !s) { s = document.createElement("div"); s.id = "spin"; s.className = "MuiCircularProgress-root"; s.textContent = "loading"; document.body.appendChild(s); }
  if (!on && s) s.remove();
}
const state = { page: 0, sort: "invoiceDate", order: "desc", status: "open", search: "" };
async function loadGrid() {
  spinner(true);
  const q = new URLSearchParams({ companyId: cid, pageNumber: String(state.page), pageSize: "25", sortBy: state.sort, sortOrder: state.order, status: state.status, search: state.search, fromDate: "2026-01-01", toDate: "2026-10-01" });
  const data = await api("GET", "/fms/v3/invoices?" + q);
  await api("POST", "/fms/v5/reports/invoices", { companyId: Number(cid), pageNumber: state.page, sortBy: state.sort });
  spinner(false);
  const rows = (data.items || []).map((r, i) => '<div class="MuiDataGrid-row" role="row" data-rowindex="' + i + '"><div class="MuiDataGrid-cell"><a href="/en/retailer/' + cid + '/invoices/my-invoices/invoice-details?invoiceId=' + r.id + '">' + r.number + '</a></div></div>').join("");
  document.getElementById("grid-body").innerHTML = rows;
}
async function main() {
  if (!token) return;
  if (!cid) {
    if (LANDING === "select-nodata") { app.innerHTML = "<h1>Select Company</h1>"; return; }
    const me = await api("GET", "/fms/v2.1/users/data");
    if (LANDING === "select") { app.innerHTML = "<h1>Select Company</h1>"; return; }
    location.href = "/en/retailer/" + me.result.activeCompanies[0].ftsId + "/home";
    return;
  }
  await api("GET", "/fms/users/v1/policy/menu-items");
  // A write the guard must block.
  fetch(GW + "/fms/v1/audit/track", { method: "POST", headers: { Authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ page: pagePath }) }).catch(() => {});
  if (pagePath === "home") {
    spinner(true);
    await api("GET", "/fms/v3/invoices/average-spend?companyId=" + cid);
    spinner(false);
    app.innerHTML = "<h1>Home</h1>";
  } else if (pagePath === "invoices/my-invoices") {
    app.innerHTML = '<div role="tablist"><button role="tab" aria-selected="true" id="t-open">Open</button><button role="tab" aria-selected="false" id="t-paid">Paid</button></div>' +
      '<input type="search" placeholder="Search invoices" id="search">' +
      '<div role="grid"><div class="MuiDataGrid-columnHeader MuiDataGrid-columnHeader--sortable" role="columnheader" aria-sort="none" data-f="invoiceDate">Invoice Date</div>' +
      '<div class="MuiDataGrid-columnHeader MuiDataGrid-columnHeader--sortable" role="columnheader" aria-sort="none" data-f="amount">Amount</div><div id="grid-body"></div></div>' +
      '<button aria-label="Go to next page" id="next">next</button>';
    document.querySelectorAll("[role=tab]").forEach((t) => t.addEventListener("click", () => { document.querySelectorAll("[role=tab]").forEach((x) => x.setAttribute("aria-selected", "false")); t.setAttribute("aria-selected", "true"); state.status = t.textContent.toLowerCase(); state.page = 0; loadGrid(); }));
    document.querySelectorAll("[role=columnheader]").forEach((h) => h.addEventListener("click", () => { state.sort = h.dataset.f; state.order = state.order === "asc" ? "desc" : "asc"; loadGrid(); }));
    document.getElementById("next").addEventListener("click", () => { state.page++; loadGrid(); });
    document.getElementById("search").addEventListener("keydown", (e) => { if (e.key === "Enter") { state.search = e.target.value; state.page = 0; loadGrid(); } });
    await loadGrid();
  } else if (pagePath === "invoices/my-invoices/invoice-details") {
    const id = new URLSearchParams(location.search).get("invoiceId");
    spinner(true);
    await Promise.all([api("GET", "/fms/v3/invoice/invoice-details/header?invoiceId=" + id), api("GET", "/fms/v3/invoice/invoice-details/line-items?invoiceId=" + id)]);
    spinner(false);
    app.innerHTML = "<h1>Invoice " + id + "</h1>";
  } else if (pagePath === "insights/spend-overview") {
    spinner(true);
    await api("GET", "/data-platform/v1/insights/spend?companyId=" + cid + "&fromDate=2026-01-01&toDate=2026-10-01");
    spinner(false);
    app.innerHTML = "<h1>Spend</h1>";
  } else {
    location.href = "/en/retailer/" + cid + "/home";
  }
}
main();
`;

http
  .createServer((req, res) => {
    const url = new URL(req.url!, webOrigin);
    if (url.pathname.startsWith("/en/retailer")) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><html><head><title>Mock DXP</title></head><body><div id="app">app</div><script>${APP_JS}</script></body></html>`);
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("mock web");
  })
  .listen(WEB);

// ---------------------------------------------------------------------------- Gateway

let inflight = 0;
const windows = new Map<string, { start: number; n: number }>();

/** 10 req/s per token on invoice detail endpoints, like a rate-limited backend. */
function rateLimited(token: string, path: string): boolean {
  if (!path.startsWith("/fms/v3/invoice/")) return false;
  const now = Date.now();
  const w = windows.get(token);
  if (!w || now - w.start >= 1000) {
    windows.set(token, { start: now, n: 1 });
    return false;
  }
  w.n++;
  return w.n > 10;
}

function latencyFor(path: string, q: URLSearchParams): { ms: number; capacity: number } {
  if (path.startsWith("/data-platform/v1/insights/spend")) return { ms: 120 * SLOW, capacity: 6 };
  if (path === "/fms/v3/invoices") {
    const page = Number(q.get("pageNumber") ?? 0);
    return { ms: (40 + page * 15) * SLOW, capacity: 40 };
  }
  return { ms: 25 * SLOW, capacity: 60 };
}

http
  .createServer((req, res) => {
    const cors = corsFor();
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    const url = new URL(req.url!, gwOrigin);
    const token = tokenOk(req.headers.authorization);
    const send = (status: number, body: unknown, extra: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...cors, ...extra });
      res.end(JSON.stringify(body));
    };
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      // The company list through the gateway (FMS_UI's KrakenD form of /api/users/v1/usersauth/companies).
      if (url.pathname === "/fms/users/v1/usersauth/companies" && req.method === "GET") {
        if (!claims(req.headers.authorization)) return send(401, { error: "unauthorized" });
        return send(200, { result: FMS_COMPANIES.map(({ type: _type, ...c }) => c) });
      }
      // FMS_UI's username step: a POST lookup of whether the user signs in through Auth0.
      if (url.pathname === "/fms/v1/users/authPortal" && req.method === "POST") {
        return send(200, { statusCode: "200", result: { useFms: false } });
      }
      // FMS_UI-style token exchange: Auth0 token + company login -> a token for that company (in response headers).
      if (/^\/(api|fms)\/v1\/auth2\/auth0Validation$/.test(url.pathname) && req.method === "POST") {
        const { token: auth0, wwwLogin } = JSON.parse(body || "{}") as { token?: string; wwwLogin?: string };
        const who = claims(`Bearer ${auth0}`);
        const company = FMS_COMPANIES.find((c) => c.userName === wwwLogin);
        if (!who || !company) return send(401, { error: "invalid exchange" });
        const access = makeToken(String(who.sub), { company: String(company.ftsId), companyType: company.type });
        return send(200, { result: { ok: true } }, { x_access_token: access, x_refresh_token: "r-" + company.userName, "access-control-expose-headers": "x_access_token, x_refresh_token" });
      }
      if (!token) return send(401, { error: "unauthorized" });
      // Company-token endpoints: the path's company must be the token's company.
      const scoped = url.pathname.match(/^\/fms\/v1\/companies\/(\d+)\//);
      if (scoped && claims(req.headers.authorization)?.company !== scoped[1]) return send(403, { error: "token is for another company" });
      if (rateLimited(token, url.pathname)) return send(429, { error: "quota exceeded" }, { "retry-after": "1" });
      const { ms, capacity } = latencyFor(url.pathname, url.searchParams);
      inflight++;
      // Latency grows with concurrency; beyond 3x capacity the service starts failing.
      const load = inflight / capacity;
      const delay = ms * (1 + load * load);
      setTimeout(() => {
        inflight--;
        if (load > 3) return send(503, { error: "overloaded" });
        if (url.pathname === "/fms/v2.1/users/data") {
          return send(200, { result: { uid: "u1", firstName: "Mock", lastName: "User", activeCompanies: [{ ftsId: 1001, companyId: 1, childCompanies: [{ ftsId: 1002, companyId: 2, childCompanies: [] }] }] } });
        }
        if (scoped && url.pathname.endsWith("/invoices")) {
          const page = Number(url.searchParams.get("page") ?? 1);
          const items = Array.from({ length: 20 }, (_, i) => ({ id: Number(scoped[1]) * 100 + page * 20 + i, amount: 100 + i }));
          return send(200, { items, totalCount: 300 });
        }
        if (url.pathname === "/fms/v3/invoices") {
          const page = Number(url.searchParams.get("pageNumber") ?? 0);
          const items = Array.from({ length: 25 }, (_, i) => ({ id: 50000 + page * 25 + i, number: `INV-${50000 + page * 25 + i}` }));
          return send(200, { items, totalCount: 1240 });
        }
        if (url.pathname === "/fms/v1/audit/track") return send(500, { error: "writes must never reach the mock" });
        return send(200, { ok: true, path: url.pathname });
      }, delay);
    });
  })
  .listen(GW);

// ---------------------------------------------------------------------------- FMS_UI-style web app

// No company in the URL: the company is whichever token is in localStorage.access_token. Login goes through the app's
// own /login page, then Auth0, then /auth0 where the app swaps the Auth0 token for a company token.
const FMS_JS = `
const GW = "${gwOrigin}", USERS = "${usersOrigin}", CONFIG = "${configOrigin}", AUTH = "${authOrigin}";
const app = document.getElementById("app");
const path = location.pathname;
function claim(t, k) { try { return JSON.parse(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")))[k]; } catch (e) { return undefined; } }
function skeleton(on) {
  let s = document.getElementById("skel");
  if (on && !s) { s = document.createElement("div"); s.id = "skel"; s.className = "react-loading-skeleton"; s.textContent = "..."; document.body.appendChild(s); }
  if (!on && s) s.remove();
}
async function api(base, p) {
  const res = await fetch(base + p, { headers: { Authorization: "Bearer " + localStorage.getItem("access_token") } });
  if (res.status === 401) { localStorage.removeItem("access_token"); location.href = "/login"; }
  return res.ok ? res.json() : { error: res.status };
}
async function exchange(auth0, wwwLogin) {
  const res = await fetch(GW + "/fms/v1/auth2/auth0Validation", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: auth0, wwwLogin }) });
  localStorage.setItem("access_token", res.headers.get("x_access_token"));
  localStorage.setItem("refresh_token", res.headers.get("x_refresh_token"));
  localStorage.setItem("auth0Handled", "true");
}
async function main() {
  if (path === "/login") {
    app.innerHTML = '<form id="f"><input id="signin-email" name="username"><button type="submit" id="btn-login">Sign In</button></form>';
    document.getElementById("f").addEventListener("submit", async (e) => { e.preventDefault(); const u = document.getElementById("signin-email").value; const check = await fetch(GW + "/fms/v1/users/authPortal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: u }) }).catch(() => undefined); if (!check || !check.ok) { location.href = "/login"; return; } location.href = AUTH + "/authorize?login_hint=" + encodeURIComponent(u) + "&redirect_uri=" + encodeURIComponent(location.origin + "/auth0"); });
    return;
  }
  if (path === "/auth0") {
    if (location.hash.startsWith("#token=")) localStorage.setItem("auth0Token", location.hash.slice(7));
    const auth0 = localStorage.getItem("auth0Token");
    // Like FMS_UI without the multi-company flag (or with a default company): no list, straight to the default company.
    if (String(claim(auth0, "sub")).startsWith("default")) { await exchange(auth0, "ret_a"); location.href = "/"; return; }
    const r = await fetch(USERS + "/api/users/v1/usersauth/companies", { headers: { Authorization: "Bearer " + auth0 } }).then((x) => x.json());
    if (r.result.length === 1) { await exchange(auth0, r.result[0].userName); location.href = "/"; return; }
    app.innerHTML = '<h1>Select Company</h1><div data-testid="active-companies-list">' + r.result.map((c) => '<div>' + c.companyName + ' <button class="continue-btn" data-login="' + c.userName + '">Continue</button></div>').join("") + "</div>";
    document.querySelectorAll("[data-login]").forEach((b) => b.addEventListener("click", async () => { await exchange(auth0, b.dataset.login); location.href = "/"; }));
    return;
  }
  const token = localStorage.getItem("access_token");
  if (!token) { location.href = "/login"; return; }
  const company = claim(token, "company");
  fetch(CONFIG + "/config/flags").catch(() => {});
  // A write the guard must block.
  fetch(GW + "/fms/v1/audit/track", { method: "POST", headers: { Authorization: "Bearer " + token, "content-type": "application/json" }, body: "{}" }).catch(() => {});
  if (path === "/") {
    skeleton(true);
    await api(GW, "/fms/v1/companies/" + company + "/summary");
    skeleton(false);
    app.innerHTML = "<h1>Dashboard</h1>";
  } else if (path === "/invoice-summary") {
    const st = { page: 1, sort: "date", search: "" };
    app.innerHTML = '<input placeholder="Search invoices" id="q"><table><thead><tr><th id="sort_date" class="font-weight-bold sortable-header">Date</th><th id="sort_amount" class="font-weight-bold sortable-header">Amount</th></tr></thead><tbody id="rows"></tbody></table>' +
      '<div class="d-flex"><button id="prev">&lt;</button><button id="next">&gt;</button></div>';
    async function load() {
      skeleton(true);
      const d = await api(GW, "/fms/v1/companies/" + company + "/invoices?page=" + st.page + "&sort=" + st.sort + "&search=" + st.search);
      skeleton(false);
      document.getElementById("rows").innerHTML = (d.items || []).map((r) => '<tr><td><a href="/invoice-details?id=' + r.id + '">' + r.id + "</a></td><td>" + r.amount + "</td></tr>").join("");
    }
    document.querySelectorAll("th.sortable-header").forEach((h) => h.addEventListener("click", () => { st.sort = h.id.slice(5); load(); }));
    document.getElementById("next").addEventListener("click", () => { st.page++; load(); });
    document.getElementById("q").addEventListener("keydown", (e) => { if (e.key === "Enter") { st.search = e.target.value; st.page = 1; load(); } });
    await load();
  } else if (path === "/invoice-details") {
    skeleton(true);
    await api(GW, "/fms/v1/companies/" + company + "/invoices/" + new URLSearchParams(location.search).get("id"));
    skeleton(false);
    app.innerHTML = "<h1>Invoice</h1>";
  } else if (path === "/company-users") {
    skeleton(true);
    await api(USERS, "/api/users/v1/company-users");
    skeleton(false);
    app.innerHTML = "<h1>Users</h1>";
  } else if (path === "/retailer-dashboard" || path === "/distributor-dashboard") {
    skeleton(true);
    await api(GW, "/fms/v1/companies/" + company + "/" + path.slice(1));
    skeleton(false);
    app.innerHTML = "<h1>" + path.slice(1) + "</h1>";
  } else {
    location.href = "/";
  }
}
main();
`;

http
  .createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><html><head><title>Mock FMS</title></head><body><div id="app">app</div><script>${FMS_JS}</script></body></html>`);
  })
  .listen(FMS_WEB);

// FMS_UI-style APIs called directly (not through the gateway): the users API, and a config host the env doesn't list.
http
  .createServer((req, res) => {
    const url = new URL(req.url!, usersOrigin);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", ...corsFor() });
      res.end(JSON.stringify(body));
    };
    if (req.method === "OPTIONS") return send(204, {});
    const who = claims(req.headers.authorization);
    if (!who) return send(401, { error: "unauthorized" });
    if (url.pathname === "/api/users/v1/usersauth/companies") {
      return send(200, { result: FMS_COMPANIES.map(({ type: _type, ...c }) => c) });
    }
    if (url.pathname === "/api/users/v1/company-users") {
      if (!who.company) return send(403, { error: "company token required" });
      return setTimeout(() => send(200, { result: [{ id: 1, company: who.company }] }), 30 * SLOW);
    }
    return send(404, { error: "not found" });
  })
  .listen(USERS_API);

http
  .createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json", ...corsFor() });
    res.end("{}");
  })
  .listen(CONFIG_HOST);

console.log(`mock DXP: web ${webOrigin}, FMS web ${fmsOrigin}, auth ${authOrigin}, gateway ${gwOrigin}, users API ${usersOrigin}${SLOW !== 1 ? ` (slow x${SLOW})` : ""}`);
