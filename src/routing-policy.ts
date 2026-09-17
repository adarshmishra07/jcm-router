// Everything a human should review to tune routing lives in this file:
// the model catalog, the Jev questions, the state Jev sees, and the thresholds.

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
  FOLLOWUP_MIN_NOUL: 0.7,
  // Never send a large context to haiku (200K window). Tokens estimated as body chars / 4.
  HAIKU_MAX_TOKENS: 150_000,
} as const;

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
