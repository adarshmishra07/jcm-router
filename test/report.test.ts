import { describe, expect, test } from "bun:test";
import { parseJournal, render, sinceMs, summarize } from "../scripts/report.ts";
import type { DecisionRecord } from "../src/decision-log.ts";

const choice = (c: string, confidence: number) => ({ type: "choice" as const, choice: c, probabilities: {}, confidence });

const rec = (over: Partial<DecisionRecord>): DecisionRecord => ({
  at: "2026-09-17T10:00:00.000Z",
  conv: "aaaaaaaa",
  turn: "new",
  source: "jev",
  requested: { model: "claude-sonnet-5", effort: "low" },
  routed: { alias: "opus", model: "claude-opus-5", effort: "high" },
  jev: { ms: 500, model: choice("opus", 0.8), effort: choice("high", 0.7), is_followup: 0 },
  prompt_preview: "refactor the auth middleware to support tenants",
  upstream: { status: 200, ms_to_headers: 900, retried_with_original: false },
  usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 300, cache_creation_input_tokens: 0 },
  ...over,
});

const records: DecisionRecord[] = [
  rec({}),
  rec({ turn: "continuation", source: "cached", jev: null, prompt_preview: undefined, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 390, cache_creation_input_tokens: 0 } }),
  rec({ at: "2026-09-17T10:01:00.000Z", conv: "bbbbbbbb", routed: { alias: "haiku", model: "claude-haiku-4-5", effort: null }, jev: { ms: 1500, model: choice("haiku", 0.9), effort: choice("low", 0.9), is_followup: 0 }, prompt_preview: "what is 2+2", usage: null }),
  rec({ at: "2026-09-17T10:02:00.000Z", conv: "cccccccc", source: "fallback", routed: { alias: null, model: "claude-sonnet-5", effort: "low" }, jev: null, jev_error: "TimeoutError: The operation timed out.", usage: null }),
  rec({ at: "2026-09-17T10:03:00.000Z", conv: "dddddddd", source: "fallback", routed: { alias: null, model: "claude-sonnet-5", effort: "low" }, upstream: { status: 200, ms_to_headers: 100, retried_with_original: true }, usage: null }),
];

describe("summarize", () => {
  const s = summarize(records);

  test("counts requests and new turns per target", () => {
    expect(s.byTarget).toEqual([
      { target: "opus/high", requests: 2, new_turns: 1 },
      { target: "haiku/default", requests: 1, new_turns: 1 },
      { target: "claude-sonnet-5/low", requests: 2, new_turns: 2 },
    ]);
  });

  test("source breakdown, latency percentiles, fallback reasons and retries", () => {
    expect(s.bySource).toEqual([
      { source: "jev", requests: 2 },
      { source: "cached", requests: 1 },
      { source: "fallback", requests: 2 },
    ]);
    expect(s.jev).toEqual({ count: 3, p50: 500, p95: 1500 });
    expect(s.fallbacks).toEqual([
      { reason: "TimeoutError: The operation timed out.", requests: 1 },
      { reason: "upstream rejected rewrite", requests: 1 },
    ]);
    expect(s.retries).toBe(1);
  });

  test("tokens and cache hit ratio per model, only for requests with usage", () => {
    expect(s.tokens).toEqual([{ model: "claude-opus-5", requests: 2, input: 110, output: 55, cache_read: 690, cache_created: 0, cache_hit: "0.86" }]);
  });

  test("recent decisions list new turns only, oldest first, with confidences", () => {
    expect(s.recent.map((r) => r.conf)).toEqual(["0.80/0.70", "0.90/0.90", "", "0.80/0.70"]);
    expect(s.recent[1]).toEqual({ time: "10:01:00", prompt: "what is 2+2", routed: "haiku/default", source: "jev", conf: "0.90/0.90" });
  });

  test("render produces the plain tables", () => {
    const out = render(s);
    expect(out).toMatch(/opus\/high +2 +1/);
    expect(out).toContain("Jev latency: 3 calls, p50 500ms, p95 1500ms");
    expect(render(summarize([]))).toContain("(none)");
  });
});

describe("journal helpers", () => {
  test("parseJournal skips blank and corrupt lines", () => {
    expect(parseJournal(`${JSON.stringify(records[0])}\n\nnot json\n${JSON.stringify(records[1])}\n`)).toHaveLength(2);
  });

  test("sinceMs parses m/h/d and returns 0 otherwise", () => {
    expect(Date.now() - sinceMs("2h")).toBeGreaterThanOrEqual(2 * 3_600_000 - 50);
    expect(sinceMs(undefined)).toBe(0);
    expect(sinceMs("soon")).toBe(0);
  });
});
