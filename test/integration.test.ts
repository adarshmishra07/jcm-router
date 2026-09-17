// Starts the proxy against a fake Anthropic upstream and a fake Jev. No real network.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DecisionRecord } from "../src/decision-log.ts";
import { startServer } from "../src/server.ts";

type Seen = { path: string; headers: Record<string, string>; body: { model?: string; [k: string]: unknown } | null; text: string };

const upstreamSeen: Seen[] = [];
const jevSeen: unknown[] = [];
let rejectModels: string[] = [];
let jevMode: "ok" | "down" = "ok";
let jevAnswers = { model: "opus", modelConf: 0.9, effort: "high", effortConf: 0.9, followup: 0.0 };

const sseFor = (model: string) =>
  `event: message_start\ndata: {"type":"message_start","message":{"model":"${model}","usage":{"input_tokens":10,"output_tokens":1,"cache_read_input_tokens":500,"cache_creation_input_tokens":0}}}\n\n` +
  `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n` +
  `event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\n`;

const upstream = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const text = req.method === "GET" ? "" : await req.text();
    const body = text ? JSON.parse(text) : null;
    upstreamSeen.push({ path: url.pathname, headers: Object.fromEntries(req.headers), body, text });
    if (url.pathname === "/api/hello") return Response.json({ hello: true });
    if (rejectModels.includes(body?.model)) return Response.json({ error: "bad model" }, { status: 400 });
    // Compressed like the real API, so the proxy has to drop content-encoding/content-length after fetch decompresses.
    const sse = Bun.gzipSync(sseFor(body?.model));
    return new Response(sse, { headers: { "content-type": "text/event-stream", "content-encoding": "gzip", "content-length": String(sse.byteLength) } });
  },
});

const jev = Bun.serve({
  port: 0,
  async fetch(req) {
    jevSeen.push(await req.json());
    if (jevMode === "down") return new Response("nope", { status: 503 });
    const a = jevAnswers;
    return Response.json({
      model: "jev-latest",
      answers: {
        model: { type: "choice", choice: a.model, probabilities: { [a.model]: a.modelConf }, confidence: a.modelConf },
        effort: { type: "choice", choice: a.effort, probabilities: {}, confidence: a.effortConf },
        is_followup: { type: "noul", noul: a.followup },
      },
    });
  },
});

let stateDir: string;
let proxy: ReturnType<typeof startServer>;
let dryProxy: ReturnType<typeof startServer>;
const logs: string[] = [];

beforeAll(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "claude-router-test-"));
  const base = {
    port: 0,
    upstream: `http://localhost:${upstream.port}`,
    jev: { url: `http://localhost:${jev.port}/v1/systemone`, apiKey: "apikey_test", timeoutMs: 1000 },
    logPrompts: true,
    stateDir,
    log: (l: string) => logs.push(l),
  };
  proxy = startServer({ ...base, dryRun: false });
  dryProxy = startServer({ ...base, dryRun: true, stateDir: join(stateDir, "dry") });
});

afterAll(async () => {
  proxy.stop(true);
  dryProxy.stop(true);
  upstream.stop(true);
  jev.stop(true);
  await rm(stateDir, { recursive: true, force: true });
});

beforeEach(() => {
  upstreamSeen.length = 0;
  jevSeen.length = 0;
  logs.length = 0;
  rejectModels = [];
  jevMode = "ok";
  jevAnswers = { model: "opus", modelConf: 0.9, effort: "high", effortConf: 0.9, followup: 0.0 };
});

const reminder = { type: "text", text: "<system-reminder>ctx</system-reminder>" };
const text = (t: string, extra: Record<string, unknown> = {}) => ({ type: "text", text: t, ...extra });
const toolUse = { role: "assistant", content: [{ type: "tool_use", id: "1", name: "Bash", input: {} }] };
const toolResult = (content = "ok") => ({ role: "user", content: [{ type: "tool_result", tool_use_id: "1", content }] });

// Shape of a Claude Code main request. `first` keys the conversation.
const mainBody = (first: string, extraMessages: unknown[] = [], firstExtra: Record<string, unknown> = {}) => ({
  model: "claude-sonnet-5",
  stream: true,
  system: [{ type: "text", text: "x-anthropic-billing-header: cc_version=2.1.274.0a0; cc_entrypoint=cli;" }, { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }],
  thinking: { type: "adaptive", display: "omitted" },
  output_config: { effort: "low" },
  tools: [{ name: "Bash" }],
  messages: [{ role: "user", content: [reminder, text(first, firstExtra), reminder] }, ...extraMessages],
});

