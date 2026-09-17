// Starts the proxy against a fake Anthropic upstream and a fake Jev. No real network.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DecisionRecord } from "../src/decision-log.ts";
import { THRESHOLDS } from "../src/routing-policy.ts";
import { startServer } from "../src/server.ts";

type Seen = { path: string; headers: Record<string, string>; body: { model?: string; [k: string]: unknown } | null; text: string };

const upstreamSeen: Seen[] = [];
const jevSeen: unknown[] = [];
let rejectModels: string[] = [];
let jevMode: "ok" | "down" = "ok";
let jevAnswers = { model: "opus", modelConf: 0.9, effort: "high", effortConf: 0.9, followup: 0.0 };

// The usage the fake API reports. The proxy takes input + cache_read + cache_creation of it as the measured
// context size of this conversation's next turn, so tests can make a small body look like a big prompt.
const DEFAULT_USAGE = { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 };
const OBSERVED = DEFAULT_USAGE.input_tokens + DEFAULT_USAGE.cache_read_input_tokens + DEFAULT_USAGE.cache_creation_input_tokens;
let upstreamUsage = DEFAULT_USAGE;

const sseFor = (model: string) =>
  `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { model, usage: upstreamUsage } })}\n\n` +
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
let subagentsProxy: ReturnType<typeof startServer>;
let upgradesProxy: ReturnType<typeof startServer>;
let noUpgradesProxy: ReturnType<typeof startServer>;
const logs: string[] = [];

beforeAll(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "claude-router-test-"));
  const base = {
    port: 0,
    upstream: `http://localhost:${upstream.port}`,
    jev: { url: `http://localhost:${jev.port}/v1/systemone`, apiKey: "apikey_test", timeoutMs: 1000 },
    logPrompts: true,
    stateDir,
    policy: { scope: "all" as const, mainUpgrades: false, upgrades: "on" as const },
    log: (l: string) => logs.push(l),
  };
  proxy = startServer({ ...base, dryRun: false });
  dryProxy = startServer({ ...base, dryRun: true, stateDir: join(stateDir, "dry") });
  subagentsProxy = startServer({ ...base, dryRun: false, stateDir: join(stateDir, "sub"), policy: { scope: "subagents", mainUpgrades: false, upgrades: "on" } });
  upgradesProxy = startServer({ ...base, dryRun: false, stateDir: join(stateDir, "up"), policy: { scope: "all", mainUpgrades: true, upgrades: "on" } });
  // The default ROUTER_UPGRADES, paired with ROUTER_MAIN_UPGRADES=1 to show the former wins.
  noUpgradesProxy = startServer({ ...base, dryRun: false, stateDir: join(stateDir, "noup"), policy: { scope: "all", mainUpgrades: true, upgrades: "off" } });
});

afterAll(async () => {
  proxy.stop(true);
  dryProxy.stop(true);
  subagentsProxy.stop(true);
  upgradesProxy.stop(true);
  noUpgradesProxy.stop(true);
  upstream.stop(true);
  jev.stop(true);
  await rm(stateDir, { recursive: true, force: true });
});

