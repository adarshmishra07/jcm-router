import { describe, expect, test } from "bun:test";
import { CACHE_READ as DASHBOARD_CACHE_READ, CACHE_WRITE as DASHBOARD_CACHE_WRITE, PRICES as DASHBOARD_PRICES } from "../scripts/cost.ts";
import { CACHE_READ_MULTIPLIER, CACHE_WRITE_MULTIPLIER, CHARS_PER_TOKEN, PRICES, estimateContextTokens, recacheOnSameModel, switchPaysOff } from "../src/cost.ts";
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

  test("estimateContextTokens uses the calibrated divisor, rounded up", () => {
    expect(estimateContextTokens(0)).toBe(0);
    expect(estimateContextTokens(1441)).toBe(Math.ceil(1441 / CHARS_PER_TOKEN));
    // Real usage ran 1.07x to 1.52x of chars/4: the estimate must not go back to the old divisor.
    expect(estimateContextTokens(4000)).toBeGreaterThan(1000);
  });

  test("the dashboard price table matches the router's, so the two cannot drift", () => {
    const dashboard: Record<string, { in: number; out: number }> = DASHBOARD_PRICES;
    expect(Object.keys(dashboard).sort()).toEqual(Object.keys(PRICES).sort());
    for (const alias of Object.keys(PRICES) as ModelAlias[]) {
      expect(dashboard[alias]).toEqual({ in: PRICES[alias].input, out: PRICES[alias].output });
    }
    expect(DASHBOARD_CACHE_READ).toBe(CACHE_READ_MULTIPLIER);
    expect(DASHBOARD_CACHE_WRITE).toBe(CACHE_WRITE_MULTIPLIER);
  });
});

describe("recacheOnSameModel", () => {
  test("prices a skip with no target model: read versus write on the model it sits on", () => {
    const c = recacheOnSameModel(100_000, "opus");
    expect(c.stay).toBeCloseTo(0.05, 10); // 100K at 0.1x of $5/Mtok
    expect(c.switch).toBeCloseTo(1, 10); // 100K at 2x of $5/Mtok
    expect(c.switch).toBeGreaterThan(c.stay);
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