const post = async (server: ReturnType<typeof startServer>, body: unknown, path = "/v1/messages") => {
  const res = await fetch(`http://localhost:${server.port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer sk-ant-oat-test", "anthropic-beta": "x" },
    body: JSON.stringify(body),
  });
  return { res, text: await res.text() };
};

const lastJson = async (dir = stateDir) => JSON.parse(await readFile(join(dir, "last.json"), "utf8"));
const journal = async (dir = stateDir): Promise<DecisionRecord[]> => {
  await Bun.sleep(20); // records are appended once the stream has drained
  const text = await readFile(join(dir, "decisions.jsonl"), "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
};

describe("proxy", () => {
  test("routes a new user turn, streams the response, cleans headers, journals the decision with usage", async () => {
    const { res, text: out } = await post(proxy, mainBody("fix the race condition in checkout"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
    const len = res.headers.get("content-length");
    expect(len === null || Number(len) === Buffer.byteLength(out)).toBe(true);
    expect(out).toBe(sseFor("claude-opus-5"));

    const sent = upstreamSeen[0]!;
    expect(sent.body).toMatchObject({ model: "claude-opus-5", output_config: { effort: "high" }, thinking: { type: "adaptive" } });
    expect(sent.headers.authorization).toBe("Bearer sk-ant-oat-test");
    expect(sent.headers["anthropic-beta"]).toBe("x");
    expect(sent.headers["content-length"]).toBe(String(sent.text.length));

    expect(jevSeen).toHaveLength(1);
    expect(jevSeen[0]).toMatchObject({
      model: "jev-latest",
      state: { latest_user_message: "fix the race condition in checkout", previous_assistant_reply: null, previous_routing: null },
    });
    const last = await lastJson();
    expect(last).toMatchObject({ kind: "main", alias: "opus", model: "claude-opus-5", effort: "high", source: "jev" });
    expect(last.conv).toMatch(/^[0-9a-f]{8}$/);

    const [record] = await journal();
    expect(record).toMatchObject({
      conv: last.conv,
      kind: "main",
      turn: "new",
      source: "jev",
      requested: { model: "claude-sonnet-5", effort: "low" },
      routed: { alias: "opus", model: "claude-opus-5", effort: "high" },
      jev: { model: { choice: "opus", confidence: 0.9 }, effort: { choice: "high" }, is_followup: 0 },
      prompt_preview: "fix the race condition in checkout",
      upstream: { status: 200, retried_with_original: false },
      usage: { input_tokens: 10, output_tokens: 42, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 },
    });
    expect(logs.at(-1)).toMatch(/^\d\d:\d\d:\d\d  new   #[0-9a-f]{8} main  opus\/high +jev 0\.90\/0\.90 \d+ms +200 in \d\.\ds  "fix the race/);
  });

  test("tool-loop continuation reuses the cached decision without asking Jev, even with cache_control moved", async () => {
    const first = "run the tests and fix failures";
    await post(proxy, mainBody(first, [], { cache_control: { type: "ephemeral" } }));
    jevAnswers = { ...jevAnswers, model: "haiku" };
    await post(proxy, mainBody(first, [toolUse, toolResult()]));
    await post(proxy, mainBody(first, [toolUse, toolResult("[cleared]"), toolUse, toolResult("more")]));
    expect(jevSeen).toHaveLength(1);
    expect(upstreamSeen[1]!.body).toMatchObject({ model: "claude-opus-5", output_config: { effort: "high" } });
    expect(upstreamSeen[2]!.body).toMatchObject({ model: "claude-opus-5", output_config: { effort: "high" } });
    expect(await lastJson()).toMatchObject({ alias: "opus", source: "cached" });
    const records = await journal();
    expect(records.slice(-2).map((r) => [r.turn, r.source, r.prompt_preview])).toEqual([
      ["continuation", "cached", undefined],
      ["continuation", "cached", undefined],
    ]);
    expect(logs.at(-1)).toContain("cont");
  });

  test("a fork does not disturb the parent's cached decision, and parallel conversations interleave safely", async () => {
    const parent = mainBody("big task");
    await post(proxy, parent);
    jevAnswers = { ...jevAnswers, model: "haiku", effort: "low" };
    const fork = mainBody("big task", [toolUse, toolResult(), toolUse, { role: "user", content: [reminder, text("subtask: count files")] }]);
    await post(proxy, fork);
    jevAnswers = { ...jevAnswers, model: "sonnet", effort: "medium" };
    const other = mainBody("unrelated conversation");
    await post(proxy, other);
    await post(proxy, mainBody("big task", [toolUse, toolResult()]));
    await post(proxy, mainBody("big task", [...fork.messages.slice(1), toolUse, toolResult()]));
    await post(proxy, mainBody("unrelated conversation", [toolUse, toolResult()]));
    expect(jevSeen).toHaveLength(3);
    expect(upstreamSeen.map((s) => s.body?.model)).toEqual([
      "claude-opus-5",
      "claude-haiku-4-5",
      "claude-sonnet-5",
      "claude-opus-5",
      "claude-haiku-4-5",
      "claude-sonnet-5",
    ]);
    const convs = (await journal()).slice(-6).map((r) => r.conv);
    expect(convs[0]).toBe(convs[3]);
    expect(convs[1]).toBe(convs[4]);
    expect(convs[2]).toBe(convs[5]);
    expect(new Set(convs).size).toBe(3);
  });

  test("continuation with no cached decision passes through unchanged", async () => {
    const body = mainBody("unknown conversation", [toolUse, toolResult()]);
    await post(proxy, body);
    expect(jevSeen).toHaveLength(0);
    expect(upstreamSeen[0]!.text).toBe(JSON.stringify(body));
  });

  test("Jev failure forwards the request byte for byte and records the error", async () => {
    jevMode = "down";
    const body = mainBody("anything");
    await post(proxy, body);
    expect(upstreamSeen[0]!.text).toBe(JSON.stringify(body));
    expect(await lastJson()).toMatchObject({ alias: "sonnet", effort: "low", source: "fallback" });
    expect((await journal()).at(-1)).toMatchObject({ source: "fallback", jev: null, jev_error: "http 503" });
    expect(logs.at(-1)).toContain("fallback (jev: http 503)");
  });

  test("haiku is sent without effort or thinking; a 4xx retries with the original and sticks", async () => {
    jevAnswers = { ...jevAnswers, model: "haiku" };
    const first = "count the files";
    await post(proxy, mainBody(first));
    expect(upstreamSeen[0]!.body).toEqual({ ...mainBody(first), model: "claude-haiku-4-5", thinking: undefined, output_config: undefined });

    rejectModels = ["claude-haiku-4-5"];
    const { res } = await post(proxy, mainBody("count the lines"));
    expect(res.status).toBe(200);
    expect(upstreamSeen.map((s) => s.body?.model)).toEqual(["claude-haiku-4-5", "claude-haiku-4-5", "claude-sonnet-5"]);
    expect(upstreamSeen[2]!.text).toBe(JSON.stringify(mainBody("count the lines")));
    expect(await lastJson()).toMatchObject({ alias: "sonnet", model: "claude-sonnet-5", effort: "low", source: "fallback" });
    expect((await journal()).at(-1)).toMatchObject({ source: "fallback", upstream: { status: 200, retried_with_original: true } });
    expect(logs.at(-1)).toContain("RETRIED");

    await post(proxy, mainBody("count the lines", [toolUse, toolResult()]));
    expect(upstreamSeen[3]!.text).toBe(JSON.stringify(mainBody("count the lines", [toolUse, toolResult()])));
  });

  test("manual override skips Jev", async () => {
    await post(proxy, mainBody("!fable !max rewrite the build"));
    expect(jevSeen).toHaveLength(0);
    expect(upstreamSeen[0]!.body).toMatchObject({ model: "claude-fable-5-1", output_config: { effort: "max" } });
    expect(await lastJson()).toMatchObject({ alias: "fable", effort: "max", source: "override" });
  });

  test("a confident follow-up keeps the previous decision", async () => {
    const first = "plan the auth migration";
    await post(proxy, mainBody(first));
    jevAnswers = { model: "haiku", modelConf: 0.95, effort: "low", effortConf: 0.95, followup: 0.9 };
    await post(proxy, mainBody(first, [{ role: "assistant", content: [text("Here is the plan: ...")] }, { role: "user", content: [text("yes do it")] }]));
    expect(jevSeen[1]).toMatchObject({
      state: { latest_user_message: "yes do it", previous_assistant_reply: "Here is the plan: ...", previous_routing: { model: "opus", effort: "high" } },
    });
    expect(upstreamSeen[1]!.body).toMatchObject({ model: "claude-opus-5", output_config: { effort: "high" } });
    expect(await lastJson()).toMatchObject({ source: "followup" });
  });

  test("subagent requests are routed on their own task and labelled", async () => {
    jevAnswers = { ...jevAnswers, model: "haiku" };
    const sub = { ...mainBody("what is 17*23, answer only the number"), system: "You are an agent for Claude Code, Anthropic's official CLI for Claude. Given the user's message..." };
    await post(proxy, sub);
    expect(upstreamSeen[0]!.body?.model).toBe("claude-haiku-4-5");
    expect(await lastJson()).toMatchObject({ kind: "subagent", alias: "haiku" });
  });

  test("requests without tools and other paths pass straight through", async () => {
    const side = { model: "claude-sonnet-5", messages: [{ role: "user", content: "title?" }], output_config: { format: {} } };
    await post(proxy, side);
    const hello = await fetch(`http://localhost:${proxy.port}/api/hello`);
    expect(await hello.json()).toEqual({ hello: true });
    expect(jevSeen).toHaveLength(0);
    expect(upstreamSeen[0]!.text).toBe(JSON.stringify(side));
    expect(upstreamSeen[1]!.path).toBe("/api/hello");
    expect(logs).toHaveLength(0);
  });

  test("dry run logs the decision but forwards unchanged", async () => {
    const body = mainBody("dry run me");
    await post(dryProxy, body);
    expect(jevSeen).toHaveLength(1);
    expect(upstreamSeen[0]!.text).toBe(JSON.stringify(body));
    expect(await lastJson(join(stateDir, "dry"))).toMatchObject({ alias: "opus", source: "jev" });
    expect((await journal(join(stateDir, "dry"))).at(-1)).toMatchObject({ source: "dry_run", routed: { alias: "opus" } });
    expect(logs.at(-1)).toContain("[dry, would be jev]");
  });
});
