// Everything a human should review to tune routing lives in this file:
// the model catalog, the Jev questions, the state Jev sees, the thresholds, and the scope rules.

import { PRICES, recacheOnSameModel, switchPaysOff } from "./cost.ts";
import type { RequestKind } from "./decide.ts";
import type { JevQuestion } from "./jev.ts";

export const MODELS = {
  fable: {
    id: "claude-fable-5-1",
    use: "Hardest, longest, most ambiguous work. Mistakes are very costly.",
    supportsEffort: true,
  },
  opus: {
    id: "claude-opus-5",
    use: "Hard engineering: multi-file changes, tricky bugs, architecture, security.",
    supportsEffort: true,
  },
  sonnet: {
    id: "claude-sonnet-5",
    use: "Normal feature work, scoped debugging, tests.",
    supportsEffort: true,
  },
  haiku: {
    id: "claude-haiku-4-5",
    // Haiku 4.5 rejects output_config.effort and adaptive thinking; both are stripped when routing to it.
    use: "Trivial mechanical edits, lookups, formatting, simple questions.",
    supportsEffort: false,
  },
} as const;

export type ModelAlias = keyof typeof MODELS;

export const EFFORTS = {
  low: "Little to think about. One pass is enough.",
  medium: "Ordinary task. Some checking, no deep deliberation.",
  high: "Several moving parts. Should verify its work and weigh alternatives.",
  xhigh: "Errors likely without careful step-by-step reasoning.",
  max: "Correctness dominates cost and time.",
} as const;

export type Effort = keyof typeof EFFORTS;

// Starting values. Tune with ROUTER_DRY_RUN=1 and the decision log.
export const THRESHOLDS = {
  // Below these, keep whatever Claude Code asked for (model and effort are gated separately).
  MODEL_MIN_CONFIDENCE: 0.5,
  EFFORT_MIN_CONFIDENCE: 0.5,
  // At or above this, reuse the previous decision for the conversation ("yes do it" after an opus plan).
  // Tuned on the 41-case eval run against real Jev (39 correct): at 0.7 the bare follow-ups "hmm" (0.70) and
  // "why?" (0.54) fell through to a fresh classification and went to haiku mid task; "yes do it" scored 0.92.
  FOLLOWUP_MIN_NOUL: 0.55,
  // Never send a large context to haiku (200K window). Tokens estimated as body chars / 4.
  HAIKU_MAX_TOKENS: 150_000,
  // Main chat only. Above this many context tokens Jev is not asked at all: a switch would re-cache the whole
  // history. A fresh Claude Code chat already carries 50 to 70K tokens of system prompt and tool schemas.
  MAIN_MAX_CONTEXT_TOKENS: 100_000,
  // Main chat only. A switch may cost at most this much more than staying, this turn (see cost.ts).
  MAIN_MAX_SWITCH_COST_USD: 0.25,
} as const;

// Scope: where routing is allowed to change the model.
// Subagents start with a fresh, small context and nothing cached to lose, so they are always routed.
// The main chat (and anything not identifiably Claude Code) is routed only while a switch is cheap, because prompt
// caches are per model and an effort change invalidates the messages cache too.
// Future upgrade path: the mid-conversation-output-config-2026-07-01 beta (Opus 5, Fable 5.1) lets effort change
// without a cache miss via a system message with empty content; effort-only changes would then skip the guard.
export const ROUTER_SCOPES = ["subagents", "all"] as const;
export type RouterScope = (typeof ROUTER_SCOPES)[number];
export type ScopePolicy = { scope: RouterScope; mainUpgrades: boolean };
export type SkipReason = "scope" | "context_too_large" | "switch_not_worth_it";

// Before Jev is called. A skip here means no Jev latency and no Jev spend. Overrides bypass every guard.
export function skipBeforeAsking(input: { kind: RequestKind | undefined; contextTokens: number; overridden: boolean; policy: ScopePolicy }): SkipReason | null {
  if (input.overridden || input.kind === "subagent") return null;
  if (input.policy.scope === "subagents") return "scope";
  // With ROUTER_MAIN_UPGRADES Jev is still asked, so a confident upgrade can go through guardSwitch.
  if (input.contextTokens > THRESHOLDS.MAIN_MAX_CONTEXT_TOKENS && !input.policy.mainUpgrades) return "context_too_large";
  return null;
}

