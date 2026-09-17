import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogRecord } from "../scripts/cost.ts";
import { analyse, attachDeciding, deltaAt, reliability, render, sweep } from "../scripts/tune.ts";
import { THRESHOLDS } from "../src/routing-policy.ts";

const ROOT = new URL("..", import.meta.url).pathname;

// 1000 in + 1000 out: $0.012 on sonnet, $0.030 on opus, so a switched record saves $0.018.
const USAGE = { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const OPUS = { model: "claude-opus-5", effort: "high" };
const SONNET = { alias: "sonnet", model: "claude-sonnet-5", effort: "low" };
const UP = { status: 200, ms_to_headers: 100, retried_with_original: false };

const jev = (confidence: number, over: Partial<LogRecord> = {}): LogRecord => ({
  at: "2026-09-17T10:00:00.000Z",
  conv: `c${confidence}`,
  kind: "subagent",
  turn: "new",
  source: "jev",
  requested: OPUS,
  routed: SONNET,
  jev: { ms: 300, model: { type: "choice", choice: "sonnet", confidence }, effort: { type: "choice", choice: "low", confidence }, is_followup: 0.1 },
  upstream: UP,
  usage: USAGE,
  ...over,
});

describe("counterfactual sweep", () => {
  const below = jev(0.6, { conv: "a" });
  const continuation = jev(0.6, { conv: "a", turn: "continuation", source: "cached", jev: null, usage: { ...USAGE, output_tokens: 0 } });
  const above = jev(0.9, { conv: "b" });
  const override = jev(0.6, { conv: "o", source: "override", jev: null, routed: { alias: "haiku", model: "claude-haiku-4-5", effort: null } });
  const skipped = jev(0.6, { conv: "s", kind: "main", source: "skipped", skip_reason: "context_too_large", jev: null, routed: { alias: "opus", ...OPUS }, context_tokens: 500_000 });
  const decided = attachDeciding([below, continuation, above, override, skipped]);
  const OVERRIDE_DELTA = (1000 * 1 + 1000 * 5 - (1000 * 5 + 1000 * 25)) / 1e6;

  test("a decision below the floor reverts to baseline with its continuation, one above keeps its actual", () => {
    const at07 = deltaAt(decided, "MODEL_MIN_CONFIDENCE", 0.7);
    expect(at07.decisions).toBe(1);
    expect(at07.requests).toBe(1);
    expect(at07.delta).toBeCloseTo(-0.018 + OVERRIDE_DELTA, 6);
  });

  test("below the floor every decision keeps its actual", () => {
    const at05 = deltaAt(decided, "MODEL_MIN_CONFIDENCE", 0.5);
    expect(at05.decisions).toBe(2);
    expect(at05.requests).toBe(3);
    expect(at05.delta).toBeCloseTo(-0.018 - 0.003 - 0.018 + OVERRIDE_DELTA, 6);
  });

  test("an override and a skip are never gated, so the floor cannot touch them", () => {
    const at099 = deltaAt(decided, "MODEL_MIN_CONFIDENCE", 0.99);
    expect(at099.requests).toBe(0);
    expect(at099.delta).toBeCloseTo(OVERRIDE_DELTA, 6);
    expect(deltaAt(decided, "MAIN_MAX_CONTEXT_TOKENS", 25_000).requests).toBe(0);
  });

  test("a continuation follows the newest deciding record of its conversation", () => {
    const later = jev(0.95, { conv: "a" });
    const [, , , third] = attachDeciding([below, continuation, later, { ...continuation }]);
    expect(third!.deciding).toBe(later);
  });
});

describe("sweep table", () => {
  const records = [0.5, 0.6, 0.7, 0.8, 0.9].map((c) => jev(c));
  const s = sweep(attachDeciding(records), "MODEL_MIN_CONFIDENCE", [0.5, 0.6, 0.7, 0.8, 0.9]);

  test("the delta curve rises as the floor rises when every decision saved money", () => {
    const deltas = s.rows.map((r) => Number(String(r.delta).replace(/[$]/g, "").replace(/^-\$?/, "-")));
    for (let i = 1; i < deltas.length; i++) expect(deltas[i]!).toBeGreaterThan(deltas[i - 1]!);
    expect(s.rows.map((r) => r.decisions)).toEqual([5, 4, 3, 2, 1]);
  });

  test("the current value is marked and the money-optimal value is the lowest delta", () => {
    expect(s.rows.find((r) => String(r.value).endsWith("*"))?.value).toBe(`${THRESHOLDS.MODEL_MIN_CONFIDENCE.toFixed(2)} *`);
    expect(s.moneyOptimal).toBe(0.5);
    expect(s.verdict).toContain("money says 0.50");
  });

  test("when money and the eval disagree the verdict recommends the eval's nearest edge", () => {
    const low = sweep(attachDeciding([jev(0.3), jev(0.3)]), "MODEL_MIN_CONFIDENCE", [0.3, 0.5]);
    expect(low.moneyOptimal).toBe(0.3);
    expect(low.verdict).toContain("the eval only supports 0.40 to 0.65. Recommend 0.40, the safer value");
  });

  test("effort is counted but never priced", () => {
    const e = sweep(attachDeciding(records), "EFFORT_MIN_CONFIDENCE", [0.5]);
    expect(e.priced).toBe(false);
    expect(e.rows[0]).not.toHaveProperty("delta");
    expect(e.moneyOptimal).toBeNull();
  });
});

describe("reliability", () => {
  const retriedOk = jev(0.9, { source: "fallback", routed: { alias: "opus", ...OPUS }, upstream: { ...UP, retried_with_original: true }, jev: { ms: 1, model: { type: "choice", choice: "haiku", confidence: 0.9 }, effort: { type: "choice", choice: "low", confidence: 0.9 }, is_followup: 0 } });
  const retriedThen4xx = { ...retriedOk, upstream: { ...UP, status: 400, retried_with_original: true } };
  const rateLimited = jev(0.9, { upstream: { ...UP, status: 429 } });
  const r = reliability([retriedOk, retriedThen4xx, rateLimited, jev(0.9), jev(0.9)]);

  test("a retried record counts once, grouped by the pick that was rejected with effort normalised", () => {
    expect(r.rows.find((row) => row.target === "haiku/default")).toMatchObject({ requests: 2, retried: 2, failures: 2, failure_rate: "100%" });
  });

  test("an upstream 4xx without a retry is a failure, and a plain 200 is not", () => {
    expect(r.rows.find((row) => row.target === "sonnet/low")).toMatchObject({ requests: 3, "4xx": 1, failures: 1, failure_rate: "33%", codes: "429x1" });
  });
});

describe("analyse and render", () => {
  test("an empty log renders with the hard limit and every tunable", () => {
    const out = render(analyse([], "none", null));
    expect(out).toContain("not quality");
    expect(out).toContain("never edits src/");
    for (const t of ["MODEL_MIN_CONFIDENCE", "EFFORT_MIN_CONFIDENCE", "FOLLOWUP_MIN_NOUL", "MAIN_MAX_CONTEXT_TOKENS", "MAIN_MAX_SWITCH_COST_USD"]) expect(out).toContain(t);
    expect(out).toContain("What this cannot see");
  });

  test("records missing the newer fields still render", () => {
    const bare: LogRecord = { at: "2026-09-17T10:00:00.000Z", conv: "x", turn: "new", source: "jev", requested: OPUS, routed: SONNET };
    const noUpstream: LogRecord = { ...bare, jev: { ms: 5 } };
    const out = render(analyse([bare, noUpstream, {}], "none", null));
    expect(out).toContain("3 requests, 2 decisions");
    expect(out).toContain("Jev: 1 calls");
  });
});

describe("cli", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "router-tune-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const run = async (...args: string[]) => {
    const proc = Bun.spawn(["bun", join(ROOT, "scripts/tune.ts"), ...args], { env: { ...process.env, ROUTER_STATE_DIR: dir }, stdout: "pipe", stderr: "pipe" });
    return { code: await proc.exited, out: await new Response(proc.stdout).text() };
  };

  test("--since drops old records and --json keeps a stable shape", async () => {
    const old = jev(0.9, { at: "2020-01-01T00:00:00.000Z" });
    const fresh = jev(0.9, { at: new Date().toISOString() });
    await Bun.write(join(dir, "decisions.jsonl"), `${JSON.stringify(old)}\n${JSON.stringify(fresh)}\n`);
    const { code, out } = await run("--json", "--since", "1d");
    expect(code).toBe(0);
    const report = JSON.parse(out);
    expect(Object.keys(report)).toEqual(["log", "since", "records", "decisions", "totals", "hardLimit", "sweeps", "reliability", "jev", "cannotSee"]);
    expect(report.records).toBe(1);
    expect(report.since).toBe("1d");
    expect(report.sweeps.map((s: { tunable: string }) => s.tunable)).toEqual(["MODEL_MIN_CONFIDENCE", "EFFORT_MIN_CONFIDENCE", "FOLLOWUP_MIN_NOUL", "MAIN_MAX_CONTEXT_TOKENS", "MAIN_MAX_SWITCH_COST_USD"]);
    expect(Object.keys(report.sweeps[0])).toEqual(["tunable", "current", "direction", "priced", "rows", "moneyOptimal", "evalSupported", "verdict"]);
  });

  test("a missing log still produces the report", async () => {
    const { code, out } = await run();
    expect(code).toBe(0);
    expect(out).toContain("0 requests, 0 decisions");
  });
});
