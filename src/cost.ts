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

// Rough token count of a request body. Used for every size check in the router.
export const estimateContextTokens = (bodyChars: number): number => Math.ceil(bodyChars / 4);

const usd = (tokens: number, pricePerMtok: number): number => (tokens * pricePerMtok) / MTOK;

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
