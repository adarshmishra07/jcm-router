// HTML view for the dashboard. One function, renderPage(data), returns the whole document.
// The body is rendered by `render`, which is also shipped to the browser verbatim
// (Bun strips the types, Function.prototype.toString gives the JS) so the 5 second
// auto-refresh re-renders with exactly the same code the server used. Keep `render`
// self-contained: no imports, no outer-scope references, no TS-only runtime syntax.

export type Totals = { requests?: number; actual?: number; baseline?: number; delta?: number };
export type DashboardData = {
  generated_at?: string;
  log?: string;
  records?: number;
  unpriced?: number;
  verdict?: { overall?: Totals; main?: Totals; subagent?: Totals };
  cache?: {
    byModel?: Array<{ model?: string; requests?: number; cache_read?: number; cache_created?: number; hit_rate?: number }>;
    switches?: number;
    recaches?: number;
    recached_tokens?: number;
  };
  rows?: Array<Record<string, string | number | null | undefined>>;
  // Counterfactual, never netted into the spend above: re-caching that skipped switches avoided.
  avoided?: { skips?: number; tokens?: number; usd?: number };
  jev?: {
    count?: number;
    p50?: number;
    p95?: number;
    errors?: Array<{ reason?: string; requests?: number; fallbacks?: number }>;
    sources?: Array<{ source?: string; requests?: number }>;
    confidence?: Array<{ bucket?: string; requests?: number }>;
  };
  [extra: string]: unknown;
};

export const REFRESH_MS = 5000;

