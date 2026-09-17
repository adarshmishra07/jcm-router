// The proxy. Routes new user turns through Jev, keeps the decision for the rest of the tool loop,
// and forwards everything else unchanged.

import { join } from "node:path";
import { LruCache } from "./cache.ts";
import { classifyRequest, requestKind, type MessagesBody, type Turn } from "./conversation.ts";
import { estimateContextTokens } from "./cost.ts";
import { aliasOfModel, decide, isNoop, isOverridden, parseOverrides, requestedOf, type Decision, type RequestKind, type Requested } from "./decide.ts";
import { appendRecord, formatLine, writeLastDecision, PROMPT_PREVIEW_CHARS, type DecisionRecord } from "./decision-log.ts";
import { askJev, type JevClient, type JevResult } from "./jev.ts";
import { forward, isRewriteRejection, withoutLongContextBeta } from "./proxy.ts";
import { applyDecision } from "./rewrite.ts";
import { MODELS, QUESTIONS, buildState, capForContext, skipBeforeAsking, type ScopePolicy } from "./routing-policy.ts";
import { teeUsage } from "./usage.ts";

export type ServerOptions = {
  port: number;
  upstream: string;
  jev: JevClient;
  dryRun: boolean;
  logPrompts: boolean;
  stateDir: string;
  policy: ScopePolicy;
  log: (line: string) => void;
};

const ROUTED_PATH = "/v1/messages";

function parseJson(text: string): MessagesBody | null {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null ? (v as MessagesBody) : null;
  } catch {
    return null;
  }
}

export function startServer(o: ServerOptions) {
  const cache = new LruCache<Decision>();
  // Real prompt size (cache reads + cache writes + fresh input) from the last response of each turn. The API's
  // own count, so it beats chars/4, but it arrives one turn late: a new turn is sized by the turn it follows,
  // and the first turn of a conversation has nothing to go on and falls back to the estimate.
  const observed = new LruCache<number>();
  const lastPath = join(o.stateDir, "last.json");
  const journalPath = join(o.stateDir, "decisions.jsonl");
  const safely = (what: string, p: Promise<void>) => p.catch((err) => o.log(`could not write ${what}: ${err}`));

  async function routeNewTurn(
    turn: Extract<Turn, { kind: "new" }>,
    requested: Requested,
    contextTokens: number,
    kind: RequestKind | undefined,
  ): Promise<{ decision: Decision; jev: JevResult | null }> {
    const overrides = parseOverrides(turn.prompt);
    const previous = turn.previousKey ? cache.get(turn.previousKey) : null;
    const skip = skipBeforeAsking({ kind, contextTokens, overridden: isOverridden(overrides), policy: o.policy });
    const fullyOverridden = overrides.alias !== undefined && overrides.effort !== undefined;
    const jev = skip || fullyOverridden
      ? null
      : await askJev(
          o.jev,
          buildState({
            prompt: turn.prompt,
            previousReply: turn.previousReply,
            previousRouting: previous ? { model: previous.alias, effort: previous.effort } : null,
          }),
          QUESTIONS,
        );
    const answers = jev?.ok ? jev.answers : null;
    return {
      decision: decide({ key: turn.key, kind, requested, overrides, answers, previous, jevMs: jev?.ms ?? null, contextTokens, skip, policy: o.policy }),
      jev,
    };
  }

  async function handleMessages(req: Request): Promise<Response> {
    const text = await req.text();
    const body = parseJson(text);
    const turn: Turn = body ? classifyRequest(body) : { kind: "passthrough", reason: "not json" };
    if (!body || turn.kind === "passthrough") return forward(o.upstream, req, text);

    const requested = requestedOf(body);
    const measured = observed.get(turn.kind === "new" ? (turn.previousKey ?? "") : turn.key);
    const contextTokens = measured ?? estimateContextTokens(text.length);
    let decision: Decision;
    let jev: JevResult | null = null;
    if (turn.kind === "continuation") {
      const cached = cache.get(turn.key);
      if (!cached) return forward(o.upstream, req, text);
      const { skipReason: _skip, cost: _cost, ...rest } = cached; // the guard ran once, on the new turn
      // The ceiling is the exception: a tool loop grows, and the measured size may have passed what haiku holds
      // since the turn was decided.
      const alias = capForContext(cached.alias, contextTokens);
      decision = { ...rest, alias, model: alias ? MODELS[alias].id : cached.model, source: "cached", at: new Date().toISOString() };
    } else {
      ({ decision, jev } = await routeNewTurn(turn, requested, contextTokens, requestKind(body)));
    }
    cache.set(turn.key, decision);
    await safely("last.json", writeLastDecision(lastPath, decision));

    const rewrite = !o.dryRun && !isNoop(decision, requested);
    const started = performance.now();
    const smallContext = decision.alias !== null && !MODELS[decision.alias].supportsEffort;
    const headers = rewrite && smallContext ? withoutLongContextBeta(req.headers) : req.headers;
    let res = await forward(o.upstream, req, rewrite ? JSON.stringify(applyDecision(body, decision)) : text, headers);
    let retried = false;
    if (rewrite && isRewriteRejection(res.status)) {
      const reason = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
      o.log(`upstream ${res.status} for ${decision.model}: ${reason}. Retrying with the original request and keeping it for this conversation`);
      retried = true;
      decision = { ...decision, alias: aliasOfModel(requested.model), model: requested.model, effort: requested.effort, source: "fallback" };
      cache.set(turn.key, decision);
      await safely("last.json", writeLastDecision(lastPath, decision));
      res = await forward(o.upstream, req, text);
    }

    const record: Omit<DecisionRecord, "usage"> = {
      at: decision.at,
      conv: decision.conv,
      kind: decision.kind,
      turn: turn.kind === "new" ? "new" : "continuation",
      source: o.dryRun ? "dry_run" : decision.source,
      ...(decision.skipReason ? { skip_reason: decision.skipReason } : {}),
      requested,
      routed: { alias: decision.alias, model: decision.model, effort: decision.effort },
      context_tokens: contextTokens,
      context_source: measured === null ? "estimated" : "measured",
      ...(decision.cost
        ? decision.cost.counterfactual
          ? { stay_cost: decision.cost.stay, avoided_recache_cost: decision.cost.switch }
          : { stay_cost: decision.cost.stay, switch_cost: decision.cost.switch }
        : {}),
      jev: jev?.ok
        ? { ms: jev.ms, model: jev.answers.model!, effort: jev.answers.effort!, is_followup: decision.confidences.is_followup ?? 0 }
        : null,
      jev_error: jev && !jev.ok ? jev.error : undefined,
      prompt_preview: turn.kind === "new" && o.logPrompts ? turn.prompt.slice(0, PROMPT_PREVIEW_CHARS) : undefined,
      upstream: { status: res.status, ms_to_headers: Math.round(performance.now() - started), retried_with_original: retried },
    };
    o.log(formatLine(record, decision));
    return teeUsage(res, (usage) => {
      if (usage) observed.set(turn.key, usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens);
      void safely("decisions.jsonl", appendRecord(journalPath, { ...record, usage }));
    });
  }

  return Bun.serve({
    port: o.port,
    idleTimeout: 255,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (req.method === "POST" && pathname === ROUTED_PATH) return handleMessages(req);
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      return forward(o.upstream, req, hasBody ? await req.text() : undefined);
    },
    error(err) {
      o.log(`proxy error: ${err.message}`);
      return new Response(`jcm-router: ${err.message}`, { status: 502 });
    },
  });
}
