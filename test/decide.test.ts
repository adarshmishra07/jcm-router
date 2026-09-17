import { describe, expect, test } from "bun:test";
import { recacheOnSameModel } from "../src/cost.ts";
import { decide, isNoop, parseOverrides, requestedOf, type Decision } from "../src/decide.ts";
import type { JevAnswers } from "../src/jev.ts";
import { THRESHOLDS } from "../src/routing-policy.ts";

const requested = { model: "claude-sonnet-5", effort: "low" as const };

const answers = (model: string, mc: number, effort: string, ec: number, followup = 0): JevAnswers => ({
  model: { type: "choice", choice: model, confidence: mc, probabilities: {} },
  effort: { type: "choice", choice: effort, confidence: ec, probabilities: {} },
  is_followup: { type: "noul", noul: followup },
});

const previous: Decision = {
  conv: "prevprev",
  alias: "opus",
  model: "claude-opus-5",
  effort: "high",
  source: "jev",
  confidences: {},
  jevMs: 1,
  at: "",
};

const policy = { scope: "all" as const, mainUpgrades: false };
const base = { key: "abcdef0123456789", requested, overrides: {}, previous: null, jevMs: 5, contextTokens: 250, skip: null, policy };

describe("parseOverrides", () => {
  test("reads leading model and effort tokens in any order", () => {
    expect(parseOverrides("!opus !high fix this")).toEqual({ alias: "opus", effort: "high" });
    expect(parseOverrides("  !max !haiku x")).toEqual({ alias: "haiku", effort: "max" });
  });
  test("stops at the first non-override token", () => {
    expect(parseOverrides("!opus fix !high")).toEqual({ alias: "opus" });
    expect(parseOverrides("fix !opus")).toEqual({});
    expect(parseOverrides("!nope !opus")).toEqual({});
  });
});

describe("requestedOf", () => {
  test("reads model and a valid effort, ignores junk", () => {
    expect(requestedOf({ model: "m", output_config: { effort: "high" } })).toEqual({ model: "m", effort: "high" });
    expect(requestedOf({ model: "m", output_config: { effort: "huge" } })).toEqual({ model: "m", effort: null });
    expect(requestedOf({})).toEqual({ model: "", effort: null });
  });
});

