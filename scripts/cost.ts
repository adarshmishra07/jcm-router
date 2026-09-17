// Pricing and per-request cost maths for the dashboard.
// This table mirrors src/cost.ts. It is duplicated on purpose so the dashboard never
// depends on proxy internals; if one changes, change both.
// USD per million tokens. Cache read costs 0.1x input, cache write 2x input
// (Claude Code uses a 1-hour cache TTL on a subscription).

export const PRICES = {
  fable: { in: 10, out: 50 },
  opus: { in: 5, out: 25 },
  sonnet: { in: 2, out: 10 },
  haiku: { in: 1, out: 5 },
} as const;

export const CACHE_READ = 0.1;
export const CACHE_WRITE = 2;
const PER_MTOK = 1_000_000;

export type Price = { in: number; out: number };

export type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

// Every field is optional: the proxy keeps gaining fields and old lines lack the new ones.
export type LogRecord = {
  at?: string;
  conv?: string;
  kind?: string;
  turn?: string;
  source?: string;
  skip_reason?: string;
  requested?: { model?: string; effort?: string | null };
  routed?: { alias?: string | null; model?: string; effort?: string | null };
  jev?: {
    ms?: number;
    model?: { type?: string; choice?: string; confidence?: number };
    effort?: { type?: string; choice?: string; confidence?: number };
    is_followup?: number;
  } | null;
  jev_error?: string;
  prompt_preview?: string;
  context_tokens?: number;
  upstream?: { status?: number; ms_to_headers?: number; retried_with_original?: boolean };
  usage?: Usage | null;
};

export type RecordCost = {
  actual: number;
  baseline: number;
  delta: number;
  switched: boolean;
  priced: boolean;
};

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function priceFor(model: string | null | undefined): Price | null {
  const id = model ?? "";
  const family = Object.keys(PRICES).find((k) => id.includes(k));
  return family ? PRICES[family as keyof typeof PRICES] : null;
}

export function costOf(usage: Usage | null | undefined, price: Price): number {
  const u = usage ?? {};
  const input = num(u.input_tokens) * price.in;
  const read = num(u.cache_read_input_tokens) * price.in * CACHE_READ;
  const written = num(u.cache_creation_input_tokens) * price.in * CACHE_WRITE;
  const output = num(u.output_tokens) * price.out;
  return (input + read + written + output) / PER_MTOK;
}

// Baseline is the same usage priced at the model Claude Code asked for. When the router
// switched models the prompt cache was dumped, so the tokens it had to re-cache would have
// been a plain cache read without the router.
export function recordCost(r: LogRecord): RecordCost {
  const routedPrice = priceFor(r.routed?.model);
  const requestedPrice = priceFor(r.requested?.model);
  const switched = Boolean(r.routed?.model && r.requested?.model && r.routed.model !== r.requested.model);
  if (!r.usage || !routedPrice || !requestedPrice) {
    return { actual: 0, baseline: 0, delta: 0, switched, priced: false };
  }
  const actual = costOf(r.usage, routedPrice);
  const created = num(r.usage.cache_creation_input_tokens);
  const baselineUsage: Usage = switched
    ? {
        ...r.usage,
        cache_read_input_tokens: num(r.usage.cache_read_input_tokens) + created,
        cache_creation_input_tokens: 0,
      }
    : r.usage;
  const baseline = costOf(baselineUsage, requestedPrice);
  return { actual, baseline, delta: actual - baseline, switched, priced: true };
}

export function parseJournal(text: string): LogRecord[] {
  return text
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        const parsed: unknown = JSON.parse(l);
        return parsed && typeof parsed === "object" ? [parsed as LogRecord] : [];
      } catch {
        return [];
      }
    });
}
