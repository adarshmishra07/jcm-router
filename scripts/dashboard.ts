// Local dashboard for decisions.jsonl. Separate process from the proxy, no build step:
// one HTML page (scripts/dashboard-view.ts) plus a JSON endpoint, both re-reading the log on every request.
// Usage: bun run dashboard [--port 8788]

import { homedir } from "node:os";
import { join } from "node:path";
import { describeEnv } from "../src/env.ts";
import { HEALTH_PATH, type Health } from "../src/health.ts";
import { avoidedCost, type LogRecord, parseJournal, recordCost } from "./cost.ts";
import { renderPage } from "./dashboard-view.ts";

export const DEFAULT_PORT = 8788;
const HEALTH_TIMEOUT_MS = 500;
const RECENT = 100;
const PREVIEW = 90;
const CONFIDENCE_BUCKETS = [0.5, 0.7, 0.9] as const;

export type Totals = { requests: number; actual: number; baseline: number; delta: number };
export type Avoided = { skips: number; tokens: number; usd: number };
export type Row = Record<string, string | number>;

export type Summary = {
  generated_at: string;
  log: string;
  records: number;
  unpriced: number;
  verdict: { overall: Totals; main: Totals; subagent: Totals };
  // Counterfactual, kept apart from the measured spend in `verdict` on purpose: no request was made.
  avoided: Avoided;
  // The proxy's own answer, or null when it did not give one. Null means "not running", not "passthrough".
  health: Health | null;
  cache: { byModel: Row[]; switches: number; recaches: number; recached_tokens: number };
  rows: Row[];
  jev: {
    count: number;
    p50: number;
    p95: number;
    errors: Row[];
    sources: Row[];
    confidence: Row[];
  };
};

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const kindOf = (r: LogRecord): string => (str(r.kind) === "subagent" ? "subagent" : "main");
const pct = (sorted: number[], p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;

const group = <T>(items: T[], keyOf: (t: T) => string): Map<string, T[]> => {
  const m = new Map<string, T[]>();
  for (const it of items) m.set(keyOf(it), [...(m.get(keyOf(it)) ?? []), it]);
  return m;
};

export const sourceLabel = (r: LogRecord): string => {
  const source = str(r.source, "unknown");
  const reason = str(r.skip_reason);
  return reason ? `${source}: ${reason}` : source;
};

function totals(records: LogRecord[]): Totals {
  return records.reduce<Totals>(
    (acc, r) => {
      const c = recordCost(r);
      return { requests: acc.requests + 1, actual: acc.actual + c.actual, baseline: acc.baseline + c.baseline, delta: acc.delta + c.delta };
    },
    { requests: 0, actual: 0, baseline: 0, delta: 0 },
  );
}

function avoided(records: LogRecord[]): Avoided {
  return records.reduce<Avoided>(
    (acc, r) => {
      const a = avoidedCost(r);
      return a ? { skips: acc.skips + 1, tokens: acc.tokens + a.tokens, usd: acc.usd + a.usd } : acc;
    },
    { skips: 0, tokens: 0, usd: 0 },
  );
}

function cacheHealth(records: LogRecord[]): Summary["cache"] {
  const withUsage = records.filter((r) => r.usage);
  const byModel = [...group(withUsage, (r) => str(r.routed?.model, "unknown"))].map(([model, rs]) => {
    const sum = (k: keyof NonNullable<LogRecord["usage"]>) => rs.reduce((n, r) => n + num(r.usage?.[k]), 0);
    const read = sum("cache_read_input_tokens");
    const created = sum("cache_creation_input_tokens");
    return {
      model,
      requests: rs.length,
      cache_read: read,
      cache_created: created,
      hit_rate: read + created > 0 ? read / (read + created) : 0,
    };
  });
  const switched = records.filter((r) => recordCost(r).switched);
  // Only a switch that started from a cold cache re-wrote the history; the rest is a tool loop's normal growth.
  const recached = records.filter((r) => recordCost(r).dumped);
  return {
    byModel,
    switches: switched.length,
    recaches: recached.length,
    recached_tokens: recached.reduce((n, r) => n + num(r.usage?.cache_creation_input_tokens), 0),
  };
}

function jevHealth(records: LogRecord[]): Summary["jev"] {
  const ms = records.flatMap((r) => (r.jev ? [num(r.jev.ms)] : [])).sort((a, b) => a - b);
  const errors = [...group(records.filter((r) => r.jev_error || r.source === "fallback"), (r) => str(r.jev_error, "unknown"))].map(([reason, rs]) => ({
    reason,
    requests: rs.length,
    fallbacks: rs.filter((r) => r.source === "fallback").length,
  }));
  const sources = [...group(records, sourceLabel)].map(([source, rs]) => ({ source, requests: rs.length }));
  const confidences = records.flatMap((r) => (typeof r.jev?.model?.confidence === "number" ? [r.jev.model.confidence] : []));
  const edges = [0, ...CONFIDENCE_BUCKETS, 1];
  const confidence = edges.slice(0, -1).map((lo, i) => {
    const hi = edges[i + 1]!;
    const last = i === edges.length - 2;
    return {
      bucket: `${lo.toFixed(2)} to ${hi.toFixed(2)}`,
      requests: confidences.filter((c) => c >= lo && (last ? c <= hi : c < hi)).length,
    };
  });
  return { count: ms.length, p50: pct(ms, 0.5), p95: pct(ms, 0.95), errors, sources, confidence };
}

function recentRows(records: LogRecord[]): Row[] {
  return [...records]
    .sort((a, b) => Date.parse(str(b.at)) - Date.parse(str(a.at)) || 0)
    .slice(0, RECENT)
    .map((r) => {
      const c = recordCost(r);
      const conf = r.jev?.model?.confidence;
      return {
        at: str(r.at).slice(11, 19) || "?",
        kind: kindOf(r),
        turn: str(r.turn, "?"),
        prompt: str(r.prompt_preview).replace(/\s+/g, " ").slice(0, PREVIEW),
        requested: `${str(r.requested?.model, "?")}/${str(r.requested?.effort, "default")}`,
        routed: `${str(r.routed?.alias) || str(r.routed?.model, "?")}/${str(r.routed?.effort, "default")}`,
        source: sourceLabel(r),
        confidence: typeof conf === "number" ? conf.toFixed(2) : "",
        jev_ms: r.jev ? num(r.jev.ms) : "",
        status: num(r.upstream?.status) || "",
        delta: c.priced ? c.delta : "",
      };
    });
}

export function summarize(records: LogRecord[], log = "", health: Health | null = null): Summary {
  const byKind = group(records, kindOf);
  return {
    generated_at: new Date().toISOString(),
    log,
    health,
    records: records.length,
    unpriced: records.filter((r) => !recordCost(r).priced).length,
    verdict: {
      overall: totals(records),
      main: totals(byKind.get("main") ?? []),
      subagent: totals(byKind.get("subagent") ?? []),
    },
    avoided: avoided(records),
    cache: cacheHealth(records),
    rows: recentRows(records),
    jev: jevHealth(records),
  };
}

export const logPath = (): string => join(process.env.ROUTER_STATE_DIR || join(homedir(), ".claude-router"), "decisions.jsonl");

// The dashboard is a separate process from the proxy, so /healthz is the only way it can tell whether routing
// is still on. No answer at all means the proxy is not running, which is not the same thing as passthrough.
export async function fetchHealth(port: number | null): Promise<Health | null> {
  if (port === null) return null;
  try {
    const res = await fetch(`http://localhost:${port}${HEALTH_PATH}`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    return res.ok ? ((await res.json()) as Health) : null;
  } catch {
    return null;
  }
}

export async function readSummary(path: string, proxyPort: number | null = null): Promise<Summary> {
  const file = Bun.file(path);
  const text = (await file.exists()) ? await file.text() : "";
  return summarize(parseJournal(text), path, await fetchHealth(proxyPort));
}

export const handler = (path: string, proxyPort: number | null = null) => async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  if (url.pathname === "/api.json") {
    return Response.json(await readSummary(path, proxyPort), { headers: { "cache-control": "no-store" } });
  }
  if (url.pathname === "/") {
    const summary = await readSummary(path, proxyPort);
    // ?share=1 blanks the prompt previews so a screenshot can be posted publicly.
    const shown = url.searchParams.get("share") === "1"
      ? { ...summary, rows: summary.rows?.map((r) => ({ ...r, prompt: "" })) }
      : summary;
    return new Response(renderPage(shown), { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  return new Response("not found", { status: 404 });
};

if (import.meta.main) {
  const flag = process.argv.indexOf("--port");
  const port = flag >= 0 ? Number(process.argv[flag + 1]) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`dashboard: --port must be an integer between 1 and 65535`);
    process.exit(1);
  }
  const path = logPath();
  const server = Bun.serve({ port, fetch: handler(path, describeEnv(process.env).port) });
  console.log(`dashboard on http://localhost:${server.port} reading ${path}`);
}
