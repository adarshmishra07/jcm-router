import { describe, expect, test } from "bun:test";
import { THRESHOLDS, guardSwitch, skipBeforeAsking, type ScopePolicy } from "../src/routing-policy.ts";

const all: ScopePolicy = { scope: "all", mainUpgrades: false };
const subagentsOnly: ScopePolicy = { scope: "subagents", mainUpgrades: false };
const upgrades: ScopePolicy = { scope: "all", mainUpgrades: true };
const large = THRESHOLDS.MAIN_MAX_CONTEXT_TOKENS + 1;
const small = 500;

describe("skipBeforeAsking", () => {
  test("subagents are always asked, even with a huge context or subagents-only scope", () => {
    expect(skipBeforeAsking({ kind: "subagent", contextTokens: large * 4, overridden: false, policy: subagentsOnly })).toBeNull();
  });

  test("main chat: small routes, large skips, no kind counts as main", () => {
    expect(skipBeforeAsking({ kind: "main", contextTokens: small, overridden: false, policy: all })).toBeNull();
    expect(skipBeforeAsking({ kind: "main", contextTokens: large, overridden: false, policy: all })).toBe("context_too_large");
    expect(skipBeforeAsking({ kind: undefined, contextTokens: large, overridden: false, policy: all })).toBe("context_too_large");
  });

  test("ROUTER_SCOPE=subagents skips all main traffic; ROUTER_MAIN_UPGRADES still asks on a large context", () => {
    expect(skipBeforeAsking({ kind: "main", contextTokens: small, overridden: false, policy: subagentsOnly })).toBe("scope");
    expect(skipBeforeAsking({ kind: "main", contextTokens: large, overridden: false, policy: upgrades })).toBeNull();
  });

  test("overrides bypass every gate", () => {
    expect(skipBeforeAsking({ kind: "main", contextTokens: large, overridden: true, policy: subagentsOnly })).toBeNull();
  });
});

describe("guardSwitch", () => {
  const sonnetLow = { alias: "sonnet" as const, effort: "low" as const };

  test("no change is never a switch, unknown models cannot be priced", () => {
    expect(guardSwitch({ kind: "main", contextTokens: large, from: sonnetLow, to: sonnetLow, policy: all })).toEqual({ skip: null });
    expect(guardSwitch({ kind: "main", contextTokens: large, from: { alias: null, effort: null }, to: { alias: "haiku", effort: null }, policy: all })).toEqual({ skip: null });
  });

  test("subagents are never guarded", () => {
    expect(guardSwitch({ kind: "subagent", contextTokens: large, from: sonnetLow, to: { alias: "haiku", effort: null }, policy: all })).toEqual({ skip: null });
  });

  test("a cheap switch passes with its costs; an expensive one is refused", () => {
    const ok = guardSwitch({ kind: "main", contextTokens: small, from: sonnetLow, to: { alias: "opus", effort: "high" }, policy: all });
    expect(ok.skip).toBeNull();
    expect(ok.cost?.switch).toBeGreaterThan(ok.cost?.stay ?? 0);
    const no = guardSwitch({ kind: "main", contextTokens: 360_000, from: sonnetLow, to: { alias: "opus", effort: "high" }, policy: all });
    expect(no).toMatchObject({ skip: "switch_not_worth_it", cost: { stay: 0.072, switch: 3.6 } });
  });

  test("an effort-only change on a large context is a switch too", () => {
    expect(guardSwitch({ kind: "main", contextTokens: 360_000, from: sonnetLow, to: { alias: "sonnet", effort: "high" }, policy: all }).skip).toBe("switch_not_worth_it");
  });

  test("ROUTER_MAIN_UPGRADES allows an upgrade but never a downgrade on a large context", () => {
    expect(guardSwitch({ kind: "main", contextTokens: 360_000, from: sonnetLow, to: { alias: "opus", effort: "high" }, policy: upgrades }).skip).toBeNull();
    expect(guardSwitch({ kind: "main", contextTokens: 360_000, from: sonnetLow, to: { alias: "haiku", effort: null }, policy: upgrades }).skip).toBe("switch_not_worth_it");
    // Just past the gate a haiku switch is still under the dollar budget; the gate is a hard ceiling for downgrades anyway.
    expect(guardSwitch({ kind: "main", contextTokens: large, from: sonnetLow, to: { alias: "haiku", effort: null }, policy: upgrades }).skip).toBe("switch_not_worth_it");
  });
});
