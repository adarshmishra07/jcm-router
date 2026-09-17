// Prices and the one cost question the router asks: is switching model worth a full prompt-cache miss?

import type { ModelAlias } from "./routing-policy.ts";

const MTOK = 1_000_000;

// Cache read is 0.1x the input price. Cache write is 1.25x for the 5-minute TTL and 2x for the 1-hour TTL;
// Claude Code on a Claude subscription uses the 1-hour TTL, so 2x is assumed.
export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_MULTIPLIER = 2;

// USD per million tokens.
const LIST_PRICES: Record<ModelAlias, { input: number; output: number }> = {
  fable: { input: 10, output: 50 },
  opus: { input: 5, output: 25 },
  sonnet: { input: 2, output: 10 },
  haiku: { input: 1, output: 5 },
};

export type Price = { input: number; output: number; cacheRead: number; cacheWrite: number };

export const PRICES: Record<ModelAlias, Price> = Object.fromEntries(
  Object.entries(LIST_PRICES).map(([alias, p]) => [
    alias,
    { ...p, cacheRead: p.input * CACHE_READ_MULTIPLIER, cacheWrite: p.input * CACHE_WRITE_MULTIPLIER },
  ]),
) as Record<ModelAlias, Price>;

// Fallback token count of a request body, used only until the API has reported a real prompt size for the
// conversation (see server.ts). Calibrated against the usage in ~/.claude-router/decisions.jsonl: over the 69
// records whose body the API billed in full, real prompt tokens / (chars / 4) ran 1.07 to 1.52, token-weighted
// 1.43, so a token is about 2.8 chars of Claude Code's JSON, not 4.
// The other 47 records, all from one long session, measured 0.23x instead: once a body carries content the
// server drops before billing (context_management edits, images), its size stops predicting the prompt at all,
// by a factor no divisor can fix. That is why this is a first-turn fallback and not the router's token count.
export const CHARS_PER_TOKEN = 2.8;
export const estimateContextTokens = (bodyChars: number): number => Math.ceil(bodyChars / CHARS_PER_TOKEN);

const usd = (tokens: number, pricePerMtok: number): number => (tokens * pricePerMtok) / MTOK;

// What re-caching this context on the model it already sits on would cost. Used to price a skip that never
// reached Jev: there is no target model, and staying put is the floor under any switch it might have made.
export const recacheOnSameModel = (contextTokens: number, alias: ModelAlias): { stay: number; switch: number } => ({
  stay: usd(contextTokens, PRICES[alias].cacheRead),
  switch: usd(contextTokens, PRICES[alias].cacheWrite),
});

// Caches are scoped to the model. Staying reads the whole history from the cache on the current model; switching
// writes it again on the target. Fresh input and output tokens are excluded: they are small next to the history
// and get paid on whichever model answers. `from === to` prices an effort-only change, which invalidates the
// messages cache just the same. Dollars for this turn only.
export function switchPaysOff(input: { contextTokens: number; from: ModelAlias; to: ModelAlias; maxSwitchCost: number }): {
  worth: boolean;
  stayCost: number;
  switchCost: number;
} {
  const stayCost = usd(input.contextTokens, PRICES[input.from].cacheRead);
  const switchCost = usd(input.contextTokens, PRICES[input.to].cacheWrite);
  return { worth: switchCost - stayCost <= input.maxSwitchCost, stayCost, switchCost };
}
