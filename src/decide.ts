// Turns Jev answers, manual overrides and the previous decision into one concrete Decision.

import type { JevAnswer, JevAnswers } from "./jev.ts";
import { EFFORTS, MODELS, THRESHOLDS, type Effort, type ModelAlias } from "./routing-policy.ts";

export type DecisionSource = "jev" | "override" | "followup" | "fallback" | "cached";

export type RequestKind = "main" | "subagent";

export type Decision = {
  conv: string;
  kind?: RequestKind;
  alias: ModelAlias | null;
  model: string;
  effort: Effort | null;
  source: DecisionSource;
  confidences: { model?: number; effort?: number; is_followup?: number };
  jevMs: number | null;
  at: string;
};

export type Requested = { model: string; effort: Effort | null };
export type Overrides = { alias?: ModelAlias; effort?: Effort };

export const isAlias = (v: unknown): v is ModelAlias => typeof v === "string" && v in MODELS;
export const isEffort = (v: unknown): v is Effort => typeof v === "string" && v in EFFORTS;

export function requestedOf(body: { model?: unknown; output_config?: unknown }): Requested {
  const effort = (body.output_config as { effort?: unknown } | undefined)?.effort;
  return { model: typeof body.model === "string" ? body.model : "", effort: isEffort(effort) ? effort : null };
}

// Leading "!opus !high ..." tokens. Not stripped from the message so history bytes stay stable.
export function parseOverrides(prompt: string): Overrides {
  const tokens = prompt.trimStart().split(/\s+/);
  let overrides: Overrides = {};
  for (const t of tokens) {
    if (!t.startsWith("!")) break;
    const word = t.slice(1);
    if (isAlias(word)) overrides = { ...overrides, alias: word };
    else if (isEffort(word)) overrides = { ...overrides, effort: word };
    else break;
  }
  return overrides;
}

export const aliasOfModel = (model: string): ModelAlias | null =>
  (Object.keys(MODELS) as ModelAlias[]).find((a) => MODELS[a].id === model) ?? null;

function confident(answer: JevAnswer | undefined, min: number): string | null {
  if (answer?.type !== "choice") return null;
  return answer.confidence >= min ? answer.choice : null;
}

export function decide(input: {
  key: string;
  kind?: RequestKind;
  requested: Requested;
  overrides: Overrides;
  answers: JevAnswers | null;
  previous: Decision | null;
  jevMs: number | null;
  bodyChars: number;
}): Decision {
  const { requested, overrides, answers, previous } = input;
  const followupNoul = answers?.is_followup?.type === "noul" ? answers.is_followup.noul : undefined;
  const followup = previous !== null && followupNoul !== undefined && followupNoul >= THRESHOLDS.FOLLOWUP_MIN_NOUL;

  const jevAlias = confident(answers?.model, THRESHOLDS.MODEL_MIN_CONFIDENCE);
  const jevEffort = confident(answers?.effort, THRESHOLDS.EFFORT_MIN_CONFIDENCE);

  const chosenAlias = overrides.alias ?? (followup ? previous.alias : isAlias(jevAlias) ? jevAlias : null) ?? aliasOfModel(requested.model);
  const chosenEffort = overrides.effort ?? (followup ? previous.effort : isEffort(jevEffort) ? jevEffort : null) ?? requested.effort;

  const tooBigForHaiku = input.bodyChars / 4 > THRESHOLDS.HAIKU_MAX_TOKENS;
  const alias = chosenAlias === "haiku" && tooBigForHaiku ? "sonnet" : chosenAlias;

  const source: DecisionSource =
    overrides.alias || overrides.effort ? "override" : followup ? "followup" : answers ? "jev" : "fallback";

  const model = answers?.model;
  const effort = answers?.effort;
  return {
    conv: input.key.slice(0, 8),
    ...(input.kind ? { kind: input.kind } : {}),
    alias,
    model: alias ? MODELS[alias].id : requested.model,
    effort: alias && !MODELS[alias].supportsEffort ? null : chosenEffort,
    source,
    confidences: {
      ...(model?.type === "choice" ? { model: model.confidence } : {}),
      ...(effort?.type === "choice" ? { effort: effort.confidence } : {}),
      ...(followupNoul !== undefined ? { is_followup: followupNoul } : {}),
    },
    jevMs: input.jevMs,
    at: new Date().toISOString(),
  };
}

export const isNoop = (d: Decision, requested: Requested): boolean =>
  d.model === requested.model && d.effort === requested.effort;
