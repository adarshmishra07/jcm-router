// Local dashboard for decisions.jsonl. Separate process from the proxy, no build step:
// one HTML page plus a JSON endpoint that re-reads the log on every request.
// Usage: bun run dashboard [--port 8788]

import { homedir } from "node:os";
import { join } from "node:path";
import { type LogRecord, parseJournal, recordCost } from "./cost.ts";

export const DEFAULT_PORT = 8788;
const RECENT = 100;
const PREVIEW = 90;
const CONFIDENCE_BUCKETS = [0.5, 0.7, 0.9] as const;

export type Totals = { requests: number; actual: number; baseline: number; delta: number };
export type Row = Record<string, string | number>;

export type Summary = {
  generated_at: string;
  log: string;
  records: number;
  unpriced: number;
  verdict: { overall: Totals; main: Totals; subagent: Totals };
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
  const recached = switched.filter((r) => num(r.usage?.cache_creation_input_tokens) > 0);
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

export function summarize(records: LogRecord[], log = ""): Summary {
  const byKind = group(records, kindOf);
  return {
    generated_at: new Date().toISOString(),
    log,
    records: records.length,
    unpriced: records.filter((r) => !recordCost(r).priced).length,
    verdict: {
      overall: totals(records),
      main: totals(byKind.get("main") ?? []),
      subagent: totals(byKind.get("subagent") ?? []),
    },
    cache: cacheHealth(records),
    rows: recentRows(records),
    jev: jevHealth(records),
  };
}

export const logPath = (): string => join(process.env.ROUTER_STATE_DIR || join(homedir(), ".claude-router"), "decisions.jsonl");

export async function readSummary(path: string): Promise<Summary> {
  const file = Bun.file(path);
  const text = (await file.exists()) ? await file.text() : "";
  return summarize(parseJournal(text), path);
}

export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>claude-router dashboard</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #fbfbfa; --fg: #1a1a18; --muted: #6b6b66; --line: #e2e2dd; --card: #fff;
    --good: #0f7a4a; --goodbg: #e7f6ee; --bad: #a92c2c; --badbg: #fbeaea;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #16161a; --fg: #ecece8; --muted: #9a9a94; --line: #2c2c33; --card: #1d1d22;
      --good: #6fd39b; --goodbg: #173026; --bad: #f08a8a; --badbg: #331c1c;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; background: var(--bg); color: var(--fg);
    font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  h1 { font-size: 16px; margin: 0 0 4px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 28px 0 8px; }
  .meta { color: var(--muted); margin-bottom: 20px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 16px; }
  .verdict { font-size: 20px; line-height: 1.4; }
  .verdict .lede { font-size: 24px; font-weight: 600; }
  .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); margin-top: 12px; }
  .stat { border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px; }
  .stat b { display: block; font-size: 18px; }
  .stat span { color: var(--muted); font-size: 12px; }
  table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  th { color: var(--muted); font-weight: 500; position: sticky; top: 0; background: var(--bg); }
  td.prompt { white-space: normal; max-width: 420px; color: var(--muted); }
  td.num { text-align: right; }
  tr.over td { background: var(--badbg); }
  tr.under td { background: var(--goodbg); }
  .over-fg { color: var(--bad); }
  .under-fg { color: var(--good); }
  .scroll { overflow: auto; max-height: 70vh; border: 1px solid var(--line); border-radius: 8px; }
  .cols { display: grid; gap: 20px; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }
