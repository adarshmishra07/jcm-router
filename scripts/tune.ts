// Offline threshold tuner. Replays decisions.jsonl and reports what each threshold in src/routing-policy.ts
// would have cost at other values, using only what the log already holds. It never writes to src/ and never
// changes routing: a human reads the table and edits one constant.
// Usage: bun run tune [--since 7d] [--json]

import { MODELS, THRESHOLDS } from "../src/routing-policy.ts";
import { avoidedCost, type LogRecord, parseJournal, recordCost } from "./cost.ts";
import { logPath } from "./dashboard.ts";
import { sinceMs, table } from "./report.ts";

export const HARD_LIMIT =
  "This optimises money and reliability, not quality. The log has no record of whether the routed model did the job well, " +
  "so the floor that saves the most may be sending work to a model that answers worse, and nothing here can see that. " +
  "The only accuracy signal in the repo is bun run eval: 41 hand-written cases, not real traffic.";

// The floors the last eval run supported: no wrong call let through, no correct call discarded beyond the ones
// every floor in the range discards. Hand-copied from `bun run eval --json` on 2026-09-17 (41 cases, 39 pass).
// Model: no floor from 0.40 to 0.65 lost a correct call; 0.70 and up each lose one more. Follow-up: the true
// follow-ups scored 0.96 to 0.98, or 0.54 and 0.31 which no floor above those catches; every non-follow-up was
// at or below 0.03. Jev's confidences move a case or two between runs, so re-run the eval before trusting an edge.
// The eval scores model choice and follow-up detection only, so the other tunables have no accuracy signal at all.
export const EVAL_SUPPORTED: Partial<Record<keyof typeof THRESHOLDS, { lo: number; hi: number }>> = {
  MODEL_MIN_CONFIDENCE: { lo: 0.4, hi: 0.65 },
  FOLLOWUP_MIN_NOUL: { lo: 0.05, hi: 0.95 },
};

const CONFIDENCE_GRID = Array.from({ length: 14 }, (_, i) => Number((0.3 + i * 0.05).toFixed(2)));
const CONTEXT_GRID = [25_000, 50_000, 75_000, 100_000, 150_000, 200_000, 300_000];
const SWITCH_COST_GRID = [0.05, 0.1, 0.25, 0.5, 1, 2];
const STANDOUT_MIN_FAILURES = 3;
const STANDOUT_RATIO = 2;

type Tunable = keyof typeof THRESHOLDS;
type Row = Record<string, string | number>;

// A continuation runs on whatever its turn decided, so the counterfactual must follow the deciding record.
export type Decided = { record: LogRecord; deciding: LogRecord };

export type Sweep = {
  tunable: Tunable;
  current: number;
  // "floor": a value below the candidate reverts. "ceiling": a value above it reverts.
  direction: "floor" | "ceiling";
  priced: boolean;
  rows: Row[];
  moneyOptimal: number | null;
  evalSupported: { lo: number; hi: number } | null;
  verdict: string;
};

