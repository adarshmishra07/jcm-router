import { describe, expect, test } from "bun:test";
import { SseUsageParser, parseJsonUsage, teeUsage } from "../src/usage.ts";

const stream =
  'event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":12,"output_tokens":1,"cache_read_input_tokens":3000,"cache_creation_input_tokens":40}}}\n\n' +
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n' +
  'event: ping\ndata: {"type":"ping"}\n\n' +
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":57}}\n\n' +
  'event: message_stop\ndata: {"type":"message_stop"}\n\n';

const expected = { input_tokens: 12, output_tokens: 57, cache_read_input_tokens: 3000, cache_creation_input_tokens: 40 };

describe("SseUsageParser", () => {
  test("reads usage from message_start and the final output_tokens from message_delta", () => {
    const p = new SseUsageParser();
    p.push(stream);
    expect(p.result()).toEqual(expected);
  });

  test("handles events split across arbitrary chunk boundaries", () => {
    for (const size of [1, 7, 33, 100]) {
      const p = new SseUsageParser();
      for (let i = 0; i < stream.length; i += size) p.push(stream.slice(i, i + size));
      expect(p.result()).toEqual(expected);
    }
  });

  test("ignores malformed data lines and returns null without a message_start", () => {
    const p = new SseUsageParser();
    p.push("data: not json\n\nevent: ping\ndata: {\"type\":\"ping\"}\n\n");
    expect(p.result()).toBeNull();
  });
});

describe("parseJsonUsage", () => {
  test("reads usage from a non-streamed response, missing fields default to 0", () => {
    expect(parseJsonUsage('{"id":"m","usage":{"input_tokens":5,"output_tokens":6}}')).toEqual({ ...expected, input_tokens: 5, output_tokens: 6, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
    expect(parseJsonUsage("{}")).toBeNull();
    expect(parseJsonUsage("garbage")).toBeNull();
  });
});

describe("teeUsage", () => {
  test("client receives the full body and usage arrives after the stream ends", async () => {
    const chunks = [stream.slice(0, 50), stream.slice(50, 200), stream.slice(200)];
    const body = new ReadableStream({
      start(c) {
        for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
        c.close();
      },
    });
    const res = new Response(body, { headers: { "content-type": "text/event-stream" } });
    let usage: unknown = "pending";
    const out = teeUsage(res, (u) => (usage = u));
    expect(await out.text()).toBe(stream);
    await Bun.sleep(10);
    expect(usage).toEqual(expected);
  });

  test("non-stream JSON responses are parsed too", async () => {
    const res = Response.json({ usage: { input_tokens: 1, output_tokens: 2 } });
    let usage: unknown;
    const out = teeUsage(res, (u) => (usage = u));
    expect(await out.json()).toEqual({ usage: { input_tokens: 1, output_tokens: 2 } });
    await Bun.sleep(10);
    expect(usage).toMatchObject({ input_tokens: 1, output_tokens: 2 });
  });
});
