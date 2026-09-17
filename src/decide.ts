// Turns Jev answers, manual overrides, the previous decision and the scope policy into one concrete Decision.

import type { JevAnswer, JevAnswers } from "./jev.ts";
import { EFFORTS, MODELS, THRESHOLDS, blocksUpgrade, capForContext, guardSwitch, skipCost, type Effort, type ModelAlias, type ScopePolicy, type SkipReason, type SwitchCost, type Target } from "./routing-policy.ts";

export type DecisionSource = "jev" | "override" | "followup" | "fallback" | "cached" | "skipped";

export type RequestKind = "main" | "subagent";

export type Decision = {
  conv: string;
  kind?: RequestKind;
  alias: ModelAlias | null;
  model: string;
  effort: Effort | null;
  source: DecisionSource;
  skipReason?: SkipReason;
  cost?: SwitchCost;
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

export const isOverridden = (o: Overrides): boolean => o.alias !== undefined || o.effort !== undefined;

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
  contextTokens: number;
  skip: SkipReason | null;
  policy: ScopePolicy;
}): Decision {
  const { requested, overrides, answers, previous } = input;
  const followupNoul = answers?.is_followup?.type === "noul" ? answers.is_followup.noul : undefined;
  const followup = previous !== null && followupNoul !== undefined && followupNoul >= THRESHOLDS.FOLLOWUP_MIN_NOUL;

  const jevAlias = confident(answers?.model, THRESHOLDS.MODEL_MIN_CONFIDENCE);
  const jevEffort = confident(answers?.effort, THRESHOLDS.EFFORT_MIN_CONFIDENCE);

  const chosenAlias = overrides.alias ?? (followup ? previous.alias : isAlias(jevAlias) ? jevAlias : null) ?? aliasOfModel(requested.model);
  const chosenEffort = overrides.effort ?? (followup ? previous.effort : isEffort(jevEffort) ? jevEffort : null) ?? requested.effort;

  const alias = capForContext(chosenAlias, input.contextTokens);
  const effort = alias && !MODELS[alias].supportsEffort ? null : chosenEffort;

  // Where this conversation's prompt cache lives. Claude Code always sends the launched model, so after a routed
  // turn the cache is on the routed model, not the requested one.
  const from: Target = previous ? { alias: previous.alias, effort: previous.effort } : { alias: aliasOfModel(requested.model), effort: requested.effort };
  const fromModel = previous ? previous.model : requested.model;

  const source: DecisionSource = isOverridden(overrides) ? "override" : followup ? "followup" : answers ? "jev" : "fallback";
  const model = answers?.model;
  const jevEffortAnswer = answers?.effort;
  const to: Target = { alias, effort };
  const blocked =
    source === "jev" &&
    blocksUpgrade({ requested: { alias: aliasOfModel(requested.model), effort: requested.effort }, to, confidence: model?.type === "choice" ? model.confidence : undefined, policy: input.policy });
  const guard = input.skip
    ? { skip: input.skip, cost: skipCost({ contextTokens: input.contextTokens, from }) }
    : source === "override"
      ? { skip: null }
      : blocked
        ? { skip: "upgrade_blocked" as const }
        : guardSwitch({ kind: input.kind, contextTokens: input.contextTokens, from, to, policy: input.policy });

  return {
    conv: input.key.slice(0, 8),
    ...(input.kind ? { kind: input.kind } : {}),
    ...(guard.skip
      ? { alias: from.alias, model: fromModel, effort: from.effort, source: "skipped" as const, skipReason: guard.skip }
      : { alias, model: alias ? MODELS[alias].id : requested.model, effort, source }),
    ...("cost" in guard && guard.cost ? { cost: guard.cost } : {}),
    confidences: {
      ...(model?.type === "choice" ? { model: model.confidence } : {}),
      ...(jevEffortAnswer?.type === "choice" ? { effort: jevEffortAnswer.confidence } : {}),
      ...(followupNoul !== undefined ? { is_followup: followupNoul } : {}),
    },
    jevMs: input.jevMs,
    at: new Date().toISOString(),
  };
}

export const isNoop = (d: Decision, requested: Requested): boolean =>
  d.model === requested.model && d.effort === requested.effort;
