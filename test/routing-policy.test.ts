import { describe, expect, test } from "bun:test";
import { THRESHOLDS, blocksUpgrade, guardSwitch, isUpgrade, skipBeforeAsking, type ScopePolicy, type Target } from "../src/routing-policy.ts";

const all: ScopePolicy = { scope: "all", mainUpgrades: false, upgrades: "on" };
const subagentsOnly: ScopePolicy = { scope: "subagents", mainUpgrades: false, upgrades: "on" };
const upgrades: ScopePolicy = { scope: "all", mainUpgrades: true, upgrades: "on" };
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

describe("ROUTER_UPGRADES", () => {
  const sonnetLow: Target = { alias: "sonnet", effort: "low" };
  const off: ScopePolicy = { scope: "all", mainUpgrades: false, upgrades: "off" };
  const confident: ScopePolicy = { scope: "all", mainUpgrades: false, upgrades: "confident" };
  const min = THRESHOLDS.UPGRADE_MIN_CONFIDENCE;

  test("an upgrade is a pricier model, or more effort on the same model; null effort is not compared", () => {
    expect(isUpgrade(sonnetLow, { alias: "opus", effort: "low" })).toBe(true);
    expect(isUpgrade(sonnetLow, { alias: "haiku", effort: null })).toBe(false);
    expect(isUpgrade(sonnetLow, { alias: "sonnet", effort: "high" })).toBe(true);
    expect(isUpgrade({ alias: "sonnet", effort: "high" }, { alias: "sonnet", effort: "low" })).toBe(false);
    expect(isUpgrade({ alias: "sonnet", effort: null }, { alias: "sonnet", effort: "max" })).toBe(false);
    expect(isUpgrade({ alias: null, effort: "low" }, { alias: "fable", effort: "max" })).toBe(false);
  });

  test("off blocks every upgrade, allows downgrades and same-price picks", () => {
    expect(blocksUpgrade({ requested: sonnetLow, to: { alias: "opus", effort: "low" }, confidence: 0.99, policy: off })).toBe(true);
    expect(blocksUpgrade({ requested: sonnetLow, to: { alias: "sonnet", effort: "high" }, confidence: 0.99, policy: off })).toBe(true);
    expect(blocksUpgrade({ requested: sonnetLow, to: { alias: "haiku", effort: null }, confidence: 0.5, policy: off })).toBe(false);
    expect(blocksUpgrade({ requested: sonnetLow, to: sonnetLow, confidence: 0.5, policy: off })).toBe(false);
  });

  test("confident allows a top-tier upgrade at the confidence threshold, nothing below it, never a lower tier", () => {
    expect(blocksUpgrade({ requested: sonnetLow, to: { alias: "opus", effort: "high" }, confidence: 0.85, policy: confident })).toBe(false);
    expect(blocksUpgrade({ requested: sonnetLow, to: { alias: "fable", effort: "high" }, confidence: min, policy: confident })).toBe(false);
    expect(blocksUpgrade({ requested: sonnetLow, to: { alias: "opus", effort: "high" }, confidence: 0.7, policy: confident })).toBe(true);
    expect(blocksUpgrade({ requested: sonnetLow, to: { alias: "opus", effort: "high" }, confidence: undefined, policy: confident })).toBe(true);
    expect(blocksUpgrade({ requested: { alias: "haiku", effort: null }, to: { alias: "sonnet", effort: "low" }, confidence: 0.99, policy: confident })).toBe(true);
    expect(blocksUpgrade({ requested: sonnetLow, to: { alias: "sonnet", effort: "max" }, confidence: 0.99, policy: confident })).toBe(true);
  });

  test("on honours any pick", () => {
    expect(blocksUpgrade({ requested: { alias: "haiku", effort: null }, to: { alias: "fable", effort: "max" }, confidence: 0.5, policy: all })).toBe(false);
  });

  test("off beats ROUTER_MAIN_UPGRADES=1: a large main context is skipped before Jev is asked", () => {
    const both: ScopePolicy = { scope: "all", mainUpgrades: true, upgrades: "off" };
    expect(skipBeforeAsking({ kind: "main", contextTokens: large, overridden: false, policy: both })).toBe("context_too_large");
    expect(skipBeforeAsking({ kind: "main", contextTokens: large, overridden: false, policy: { ...both, upgrades: "confident" } })).toBeNull();
  });
});
