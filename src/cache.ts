// In-memory decision cache keyed by conversation. Evicts the oldest entry past the cap.

import type { Decision } from "./decide.ts";

export const CACHE_MAX_CONVERSATIONS = 200;

export class DecisionCache {
  private readonly map = new Map<string, Decision>();

  constructor(private readonly max = CACHE_MAX_CONVERSATIONS) {}

  get(key: string): Decision | null {
    return this.map.get(key) ?? null;
  }

  set(key: string, decision: Decision): void {
    this.map.delete(key);
    this.map.set(key, decision);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
}