describe("decide", () => {
  test("uses confident Jev answers", () => {
    const d = decide({ ...base, answers: answers("opus", 0.9, "high", 0.8) });
    expect(d).toMatchObject({ conv: "abcdef01", alias: "opus", model: "claude-opus-5", effort: "high", source: "jev", jevMs: 5 });
    expect(d.confidences).toEqual({ model: 0.9, effort: 0.8, is_followup: 0 });
    expect("kind" in d).toBe(false);
    expect(decide({ ...base, kind: "subagent", answers: null }).kind).toBe("subagent");
  });

  test("gates model and effort on confidence separately", () => {
    const min = THRESHOLDS.MODEL_MIN_CONFIDENCE;
    const d = decide({ ...base, answers: answers("opus", min - 0.01, "high", 0.9) });
    expect(d).toMatchObject({ alias: "sonnet", effort: "high" });
    const e = decide({ ...base, answers: answers("opus", 0.9, "high", THRESHOLDS.EFFORT_MIN_CONFIDENCE - 0.01) });
    expect(e).toMatchObject({ alias: "opus", effort: "low" });
  });

  test("falls back to the request when Jev failed", () => {
    const d = decide({ ...base, answers: null, jevMs: null });
    expect(d).toMatchObject({ alias: "sonnet", model: "claude-sonnet-5", effort: "low", source: "fallback" });
    expect(isNoop(d, requested)).toBe(true);
  });

  test("unknown requested model stays as is with alias null", () => {
    const d = decide({ ...base, requested: { model: "claude-custom", effort: null }, answers: answers("opus", 0.1, "max", 0.1) });
    expect(d).toMatchObject({ alias: null, model: "claude-custom", effort: null });
  });

  test("reuses the previous decision on a confident follow-up, even if Jev now says haiku", () => {
    const d = decide({ ...base, previous, answers: answers("haiku", 0.95, "low", 0.95, THRESHOLDS.FOLLOWUP_MIN_NOUL) });
    expect(d).toMatchObject({ alias: "opus", effort: "high", source: "followup" });
  });

  test("a bare short follow-up like \"hmm\" reuses the previous decision", () => {
    expect(THRESHOLDS.FOLLOWUP_MIN_NOUL).toBeLessThanOrEqual(0.7); // "hmm" scored 0.70 on the eval run
    const d = decide({ ...base, previous, answers: answers("haiku", 0.9, "low", 0.9, 0.7) });
    expect(d).toMatchObject({ alias: "opus", effort: "high", source: "followup" });
  });

  test("ignores follow-up signal without a previous decision", () => {
    const d = decide({ ...base, answers: answers("haiku", 0.95, "low", 0.95, 0.99) });
    expect(d).toMatchObject({ alias: "haiku", source: "jev" });
  });

  test("overrides beat Jev and follow-up", () => {
    const d = decide({ ...base, previous, overrides: { alias: "fable" }, answers: answers("haiku", 0.95, "low", 0.95, 0.99) });
    expect(d).toMatchObject({ alias: "fable", model: "claude-fable-5-1", effort: "high", source: "override" });
    const e = decide({ ...base, overrides: { alias: "opus", effort: "max" }, answers: null, jevMs: null });
    expect(e).toMatchObject({ alias: "opus", effort: "max", source: "override" });
  });

  test("haiku never carries an effort", () => {
    const d = decide({ ...base, answers: answers("haiku", 0.9, "high", 0.9) });
    expect(d).toMatchObject({ alias: "haiku", model: "claude-haiku-4-5", effort: null });
    expect(isNoop(d, requested)).toBe(false);
  });

  test("bumps haiku to sonnet when the request is large", () => {
    const contextTokens = THRESHOLDS.HAIKU_MAX_TOKENS + 1;
    const d = decide({ ...base, kind: "subagent", contextTokens, answers: answers("haiku", 0.9, "low", 0.9) });
    expect(d).toMatchObject({ alias: "sonnet", effort: "low" });
    const e = decide({ ...base, contextTokens, overrides: { alias: "haiku" }, answers: null });
    expect(e.alias).toBe("sonnet");
  });

  test("a pre-Jev skip keeps the cached model and effort, not the requested ones", () => {
    const d = decide({ ...base, previous, contextTokens: 400_000, skip: "context_too_large", answers: null, jevMs: null });
    expect(d).toMatchObject({ alias: "opus", model: "claude-opus-5", effort: "high", source: "skipped", skipReason: "context_too_large" });
    // Jev was never asked, so there is no target model: the skip is priced as a re-cache on the model it sits on.
    expect(d.cost).toEqual({ ...recacheOnSameModel(400_000, "opus"), counterfactual: true });
    expect(d.cost!.switch).toBeGreaterThan(d.cost!.stay);
    const fresh = decide({ ...base, skip: "scope", answers: null, jevMs: null });
    expect(fresh).toMatchObject({ alias: "sonnet", model: "claude-sonnet-5", effort: "low", source: "skipped", skipReason: "scope" });
    expect(isNoop(fresh, requested)).toBe(true);
  });

  test("the guard refuses a switch that is not worth it and records both costs", () => {
    const d = decide({ ...base, kind: "main", contextTokens: 360_000, answers: answers("opus", 0.95, "high", 0.95) });
    expect(d).toMatchObject({ alias: "sonnet", effort: "low", source: "skipped", skipReason: "switch_not_worth_it" });
    expect(d.cost?.stay).toBeCloseTo(0.072, 6);
    expect(d.cost?.switch).toBeCloseTo(3.6, 6);
    // Jev did pick a target here, so this is a real switch price, not the same-model counterfactual.
    expect(d.cost?.counterfactual).toBeUndefined();
    expect(d.confidences.model).toBe(0.95);
  });

  test("small contexts route, subagents always route, overrides always win", () => {
    expect(decide({ ...base, kind: "main", answers: answers("haiku", 0.9, "low", 0.9) })).toMatchObject({ alias: "haiku", source: "jev" });
    expect(decide({ ...base, kind: "subagent", contextTokens: 360_000, answers: answers("haiku", 0.9, "low", 0.9) })).toMatchObject({ alias: "sonnet", source: "jev" });
    expect(decide({ ...base, kind: "main", contextTokens: 360_000, overrides: { alias: "opus" }, answers: answers("haiku", 0.9, "low", 0.9) })).toMatchObject({ alias: "opus", source: "override" });
  });
});
