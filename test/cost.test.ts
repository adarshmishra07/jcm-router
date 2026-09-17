import { describe, expect, test } from "bun:test";
import { CACHE_READ_MULTIPLIER, CACHE_WRITE_MULTIPLIER, PRICES, estimateContextTokens, switchPaysOff } from "../src/cost.ts";
import { MODELS, THRESHOLDS, type ModelAlias } from "../src/routing-policy.ts";

const maxSwitchCost = THRESHOLDS.MAIN_MAX_SWITCH_COST_USD;

describe("prices", () => {
  test("cache prices are derived from input for every model in the catalog", () => {
    for (const alias of Object.keys(MODELS) as ModelAlias[]) {
      const p = PRICES[alias];
      expect(p.cacheRead).toBe(p.input * CACHE_READ_MULTIPLIER);
      expect(p.cacheWrite).toBe(p.input * CACHE_WRITE_MULTIPLIER);
    }
    expect(PRICES.sonnet).toEqual({ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 4 });
  });

  test("estimateContextTokens is chars / 4, rounded up", () => {
    expect(estimateContextTokens(0)).toBe(0);
    expect(estimateContextTokens(1441)).toBe(361);
  });
});

describe("switchPaysOff", () => {
  test("sonnet to haiku on a 360K context is not worth it", () => {
    const r = switchPaysOff({ contextTokens: 360_000, from: "sonnet", to: "haiku", maxSwitchCost });
    expect(r.worth).toBe(false);
    expect(r.stayCost).toBeCloseTo(0.072, 6);
    expect(r.switchCost).toBeCloseTo(0.72, 6);
  });

  test("sonnet to haiku on a 2K context is worth it", () => {
    const r = switchPaysOff({ contextTokens: 2_000, from: "sonnet", to: "haiku", maxSwitchCost });
    expect(r.worth).toBe(true);
    expect(r.stayCost).toBeCloseTo(0.0004, 8);
    expect(r.switchCost).toBeCloseTo(0.004, 8);
  });

  test("the same model still prices an effort-only change as a full re-cache", () => {
    const r = switchPaysOff({ contextTokens: 360_000, from: "sonnet", to: "sonnet", maxSwitchCost });
    expect(r.worth).toBe(false);
    expect(r.switchCost).toBeCloseTo(1.44, 6);
  });
});
