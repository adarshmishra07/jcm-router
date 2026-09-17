// Summarises ~/.claude-router/decisions.jsonl so a human can judge routing quality.
// Usage: bun run report [--since 2h]

import { join } from "node:path";
import type { DecisionRecord } from "../src/decision-log.ts";
import { loadStateDir } from "../src/env.ts";

type Row = Record<string, string | number>;

export type Summary = {
  byTarget: Row[];
  bySource: Row[];
  jev: { count: number; p50: number; p95: number };
  fallbacks: Row[];
  retries: number;
  tokens: Row[];
  recent: Row[];
};

const RECENT = 15;
const PREVIEW = 60;

const pct = (sorted: number[], p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
const ratio = (num: number, den: number): string => (den > 0 ? (num / den).toFixed(2) : "n/a");
const count = <T>(items: T[], keyOf: (t: T) => string): Map<string, T[]> => {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = keyOf(it);
    m.set(k, [...(m.get(k) ?? []), it]);
  }
  return m;
};

export function summarize(records: DecisionRecord[]): Summary {
  const target = (r: DecisionRecord) => `${r.routed.alias ?? r.routed.model}/${r.routed.effort ?? "default"}`;
  const byTarget = [...count(records, target)].map(([k, rs]) => ({
    target: k,
    requests: rs.length,
    new_turns: rs.filter((r) => r.turn === "new").length,
  }));
  const bySource = [...count(records, (r) => r.source)].map(([k, rs]) => ({ source: k, requests: rs.length }));

  const jevMs = records.flatMap((r) => (r.jev ? [r.jev.ms] : [])).sort((a, b) => a - b);
  const jev = { count: jevMs.length, p50: pct(jevMs, 0.5), p95: pct(jevMs, 0.95) };

  const fallbacks = [...count(records.filter((r) => r.source === "fallback"), (r) => r.jev_error ?? (r.upstream.retried_with_original ? "upstream rejected rewrite" : "unknown"))].map(
    ([reason, rs]) => ({ reason, requests: rs.length }),
  );
  const retries = records.filter((r) => r.upstream.retried_with_original).length;

  const tokens = [...count(records.filter((r) => r.usage), (r) => r.routed.model)].map(([model, rs]) => {
    const sum = (k: keyof NonNullable<DecisionRecord["usage"]>) => rs.reduce((n, r) => n + (r.usage?.[k] ?? 0), 0);
    const input = sum("input_tokens");
    const read = sum("cache_read_input_tokens");
    const created = sum("cache_creation_input_tokens");
    return { model, requests: rs.length, input, output: sum("output_tokens"), cache_read: read, cache_created: created, cache_hit: ratio(read, input + read + created) };
  });

  const recent = records
    .filter((r) => r.turn === "new")
    .slice(-RECENT)
    .map((r) => ({
      time: r.at.slice(11, 19),
      prompt: (r.prompt_preview ?? "").replace(/\s+/g, " ").slice(0, PREVIEW),
      routed: target(r),
      source: r.source,
      conf: r.jev ? `${r.jev.model.type === "choice" ? r.jev.model.confidence.toFixed(2) : "?"}/${r.jev.effort.type === "choice" ? r.jev.effort.confidence.toFixed(2) : "?"}` : "",
    }));

  return { byTarget, bySource, jev, fallbacks, retries, tokens, recent };
}

export function table(rows: Row[]): string {
  if (rows.length === 0) return "  (none)";
  const cols = Object.keys(rows[0]!);
  const width = (c: string) => Math.max(c.length, ...rows.map((r) => String(r[c]).length));
  const line = (cells: (string | number)[]) => "  " + cells.map((v, i) => String(v).padEnd(width(cols[i]!))).join("  ");
  return [line(cols), ...rows.map((r) => line(cols.map((c) => r[c] ?? "")))].join("\n");
}

export function render(s: Summary): string {
  return [
    "Requests per routed model/effort",
    table(s.byTarget),
    "\nDecision sources",
    table(s.bySource),
    `\nJev latency: ${s.jev.count} calls, p50 ${s.jev.p50}ms, p95 ${s.jev.p95}ms`,
    `\nFallbacks (retries with the original request: ${s.retries})`,
    table(s.fallbacks),
    "\nTokens per model",
    table(s.tokens),
    `\nLast ${RECENT} new-turn decisions`,
    table(s.recent),
  ].join("\n");
}

// "2h", "30m", "1d"
export function sinceMs(arg: string | undefined): number {
  const m = arg?.match(/^(\d+)([mhd])$/);
  if (!m) return 0;
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"];
  return Date.now() - Number(m[1]) * unit;
}

export function parseJournal(text: string): DecisionRecord[] {
  return text
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as DecisionRecord];
      } catch {
        return [];
      }
    });
}

if (import.meta.main) {
  const path = join(loadStateDir(), "decisions.jsonl");
  const file = Bun.file(path);
  if (!(await file.exists())) {
    console.log(`No decisions yet (${path}).`);
    process.exit(0);
  }
  const sinceIdx = process.argv.indexOf("--since");
  const since = sinceMs(sinceIdx >= 0 ? process.argv[sinceIdx + 1] : undefined);
  const records = parseJournal(await file.text()).filter((r) => Date.parse(r.at) >= since);
  console.log(`${records.length} routed requests in ${path}\n`);
  console.log(render(summarize(records)));
}