function render(input: unknown): string {
  const d = (input && typeof input === "object" ? input : {}) as DashboardData;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const str = (v: unknown): string => (v == null ? "" : String(v));
  const esc = (v: unknown): string =>
    str(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
  const int = (v: unknown): string => Math.round(num(v)).toLocaleString("en-US");
  const money = (v: unknown, places = 2): string => {
    const n = num(v);
    return (n < 0 ? "-" : "") + "$" + Math.abs(n).toFixed(places);
  };
  const signed = (v: unknown, places = 2): string => (num(v) > 0 ? "+" : "") + money(v, places);
  const tokens = (v: unknown): string => {
    const n = num(v);
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e4) return (n / 1e3).toFixed(0) + "K";
    return int(n);
  };
  const ms = (v: unknown): string => {
    const n = num(v);
    return n >= 1000 ? (n / 1000).toFixed(1) + " s" : Math.round(n) + " ms";
  };
  const pct = (v: unknown): string => Math.round(num(v) * 100) + "%";
  const model = (v: unknown): string => str(v).replace(/^claude-/, "");

  const v = d.verdict ?? {};
  const all = v.overall ?? {};
  const records = num(d.records) || num(all.requests);
  const delta = num(all.delta);
  const saving = delta < 0;
  const flat = Math.abs(delta) < 0.005;

  if (records === 0) {
    return (
      '<section class="hero flat"><p class="lede">No decisions yet.</p>' +
      "<p class=\"sub\">This page reads the router's log and refreshes itself every 5 seconds. Nothing has been routed so far.</p>" +
      '<ol class="steps"><li>Start the proxy: <code>bun run up</code></li>' +
      "<li>Point Claude Code at it: <code>ANTHROPIC_BASE_URL=http://localhost:8787</code></li>" +
      "<li>Send one message. The verdict appears here as soon as the reply lands.</li></ol>" +
      (d.log ? '<p class="sub">Watching <code>' + esc(d.log) + "</code></p>" : "") +
      "</section>"
    );
  }

  const split = (label: string, t: Totals | undefined): string =>
    !t || !num(t.requests)
      ? ""
      : "<tr><th scope=\"row\">" + label + "</th><td>" + int(t.requests) + "</td><td>" + money(t.actual) + '</td><td class="bl">' + money(t.baseline) +
        '</td><td class="' + (num(t.delta) > 0.005 ? "over" : num(t.delta) < -0.005 ? "under" : "") + '">' + signed(t.delta) + "</td></tr>";
  const c = d.cache ?? {};
  const hero =
    '<section class="hero ' + (flat ? "flat" : saving ? "under" : "over") + '" aria-live="polite">' +
    '<p class="lede"><span class="mark" aria-hidden="true">' + (flat ? "=" : saving ? "↓" : "↑") + "</span>" +
    (flat ? "Breaking even" : saving ? "Saving " + money(-delta) : "Costing you " + money(delta)) + "</p>" +
    '<p class="sub">' + int(records) + " requests cost <b>" + money(all.actual) + "</b> through the router. " +
    "Sent unchanged to the model Claude Code asked for, they would have cost <b>" + money(all.baseline) + "</b>." +
    (num(d.unpriced) ? " " + int(d.unpriced) + " requests have no usage yet and are not counted." : "") + "</p>" +
    '<table class="split"><thead><tr><th></th><th>requests</th><th>actual</th><th class="bl">baseline</th><th>delta</th></tr></thead><tbody>' +
    split("Main chat", v.main) + split("Subagents", v.subagent) + "</tbody></table>" +
    (num(c.switches)
      ? '<p class="sub">' + int(c.switches) + " requests were switched to another model; " + int(c.recaches) +
        " of those had to rebuild the prompt cache (" + tokens(c.recached_tokens) + " tokens written again).</p>"
      : "") +
    (num(d.avoided?.skips)
      ? '<p class="sub">' + int(d.avoided?.skips) + " switches were skipped because they would not have paid off, avoiding " +
        tokens(d.avoided?.tokens) + " tokens of re-caching (about " + money(d.avoided?.usd) +
        "). That is a counterfactual and is not part of the figures above.</p>"
      : "") +
    "</section>";

  const models = (c.byModel ?? []).filter((m) => num(m.requests) > 0);
  const cacheSection =
    '<section><h2>Cache hit rate by model</h2><p class="hint">Share of prompt tokens read from cache rather than written. Higher is cheaper.</p>' +
    (models.length
      ? '<table class="meters"><tbody>' +
        models
          .map(
            (m) =>
              '<tr><th scope="row"><code>' + esc(model(m.model)) + "</code><small>" + int(m.requests) + " req</small></th>" +
              '<td><div class="meter" role="img" aria-label="' + pct(m.hit_rate) + ' hit rate"><span style="width:' + Math.round(num(m.hit_rate) * 100) + '%"></span></div></td>' +
              '<td class="n">' + pct(m.hit_rate) + "</td><td class=\"n dim\">" + tokens(m.cache_read) + " read</td></tr>",
          )
          .join("") +
        "</tbody></table>"
      : '<p class="hint">No usage recorded yet.</p>') +
    "</section>";

  const j = d.jev ?? {};
  const buckets = (j.confidence ?? []).map((b) => ({ label: str(b.bucket).replace(" to ", "–"), n: num(b.requests) }));
  const total = buckets.reduce((s, b) => s + b.n, 0);
  const errors = (j.errors ?? []).filter((e) => num(e.requests) > 0);
  const jevSection =
    '<section><h2>Jev confidence</h2><p class="hint">How sure the classifier was on each routing call. Low confidence falls back to the requested model.</p>' +
    (total
      ? '<div class="stack" role="img" aria-label="confidence distribution">' +
        buckets.map((b, i) => (b.n ? '<span class="s' + i + '" style="flex:' + b.n + '"></span>' : "")).join("") +
        '</div><ul class="legend">' +
        buckets.map((b, i) => '<li><i class="s' + i + '"></i>' + esc(b.label) + " <b>" + int(b.n) + "</b></li>").join("") +
        "</ul>"
      : '<p class="hint">No Jev calls yet.</p>') +
    '<dl class="facts"><div><dt>calls</dt><dd>' + int(j.count) + "</dd></div><div><dt>p50</dt><dd>" + ms(j.p50) + "</dd></div><div><dt>p95</dt><dd>" + ms(j.p95) + "</dd></div>" +
    (errors.length
      ? "<div><dt>fallbacks</dt><dd>" + int(errors.reduce((s, e) => s + num(e.fallbacks), 0)) + "</dd></div>"
      : "") +
    "</dl>" +
    (errors.length
      ? '<ul class="errs">' + errors.map((e) => "<li>" + int(e.requests) + " <span>" + esc(e.reason) + "</span></li>").join("") + "</ul>"
      : "") +
    "</section>";

  const rows = d.rows ?? [];
  const cell = (r: Record<string, unknown>) => {
    const dv = r.delta;
    const priced = typeof dv === "number" && Number.isFinite(dv);
    const cls = !priced ? "" : dv > 0.0005 ? "over" : dv < -0.0005 ? "under" : "";
    const src = str(r.source);
    const srcCls = src === "jev" || src === "cached" || src === "followup" ? "" : " warn";
    return (
      "<tr" + (cls ? ' class="' + cls + '"' : "") + "><td>" + esc(r.at) + "</td><td>" + esc(r.kind === "subagent" ? "sub" : r.kind) +
      '</td><td class="turn">' + esc(r.turn === "continuation" ? "cont." : r.turn) + '</td><td class="prompt"><span>' + esc(r.prompt) + "</span>" +
      '</td><td class="route"><code>' + esc(model(str(r.requested))) + '</code> <span aria-hidden="true">→</span> <code>' + esc(r.routed) +
      '</code></td><td class="src' + srcCls + '">' + esc(src) + '</td><td class="n conf">' + esc(r.confidence) + '</td><td class="n jev">' +
      (r.jev_ms === "" || r.jev_ms == null ? "" : ms(r.jev_ms)) + '</td><td class="n st">' + esc(r.status) +
      '</td><td class="n delta">' + (priced ? (Math.abs(dv) < 0.0005 ? "0" : signed(dv, 3)) : "") + "</td></tr>"
    );
  };
  const decisions =
    '<section class="wide"><h2>Decisions</h2><p class="hint">Most recent ' + int(rows.length) +
    ". Delta is what the routed call cost minus what the requested model would have cost. Rows that cost more are tinted.</p>" +
    (rows.length
      ? '<div class="scroll"><table class="log"><thead><tr><th>time</th><th>kind</th><th class="turn">turn</th><th class="prompt">prompt</th>' +
        '<th>requested → routed</th><th class="src">source</th><th class="n conf">conf</th><th class="n jev">jev</th><th class="n st">status</th><th class="n">delta</th></tr></thead><tbody>' +
        rows.map(cell).join("") +
        "</tbody></table></div>"
      : '<p class="hint">Nothing routed yet.</p>') +
    "</section>";

  return hero + '<div class="cols">' + cacheSection + jevSection + "</div>" + decisions;
}

