import fs from "node:fs";
import path from "node:path";

export interface GatewayRoute {
  /** "<prefix>/<service dir>", e.g. "fms/invoice-apis". */
  service: string;
  method: string;
  /** Path as seen on the gateway, e.g. /fms/v3/invoices/{invoiceId}. */
  gatewayPath: string;
  /** Path the backend receives, e.g. /api/v3/invoices/{invoiceId}. */
  servicePath: string;
  host: string;
  regex: RegExp;
  literalChars: number;
}

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

/** Strips zero-width characters and query strings the gateway config sometimes carries. */
export function cleanGatewayPath(p: string): string {
  let s = p.replace(/[​-‍﻿]/g, "").trim();
  s = s.split("?")[0]!;
  if (!s.startsWith("/")) s = "/" + s;
  return s.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
}

export function templateToRegex(template: string): { regex: RegExp; literalChars: number } {
  let literalChars = 0;
  const pattern = template
    .split("/")
    .map((seg) => {
      if (/^\{[^}]+\}$/.test(seg)) return "[^/]+";
      literalChars += seg.length;
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{[^}]+\\\}/g, "[^/]+");
    })
    .join("/");
  return { regex: new RegExp(`^${pattern}/?$`, "i"), literalChars };
}

export function loadGatewayRoutes(configDir: string): GatewayRoute[] {
  const routes: GatewayRoute[] = [];
  if (!fs.existsSync(configDir)) return routes;
  for (const prefix of fs.readdirSync(configDir)) {
    const servicesDir = path.join(configDir, prefix, "services");
    if (!fs.existsSync(servicesDir)) continue;
    for (const svcDir of fs.readdirSync(servicesDir)) {
      const svcPath = path.join(servicesDir, svcDir);
      if (!fs.statSync(svcPath).isDirectory()) continue;
      for (const version of fs.readdirSync(svcPath)) {
        const file = path.join(svcPath, version, "service.json");
        if (!fs.existsSync(file)) continue;
        let doc: { info?: { host?: string }; paths?: Record<string, Record<string, { description?: string }>> };
        try {
          doc = JSON.parse(fs.readFileSync(file, "utf8"));
        } catch {
          continue;
        }
        const host = doc.info?.host ?? "";
        for (const [servicePath, ops] of Object.entries(doc.paths ?? {})) {
          for (const [method, op] of Object.entries(ops ?? {})) {
            if (!HTTP_METHODS.has(method.toLowerCase()) || !op?.description) continue;
            const gatewayPath = cleanGatewayPath(`/${prefix}${cleanGatewayPath(op.description)}`);
            const { regex, literalChars } = templateToRegex(gatewayPath);
            routes.push({
              service: `${prefix}/${svcDir}`,
              method: method.toUpperCase(),
              gatewayPath,
              servicePath: cleanGatewayPath(servicePath),
              host,
              regex,
              literalChars,
            });
          }
        }
      }
    }
  }
  return routes;
}

export interface RouteMatcher {
  match(method: string, pathname: string): GatewayRoute | undefined;
  size: number;
}

export function createRouteMatcher(routes: GatewayRoute[]): RouteMatcher {
  const byMethod = new Map<string, GatewayRoute[]>();
  for (const r of routes) {
    const list = byMethod.get(r.method) ?? [];
    list.push(r);
    byMethod.set(r.method, list);
  }
  return {
    size: routes.length,
    match(method, pathname) {
      const clean = cleanGatewayPath(decodeURIComponentSafe(pathname));
      let best: GatewayRoute | undefined;
      for (const r of byMethod.get(method.toUpperCase()) ?? []) {
        if (!r.regex.test(clean)) continue;
        if (!best || r.literalChars > best.literalChars) best = r;
      }
      return best;
    },
  };
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
