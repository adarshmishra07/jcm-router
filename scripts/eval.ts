// Runs a labeled prompt set through the Jev API only. No Claude calls, so tuning thresholds
// costs a few cents and a few seconds. Usage: bun run eval [--json]

import { join } from "node:path";

// WARNING: eval/questions.json is a hand-kept copy of QUESTIONS in src/routing-policy.ts.
// The harness deliberately does not import the source so it can run while the proxy is edited.
// If you change the questions there, copy them here or this eval measures the wrong thing.
export const SYNC_WARNING =
  "eval/questions.json is a copy of QUESTIONS in src/routing-policy.ts. Keep it in sync by hand, otherwise these numbers describe a router you are not running.";

const JEV_PATH = "/v1/systemone";
const TIMEOUT_MS = 10_000;
const CONCURRENCY = 5;
const LOW_CONFIDENCE = 0.5;
// Jev pricing, USD per million tokens. Source: typesafe.ai homepage, checked 2026-09-17 ($42 per billion
// input tokens, output free). TypeSafe publishes no /pricing page, so this homepage figure may drift.
// JEV_PRICE_IN and JEV_PRICE_OUT override it.
export const JEV_PRICE = { in: 0.042, out: 0 } as const;
// Mirrors THRESHOLDS.FOLLOWUP_MIN_NOUL in src/routing-policy.ts.
export const FOLLOWUP_MIN_NOUL = 0.7;
// Mirrors LIMITS in src/routing-policy.ts.
const USER_MESSAGE_MAX_CHARS = 6000;
const ASSISTANT_REPLY_MAX_CHARS = 2000;

export const TIER_OF_ALIAS = { haiku: "trivial", sonnet: "normal", opus: "hard", fable: "hard" } as const;
const ALIASES = Object.keys(TIER_OF_ALIAS);
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export type Tier = "trivial" | "normal" | "hard";

export type Case = {
  prompt: string;
  expect: { tier: Tier; note?: string; followup?: boolean; override?: string };
  context?: { previousReply?: string; previousRouting?: { model?: string | null; effort?: string | null } | null };
};

export type Answers = {
  model?: { choice?: string; confidence?: number };
  effort?: { choice?: string; confidence?: number };
  is_followup?: { noul?: number };
};

export type Result = {
  prompt: string;
  expected: Tier;
  got: Tier | "";
  model: string;
  effort: string;
  confidence: number | null;
  followup: number | null;
  pass: boolean;
  how: "jev" | "override" | "followup" | "error";
  note: string;
  ms: number;
  tokens: { input: number; output: number };
};

export const tierOf = (alias: string | undefined): Tier | "" =>
  (TIER_OF_ALIAS[alias as keyof typeof TIER_OF_ALIAS] as Tier | undefined) ?? "";

// Leading "!opus !high" tokens, same rule as src/decide.ts parseOverrides.
export function overrideAlias(prompt: string): string | null {
  for (const token of prompt.trimStart().split(/\s+/)) {
    if (!token.startsWith("!")) return null;
    const word = token.slice(1);
    if (ALIASES.includes(word)) return word;
    if (!EFFORTS.includes(word)) return null;
  }
  return null;
}

export function buildState(c: Case): Record<string, unknown> {
  return {
    latest_user_message: c.prompt.slice(0, USER_MESSAGE_MAX_CHARS),
    previous_assistant_reply: c.context?.previousReply?.slice(0, ASSISTANT_REPLY_MAX_CHARS) ?? null,
    previous_routing: c.context?.previousRouting ?? null,
  };
}