export type Target = { alias: ModelAlias | null; effort: Effort | null };
// `switch` is what moving this context would cost. With `counterfactual`, no target model was ever chosen
// (the skip happened before Jev was asked) and the figure is a re-cache on the current model: the floor under
// any switch, not a switch that was priced against a real target.
export type SwitchCost = { stay: number; switch: number; counterfactual?: true };

// After a candidate is chosen. `from` is where the conversation's cache lives: the previous routed decision, or the
// request if none is known. Upgrades with ROUTER_MAIN_UPGRADES deliberately spend more for quality.
export function guardSwitch(input: { kind: RequestKind | undefined; contextTokens: number; from: Target; to: Target; policy: ScopePolicy }): {
  skip: SkipReason | null;
  cost?: SwitchCost;
} {
  const { from, to } = input;
  if (input.kind === "subagent") return { skip: null };
  if (from.alias === null || to.alias === null) return { skip: null }; // unknown model, cannot be priced
  if (from.alias === to.alias && from.effort === to.effort) return { skip: null }; // nothing changes, nothing to re-cache
  const c = switchPaysOff({ contextTokens: input.contextTokens, from: from.alias, to: to.alias, maxSwitchCost: THRESHOLDS.MAIN_MAX_SWITCH_COST_USD });
  const cost = { stay: c.stayCost, switch: c.switchCost };
  const upgrade = PRICES[to.alias].input > PRICES[from.alias].input;
  const tooLarge = input.contextTokens > THRESHOLDS.MAIN_MAX_CONTEXT_TOKENS;
  const allowed = (upgrade && input.policy.mainUpgrades) || (!tooLarge && c.worth);
  return { skip: allowed ? null : "switch_not_worth_it", cost };
}

// A skip decided before Jev was asked still gets priced, so the log can show what the skip avoided. There is no
// target model, so the counterfactual is a re-cache on the model the conversation already sits on.
export function skipCost(input: { contextTokens: number; from: Target }): SwitchCost | undefined {
  if (input.from.alias === null) return undefined; // unknown model, cannot be priced
  return { ...recacheOnSameModel(input.contextTokens, input.from.alias), counterfactual: true };
}

export const LIMITS = {
  USER_MESSAGE_MAX_CHARS: 6000,
  ASSISTANT_REPLY_MAX_CHARS: 2000,
} as const;

export type RoutingState = {
  latest_user_message: string;
  previous_assistant_reply: string | null;
  previous_routing: { model: ModelAlias | null; effort: Effort | null } | null;
};

export function buildState(input: {
  prompt: string;
  previousReply: string | null;
  previousRouting: RoutingState["previous_routing"];
}): RoutingState {
  return {
    latest_user_message: input.prompt.slice(0, LIMITS.USER_MESSAGE_MAX_CHARS),
    previous_assistant_reply: input.previousReply?.slice(0, LIMITS.ASSISTANT_REPLY_MAX_CHARS) ?? null,
    previous_routing: input.previousRouting,
  };
}

const CONTEXT =
  "The task is carried out by an AI coding agent (Claude Code) that can read and edit files, run shell commands, and search the web. " +
  "Judge only the task in `latest_user_message`. Use `previous_assistant_reply` only to resolve references like 'that', 'it', or 'the second option'.";

