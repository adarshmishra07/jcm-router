import { describe, expect, test } from "bun:test";
import { buildState, overrideAlias, render, score, summarize, tierOf, type Answers, type Case } from "../scripts/eval.ts";

const answers = (model: string, confidence: number, followup = 0.05): Answers => ({
  model: { choice: model, confidence },
  effort: { choice: "medium", confidence: 0.7 },
  is_followup: { noul: followup },
});

const hard: Case = { prompt: "Find the race condition causing duplicate orders", expect: { tier: "hard" } };
const trivial: Case = { prompt: "Fix the typo in README", expect: { tier: "trivial" } };
const followup: Case = {
  prompt: "yes do it",
  expect: { tier: "hard", followup: true },
  context: { previousReply: "Here is the plan.", previousRouting: { model: "opus", effort: "xhigh" } },
};

describe("tier mapping", () => {
  test("haiku is trivial, sonnet normal, opus and fable hard", () => {
    expect(tierOf("haiku")).toBe("trivial");
    expect(tierOf("sonnet")).toBe("normal");
    expect(tierOf("opus")).toBe("hard");
    expect(tierOf("fable")).toBe("hard");
    expect(tierOf("nonsense")).toBe("");
    expect(tierOf(undefined)).toBe("");
  });
});

describe("overrides", () => {
  test("leading bang tokens are read before Jev is called", () => {
    expect(overrideAlias("!haiku write me a compiler")).toBe("haiku");
    expect(overrideAlias("  !high !opus fix this")).toBe("opus");
    expect(overrideAlias("!high do the thing")).toBeNull();
    expect(overrideAlias("write me a compiler")).toBeNull();
  });

  test("an override case is scored without an answer and marked as such", () => {
    const r = score({ prompt: "!haiku write me a compiler", expect: { tier: "trivial", override: "haiku" } }, null);
    expect(r.how).toBe("override");
    expect(r.pass).toBe(true);
    expect(r.note).toContain("before Jev");
  });
});

describe("scoring", () => {
  test("a matching tier passes, a mismatching one fails", () => {
    expect(score(hard, answers("opus", 0.8)).pass).toBe(true);
    expect(score(hard, answers("fable", 0.6)).pass).toBe(true);
    const miss = score(hard, answers("haiku", 0.9));
    expect(miss.pass).toBe(false);
    expect(miss.got).toBe("trivial");
  });

  test("a follow-up case is scored on the follow-up signal, not the tier", () => {
    expect(score(followup, answers("haiku", 0.9, 0.93)).pass).toBe(true);
    expect(score(followup, answers("opus", 0.9, 0.2)).pass).toBe(false);
    expect(score(followup, answers("haiku", 0.9, 0.93)).how).toBe("followup");
  });

  test("a failed call fails the case and keeps the error", () => {
    const r = score(trivial, null, { error: "http 500" });
    expect(r.pass).toBe(false);
    expect(r.how).toBe("error");
    expect(r.note).toBe("http 500");
  });

  test("state carries the previous reply and routing", () => {
    expect(buildState(followup)).toEqual({
      latest_user_message: "yes do it",
      previous_assistant_reply: "Here is the plan.",
      previous_routing: { model: "opus", effort: "xhigh" },
    });
    expect(buildState(trivial).previous_assistant_reply).toBeNull();
  });
});

describe("summary", () => {
  const results = [
    score(hard, answers("opus", 0.8)),
    score(hard, answers("haiku", 0.3)),
    score(trivial, answers("haiku", 0.95)),
    score(trivial, answers("sonnet", 0.45)),
    score(followup, answers("haiku", 0.9, 0.93)),
    score({ prompt: "!haiku compile this", expect: { tier: "trivial" } }, null),
  ];
  const s = summarize(results);

  test("accuracy overall and per tier", () => {
    expect(s.cases).toBe(6);
    expect(s.passed).toBe(4);
    expect(s.byTier.find((t) => t.tier === "trivial")).toMatchObject({ cases: 3, passed: 2 });
    expect(s.byTier.find((t) => t.tier === "hard")).toMatchObject({ cases: 3, passed: 2 });
  });

  test("confusion pairs, with overrides excluded", () => {
    expect(s.confusion).toEqual(
      expect.arrayContaining([
        { expected: "hard", got: "trivial", cases: 1 },
        { expected: "trivial", got: "normal", cases: 1 },
      ]),
    );
    expect(s.jevCalls).toBe(5);
  });

  test("mean confidence separates hits from misses", () => {
    expect(s.meanConfidence.hits).toBeCloseTo((0.8 + 0.95 + 0.9) / 3, 10);
    expect(s.meanConfidence.misses).toBeCloseTo((0.3 + 0.45) / 2, 10);
  });

  test("low confidence cases are listed", () => {
    expect(s.lowConfidence.map((c) => c.confidence)).toEqual([0.3, 0.45]);
  });

  test("prices the run at the Jev default and at an override", () => {
    const withTokens = summarize([{ ...results[0]!, tokens: { input: 1_000_000, output: 100 } }]);
    expect(render(results, withTokens)).toContain("Run cost: $0.0420");
    expect(render(results, withTokens, { in: 1, out: 5 })).toContain("Run cost: $1.0005");
  });
});