// Pure scoring, so it can be tested against a stubbed Jev answer with no network.
export function score(c: Case, answers: Answers | null, extra: { ms?: number; tokens?: Result["tokens"]; error?: string } = {}): Result {
  const base = {
    prompt: c.prompt,
    expected: c.expect.tier,
    note: c.expect.note ?? "",
    ms: extra.ms ?? 0,
    tokens: extra.tokens ?? { input: 0, output: 0 },
  };
  const override = overrideAlias(c.prompt);
  if (override) {
    const got = tierOf(override);
    return { ...base, got, model: override, effort: "", confidence: null, followup: null, pass: got === c.expect.tier, how: "override", note: base.note || "decided before Jev is called" };
  }
  if (!answers) {
    return { ...base, got: "", model: "", effort: "", confidence: null, followup: null, pass: false, how: "error", note: extra.error ?? "no answer" };
  }
  const followup = typeof answers.is_followup?.noul === "number" ? answers.is_followup.noul : null;
  const model = answers.model?.choice ?? "";
  const confidence = typeof answers.model?.confidence === "number" ? answers.model.confidence : null;
  const common = { ...base, model, effort: answers.effort?.choice ?? "", confidence, followup };
  // A follow-up case passes when Jev spots the continuation. Its tier comes from the previous
  // decision, so the model choice is reported but not scored.
  if (c.expect.followup) {
    return { ...common, got: tierOf(model), pass: followup !== null && followup >= FOLLOWUP_MIN_NOUL, how: "followup" };
  }
  const got = tierOf(model);
  return { ...common, got, pass: got === c.expect.tier, how: "jev" };
}

export type EvalSummary = {
  cases: number;
  passed: number;
  accuracy: number;
  byTier: { tier: string; cases: number; passed: number; accuracy: number }[];
  confusion: { expected: string; got: string; cases: number }[];
  meanConfidence: { hits: number | null; misses: number | null };
  lowConfidence: { prompt: string; confidence: number; got: string; expected: string }[];
  tokens: { input: number; output: number };
  jevCalls: number;
};

const mean = (ns: number[]): number | null => (ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : null);

export function summarize(results: Result[]): EvalSummary {
  const scored = results.filter((r) => r.how !== "override");
  const tiers = [...new Set(results.map((r) => r.expected))];
  const confidence = (rs: Result[]) => mean(rs.flatMap((r) => (r.confidence === null ? [] : [r.confidence])));
  return {
    cases: results.length,
    passed: results.filter((r) => r.pass).length,
    accuracy: results.length ? results.filter((r) => r.pass).length / results.length : 0,
    byTier: tiers.map((tier) => {
      const rs = results.filter((r) => r.expected === tier);
      return { tier, cases: rs.length, passed: rs.filter((r) => r.pass).length, accuracy: rs.length ? rs.filter((r) => r.pass).length / rs.length : 0 };
    }),
    confusion: [...new Map(scored.filter((r) => !r.pass).map((r) => [`${r.expected}>${r.got || "none"}`, r])).keys()].map((key) => ({
      expected: key.split(">")[0] ?? "",
      got: key.split(">")[1] ?? "",
      cases: scored.filter((r) => !r.pass && `${r.expected}>${r.got || "none"}` === key).length,
    })),
    meanConfidence: { hits: confidence(scored.filter((r) => r.pass)), misses: confidence(scored.filter((r) => !r.pass)) },
    lowConfidence: scored
      .filter((r) => r.confidence !== null && r.confidence < LOW_CONFIDENCE)
      .map((r) => ({ prompt: r.prompt, confidence: r.confidence ?? 0, got: r.got, expected: r.expected })),
    tokens: results.reduce((t, r) => ({ input: t.input + r.tokens.input, output: t.output + r.tokens.output }), { input: 0, output: 0 }),
    jevCalls: results.filter((r) => r.how !== "override").length,
  };
}

async function askJev(url: string, apiKey: string, state: unknown, questions: unknown): Promise<{ answers: Answers | null; error?: string; ms: number; tokens: Result["tokens"] }> {
  const started = performance.now();
  const done = () => Math.round(performance.now() - started);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "jev-latest", state, questions }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { answers: null, error: `http ${res.status}`, ms: done(), tokens: { input: 0, output: 0 } };
    const json = (await res.json()) as { answers?: Answers; usage?: { input_tokens?: number; output_tokens?: number } };
    return {
      answers: json.answers ?? null,
      ms: done(),
      tokens: { input: json.usage?.input_tokens ?? 0, output: json.usage?.output_tokens ?? 0 },
    };
  } catch (err) {
    return { answers: null, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err), ms: done(), tokens: { input: 0, output: 0 } };
  }
}

export async function runEval(cases: Case[], questions: unknown, client: { url: string; apiKey: string }): Promise<Result[]> {
  const results: Result[] = [];
  for (let i = 0; i < cases.length; i += CONCURRENCY) {
    const batch = await Promise.all(
      cases.slice(i, i + CONCURRENCY).map(async (c) => {
        if (overrideAlias(c.prompt)) return score(c, null);
        const { answers, error, ms, tokens } = await askJev(client.url, client.apiKey, buildState(c), questions);
        return score(c, answers, { ms, tokens, error });
      }),
    );
    results.push(...batch);
  }
  return results;
}

