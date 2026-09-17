// Pure logic over an Anthropic /v1/messages body: is this a new user turn, a tool-loop continuation,
// or something to leave alone? Plus the bits of the conversation Jev needs to see.

import type { RequestKind } from "./decide.ts";
import { LIMITS } from "./routing-policy.ts";

type ContentBlock = { type?: unknown; text?: unknown };
type Message = { role?: unknown; content?: unknown };

export type MessagesBody = {
  model?: unknown;
  messages?: unknown;
  tools?: unknown;
  output_config?: unknown;
  thinking?: unknown;
  [key: string]: unknown;
};

export type Turn =
  | { kind: "passthrough"; reason: string }
  | { kind: "new"; key: string; prompt: string; previousReply: string | null; previousKey: string | null }
  | { kind: "continuation"; key: string };

const SYSTEM_REMINDER = "<system-reminder>";

const blocksOf = (m: Message): ContentBlock[] =>
  Array.isArray(m.content) ? (m.content as ContentBlock[]) : typeof m.content === "string" ? [{ type: "text", text: m.content }] : [];

const isPromptText = (b: ContentBlock): b is { type: "text"; text: string } =>
  b.type === "text" && typeof b.text === "string" && !b.text.trimStart().startsWith(SYSTEM_REMINDER);

const promptTextOf = (m: Message): string => blocksOf(m).filter(isPromptText).map((b) => b.text).join("\n").trim();

// A "routed turn" is a user message with real prompt text and no tool results: the thing the user (or a
// parent agent) actually asked for. Tool-loop messages after it belong to the same task.
const isRoutedTurn = (m: Message): boolean =>
  m.role === "user" && !blocksOf(m).some((b) => b.type === "tool_result") && promptTextOf(m) !== "";

// Most recent routed turn strictly before `before`.
function findRoutedTurn(messages: Message[], before: number): number {
  for (let i = before - 1; i >= 0; i--) if (isRoutedTurn(messages[i]!)) return i;
  return -1;
}

function precedingAssistantText(messages: Message[], before: number): string | null {
  for (let i = before - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    const text = promptTextOf(m);
    return text ? text.slice(0, LIMITS.ASSISTANT_REPLY_MAX_CHARS) : null;
  }
  return null;
}

// Keyed by what was asked and what it was a reply to, not by raw message JSON: Claude Code moves
// cache_control markers and clears old tool results between requests, and forks share their parent's history.
function turnKey(messages: Message[], index: number): string {
  const payload = { prompt: promptTextOf(messages[index]!), prev: precedingAssistantText(messages, index) ?? "" };
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function classifyRequest(body: MessagesBody): Turn {
  if (!Array.isArray(body.tools) || body.tools.length === 0) return { kind: "passthrough", reason: "no tools" };
  if (!Array.isArray(body.messages)) return { kind: "passthrough", reason: "no messages" };
  const messages = body.messages as Message[];
  const lastIndex = messages.findLastIndex((m) => m.role !== "system");
  const last = messages[lastIndex];
  if (!last || last.role !== "user") return { kind: "passthrough", reason: "last message is not a user turn" };

  if (blocksOf(last).some((b) => b.type === "tool_result")) {
    const routed = findRoutedTurn(messages, lastIndex);
    return routed < 0 ? { kind: "passthrough", reason: "tool loop without a routed turn" } : { kind: "continuation", key: turnKey(messages, routed) };
  }
  if (!isRoutedTurn(last)) return { kind: "passthrough", reason: "no user text" };

  const previous = findRoutedTurn(messages, lastIndex);
  return {
    kind: "new",
    key: turnKey(messages, lastIndex),
    prompt: promptTextOf(last),
    previousReply: precedingAssistantText(messages, lastIndex),
    previousKey: previous < 0 ? null : turnKey(messages, previous),
  };
}

// Claude Code prefixes its system prompt with a billing line ("x-anthropic-billing-header: cc_version=...;
// cc_entrypoint=cli; cc_is_subagent=true;"). Forks inherit the parent's prompt, so they are labelled like their
// parent. Requests from other clients get no label.
const CLAUDE_CODE_MARKER = "x-anthropic-billing-header:";
const SUBAGENT_MARKERS = ["cc_is_subagent=true", "You are an agent for Claude Code"];

export function requestKind(body: MessagesBody): RequestKind | undefined {
  const system = body.system;
  const text = typeof system === "string" ? system : Array.isArray(system) ? (system as ContentBlock[]).map((b) => (typeof b.text === "string" ? b.text : "")).join("\n") : "";
  if (SUBAGENT_MARKERS.some((m) => text.includes(m))) return "subagent";
  if (text.includes(CLAUDE_CODE_MARKER)) return "main";
  return undefined;
}
