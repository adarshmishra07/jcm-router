// In-memory per-conversation state, keyed by turn like the decisions are. Evicts the oldest entry past the cap.

export const CACHE_MAX_CONVERSATIONS = 200;

export class LruCache<T> {
  private readonly map = new Map<string, T>();

  constructor(private readonly max = CACHE_MAX_CONVERSATIONS) {}

  get(key: string): T | null {
    return this.map.get(key) ?? null;
  }

  set(key: string, value: T): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
}