export type Report = {
  log: string;
  since: string | null;
  records: number;
  decisions: number;
  totals: { actual: number; baseline: number; delta: number };
  hardLimit: string;
  sweeps: Sweep[];
  reliability: { rows: Row[]; standouts: string[] };
  jev: { calls: number; p50_ms: number; p95_ms: number; cost: string };
  cannotSee: string;
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const pct = (sorted: number[], p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
const usd = (n: number): string => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
const sum = (ns: number[]): number => ns.reduce((a, b) => a + b, 0);

export function attachDeciding(records: LogRecord[]): Decided[] {
  const latest = new Map<string, LogRecord>();
  return records.map((record) => {
    const conv = record.conv ?? "";
    if (record.turn === "new") latest.set(conv, record);
    return { record, deciding: latest.get(conv) ?? record };
  });
}

// The value each decision was gated on for a tunable, or null when the gate did not apply to it.
const gateOf: Record<Tunable, (d: LogRecord) => number | null> = {
  MODEL_MIN_CONFIDENCE: (d) => (d.source === "jev" ? num(d.jev?.model?.confidence) : null),
  EFFORT_MIN_CONFIDENCE: (d) => (d.source === "jev" ? num(d.jev?.effort?.confidence) : null),
  FOLLOWUP_MIN_NOUL: (d) => (d.source === "followup" ? num(d.jev?.is_followup) : null),
  MAIN_MAX_CONTEXT_TOKENS: (d) => (d.source === "jev" && d.kind !== "subagent" ? num(d.context_tokens) : null),
  MAIN_MAX_SWITCH_COST_USD: (d) => {
    const stay = num(d.stay_cost);
    const sw = num(d.switch_cost);
    return d.source === "jev" && d.kind !== "subagent" && stay !== null && sw !== null ? sw - stay : null;
  },
  HAIKU_MAX_TOKENS: () => null,
  UPGRADE_MIN_CONFIDENCE: () => null,
};

const DIRECTION: Record<Tunable, Sweep["direction"]> = {
  MODEL_MIN_CONFIDENCE: "floor",
  EFFORT_MIN_CONFIDENCE: "floor",
  FOLLOWUP_MIN_NOUL: "floor",
  MAIN_MAX_CONTEXT_TOKENS: "ceiling",
  MAIN_MAX_SWITCH_COST_USD: "ceiling",
  HAIKU_MAX_TOKENS: "ceiling",
  UPGRADE_MIN_CONFIDENCE: "floor",
};

// Would the decision still have been acted on at this candidate value?
export const actedAt = (direction: Sweep["direction"], gate: number, candidate: number): boolean =>
  direction === "floor" ? gate >= candidate : gate <= candidate;

// Cost of the log at one candidate: a decision the candidate would have blocked reverts to its baseline.
export function deltaAt(decided: Decided[], tunable: Tunable, candidate: number): { decisions: number; requests: number; delta: number } {
  return decided.reduce(
    (acc, { record, deciding }) => {
      const gate = gateOf[tunable](deciding);
      const acted = gate !== null && actedAt(DIRECTION[tunable], gate, candidate);
      const c = recordCost(record);
      return {
        decisions: acc.decisions + (acted && record === deciding ? 1 : 0),
        requests: acc.requests + (acted ? 1 : 0),
        delta: acc.delta + (gate === null || acted ? c.delta : 0),
      };
    },
    { decisions: 0, requests: 0, delta: 0 },
  );
}

// Skipped main turns the candidate would have let through to Jev, and the re-cache each one was priced at.
function exposedAt(decided: Decided[], reason: string, candidate: number): { turns: number; usd: number } {
  const skips = decided.flatMap(({ record }) => {
    if (record.skip_reason !== reason) return [];
    const gate = reason === "context_too_large" ? num(record.context_tokens) : avoidedCost(record)?.usd ?? null;
    return gate !== null && gate <= candidate ? [avoidedCost(record)?.usd ?? 0] : [];
  });
  return { turns: skips.length, usd: sum(skips) };
}

const fmtValue = (tunable: Tunable, v: number): string =>
  tunable === "MAIN_MAX_CONTEXT_TOKENS" ? `${Math.round(v / 1000)}K` : tunable === "MAIN_MAX_SWITCH_COST_USD" ? usd(v) : v.toFixed(2);

function verdictFor(s: Omit<Sweep, "verdict">, gain: number, restsOn: number): string {
  if (!s.priced) return "not priceable from the log: effort has no line on the price list, only its output tokens are billed";
  if (s.moneyOptimal === null) return "no decision in this window was gated by this value, nothing to sweep";
  const range = s.evalSupported;
  const cur = fmtValue(s.tunable, s.current);
  const money = `money says ${fmtValue(s.tunable, s.moneyOptimal)} (${usd(-gain)} vs current, resting on ${restsOn} decision${restsOn === 1 ? "" : "s"})`;
  const inRange = (v: number) => range !== null && v >= range.lo && v <= range.hi;
  const currentNote = range && !inRange(s.current) ? ` Current ${cur} sits outside the eval range.` : "";
  if (s.moneyOptimal === s.current || gain <= 0) return `keep ${cur}: no other value in the grid saved more.${currentNote}`;
  if (!range) return `${money}. No accuracy signal exists for this value, so treat that as a ceiling on the saving, not a recommendation`;
  if (inRange(s.moneyOptimal)) return `${money} and the eval supports it.${currentNote}`;
  const safer = Math.min(Math.max(s.moneyOptimal, range.lo), range.hi);
  return `${money} but the eval only supports ${fmtValue(s.tunable, range.lo)} to ${fmtValue(s.tunable, range.hi)}. Recommend ${
    safer === s.current ? `keeping ${cur}` : fmtValue(s.tunable, safer)
  }, the safer value.${currentNote}`;
}

export function sweep(decided: Decided[], tunable: Tunable, grid: number[]): Sweep {
  const current = THRESHOLDS[tunable];
  const priced = tunable !== "EFFORT_MIN_CONFIDENCE";
  const candidates = [...new Set([...grid, current])].sort((a, b) => a - b);
  const at = new Map(candidates.map((v) => [v, deltaAt(decided, tunable, v)]));
  const currentDelta = at.get(current)!.delta;
  const gated = decided.some(({ deciding }) => gateOf[tunable](deciding) !== null);
  const rows = candidates.map((v) => {
    const r = at.get(v)!;
    const base: Row = { value: `${fmtValue(tunable, v)}${v === current ? " *" : ""}`, decisions: r.decisions, requests: r.requests };
    const money: Row = priced ? { delta: usd(r.delta), vs_current: usd(r.delta - currentDelta) } : {};
    const exposed =
      tunable === "MAIN_MAX_CONTEXT_TOKENS"
        ? exposedAt(decided, "context_too_large", v)
        : tunable === "MAIN_MAX_SWITCH_COST_USD"
          ? exposedAt(decided, "switch_not_worth_it", v)
          : null;
    const extra: Row = exposed ? { skips_exposed: exposed.turns, recache_at_risk: usd(exposed.usd) } : {};
    return { ...base, ...money, ...extra };
  });
  // Lowest delta wins; on a tie the safer value (higher floor, lower ceiling) wins, and current beats both.
  const safer = (a: number, b: number) => (DIRECTION[tunable] === "floor" ? b - a : a - b);
  const moneyOptimal =
    priced && gated
      ? [...candidates].sort((a, b) => at.get(a)!.delta - at.get(b)!.delta || (a === current ? -1 : b === current ? 1 : safer(a, b)))[0]!
      : null;
  const partial = { tunable, current, direction: DIRECTION[tunable], priced, rows, moneyOptimal, evalSupported: EVAL_SUPPORTED[tunable] ?? null };
  const gain = moneyOptimal === null ? 0 : currentDelta - at.get(moneyOptimal)!.delta;
  const restsOn = moneyOptimal === null ? 0 : Math.abs(at.get(moneyOptimal)!.decisions - at.get(current)!.decisions);
  return { ...partial, verdict: verdictFor(partial, gain, restsOn) };
}

// A retried record is one failure however it ended: the rewritten request was rejected, then the original ran.
// Retries are grouped by the target Jev picked, because that is what got rejected, not the model that answered.
// The proxy strips effort for models that reject it, so the pick is normalised the same way as a routed record.
export function reliability(records: LogRecord[]): Report["reliability"] {
  const supportsEffort = (alias: string | undefined): boolean => (MODELS as Record<string, { supportsEffort: boolean }>)[alias ?? ""]?.supportsEffort ?? true;
  const target = (r: LogRecord): string => {
    if (!r.upstream?.retried_with_original) return `${r.routed?.alias ?? r.routed?.model ?? "?"}/${r.routed?.effort ?? "default"}`;
    const pick = r.jev?.model?.choice;
    return `${pick ?? "?"}/${(supportsEffort(pick) && r.jev?.effort?.choice) || "default"}`;
  };
  const failed = (r: LogRecord): boolean => Boolean(r.upstream?.retried_with_original) || (num(r.upstream?.status) ?? 0) >= 400;
  const groups = new Map<string, LogRecord[]>();
  for (const r of records) groups.set(target(r), [...(groups.get(target(r)) ?? []), r]);
  const rows = [...groups]
    .map(([t, rs]) => {
      const status = (lo: number, hi: number) => rs.filter((r) => !r.upstream?.retried_with_original && (num(r.upstream?.status) ?? 0) >= lo && (num(r.upstream?.status) ?? 0) < hi).length;
      const failures = rs.filter(failed).length;
      const codes = new Map<number, number>();
      for (const r of rs) if ((num(r.upstream?.status) ?? 0) >= 400) codes.set(num(r.upstream?.status)!, (codes.get(num(r.upstream?.status)!) ?? 0) + 1);
      return {
        target: t,
        requests: rs.length,
        "4xx": status(400, 500),
        "5xx": status(500, 600),
        retried: rs.filter((r) => r.upstream?.retried_with_original).length,
        failures,
        failure_rate: failures / rs.length,
        codes: [...codes].map(([c, n]) => `${c}x${n}`).join(" ") || "-",
      };
    })
    .sort((a, b) => b.failure_rate - a.failure_rate || b.requests - a.requests);
  const overall = records.length ? records.filter(failed).length / records.length : 0;
  const standouts = rows
    .filter((r) => r.failures >= STANDOUT_MIN_FAILURES && r.failure_rate >= STANDOUT_RATIO * overall)
    .map((r) => `${r.target}: ${r.failures} of ${r.requests} requests failed (${(r.failure_rate * 100).toFixed(0)}%, overall ${(overall * 100).toFixed(0)}%)`);
  return { rows: rows.map((r) => ({ ...r, failure_rate: `${(r.failure_rate * 100).toFixed(0)}%` })), standouts };
}

function jevStats(records: LogRecord[]): Report["jev"] {
  const ms = records.flatMap((r) => (r.jev ? [num(r.jev.ms) ?? 0] : [])).sort((a, b) => a - b);
  return { calls: ms.length, p50_ms: pct(ms, 0.5), p95_ms: pct(ms, 0.95), cost: "not in the log: decision records carry Jev latency but not its token counts. bun run eval prints the per-call price." };
}

export const CANNOT_SEE =
  "What this cannot see: whether any routed answer was good. Outcome quality is not recorded anywhere and this tool cannot infer it. " +
  "It also cannot add decisions the router never made: the sweep only undoes actions in the log, so the curve is flat below the floor " +
  "the log was collected under, and a skipped turn's re-cache cost is an estimate from context size, not a bill. " +
  "Effort has no price, so its sweep counts decisions and nothing else. Token counts for Jev are not logged.";

export function analyse(records: LogRecord[], log: string, since: string | null): Report {
  const decided = attachDeciding(records);
  const costs = records.map(recordCost);
  return {
    log,
    since,
    records: records.length,
    decisions: records.filter((r) => r.turn === "new").length,
    totals: { actual: sum(costs.map((c) => c.actual)), baseline: sum(costs.map((c) => c.baseline)), delta: sum(costs.map((c) => c.delta)) },
    hardLimit: HARD_LIMIT,
    sweeps: [
      sweep(decided, "MODEL_MIN_CONFIDENCE", CONFIDENCE_GRID),
      sweep(decided, "EFFORT_MIN_CONFIDENCE", CONFIDENCE_GRID),
      sweep(decided, "FOLLOWUP_MIN_NOUL", CONFIDENCE_GRID),
      sweep(decided, "MAIN_MAX_CONTEXT_TOKENS", CONTEXT_GRID),
      sweep(decided, "MAIN_MAX_SWITCH_COST_USD", SWITCH_COST_GRID),
    ],
    reliability: reliability(records),
    jev: jevStats(records),
    cannotSee: CANNOT_SEE,
  };
}

export function render(r: Report): string {
  const head = [
    "jcm-router tune: what the thresholds in src/routing-policy.ts would have cost at other values.",
    "Read-only. It never edits src/ and never changes routing. Read the tables, then change one constant by hand.",
    "",
    `${r.records} requests, ${r.decisions} decisions in ${r.log}${r.since ? ` (last ${r.since})` : ""}.`,
    `As logged: actual ${usd(r.totals.actual)}, baseline ${usd(r.totals.baseline)}, delta ${usd(r.totals.delta)} (negative is a saving).`,
    "Each sweep row is what this log would have cost with that value in force throughout: a decision the value would have",
    "blocked reverts to its baseline, and every continuation of that turn reverts with it.",
    "",
    `LIMIT: ${r.hardLimit}`,
  ];
  const sweeps = r.sweeps.flatMap((s) => [
    "",
    `${s.tunable}  current ${fmtValue(s.tunable, s.current)} (* marks it)${s.evalSupported ? `, eval supports ${fmtValue(s.tunable, s.evalSupported.lo)} to ${fmtValue(s.tunable, s.evalSupported.hi)}` : ", no eval signal"}`,
    table(s.rows),
    `  money-optimal: ${s.moneyOptimal === null ? "n/a" : fmtValue(s.tunable, s.moneyOptimal)}`,
    `  verdict: ${s.verdict}`,
  ]);
  const rel = ["", "Reliability by attempted target (a retried record is one failure, grouped by the pick that was rejected)", table(r.reliability.rows), ...r.reliability.standouts.map((s) => `  stands out: ${s}`)];
  const jev = ["", `Jev: ${r.jev.calls} calls, p50 ${r.jev.p50_ms}ms, p95 ${r.jev.p95_ms}ms. Cost ${r.jev.cost}`];
  return [...head, ...sweeps, ...rel, ...jev, "", r.cannotSee].join("\n");
}

if (import.meta.main) {
  const path = logPath();
  const file = Bun.file(path);
  const sinceIdx = process.argv.indexOf("--since");
  const sinceArg = sinceIdx >= 0 ? process.argv[sinceIdx + 1] : undefined;
  const since = sinceMs(sinceArg);
  const text = (await file.exists()) ? await file.text() : "";
  const records = parseJournal(text).filter((r) => since === 0 || Date.parse(r.at ?? "") >= since);
  const report = analyse(records, path, since ? (sinceArg ?? null) : null);
  console.log(process.argv.includes("--json") ? JSON.stringify(report, null, 2) : render(report));
}
