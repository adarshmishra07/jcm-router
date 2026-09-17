import { describe, expect, test } from "bun:test";
import { parseEnv } from "../src/env.ts";

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
  });

  test("reports all errors together", () => {
    const errors = errorsOf({ PORT: "-1", ANTHROPIC_UPSTREAM: "nope", ROUTER_DRY_RUN: "maybe" });
    expect(errors).toHaveLength(4);
    expect(errors[0]).toContain("TYPESAFE_API_KEY");
  });
});
