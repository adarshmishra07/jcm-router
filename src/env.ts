// The only place that reads environment variables. Everything else gets a Config.

import { homedir } from "node:os";
import { join } from "node:path";

export type Config = Readonly<{
  typesafeApiKey: string;
  typesafeApiUrl: string;
  port: number;
  anthropicUpstream: string;
  dryRun: boolean;
  logPrompts: boolean;
  stateDir: string;
}>;

export const DEFAULTS = {
  port: 8787,
  anthropicUpstream: "https://api.anthropic.com",
  typesafeApiUrl: "https://api.typesafe.ai",
  stateDir: () => join(homedir(), ".claude-router"),
} as const;

const API_KEY_PREFIX = "apikey_";
const BOOLEANS: Record<string, boolean> = { "1": true, true: true, "0": false, false: false };

type Env = Record<string, string | undefined>;
type Parsed = { ok: true; config: Config } | { ok: false; errors: string[] };

function url(name: string, raw: string, errors: string[]): string {
  const value = raw.replace(/\/+$/, "");
  try {
    const u = new URL(value);
    if (u.protocol === "http:" || u.protocol === "https:") return value;
  } catch {}
  errors.push(`${name} must be an http(s) URL`);
  return value;
}

function bool(name: string, raw: string | undefined, fallback: boolean, errors: string[]): boolean {
  if (raw === undefined) return fallback;
  const value = BOOLEANS[raw];
  if (value === undefined) errors.push(`${name} must be one of 1, 0, true, false`);
  return value ?? fallback;
}

export function parseEnv(env: Env): Parsed {
  const errors: string[] = [];

  const typesafeApiKey = env.TYPESAFE_API_KEY?.trim() ?? "";
  if (!typesafeApiKey) errors.push("TYPESAFE_API_KEY is required");
  else if (!typesafeApiKey.startsWith(API_KEY_PREFIX)) errors.push(`TYPESAFE_API_KEY must start with "${API_KEY_PREFIX}"`);

  const port = env.PORT === undefined ? DEFAULTS.port : Number(env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push("PORT must be an integer between 1 and 65535");

  const anthropicUpstream = url("ANTHROPIC_UPSTREAM", env.ANTHROPIC_UPSTREAM ?? DEFAULTS.anthropicUpstream, errors);
  const typesafeApiUrl = url("TYPESAFE_API_URL", env.TYPESAFE_API_URL ?? DEFAULTS.typesafeApiUrl, errors);

  const dryRun = bool("ROUTER_DRY_RUN", env.ROUTER_DRY_RUN, false, errors);
  const logPrompts = bool("ROUTER_LOG_PROMPTS", env.ROUTER_LOG_PROMPTS, true, errors);

  const stateDir = env.ROUTER_STATE_DIR || DEFAULTS.stateDir();

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    config: Object.freeze({ typesafeApiKey, typesafeApiUrl, port, anthropicUpstream, dryRun, logPrompts, stateDir }),
  };
}

export function loadEnv(): Config {
  const parsed = parseEnv(process.env);
  if (parsed.ok) return parsed.config;
  console.error("claude-router: invalid environment. See .env.example.");
  for (const e of parsed.errors) console.error(`  - ${e}`);
  process.exit(1);
}

// For the statusline, which runs outside the proxy and only needs to know where last.json lives.
export const loadStateDir = (): string => process.env.ROUTER_STATE_DIR || DEFAULTS.stateDir();
