// Reads token usage off an Anthropic response without delaying it: the body is teed, Claude Code gets one
// branch untouched, the other is parsed in the background.

export type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};

const EMPTY: Usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function usageFrom(raw: unknown): Partial<Usage> {
  if (typeof raw !== "object" || raw === null) return {};
  const u = raw as Record<string, unknown>;
  const out: Partial<Usage> = {};
  for (const k of Object.keys(EMPTY) as (keyof Usage)[]) if (k in u) out[k] = num(u[k]);
  return out;
}

// Feed chunks in any split; events are only handled once their blank-line terminator has arrived.
export class SseUsageParser {
  private buffer = "";
  private usage: Usage | null = null;

  push(chunk: string): void {
    this.buffer += chunk;
    let end: number;
    while ((end = this.buffer.indexOf("\n\n")) >= 0) {
      this.handleEvent(this.buffer.slice(0, end));
      this.buffer = this.buffer.slice(end + 2);
    }
  }

  result(): Usage | null {
    return this.usage;
  }

  private handleEvent(event: string): void {
    const data = event
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("\n");
    if (!data) return;
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof json !== "object" || json === null) return;
    const e = json as { type?: unknown; message?: { usage?: unknown }; usage?: unknown };
    if (e.type === "message_start") this.usage = { ...EMPTY, ...usageFrom(e.message?.usage) };
    else if (e.type === "message_delta") this.usage = { ...(this.usage ?? EMPTY), ...usageFrom(e.usage) };
  }
}

export function parseJsonUsage(text: string): Usage | null {
  try {
    const json = JSON.parse(text) as { usage?: unknown };
    return json.usage ? { ...EMPTY, ...usageFrom(json.usage) } : null;
  } catch {
    return null;
  }
}

// Returns a response for the client; onDone fires once the body has fully streamed (or failed).
export function teeUsage(res: Response, onDone: (usage: Usage | null) => void): Response {
  if (!res.body) {
    onDone(null);
    return res;
  }
  const [toClient, toParser] = res.body.tee();
  const isSse = (res.headers.get("content-type") ?? "").includes("text/event-stream");
  void (async () => {
    try {
      const decoder = new TextDecoder();
      const parser = new SseUsageParser();
      let text = "";
      for await (const chunk of toParser) {
        const s = decoder.decode(chunk, { stream: true });
        if (isSse) parser.push(s);
        else text += s;
      }
      onDone(isSse ? parser.result() : parseJsonUsage(text));
    } catch {
      onDone(null);
    }
  })();
  return new Response(toClient, { status: res.status, headers: res.headers });
}
