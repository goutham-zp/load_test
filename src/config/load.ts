import fs from "node:fs";
import path from "node:path";
import { dirs, ROOT } from "../paths.ts";
import type {
  AllowlistEntry,
  AppProfile,
  EnvConfig,
  InteractionsFile,
  PageConfig,
  ServiceConfig,
  ServicesFile,
  Settings,
  User,
} from "./types.ts";

export function readJson<T>(file: string): T {
  const text = fs.readFileSync(file, "utf8");
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Error(`Invalid JSON in ${file}: ${(err as Error).message}`);
  }
}

export function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

/** config/settings.json, with LT_GATEWAY_CONFIG_DIR / LT_BACKENDS_DIR overrides (useful in containers). */
export function loadSettings(): Settings {
  const settings = readJson<Settings>(path.join(dirs.config, "settings.json"));
  if (process.env.LT_GATEWAY_CONFIG_DIR) settings.gatewayConfigDir = process.env.LT_GATEWAY_CONFIG_DIR;
  if (process.env.LT_BACKENDS_DIR) settings.backendsDir = process.env.LT_BACKENDS_DIR;
  return settings;
}

export function loadEnv(name: string): EnvConfig {
  const file = path.join(dirs.envs, `${name}.json`);
  if (!fs.existsSync(file)) {
    const known = fs
      .readdirSync(dirs.envs)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));
    throw new Error(`Unknown env "${name}". Defined envs: ${known.join(", ") || "(none)"}`);
  }
  const env = readJson<EnvConfig>(file);
  if (env.name !== name) throw new Error(`envs/${name}.json has name "${env.name}"; they must match.`);
  for (const field of ["webBaseUrl", "auth0Domain"] as const) {
    if (!env[field] || env[field].includes("FILL_ME")) throw new Error(`envs/${name}.json: "${field}" is not set.`);
  }
  if (!env.gatewayBaseUrls?.length) throw new Error(`envs/${name}.json: "gatewayBaseUrls" is empty.`);
  env.lang ??= "en";
  env.webBaseUrl = env.webBaseUrl.replace(/\/+$/, "");
  return env;
}

/** The env's app profile, config/apps/<env.app>/app.json (default "retailer"). */
export function loadApp(env: Pick<EnvConfig, "app" | "name">): AppProfile {
  const name = env.app ?? "retailer";
  const file = path.join(dirs.apps, name, "app.json");
  if (!fs.existsSync(file)) {
    const known = fs.existsSync(dirs.apps) ? fs.readdirSync(dirs.apps).filter((d) => fs.existsSync(path.join(dirs.apps, d, "app.json"))) : [];
    throw new Error(`envs/${env.name}.json: unknown app "${name}". Apps in config/apps/: ${known.join(", ") || "(none)"}`);
  }
  const app = readJson<AppProfile>(file);
  if (app.name !== name) throw new Error(`config/apps/${name}/app.json has name "${app.name}"; they must match.`);
  return app;
}

export function loadPages(app: AppProfile): PageConfig[] {
  return readJson<{ pages: PageConfig[] }>(path.join(dirs.apps, app.name, "pages.json")).pages.filter((p) => p.enabled !== false);
}

export function loadInteractions(app: AppProfile): InteractionsFile {
  return readJson<InteractionsFile>(path.join(dirs.apps, app.name, "interactions.json"));
}

export function loadAllowlist(): AllowlistEntry[] {
  return readJson<{ entries: AllowlistEntry[] }>(path.join(dirs.config, "read-allowlist.json")).entries;
}

export interface ResolvedServices {
  get(name: string): ServiceConfig & { known: boolean };
}

export function loadServices(env?: EnvConfig): ResolvedServices {
  const file = readJson<ServicesFile>(path.join(dirs.config, "services.json"));
  return {
    get(name: string) {
      const base = file.services[name];
      const override = env?.services?.[name];
      const merged: ServiceConfig = { ...file.defaultUnknown, ...(base ?? {}), ...(override ?? {}) };
      if (base && base.limitsVerified === undefined) merged.limitsVerified = base.limits !== undefined;
      return { ...merged, known: base !== undefined };
    },
  };
}

/**
 * Reads <prefix><n>_EMAIL / <prefix><n>_PASSWORD from the environment (and .env if present). The prefix is the env's
 * userPrefix (default LT_USER_), so each app can have its own users; keys are user1, user2, ... either way.
 */
export function loadUsers(env?: Pick<EnvConfig, "userPrefix">): User[] {
  const prefix = env?.userPrefix ?? "LT_USER_";
  const envFile = path.join(ROOT, ".env");
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  const users: User[] = [];
  for (let i = 1; i <= 20; i++) {
    const email = process.env[`${prefix}${i}_EMAIL`];
    const password = process.env[`${prefix}${i}_PASSWORD`];
    if (!email) continue;
    if (!password) throw new Error(`${prefix}${i}_EMAIL is set but ${prefix}${i}_PASSWORD is missing.`);
    users.push({ key: `user${i}`, email, password });
  }
  if (users.length === 0) throw new Error(`No users configured. Fill ${prefix}<n>_EMAIL / ${prefix}<n>_PASSWORD in .env (see .env.example).`);
  return users;
}