beforeEach(() => {
  upstreamSeen.length = 0;
  jevSeen.length = 0;
  logs.length = 0;
  rejectModels = [];
  upstreamUsage = DEFAULT_USAGE;
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

// A conversation whose history is past the main-chat context gate. `first` keys the conversation, `prompt` is the new turn.
const LARGE_CHARS = (THRESHOLDS.MAIN_MAX_CONTEXT_TOKENS + 1000) * 4;
const largeBody = (first: string, prompt: string) =>
  mainBody(first, [{ role: "assistant", content: [text("x".repeat(LARGE_CHARS))] }, { role: "user", content: [text(prompt)] }]);
const subagentBody = (prompt: string, extraMessages: unknown[] = []) => ({
  ...mainBody(prompt, extraMessages),
  system: "You are an agent for Claude Code, Anthropic's official CLI for Claude. Given the user's message...",
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
    expect(record!.context_tokens).toBeGreaterThan(100);
    expect(record!.stay_cost).toBeLessThan(record!.switch_cost!);
    expect(logs.at(-1)).toMatch(/^\d\d:\d\d:\d\d  new   #[0-9a-f]{8} main  opus\/high +0K  jev 0\.90\/0\.90 \d+ms stay \$0\.00\d switch \$0\.00\d +200 in \d\.\ds  "fix the race/);
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
    await post(proxy, subagentBody("what is 17*23, answer only the number"));
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

  test("a large main-chat turn is skipped without asking Jev and journaled with the reason", async () => {
    const body = largeBody("long chat", "now what is 2+2");
    await post(proxy, body);
    expect(jevSeen).toHaveLength(0);
    expect(upstreamSeen[0]!.text).toBe(JSON.stringify(body));
    expect(await lastJson()).toMatchObject({ kind: "main", alias: "sonnet", effort: "low", source: "skipped", skipReason: "context_too_large" });
    const record = (await journal()).at(-1)!;
    expect(record).toMatchObject({ turn: "new", source: "skipped", skip_reason: "context_too_large", routed: { alias: "sonnet", effort: "low" }, jev: null });
    expect(record.context_tokens).toBeGreaterThan(THRESHOLDS.MAIN_MAX_CONTEXT_TOKENS);
    expect(record.context_source).toBe("estimated");
    // Jev was never asked, so there is no target model: the counterfactual is a re-cache on the model it stayed
    // on, and it is named so it cannot be read as a switch that happened.
    expect(record.avoided_recache_cost).toBeGreaterThan(record.stay_cost!);
    expect(record.switch_cost).toBeUndefined();
    expect(logs.at(-1)).toMatch(/skipped context_too_large stay \$\d+\.\d{3} recache \$\d+\.\d{3}/);
  });

  test("the first turn of a conversation is estimated, every turn after it is measured", async () => {
    await post(proxy, mainBody("measure me"));
    const first = (await journal()).at(-1)!;
    expect(first).toMatchObject({ turn: "new", context_source: "estimated" });
    expect(first.context_tokens).toBeGreaterThan(100);

    await post(proxy, mainBody("measure me", [toolUse, toolResult()]));
    expect((await journal()).at(-1)).toMatchObject({ turn: "continuation", context_source: "measured", context_tokens: OBSERVED });

    const reply = { role: "assistant", content: [text("done")] };
    await post(proxy, mainBody("measure me", [reply, { role: "user", content: [text("now the next bit")] }]));
    expect((await journal()).at(-1)).toMatchObject({ turn: "new", context_source: "measured", context_tokens: OBSERVED });
  });

  test("once the measured context is large the conversation stays on the model it was routed to", async () => {
    upstreamUsage = { ...DEFAULT_USAGE, cache_read_input_tokens: THRESHOLDS.MAIN_MAX_CONTEXT_TOKENS + 1 };
    await post(proxy, mainBody("pinned chat"));
    expect(upstreamSeen[0]!.body?.model).toBe("claude-opus-5");
    await Bun.sleep(20); // the usage lands once the stream has drained

    // The next body is small. Only the size the API reported says this conversation is past the gate.
    const reply = { role: "assistant", content: [text("plan")] };
    await post(proxy, mainBody("pinned chat", [reply, { role: "user", content: [text("and now a follow-up")] }]));
    expect(jevSeen).toHaveLength(1);
    expect(upstreamSeen[1]!.body).toMatchObject({ model: "claude-opus-5", output_config: { effort: "high" } });
    expect(await lastJson()).toMatchObject({ alias: "opus", effort: "high", source: "skipped", skipReason: "context_too_large" });
    const record = (await journal()).at(-1)!;
    expect(record).toMatchObject({ context_source: "measured", context_tokens: THRESHOLDS.MAIN_MAX_CONTEXT_TOKENS + 11 });
  });

  // The ceiling has to read the same size the rest of the decision path reads. A body of a few hundred chars
  // whose conversation the API measured at 163K is exactly the case the estimate cannot see.
  test("a measured context over the haiku ceiling never reaches haiku, a small measured one still does", async () => {
    jevAnswers = { ...jevAnswers, model: "haiku", effort: "low" };
    const reply = { role: "assistant", content: [text("done")] };
    const nextTurn = (first: string) => subagentBody(first, [reply, { role: "user", content: [text("now the next bit")] }]);

    upstreamUsage = { ...DEFAULT_USAGE, cache_read_input_tokens: 163_000 };
    await post(proxy, subagentBody("big subagent chat"));
    await Bun.sleep(20); // the usage lands once the stream has drained
    await post(proxy, nextTurn("big subagent chat"));
    const big = (await journal()).at(-1)!;
    expect(big).toMatchObject({ turn: "new", context_source: "measured", routed: { alias: "sonnet", model: "claude-sonnet-5" } });
    expect(big.context_tokens).toBeGreaterThan(THRESHOLDS.HAIKU_MAX_TOKENS);
    expect(upstreamSeen.at(-1)!.body?.model).toBe("claude-sonnet-5");

    upstreamUsage = { ...DEFAULT_USAGE, cache_read_input_tokens: 40_000 };
    await post(proxy, subagentBody("small subagent chat"));
    await Bun.sleep(20);
    await post(proxy, nextTurn("small subagent chat"));
    const small = (await journal()).at(-1)!;
    expect(small).toMatchObject({ turn: "new", context_source: "measured", routed: { alias: "haiku", model: "claude-haiku-4-5" } });
    expect(small.context_tokens).toBeLessThan(THRESHOLDS.HAIKU_MAX_TOKENS);
    expect(upstreamSeen.at(-1)!.body?.model).toBe("claude-haiku-4-5");
  });

  test("a tool loop whose measured context outgrows haiku stops sending haiku", async () => {
    jevAnswers = { ...jevAnswers, model: "haiku", effort: "low" };
    upstreamUsage = { ...DEFAULT_USAGE, cache_read_input_tokens: 163_000 };
    await post(proxy, subagentBody("loop that grows"));
    expect(upstreamSeen[0]!.body?.model).toBe("claude-haiku-4-5");
    await Bun.sleep(20);

    await post(proxy, subagentBody("loop that grows", [toolUse, toolResult()]));
    expect(upstreamSeen[1]!.body?.model).toBe("claude-sonnet-5");
    expect((await journal()).at(-1)).toMatchObject({ turn: "continuation", source: "cached", routed: { alias: "sonnet" } });
  });

  test("ROUTER_SCOPE=subagents skips all main traffic and still routes subagents", async () => {
    const body = mainBody("small main turn");
    await post(subagentsProxy, body);
    expect(jevSeen).toHaveLength(0);
    expect(upstreamSeen[0]!.text).toBe(JSON.stringify(body));
    expect((await journal(join(stateDir, "sub"))).at(-1)).toMatchObject({ kind: "main", source: "skipped", skip_reason: "scope" });

    jevAnswers = { ...jevAnswers, model: "haiku" };
    await post(subagentsProxy, subagentBody("what is 17*23"));
    expect(jevSeen).toHaveLength(1);
    expect(upstreamSeen[1]!.body?.model).toBe("claude-haiku-4-5");
  });

  test("ROUTER_MAIN_UPGRADES asks Jev on a large context and allows an upgrade but never a downgrade", async () => {
    await post(upgradesProxy, largeBody("hard chat", "find the race condition"));
    expect(jevSeen).toHaveLength(1);
    expect(upstreamSeen[0]!.body).toMatchObject({ model: "claude-opus-5", output_config: { effort: "high" } });
    const up = (await journal(join(stateDir, "up"))).at(-1)!;
    expect(up).toMatchObject({ source: "jev", routed: { alias: "opus" } });
    expect(up.switch_cost).toBeGreaterThan(THRESHOLDS.MAIN_MAX_SWITCH_COST_USD);

    jevAnswers = { ...jevAnswers, model: "haiku", effort: "low" };
    const body = largeBody("easy chat", "what is 2+2");
    await post(upgradesProxy, body);
    expect(jevSeen).toHaveLength(2);
    expect(upstreamSeen[1]!.text).toBe(JSON.stringify(body));
    const down = (await journal(join(stateDir, "up"))).at(-1)!;
    expect(down).toMatchObject({ source: "skipped", skip_reason: "switch_not_worth_it", routed: { alias: "sonnet", effort: "low" }, jev: { model: { choice: "haiku" } } });
    expect(down.stay_cost).toBeLessThan(down.switch_cost!);
    expect(logs.at(-1)).toMatch(/skipped switch_not_worth_it stay \$\d+\.\d{3} switch \$\d+\.\d{3}/);
  });

  test("ROUTER_UPGRADES=off forwards a blocked upgrade unchanged and journals why; downgrades still route", async () => {
    const body = subagentBody("find the race condition");
    await post(noUpgradesProxy, body);
    expect(jevSeen).toHaveLength(1);
    expect(upstreamSeen[0]!.text).toBe(JSON.stringify(body));
    expect(await lastJson(join(stateDir, "noup"))).toMatchObject({ kind: "subagent", alias: "sonnet", effort: "low", source: "skipped", skipReason: "upgrade_blocked" });
    const record = (await journal(join(stateDir, "noup"))).at(-1)!;
    expect(record).toMatchObject({ kind: "subagent", source: "skipped", skip_reason: "upgrade_blocked", routed: { alias: "sonnet", effort: "low" }, jev: { model: { choice: "opus" } } });
    expect(logs.at(-1)).toContain("skipped upgrade_blocked");

    jevAnswers = { ...jevAnswers, model: "haiku" };
    await post(noUpgradesProxy, subagentBody("what is 17*23"));
    expect(upstreamSeen[1]!.body?.model).toBe("claude-haiku-4-5");
  });

  test("ROUTER_UPGRADES=off beats ROUTER_MAIN_UPGRADES=1: a large main context never reaches Jev", async () => {
    await post(noUpgradesProxy, largeBody("hard chat", "find the race condition"));
    expect(jevSeen).toHaveLength(0);
    expect(upstreamSeen[0]!.body?.model).toBe("claude-sonnet-5");
    expect((await journal(join(stateDir, "noup"))).at(-1)).toMatchObject({ source: "skipped", skip_reason: "context_too_large" });
    // An explicit human instruction still upgrades.
    await post(noUpgradesProxy, mainBody("!opus fix the flaky test"));
    expect(upstreamSeen[1]!.body?.model).toBe("claude-opus-5");
    expect(await lastJson(join(stateDir, "noup"))).toMatchObject({ alias: "opus", source: "override" });
  });

  test("overrides win over every guard, including on a large main context", async () => {
    await post(proxy, largeBody("override chat", "!haiku !low count the files"));
    expect(jevSeen).toHaveLength(0);
    expect(upstreamSeen[0]!.body?.model).toBe("claude-haiku-4-5");
    expect(await lastJson()).toMatchObject({ alias: "haiku", source: "override" });
    await post(subagentsProxy, mainBody("!opus fix the flaky test"));
    expect(upstreamSeen[1]!.body?.model).toBe("claude-opus-5");
  });
});
