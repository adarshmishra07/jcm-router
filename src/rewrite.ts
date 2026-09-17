// Applies a Decision to a /v1/messages body. Always returns a new object.

import type { MessagesBody } from "./conversation.ts";
import type { Decision } from "./decide.ts";
import { MODELS } from "./routing-policy.ts";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

type Message = { role?: unknown; content?: unknown };
const blocksOf = (m: Message): unknown[] => (Array.isArray(m.content) ? m.content : typeof m.content === "string" ? [{ type: "text", text: m.content }] : []);
const appendTo = (m: Message, blocks: unknown[]): Message => ({ ...m, content: [...blocksOf(m), ...blocks] });

// Haiku 4.5 rejects role "system" inside messages (Claude Code uses it for hook output and mid-session notes).
// Their blocks are appended to the nearest preceding user message, or the next one if none precedes.
// Appending keeps tool_result blocks first, which the API requires.
export function foldSystemMessages(messages: unknown): unknown {
  if (!Array.isArray(messages)) return messages;
  const out: Message[] = [];
  let pending: unknown[] = [];
  for (const m of messages as Message[]) {
    if (m.role === "system") {
      const last = out.findLastIndex((x) => x.role === "user");
      if (last >= 0) out[last] = appendTo(out[last]!, blocksOf(m));
      else pending = [...pending, ...blocksOf(m)];
    } else if (m.role === "user" && pending.length > 0) {
      out.push(appendTo(m, pending));
      pending = [];
    } else out.push(m);
  }
  return out;
}

// Claude Code asks the API to clear old thinking blocks; without thinking that edit is rejected.
export function withoutThinkingEdits(contextManagement: unknown): unknown {
  if (!isRecord(contextManagement) || !Array.isArray(contextManagement.edits)) return contextManagement;
  const edits = contextManagement.edits.filter((e: unknown) => !(isRecord(e) && typeof e.type === "string" && e.type.startsWith("clear_thinking")));
  return edits.length > 0 ? { ...contextManagement, edits } : undefined;
}

export function applyDecision(body: MessagesBody, d: Decision): MessagesBody {
  const { output_config, thinking, ...rest } = body;
  const config = isRecord(output_config) ? output_config : {};

  if (d.alias && !MODELS[d.alias].supportsEffort) {
    // Haiku 4.5: no output_config.effort, no adaptive thinking, no thinking edits, no role "system" messages.
    const { effort: _effort, ...config_without_effort } = config;
    const { context_management, ...restWithoutContext } = rest;
    const contextManagement = withoutThinkingEdits(context_management);
    return {
      ...restWithoutContext,
      model: d.model,
      messages: foldSystemMessages(body.messages),
      ...(contextManagement !== undefined ? { context_management: contextManagement } : {}),
      ...(Object.keys(config_without_effort).length > 0 ? { output_config: config_without_effort } : {}),
    };
  }

  const nextConfig = d.effort ? { ...config, effort: d.effort } : config;
  return {
    ...rest,
    model: d.model,
    ...(thinking !== undefined ? { thinking } : {}),
    ...(Object.keys(nextConfig).length > 0 ? { output_config: nextConfig } : {}),
  };
}
