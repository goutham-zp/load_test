import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const dirs = {
  config: path.join(ROOT, "config"),
  envs: path.join(ROOT, "envs"),
  catalogs: path.join(ROOT, "catalogs"),
  runs: path.join(ROOT, "runs"),
  auth: path.join(ROOT, ".auth"),
  k6Script: path.join(ROOT, "src", "load", "k6", "script.js"),
};

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

export function authDir(envName: string): string {
  return path.join(dirs.auth, envName);
}

export function catalogDir(envName: string): string {
  return path.join(dirs.catalogs, envName);
}
