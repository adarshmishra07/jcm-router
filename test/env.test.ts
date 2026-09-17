import { describe, expect, test } from "bun:test";
import { describeEnv, hasJevKey, parseEnv } from "../src/env.ts";

const valid = { TYPESAFE_API_KEY: "apikey_test" };

const errorsOf = (env: Record<string, string | undefined>): string[] => {
  const r = parseEnv(env);
  return r.ok ? [] : r.errors;
};

describe("parseEnv", () => {
  test("valid minimal env gets defaults and a frozen config", () => {
    const r = parseEnv(valid);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config).toMatchObject({
      typesafeApiKey: "apikey_test",
      port: 8787,
      anthropicUpstream: "https://api.anthropic.com",
      typesafeApiUrl: "https://api.typesafe.ai",
      dryRun: false,
      logPrompts: true,
      scope: "all",
      mainUpgrades: false,
      upgrades: "off",
    });
    expect(r.config.stateDir.endsWith("/.claude-router")).toBe(true);
    expect(Object.isFrozen(r.config)).toBe(true);
  });

  test("reads every override and strips trailing slashes", () => {
    const r = parseEnv({
      ...valid,
      PORT: "9000",
      ANTHROPIC_UPSTREAM: "http://localhost:1234/",
      TYPESAFE_API_URL: "http://localhost:5678//",
      ROUTER_DRY_RUN: "true",
      ROUTER_LOG_PROMPTS: "0",
      ROUTER_STATE_DIR: "/tmp/x",
      ROUTER_SCOPE: "subagents",
      ROUTER_MAIN_UPGRADES: "1",
      ROUTER_UPGRADES: "confident",
    });
    expect(r.ok && r.config).toEqual({
      typesafeApiKey: "apikey_test",
      typesafeApiUrl: "http://localhost:5678",
      port: 9000,
      anthropicUpstream: "http://localhost:1234",
      dryRun: true,
      logPrompts: false,
      stateDir: "/tmp/x",
      scope: "subagents",
      mainUpgrades: true,
      upgrades: "confident",
    });
  });

  test("missing or malformed key", () => {
    expect(errorsOf({})).toEqual(["TYPESAFE_API_KEY is required"]);
    expect(errorsOf({ TYPESAFE_API_KEY: "  " })).toEqual(["TYPESAFE_API_KEY is required"]);
    expect(errorsOf({ TYPESAFE_API_KEY: "sk-nope" })).toEqual(['TYPESAFE_API_KEY must start with "apikey_"']);
  });

  test("bad port", () => {
    for (const PORT of ["0", "70000", "abc", "80.5"]) expect(errorsOf({ ...valid, PORT })).toEqual(["PORT must be an integer between 1 and 65535"]);
  });

  test("bad URLs", () => {
    expect(errorsOf({ ...valid, ANTHROPIC_UPSTREAM: "api.anthropic.com" })).toEqual(["ANTHROPIC_UPSTREAM must be an http(s) URL"]);
    expect(errorsOf({ ...valid, TYPESAFE_API_URL: "ftp://x" })).toEqual(["TYPESAFE_API_URL must be an http(s) URL"]);
  });

  test("bad boolean", () => {
    expect(errorsOf({ ...valid, ROUTER_DRY_RUN: "yes" })).toEqual(["ROUTER_DRY_RUN must be one of 1, 0, true, false"]);
    expect(errorsOf({ ...valid, ROUTER_LOG_PROMPTS: "off" })).toEqual(["ROUTER_LOG_PROMPTS must be one of 1, 0, true, false"]);
    expect(parseEnv({ ...valid, ROUTER_DRY_RUN: "0" })).toMatchObject({ ok: true, config: { dryRun: false } });
  });

  test("bad scope", () => {
    expect(errorsOf({ ...valid, ROUTER_SCOPE: "main" })).toEqual(["ROUTER_SCOPE must be one of subagents, all"]);
    expect(errorsOf({ ...valid, ROUTER_MAIN_UPGRADES: "yes" })).toEqual(["ROUTER_MAIN_UPGRADES must be one of 1, 0, true, false"]);
    expect(errorsOf({ ...valid, ROUTER_UPGRADES: "maybe" })).toEqual(["ROUTER_UPGRADES must be one of off, confident, on"]);
  });

  test("reports all errors together", () => {
    const errors = errorsOf({ PORT: "-1", ANTHROPIC_UPSTREAM: "nope", ROUTER_DRY_RUN: "maybe" });
    expect(errors).toHaveLength(4);
    expect(errors[0]).toContain("TYPESAFE_API_KEY");
  });
});

describe("describeEnv", () => {
  const env = { ...valid, PORT: "9000", ROUTER_SCOPE: "subagents", ROUTER_UPGRADES: "confident", ROUTER_MAIN_UPGRADES: "1", ROUTER_DRY_RUN: "1", ROUTER_LOG_PROMPTS: "0" };

  // The profile on /healthz has to be the settings the router is actually running under, so it is read off the
  // parsed config rather than from the environment a second time.
  test("a valid environment is described by its own config, field for field", () => {
    const parsed = parseEnv(env);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const c = parsed.config;
    expect(describeEnv(env)).toEqual({
      port: c.port,
      upstream: c.anthropicUpstream,
      scope: c.scope,
      upgrades: c.upgrades,
      main_upgrades: c.mainUpgrades,
      dry_run: c.dryRun,
      log_prompts: c.logPrompts,
    });
  });

  test("an invalid environment still describes something, because that is when it is needed", () => {
    // No key and a nonsense port: the router cannot start at all, and the supervisor still has to answer.
    expect(describeEnv({ PORT: "abc", ROUTER_SCOPE: "nonsense" })).toMatchObject({ port: 8787, upstream: "https://api.anthropic.com", scope: "nonsense" });
    expect(describeEnv({ PORT: "9100" })).toMatchObject({ port: 9100 });
  });

  test("hasJevKey is a boolean and nothing else", () => {
    expect(hasJevKey({ TYPESAFE_API_KEY: "apikey_secret" })).toBe(true);
    expect(hasJevKey({ TYPESAFE_API_KEY: "   " })).toBe(false);
    expect(hasJevKey({})).toBe(false);
  });
});
