import { describe, expect, test } from "bun:test";
import type { Decision } from "../src/decide.ts";
import { applyDecision, foldSystemMessages, withoutThinkingEdits } from "../src/rewrite.ts";

const decision = (over: Partial<Decision>): Decision => ({
  conv: "abcdef01",
  alias: "opus",
  model: "claude-opus-5",
  effort: "high",
  source: "jev",
  confidences: {},
  jevMs: 1,
  at: "",
  ...over,
});

const body = {
  model: "claude-sonnet-5",
  thinking: { type: "adaptive", display: "omitted" },
  output_config: { effort: "low", other: 1 },
  messages: [],
  tools: [{ name: "Bash" }],
};

describe("applyDecision", () => {
  test("sets model and effort, keeps everything else", () => {
    const out = applyDecision(body, decision({}));
    expect(out).toEqual({ ...body, model: "claude-opus-5", output_config: { effort: "high", other: 1 } });
  });

  test("does not mutate the input", () => {
    const frozen = JSON.stringify(body);
    applyDecision(body, decision({ alias: "haiku", model: "claude-haiku-4-5", effort: null }));
    expect(JSON.stringify(body)).toBe(frozen);
  });

  test("effort null leaves output_config untouched", () => {
    expect(applyDecision(body, decision({ effort: null })).output_config).toEqual(body.output_config);
  });

  test("haiku drops effort and thinking, folds system messages, and drops output_config when empty", () => {
    const d = decision({ alias: "haiku", model: "claude-haiku-4-5", effort: null });
    const out = applyDecision(body, d);
    expect(out).toEqual({ model: "claude-haiku-4-5", output_config: { other: 1 }, messages: [], tools: body.tools });
    const withNote = applyDecision({ ...body, messages: [{ role: "user", content: "hi" }, { role: "system", content: "note" }] }, d);
    expect(withNote.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }, { type: "text", text: "note" }] }]);
    const withEdits = applyDecision({ ...body, context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] } }, d);
    expect("context_management" in withEdits).toBe(false);
    const bare = applyDecision({ ...body, output_config: { effort: "low" } }, d);
    expect("output_config" in bare).toBe(false);
    expect("thinking" in bare).toBe(false);
  });

  test("adds output_config when the request had none", () => {
    expect(applyDecision({ model: "x" }, decision({})).output_config).toEqual({ effort: "high" });
  });
});

describe("foldSystemMessages", () => {
  const note = { type: "text", text: "<system-reminder>hook output</system-reminder>", cache_control: { type: "ephemeral" } };
  const prompt = { type: "text", text: "do it" };
  const toolUse = { role: "assistant", content: [{ type: "tool_use", id: "1" }] };
  const result = { type: "tool_result", tool_use_id: "1", content: "ok" };

  test("appends a trailing system message to the preceding user message", () => {
    expect(foldSystemMessages([{ role: "user", content: [prompt] }, { role: "system", content: [note] }])).toEqual([{ role: "user", content: [prompt, note] }]);
  });

  test("a leading system message goes into the next user message, after its tool results", () => {
    expect(foldSystemMessages([{ role: "system", content: "note" }, { role: "user", content: "hi" }])).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }, { type: "text", text: "note" }] },
    ]);
  });

  test("a system message between tool_use and tool_result lands after the tool_result", () => {
    const folded = foldSystemMessages([{ role: "user", content: [prompt] }, toolUse, { role: "system", content: [note] }, { role: "user", content: [result] }]);
    expect(folded).toEqual([{ role: "user", content: [prompt, note] }, toolUse, { role: "user", content: [result] }]);
  });

  test("does not mutate the input and leaves bodies without system messages alone", () => {
    const input = [{ role: "user", content: [prompt] }, toolUse, { role: "user", content: [result] }];
    const snapshot = JSON.stringify(input);
    expect(foldSystemMessages(input)).toEqual(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(foldSystemMessages(undefined)).toBeUndefined();
  });
});

describe("withoutThinkingEdits", () => {
  test("drops clear_thinking edits, keeps others, and removes the field when nothing is left", () => {
    const keep = { type: "clear_tool_uses_20250919", trigger: { type: "input_tokens", value: 100000 } };
    expect(withoutThinkingEdits({ edits: [{ type: "clear_thinking_20251015", keep: "all" }, keep] })).toEqual({ edits: [keep] });
    expect(withoutThinkingEdits({ edits: [{ type: "clear_thinking_20251015", keep: "all" }] })).toBeUndefined();
    expect(withoutThinkingEdits(undefined)).toBeUndefined();
    expect(withoutThinkingEdits({ other: 1 })).toEqual({ other: 1 });
  });
});

import { withoutLongContextBeta } from "../src/proxy.ts";

describe("withoutLongContextBeta", () => {
  test("drops only the context-1m beta and keeps the rest", () => {
    const h = new Headers({ "anthropic-beta": "oauth-2025-04-20, context-1m-2025-08-07,effort-2025-11-24" });
    expect(withoutLongContextBeta(h).get("anthropic-beta")).toBe("oauth-2025-04-20,effort-2025-11-24");
  });
  test("removes the header when nothing is left, leaves other headers alone", () => {
    const h = new Headers({ "anthropic-beta": "context-1m-2025-08-07", authorization: "Bearer x" });
    const out = withoutLongContextBeta(h);
    expect(out.get("anthropic-beta")).toBeNull();
    expect(out.get("authorization")).toBe("Bearer x");
  });
  test("no beta header is a no-op", () => {
    expect(withoutLongContextBeta(new Headers()).get("anthropic-beta")).toBeNull();
  });
});