const CSS = `
:root{color-scheme:light;--bg:#f3f4f6;--panel:#fff;--ink:#171a1f;--mute:#5b6472;--line:#d6dae1;--soft:#e9ebef;
--good:#0d7a5f;--goodbg:#e2f3ec;--bad:#b23a1e;--badbg:#fbe8e2;--focus:#2a78d6;
--track:#cde2fb;--fill:#2a78d6;--c0:#86b6ef;--c1:#5598e7;--c2:#2a78d6;--c3:#184f95}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]){color-scheme:dark;--bg:#111418;--panel:#181c22;--ink:#e6e9ed;--mute:#98a1ad;--line:#2a3039;--soft:#1f242c;
--good:#4ccf9f;--goodbg:#14302a;--bad:#f28a68;--badbg:#3a1f18;--focus:#5598e7;
--track:#0d366b;--fill:#5598e7;--c0:#184f95;--c1:#2a78d6;--c2:#5598e7;--c3:#86b6ef}}
:root[data-theme=dark]{color-scheme:dark;--bg:#111418;--panel:#181c22;--ink:#e6e9ed;--mute:#98a1ad;--line:#2a3039;--soft:#1f242c;
--good:#4ccf9f;--goodbg:#14302a;--bad:#f28a68;--badbg:#3a1f18;--focus:#5598e7;
--track:#0d366b;--fill:#5598e7;--c0:#184f95;--c1:#2a78d6;--c2:#5598e7;--c3:#86b6ef}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,"Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
code{font:.92em ui-monospace,"SF Mono",Menlo,Consolas,monospace;overflow-wrap:anywhere}
main{max-width:1200px;margin:0 auto;padding:0 16px 48px}
header{display:flex;justify-content:space-between;align-items:baseline;gap:16px;padding:20px 0 12px}
header h1{font-size:15px;font-weight:600;margin:0;letter-spacing:.01em}
#status{color:var(--mute);font-size:13px}
#status.lost{color:var(--bad)}
h2{font-size:15px;font-weight:600;margin:0 0 2px}
.hint{color:var(--mute);font-size:13px;margin:0 0 14px;max-width:60ch}
.hero{margin:8px 0 28px;padding:24px 24px 8px;border-left:6px solid var(--mute);background:var(--panel);border-radius:0 4px 4px 0}
.hero.under{border-color:var(--good);background:var(--goodbg)}
.hero.over{border-color:var(--bad);background:var(--badbg)}
.hero.flat{border-color:var(--mute)}
.lede{font-size:clamp(34px,7vw,64px);font-weight:700;letter-spacing:-.025em;line-height:1.05;margin:0 0 10px;font-variant-numeric:lining-nums}
.hero.under .lede{color:var(--good)}.hero.over .lede{color:var(--bad)}
.mark{display:inline-block;width:.85em;font-weight:500}
.sub{font-size:16px;margin:0 0 16px;max-width:70ch}
.sub b{font-weight:600}
.steps{margin:0 0 16px;padding-left:22px;font-size:16px;line-height:1.7}
table{border-collapse:collapse}
th{font-weight:500;color:var(--mute);text-align:left}
.split{margin:0 0 16px;font-variant-numeric:tabular-nums}
.split th,.split td{padding:4px 22px 4px 0;border-bottom:1px solid var(--line);font-size:14px}
.split thead th{font-size:12px}
.split tbody th{color:var(--ink)}
.split td{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:13px}
.split td.over{color:var(--bad);font-weight:600}.split td.under{color:var(--good);font-weight:600}
.cols{display:grid;gap:28px 40px;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));margin-bottom:32px}
.meters{width:100%;font-variant-numeric:tabular-nums}
.meters th{width:1%;padding:5px 12px 5px 0;white-space:nowrap;color:var(--ink);font-weight:400}
.meters th small{display:block;color:var(--mute);font-size:11px}
.meters td{padding:5px 0 5px 8px;font-size:13px}
.meters td.n{width:1%;padding-left:14px}
.meter{height:12px;background:var(--track);border-radius:2px;overflow:hidden}
.meter span{display:block;height:100%;background:var(--fill);border-radius:0 2px 2px 0}
.n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.dim{color:var(--mute);width:1%}
.stack{display:flex;gap:2px;height:16px;border-radius:2px;overflow:hidden;margin:4px 0 8px}
.stack span{display:block;min-width:2px}
.s0{background:var(--c0)}.s1{background:var(--c1)}.s2{background:var(--c2)}.s3{background:var(--c3)}
.legend{list-style:none;margin:0 0 14px;padding:0;display:flex;flex-wrap:wrap;gap:6px 18px;font-size:13px;color:var(--mute)}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
.legend b{color:var(--ink);font-weight:600}
.facts{display:flex;flex-wrap:wrap;gap:8px 28px;margin:0 0 10px}
.facts div{display:flex;flex-direction:column}
.facts dt{font-size:12px;color:var(--mute)}
.facts dd{margin:0;font-weight:600;font-size:16px;font-variant-numeric:tabular-nums}
.errs{margin:0;padding:0;list-style:none;font-size:13px;color:var(--mute)}
.errs li{padding:3px 0;border-top:1px solid var(--line)}
.errs span{margin-left:8px;overflow-wrap:anywhere}
.scroll{overflow:auto;max-height:72vh;border:1px solid var(--line);border-radius:4px;background:var(--panel)}
.log{width:100%;font-size:12.5px;font-variant-numeric:tabular-nums}
.log th,.log td{padding:5px 8px;border-bottom:1px solid var(--line);white-space:nowrap;vertical-align:top;text-align:left}
.log thead th{position:sticky;top:0;background:var(--panel);font-size:12px;z-index:1}
.log td:first-child,.log td.delta{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
.log td.prompt{white-space:normal;color:var(--mute);min-width:160px;max-width:380px}
.log td.prompt span{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.log td.route span{color:var(--mute)}
.log td.src{color:var(--mute)}.log td.src.warn{color:var(--ink)}
.log tr.over td{background:var(--badbg)}.log tr.over td.delta{color:var(--bad);font-weight:700}
.log tr.under td.delta{color:var(--good)}
.log tr:not(.over):not(.under) td.delta{color:var(--mute)}
.log tr:hover td{filter:brightness(.97)}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
@media(max-width:640px){main{padding-bottom:32px}.hero{padding:18px 16px 4px;margin-bottom:22px}
.turn,.conf,.jev,.st,.prompt,.src,.bl{display:none}.log td.route{white-space:normal}.log td.route code{display:inline-block}.split th,.split td{padding-right:12px}
.hint{margin-bottom:10px}}
@media(prefers-reduced-motion:no-preference){.meter span{transition:width .4s ease}}
`;