</style>
</head>
<body>
<h1>claude-router</h1>
<div class="meta" id="meta">loading…</div>
<div class="card verdict" id="verdict"></div>
<h2>Cache health</h2>
<div id="cache"></div>
<h2>Decisions (most recent 100)</h2>
<div class="scroll"><table id="decisions"></table></div>
<h2>Jev health</h2>
<div class="cols" id="jev"></div>
<script>
const money = (n) => (n < 0 ? "-$" : "$") + Math.abs(n).toFixed(4);
const el = (html) => { const d = document.createElement("div"); d.innerHTML = html; return d; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const int = (n) => Number(n).toLocaleString();

function table(rows, opts = {}) {
  if (!rows.length) return '<p class="meta">(none)</p>';
  const cols = Object.keys(rows[0]);
  const head = cols.map((c) => "<th>" + esc(c) + "</th>").join("");
  const body = rows
    .map((r) => {
      const cls = opts.rowClass ? opts.rowClass(r) : "";
      const cells = cols.map((c) => {
        const v = r[c];
        const isNum = typeof v === "number";
        const text = opts.format ? opts.format(c, v) : isNum ? int(v) : esc(v);
        return '<td class="' + (isNum ? "num" : c) + '">' + text + "</td>";
      });
      return '<tr class="' + cls + '">' + cells.join("") + "</tr>";
    })
    .join("");
  return "<thead><tr>" + head + "</tr></thead><tbody>" + body + "</tbody>";
}

function verdictLine(name, t) {
  if (!t.requests) return "<div>" + name + ": no requests yet.</div>";
  const saving = t.delta <= 0;
  const cls = saving ? "under-fg" : "over-fg";
  const word = saving ? "saved" : "cost you an extra";
  return (
    "<div>" + name + ": spent <b>" + money(t.actual) + "</b> against a no-router baseline of <b>" + money(t.baseline) +
    '</b>, so the router <span class="' + cls + '">' + word + " " + money(Math.abs(t.delta)) + "</span> over " + int(t.requests) + " requests.</div>"
  );
}

function render(s) {
  document.getElementById("meta").textContent =
    int(s.records) + " requests in " + s.log + (s.unpriced ? " (" + int(s.unpriced) + " without usage or a known price)" : "") +
    " · updated " + new Date(s.generated_at).toLocaleTimeString();

  const v = s.verdict;
  const saving = v.overall.delta <= 0;
  document.getElementById("verdict").innerHTML =
    '<div class="lede ' + (saving ? "under-fg" : "over-fg") + '">' +
    (v.overall.requests === 0
      ? "No priced requests yet."
      : saving
        ? "The router is saving money: " + money(-v.overall.delta) + " so far."
        : "The router is costing money: " + money(v.overall.delta) + " more than not routing at all.") +
    "</div>" +
    verdictLine("Overall", v.overall) + verdictLine("Main chat", v.main) + verdictLine("Subagents", v.subagent) +
    '<div class="grid">' +
    ['<div class="stat"><b>' + money(v.overall.actual) + "</b><span>actual spend</span></div>",
     '<div class="stat"><b>' + money(v.overall.baseline) + "</b><span>baseline (no router)</span></div>",
     '<div class="stat"><b class="' + (saving ? "under-fg" : "over-fg") + '">' + money(v.overall.delta) + "</b><span>delta</span></div>",
     '<div class="stat"><b>' + int(s.cache.recaches) + "</b><span>switches that re-cached " + int(s.cache.recached_tokens) + " tokens</span></div>"].join("") +
    "</div>";

  document.getElementById("cache").innerHTML =
    '<div class="scroll"><table>' +
    table(s.cache.byModel.map((m) => ({ ...m, hit_rate: (m.hit_rate * 100).toFixed(1) + "%" }))) +
    "</table></div>" +
    '<p class="meta">' + int(s.cache.switches) + " requests went to a different model than Claude Code asked for; " +
    int(s.cache.recaches) + " of those had to re-write the prompt cache.</p>";

  document.getElementById("decisions").innerHTML = table(s.rows, {
    rowClass: (r) => (typeof r.delta !== "number" ? "" : r.delta > 0 ? "over" : r.delta < 0 ? "under" : ""),
    format: (c, v) => (c === "delta" && typeof v === "number" ? money(v) : typeof v === "number" ? int(v) : esc(v)),
  });

  document.getElementById("jev").innerHTML =
    '<div><h2>Latency</h2><p>' + int(s.jev.count) + " calls · p50 " + int(s.jev.p50) + "ms · p95 " + int(s.jev.p95) + "ms</p>" +
    "<h2>Model confidence</h2><table>" + table(s.jev.confidence) + "</table></div>" +
    "<div><h2>Decision sources</h2><table>" + table(s.jev.sources) + "</table>" +
    "<h2>Errors and fallbacks</h2><table>" + table(s.jev.errors) + "</table></div>";
}

async function tick() {
  try {
    const res = await fetch("/api.json", { cache: "no-store" });
    render(await res.json());
  } catch (err) {
    document.getElementById("meta").textContent = "dashboard unreachable: " + err;
  }
}
tick();
setInterval(tick, 5000);
</script>
</body>
</html>
`;

if (import.meta.main) {
  const flag = process.argv.indexOf("--port");
  const port = flag >= 0 ? Number(process.argv[flag + 1]) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`dashboard: --port must be an integer between 1 and 65535`);
    process.exit(1);
  }
  const path = logPath();
  const server = Bun.serve({
    port,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api.json") {
        return Response.json(await readSummary(path), { headers: { "cache-control": "no-store" } });
      }
      if (url.pathname === "/") return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
      return new Response("not found", { status: 404 });
    },
  });
  console.log(`dashboard on http://localhost:${server.port} reading ${path}`);
}