export const QUESTIONS = {
  model: {
    type: "choice",
    instructions: {
      question: "Which model tier fits the task in `latest_user_message`?",
      context: CONTEXT,
      focus: "Pick the cheapest tier that would reliably get this right. Judge difficulty and blast radius, not length of the message.",
    },
    criteria: {
      haiku: {
        what: "Trivial, mechanical, or lookup work where a wrong answer is cheap and obvious: rename a symbol, fix a typo, format code, answer a factual question, list files, run one command and report the result.",
        not_for: "Anything that needs understanding of how several parts of the code interact, or any design choice. That is sonnet or above.",
        examples: [
          "What is 2+2? answer only the number",
          "Run ls in this folder and count the entries",
          "Rename `fooBar` to `barBaz` in utils.ts",
          "What does this regex match?",
        ],
      },
      sonnet: {
        what: "Everyday engineering with a clear scope: add a feature in one area, write or fix tests, debug a bug that has a known reproduction, explain a module, small refactors.",
        not_for: "Trivial one-step edits (haiku). Work spanning many files, subtle bugs, or decisions where a wrong design is expensive (opus).",
        examples: [
          "Add a --json flag to the CLI and cover it with tests",
          "Why does this test fail when run in parallel? Fix it",
          "Write a function that parses this date format",
        ],
      },
      opus: {
        what: "Hard engineering: changes across many files, subtle or intermittent bugs, concurrency, performance, security-sensitive code (auth, payments, permissions), designing an API or data model, reviewing a large diff.",
        not_for: "Routine bounded work (sonnet). Open-ended research or codebase-wide rewrites where the plan itself is the hard part (fable).",
        examples: [
          "Migrate the auth middleware to support multiple tenants",
          "Find the race condition causing duplicate orders",
          "Review this PR for security issues",
        ],
      },
      fable: {
        what: "The hardest and longest work: ambiguous goals that need research and planning before code, large refactors or migrations across a codebase, architecture with many tradeoffs, tasks where a mistake is very costly and hard to undo.",
        not_for: "Anything with a clear, bounded scope, even if difficult (opus).",
        examples: [
          "Design a plan for migrating a monolith's auth to a multi-tenant OAuth service",
          "Rewrite the build system and keep everything green",
          "Investigate why p99 latency doubled last month across all services",
        ],
      },
    },
  },
  effort: {
    type: "choice",
    instructions: {
      question: "How much deliberation does the task in `latest_user_message` need before answering or acting?",
      context: CONTEXT,
      focus: "More effort means slower and costlier. Pick the lowest level at which a careful engineer would still trust the result.",
    },
    criteria: {
      low: {
        what: "Quick one-pass answer. Simple task, or the user clearly wants speed.",
        not_for: "Anything where a first guess is often wrong.",
        examples: ["What is 2+2?", "Fix this typo", "Show me the git log"],
      },
      medium: {
        what: "Ordinary task that needs some checking but no deep deliberation.",
        not_for: "Tasks with several interacting parts (high).",
        examples: ["Add a null check and a test for it", "Explain what this function does"],
      },
      high: {
        what: "Several moving parts. Should verify its work, read related code, and weigh alternatives.",
        not_for: "Problems where errors are likely even with care (xhigh).",
        examples: ["Add a feature that touches the API, the DB layer and the tests", "Debug why the cache returns stale data"],
      },
      xhigh: {
        what: "Errors are likely without careful step-by-step reasoning: tricky bugs, subtle design, concurrency, correctness arguments.",
        not_for: "Bounded feature work (high). Problems where correctness must dominate all cost (max).",
        examples: ["Find the race condition causing duplicate orders", "Design the schema migration so it can be rolled back safely"],
      },
      max: {
        what: "Correctness dominates cost and time: security analysis, complex algorithms, large migrations, anything hard to undo.",
        not_for: "Anything that is merely difficult (xhigh).",
        examples: ["Audit the auth flow for privilege escalation", "Plan the migration of the monolith to services"],
      },
    },
  },
  is_followup: {
    type: "noul",
    instructions: {
      question:
        "Is `latest_user_message` a short continuation of `previous_assistant_reply` that only makes sense given that reply: a confirmation ('yes', 'do it', 'go ahead', 'continue'), a choice among options the assistant offered, or a small tweak to what was just proposed?",
      note: "If `previous_assistant_reply` is null the answer is no. A message that states a new task on its own is not a follow-up even if it is short.",
    },
  },
} as const satisfies Record<string, JevQuestion>;

export type QuestionId = keyof typeof QUESTIONS;
