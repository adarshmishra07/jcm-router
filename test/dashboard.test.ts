import { describe, expect, test } from "bun:test";
import { priceFor, recordCost, parseJournal, type LogRecord } from "../scripts/cost.ts";
import { PAGE, readSummary, sourceLabel, summarize } from "../scripts/dashboard.ts";

const record = (over: Partial<LogRecord>): LogRecord => ({
  at: "2026-09-17T06:45:39.079Z",
  conv: "aaaa1111",
  kind: "main",
  turn: "new",
  source: "jev",
  requested: { model: "claude-sonnet-5", effort: "low" },
  routed: { alias: "sonnet", model: "claude-sonnet-5", effort: "low" },
  jev: { ms: 400, model: { type: "choice", choice: "sonnet", confidence: 0.8 }, effort: { type: "choice", choice: "low", confidence: 0.9 }, is_followup: 0.1 },
  upstream: { status: 200, ms_to_headers: 900, retried_with_original: false },
  usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  ...over,
});

// Router switched opus -> haiku and had to re-write 100K tokens of cache.
const switched = record({
  at: "2026-09-17T07:00:00.000Z",
  requested: { model: "claude-opus-5", effort: "high" },
  routed: { alias: "haiku", model: "claude-haiku-4-5", effort: null },
  usage: { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 100_000 },
});

const subagentSaving = record({
  at: "2026-09-17T07:01:00.000Z",
  kind: "subagent",
  requested: { model: "claude-opus-5", effort: "high" },
  routed: { alias: "haiku", model: "claude-haiku-4-5", effort: null },
  usage: { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 },
});

describe("pricing", () => {
  test("matches a model family inside the id", () => {
    expect(priceFor("claude-opus-4-7")).toEqual({ in: 5, out: 25 });
    expect(priceFor("claude-fable-5-1")?.out).toBe(50);
    expect(priceFor("gpt-9")).toBeNull();
    expect(priceFor(undefined)).toBeNull();
  });

  test("no switch: actual equals baseline", () => {
    const c = recordCost(record({}));
    expect(c.actual).toBeCloseTo(0.007, 10);
    expect(c.baseline).toBeCloseTo(0.007, 10);
    expect(c.delta).toBeCloseTo(0, 10);
    expect(c.switched).toBe(false);
  });

  test("a switch prices re-cached tokens as a cache read in the baseline", () => {
    const c = recordCost(switched);
    // 10 in + 100K cache writes at 2x + 100 out, all at haiku rates.
    expect(c.actual).toBeCloseTo(0.20051, 10);
    // Without the router those 100K were already cached: a read at opus rates.
    expect(c.baseline).toBeCloseTo(0.05255, 10);
    expect(c.delta).toBeGreaterThan(0);
    expect(c.switched).toBe(true);
  });

  test("a switch with a warm cache saves money", () => {
    const c = recordCost(subagentSaving);
    expect(c.actual).toBeCloseTo(0.0065, 10);
    expect(c.baseline).toBeCloseTo(0.0325, 10);
    expect(c.delta).toBeLessThan(0);
  });

  test("records without usage or with an unknown model are unpriced, not crashes", () => {
    expect(recordCost(record({ usage: null }))).toMatchObject({ priced: false, actual: 0, baseline: 0 });
    expect(recordCost(record({ routed: { model: "some-future-model" } }))).toMatchObject({ priced: false });
    expect(recordCost({} as LogRecord)).toMatchObject({ priced: false, delta: 0 });
  });
});

describe("summarize", () => {
  const s = summarize([record({}), switched, subagentSaving, record({ usage: null })], "/tmp/decisions.jsonl");

  test("splits the verdict by main chat and subagents", () => {
    expect(s.records).toBe(4);
    expect(s.unpriced).toBe(1);
    expect(s.verdict.main.requests).toBe(3);
    expect(s.verdict.subagent.requests).toBe(1);
    expect(s.verdict.main.delta).toBeGreaterThan(0);
    expect(s.verdict.subagent.delta).toBeLessThan(0);
    expect(s.verdict.overall.delta).toBeCloseTo(s.verdict.main.delta + s.verdict.subagent.delta, 10);
  });

  test("counts switches and re-cached tokens", () => {
    expect(s.cache.switches).toBe(2);
    expect(s.cache.recaches).toBe(1);
    expect(s.cache.recached_tokens).toBe(100_000);
    expect(s.cache.byModel.find((m) => m.model === "claude-haiku-4-5")?.requests).toBe(2);
  });

  test("rows are newest first and carry the delta", () => {
    expect(s.rows).toHaveLength(4);
    expect(s.rows[0]?.at).toBe("07:01:00");
    expect(s.rows[0]?.delta).toBeLessThan(0);
    expect(s.rows.at(-1)?.delta).toBe("");
  });

  test("jev latency, sources and confidence buckets", () => {
    expect(s.jev.count).toBe(4);
    expect(s.jev.p50).toBe(400);
    expect(s.jev.sources.find((x) => x.source === "jev")?.requests).toBe(4);
    expect(s.jev.confidence.find((b) => b.bucket === "0.70 to 0.90")?.requests).toBe(4);
  });

  test("skip reasons show up in the source label and the source table", () => {
    const skipped = summarize([record({ source: "skipped", skip_reason: "cache too warm to switch" })]);
    expect(skipped.jev.sources[0]?.source).toBe("skipped: cache too warm to switch");
    expect(sourceLabel(record({ source: "fallback" }))).toBe("fallback");
  });

  test("groups jev errors and fallbacks", () => {
    const withErrors = summarize([record({ source: "fallback", jev_error: "TimeoutError: timed out", jev: null }), record({ source: "fallback", jev_error: "TimeoutError: timed out", jev: null })]);
    expect(withErrors.jev.errors).toEqual([{ reason: "TimeoutError: timed out", requests: 2, fallbacks: 2 }]);
  });
});

describe("defensive parsing", () => {
  test("empty log summarizes to zeros", () => {
    const s = summarize([]);
    expect(s.records).toBe(0);
    expect(s.verdict.overall).toEqual({ requests: 0, actual: 0, baseline: 0, delta: 0 });
    expect(s.rows).toEqual([]);
    expect(s.jev.p50).toBe(0);
  });

  test("missing file reads as an empty summary", async () => {
    const s = await readSummary("/tmp/claude-router-does-not-exist.jsonl");
    expect(s.records).toBe(0);
  });

  test("records missing newer fields, and unknown fields, do not crash", () => {
    const old = parseJournal(
      [
        JSON.stringify({ at: "2026-09-17T05:00:00.000Z", turn: "new", source: "cached", requested: { model: "claude-opus-5" }, routed: { model: "claude-opus-5" }, usage: null }),
        JSON.stringify({ at: "2026-09-17T05:01:00.000Z", source: "skipped", skip_reason: "warm cache", context_tokens: 500_000, stay_cost: 1.2, switch_cost: 3.4, some_future_field: { nested: true } }),
        "{ not json",
        "",
      ].join("\n"),
    );
    expect(old).toHaveLength(2);
    const s = summarize(old);
    expect(s.records).toBe(2);
    expect(s.rows[0]?.source).toBe("skipped: warm cache");
    expect(s.jev.count).toBe(0);
  });

  test("the page is self contained", () => {
    expect(PAGE).toContain("<title>claude-router dashboard</title>");
    expect(PAGE).toContain("/api.json");
    expect(PAGE).toContain("prefers-color-scheme: dark");
    expect(PAGE).not.toContain("http://cdn");
    expect(PAGE).not.toMatch(/<script[^>]+src=/);
  });
});
