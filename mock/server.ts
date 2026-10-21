// A tiny fake DXP (Auth0 + web app + API gateway) for verifying the tool end to end without a real environment.
// Run: npm run mock   then use --env mock.  Users: any email, password "pw".
import http from "node:http";

const WEB = 4100;
const AUTH = 4101;
const GW = 4102;
const webOrigin = `http://localhost:${WEB}`;
const authOrigin = `http://localhost:${AUTH}`;
const gwOrigin = `http://localhost:${GW}`;
// Slowdown multiplier, e.g. MOCK_SLOW=2 to simulate a slower deployment for compare.
const SLOW = Number(process.env.MOCK_SLOW ?? "1");
// Landing after login: "auto" (straight to the first company), "select" (stay on a Select Company page, like a
// multi-company user), "select-nodata" (Select Company without the app ever calling /users/data).
const LANDING = process.env.MOCK_LANDING ?? "auto";

function b64url(s: string): string {
  return Buffer.from(s).toString("base64url");
}

function makeToken(email: string): string {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return `${b64url(JSON.stringify({ alg: "none" }))}.${b64url(JSON.stringify({ sub: email, exp }))}.sig`;
}

function tokenOk(auth: string | undefined): string | undefined {
  const t = auth?.replace(/^Bearer /, "");
  if (!t) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(t.split(".")[1]!, "base64url").toString());
    return payload.exp * 1000 > Date.now() ? t : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------- Auth0

http
  .createServer((req, res) => {
    const url = new URL(req.url!, authOrigin);
    if (url.pathname === "/authorize") {
      const redirect = url.searchParams.get("redirect_uri") ?? webOrigin;
      const err = url.searchParams.get("error");
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><html><body><form method="post" action="/login">
<input type="hidden" name="redirect_uri" value="${redirect}">
<input id="username" name="username"><input id="password" name="password" type="password">
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
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, retailerftsid, content-type",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    };
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
      if (!token) return send(401, { error: "unauthorized" });
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

console.log(`mock DXP: web ${webOrigin}, auth ${authOrigin}, gateway ${gwOrigin}${SLOW !== 1 ? ` (slow x${SLOW})` : ""}`);
