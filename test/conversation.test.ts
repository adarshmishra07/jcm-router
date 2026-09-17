import { describe, expect, test } from "bun:test";
import { classifyRequest, requestKind } from "../src/conversation.ts";

const reminder = { type: "text", text: "<system-reminder>\nstuff\n</system-reminder>" };
const text = (t: string, extra: Record<string, unknown> = {}) => ({ type: "text", text: t, ...extra });
const toolUse = { role: "assistant", content: [{ type: "thinking", thinking: "..." }, { type: "tool_use", id: "t1", name: "Bash", input: {} }] };
const toolResult = (content = "ok") => ({ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content }, reminder] });
const tools = [{ name: "Bash" }];

const body = (messages: unknown[], extra: Record<string, unknown> = {}) => ({ model: "claude-sonnet-5", tools, messages, ...extra });
const keyOf = (messages: unknown[]) => {
  const t = classifyRequest(body(messages));
  if (t.kind === "passthrough") throw new Error(`passthrough: ${t.reason}`);
  return t.key;
};

describe("classifyRequest", () => {
  test("first user turn with system reminders is a new turn; prompt is the real text, previous is null", () => {
    const turn = classifyRequest(body([{ role: "user", content: [reminder, text("fix the bug"), reminder] }, { role: "system", content: "mid" }]));
    expect(turn).toMatchObject({ kind: "new", prompt: "fix the bug", previousReply: null, previousKey: null });
  });

  test("string content counts as prompt text and multiple text blocks are joined", () => {
    expect(classifyRequest(body([{ role: "user", content: "hello" }]))).toMatchObject({ kind: "new", prompt: "hello" });
    expect(classifyRequest(body([{ role: "user", content: [text("a"), reminder, text("b")] }]))).toMatchObject({ kind: "new", prompt: "a\nb" });
  });

  test("tool-loop continuation keys to the routed turn", () => {
    const first = { role: "user", content: [text("run ls")] };
    const loop = classifyRequest(body([first, toolUse, toolResult()]));
    expect(loop.kind).toBe("continuation");
    expect(keyOf([first])).toBe(keyOf([first, toolUse, toolResult()]));
    expect(keyOf([first])).toBe(keyOf([first, toolUse, toolResult(), toolUse, toolResult("more")]));
  });

  test("key survives moved cache_control markers and cleared tool results", () => {
    const a = [{ role: "user", content: [text("run ls", { cache_control: { type: "ephemeral" } })] }, toolUse, toolResult("long output")];
    const b = [{ role: "user", content: [text("run ls")] }, toolUse, toolResult("[cleared]"), toolUse, toolResult("x", )];
    expect(keyOf(a)).toBe(keyOf(b));
  });

  test("key depends on the prompt and on the preceding assistant text", () => {
    const plan = { role: "assistant", content: [text("Here is a plan")] };
    const k1 = keyOf([{ role: "user", content: "plan it" }, plan, { role: "user", content: "yes do it" }]);
    const k2 = keyOf([{ role: "user", content: "plan it" }, { role: "assistant", content: [text("Other plan")] }, { role: "user", content: "yes do it" }]);
    const k3 = keyOf([{ role: "user", content: "plan it" }, plan, { role: "user", content: "no, redo it" }]);
    expect(new Set([k1, k2, k3]).size).toBe(3);
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a fork (parent history plus a new prompt) gets its own key and the parent's continuation is unaffected", () => {
    const parent = [{ role: "user", content: "big task" }, toolUse, toolResult()];
    const fork = [...parent, toolUse, { role: "user", content: [reminder, text("subtask: count files")] }];
    const parentKey = keyOf(parent);
    const forkTurn = classifyRequest(body(fork));
    expect(forkTurn).toMatchObject({ kind: "new", prompt: "subtask: count files", previousKey: parentKey });
    expect(forkTurn.kind === "new" && forkTurn.key !== parentKey).toBe(true);
    expect(keyOf([...parent, toolUse, toolResult()])).toBe(parentKey);
    expect(keyOf([...fork, toolUse, toolResult()])).toBe(forkTurn.kind === "new" ? forkTurn.key : "");
  });

  test("previous assistant text is truncated and thinking blocks are ignored; previousKey points at the earlier turn", () => {
    const turn = classifyRequest(
      body([
        { role: "user", content: "plan it" },
        { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, text("Step 1"), text("x".repeat(5000))] },
        { role: "user", content: [text("yes do it")] },
      ]),
    );
    expect(turn.kind).toBe("new");
    if (turn.kind !== "new") return;
    expect(turn.previousReply?.startsWith("Step 1\nxxx")).toBe(true);
    expect(turn.previousReply?.length).toBe(2000);
    expect(turn.previousKey).toBe(keyOf([{ role: "user", content: "plan it" }]));
  });

  test("passes through side requests without tools", () => {
    expect(classifyRequest({ model: "x", messages: [{ role: "user", content: "title?" }] })).toMatchObject({ kind: "passthrough" });
    expect(classifyRequest(body([{ role: "user", content: "x" }], { tools: [] }))).toMatchObject({ kind: "passthrough" });
  });

  test("passes through when the last non-system message is not a user turn, has only reminders, or is a tool loop with no routed turn", () => {
    expect(classifyRequest(body([{ role: "user", content: "x" }, { role: "assistant", content: [text("y")] }]))).toMatchObject({ kind: "passthrough" });
    expect(classifyRequest(body([{ role: "user", content: [reminder] }]))).toMatchObject({ kind: "passthrough" });
    expect(classifyRequest(body([{ role: "system", content: "only" }]))).toMatchObject({ kind: "passthrough" });
    expect(classifyRequest(body([toolResult()]))).toMatchObject({ kind: "passthrough" });
  });
});

describe("requestKind", () => {
  const billing = (extra = "") => `x-anthropic-billing-header: cc_version=2.1.274.0a0; cc_entrypoint=sdk-cli;${extra}`;
  test("labels main and subagent from Claude Code's billing line, leaves other clients unlabelled", () => {
    expect(requestKind({ system: [{ type: "text", text: billing() }, { type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." }] })).toBe("main");
    expect(requestKind({ system: `${billing()}\nYou are Claude Code, Anthropic's official CLI for Claude.` })).toBe("main");
    expect(requestKind({ system: [{ type: "text", text: billing(" cc_is_subagent=true;") }] })).toBe("subagent");
    expect(requestKind({ system: "You are an agent for Claude Code, Anthropic's official CLI for Claude. Given the user's message" })).toBe("subagent");
    expect(requestKind({ system: "You are a helpful assistant" })).toBeUndefined();
    expect(requestKind({})).toBeUndefined();
  });
});