const pad = (v: string | number, w: number) => String(v).padEnd(w);
const pctStr = (n: number) => `${(n * 100).toFixed(0)}%`;

export function render(results: Result[], s: EvalSummary, price: { in: number; out: number } = JEV_PRICE): string {
  const lines = [
    `${pad("result", 7)}${pad("expected", 9)}${pad("got", 11)}${pad("model/effort", 16)}${pad("conf", 6)}${pad("ms", 6)}prompt`,
    ...results.map((r) =>
      [
        pad(r.pass ? "pass" : "FAIL", 7),
        pad(r.expected, 9),
        pad(r.how === "followup" ? (r.pass ? "followup" : "not-followup") : r.got || "-", 11),
        pad(`${r.model || "-"}/${r.effort || "-"}`, 16),
        // For a follow-up case the useful number is the follow-up signal, not the model confidence.
        pad((r.how === "followup" ? r.followup : r.confidence)?.toFixed(2) ?? "-", 6),
        pad(r.ms || "-", 6),
        r.prompt.replace(/\s+/g, " ").slice(0, 70),
      ].join(""),
    ),
    "",
    `Accuracy ${s.passed}/${s.cases} (${pctStr(s.accuracy)})`,
    ...s.byTier.map((t) => `  ${pad(t.tier, 9)} ${t.passed}/${t.cases} (${pctStr(t.accuracy)})`),
    "",
    s.confusion.length ? "Confusion (expected -> got)" : "No misses.",
    ...s.confusion.map((c) => `  ${pad(c.expected, 9)} -> ${pad(c.got, 9)} ${c.cases}`),
    "",
    `Mean model confidence: hits ${s.meanConfidence.hits?.toFixed(2) ?? "n/a"}, misses ${s.meanConfidence.misses?.toFixed(2) ?? "n/a"}`,
    s.lowConfidence.length ? `Below ${LOW_CONFIDENCE} confidence (these fall back to what Claude Code asked for):` : `No case below ${LOW_CONFIDENCE} confidence.`,
    ...s.lowConfidence.map((c) => `  ${c.confidence.toFixed(2)} ${c.expected}->${c.got || "none"}  ${c.prompt.replace(/\s+/g, " ").slice(0, 60)}`),
    "",
    `Jev: ${s.jevCalls} calls, ${s.tokens.input} input + ${s.tokens.output} output tokens`,
    `Run cost: $${((s.tokens.input * price.in + s.tokens.output * price.out) / 1_000_000).toFixed(4)} at $${price.in} in / $${price.out} out per MTok`,
  ];
  return lines.join("\n");
}

function priceFromEnv(): { in: number; out: number } {
  const num = (raw: string | undefined, fallback: number) => (raw && Number.isFinite(Number(raw)) ? Number(raw) : fallback);
  return { in: num(process.env.JEV_PRICE_IN, JEV_PRICE.in), out: num(process.env.JEV_PRICE_OUT, JEV_PRICE.out) };
}

if (import.meta.main) {
  const asJson = process.argv.includes("--json");
  const apiKey = process.env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) {
    console.error("eval: TYPESAFE_API_KEY is not set. Put it in .env (Bun loads it) or export it, then run again.");
    process.exit(1);
  }
  const here = new URL("..", import.meta.url).pathname;
  const cases = (await Bun.file(join(here, "eval/prompts.json")).json()) as Case[];
  const questions = await Bun.file(join(here, "eval/questions.json")).json();
  const url = (process.env.TYPESAFE_API_URL ?? "https://api.typesafe.ai").replace(/\/+$/, "") + JEV_PATH;

  if (!asJson) {
    console.error(`warning: ${SYNC_WARNING}\n`);
    console.log(`Running ${cases.length} cases against ${url} (Jev only, no Claude calls)\n`);
  }
  const results = await runEval(cases, questions, { url, apiKey });
  const summary = summarize(results);
  if (asJson) console.log(JSON.stringify({ warning: SYNC_WARNING, summary, results }, null, 2));
  else console.log(render(results, summary, priceFromEnv()));
}