const SCRIPT = `
const render = ${render.toString()};
const main = document.getElementById("main"), status = document.getElementById("status");
let lost = false;
async function refresh(){
  try {
    const res = await fetch("/api.json" + location.search, { cache: "no-store" });
    if (!res.ok) throw new Error(res.status);
    const d = await res.json();
    const scroller = main.querySelector(".scroll"), top = scroller ? scroller.scrollTop : 0, y = window.scrollY;
    main.innerHTML = render(d);
    const next = main.querySelector(".scroll"); if (next) next.scrollTop = top; window.scrollTo(0, y);
    const t = Date.parse(d.generated_at); status.textContent = "updated " + (Number.isNaN(t) ? "" : new Date(t).toLocaleTimeString("en-US", { hour12: false }));
    status.className = ""; lost = false;
  } catch (e) { status.textContent = "cannot reach the dashboard, retrying"; status.className = "lost"; lost = true; }
  setTimeout(refresh, document.hidden ? ${REFRESH_MS * 4} : ${REFRESH_MS});
}
setTimeout(refresh, ${REFRESH_MS});
`;

export function renderPage(data: DashboardData): string {
  const d = data && typeof data === "object" ? data : {};
  const t = Date.parse(String(d.generated_at ?? ""));
  const when = Number.isNaN(t) ? "" : "updated " + new Date(t).toLocaleTimeString("en-US", { hour12: false });
  return (
    "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n" +
    "<title>jcm-router</title>\n<style>" + CSS + "</style>\n</head>\n<body>\n<main><header><h1>jcm-router</h1><span id=\"status\">" + when +
    '</span></header><div id="main">' + render(d) + "</div></main>\n<script>" + SCRIPT + "</script>\n</body>\n</html>\n"
  );
}
