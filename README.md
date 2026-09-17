# claude-router

A small local proxy between Claude Code and the Anthropic API. On every new message it asks TypeSafe's Jev model which Claude model and effort level fit the task, rewrites the request, and forwards it. Works with a Claude subscription login (OAuth) inside one ongoing Claude Code chat.

```
Claude Code  --->  claude-router (localhost:8787)  --->  api.anthropic.com
                        |
                        +--->  api.typesafe.ai (Jev: "which model? how much effort?")
```

Trivial questions go to Haiku, everyday work to Sonnet, hard problems to Opus or Fable. Decisions stick for the whole tool loop, so a task never switches model halfway through.

If you know [musistudio/claude-code-router](https://github.com/musistudio/claude-code-router): that one routes by static rules across providers. This one routes per message with a learned classifier and keeps your Claude subscription.

## Setup

Requires [Bun](https://bun.sh) and a TypeSafe API key.

```sh
bun install
cp .env.example .env      # put your TYPESAFE_API_KEY in .env
bun start                 # listens on http://localhost:8787
```

In another terminal:

```sh
env -u ANTHROPIC_API_KEY ANTHROPIC_BASE_URL=http://localhost:8787 claude
```

`env -u ANTHROPIC_API_KEY` matters: if that variable is set in your shell, Claude Code bills the API key instead of your subscription. A shell alias keeps it short:

```sh
alias clauder='env -u ANTHROPIC_API_KEY ANTHROPIC_BASE_URL=http://localhost:8787 claude'
```

### Environment

All configuration comes from the environment (Bun loads `.env` automatically). Invalid values stop the proxy at startup with a list of problems.

| Variable | Default | Meaning |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | required | TypeSafe key, must start with `apikey_`. Never logged or forwarded to Anthropic. |
| `PORT` | `8787` | Port the proxy listens on. |
| `ANTHROPIC_UPSTREAM` | `https://api.anthropic.com` | Where requests are forwarded. |
| `TYPESAFE_API_URL` | `https://api.typesafe.ai` | TypeSafe base URL (tests point it at a fake). |
| `ROUTER_DRY_RUN` | `0` | `1`: log decisions, forward everything unchanged. |
| `ROUTER_LOG_PROMPTS` | `1` | `0`: keep prompt previews out of `decisions.jsonl`. |
| `ROUTER_STATE_DIR` | `~/.claude-router` | Where `last.json` and `decisions.jsonl` are written. |
| `ROUTER_SCOPE` | `all` | `all`: route subagents and the main chat, the latter only while a switch is cheap (see [Scope](#scope-where-switching-pays-off)). `subagents`: never touch the main chat. |
| `ROUTER_MAIN_UPGRADES` | `0` | `1`: a main-chat turn whose context is too large may still be upgraded to a more expensive model when Jev is confident it is hard. Never downgraded. Deliberately spends more for quality. |

`ANTHROPIC_API_KEY` is not needed. Authentication comes from the headers Claude Code sends.

## How routing works

Only requests to `/v1/messages` that carry a non-empty `tools` array are routed. Everything else (chat title generation, `/api/hello`, other paths) passes straight through.

**New turn.** When the latest message is a user message with real text (not a `<system-reminder>`) and no tool results, the proxy sends Jev a small state object: the user message (max 6000 chars), the previous assistant reply (max 2000 chars), and the previous routing for this conversation. Jev answers three questions, all defined in [`src/routing-policy.ts`](src/routing-policy.ts):

- `model` (choice): fable, opus, sonnet or haiku. Each option says what belongs there, what belongs in the neighbour instead, and gives examples.
- `effort` (choice): low, medium, high, xhigh or max, by how much deliberation the task needs.
- `is_followup` (yes/no probability): is this message a short continuation ("yes do it", "continue", a small tweak) that only makes sense given the previous reply?

**Confidence gates.** If Jev's confidence for `model` is below `MODEL_MIN_CONFIDENCE` (0.5), the model Claude Code asked for is kept. Same for `effort`, gated separately. These are starting values; tune them.

**Sticky during tool loops.** Once decided, the model and effort are cached for that turn and reused for every tool-result continuation, so a task never switches model mid way (prompt caches are per model, so a switch would also be a cache miss). If the proxy restarts mid loop, the loop passes through unchanged.

**Follow-ups.** If `is_followup` is at least `FOLLOWUP_MIN_NOUL` (0.7) and there is a decision for the previous turn, that decision is reused. "Yes do it" after an Opus plan stays on Opus.

### Scope: where switching pays off

Prompt caches are scoped to the model. Switching model mid conversation throws away the cached history and writes it again on the new model, and a mid-conversation `output_config.effort` change invalidates the messages cache too. Measured on a real session: the main chat sat at ~360K tokens, every switch showed `cache_read_input_tokens: 0, cache_creation_input_tokens: 360370`, and over 86 requests the router cost $35.75 against $15.33 for doing nothing. Subagent routing was the part that saved money: a fresh, small context with nothing cached to lose.

So the router asks two questions before it asks Jev, all in [`src/routing-policy.ts`](src/routing-policy.ts):

- `subagent` requests are always routed.
- `main` requests (and anything not identifiably Claude Code, treated as main) are routed only while a switch is cheap. First a size gate, `MAIN_MAX_CONTEXT_TOKENS` (100K; a fresh Claude Code chat already carries 50 to 70K tokens of system prompt and tool schemas), above which Jev is not called at all. Below it, `switchPaysOff` in [`src/cost.ts`](src/cost.ts) prices the turn: staying reads the history from the cache on the current model (0.1x input), switching writes it on the target (2x input, the 1-hour TTL Claude Code uses). The switch goes ahead if it costs at most `MAIN_MAX_SWITCH_COST_USD` ($0.25) more than staying.

"Current model" is the one the conversation was last routed to, not the one Claude Code sends (Claude Code always sends the launched model). Once a chat is past the gate it stays on whatever model it is on, so a chat that went to Opus while small stays on Opus rather than re-caching on Sonnet.

Skipped turns are forwarded unchanged and still journaled with `source: "skipped"` and a `skip_reason` (`scope`, `context_too_large`, `switch_not_worth_it`), plus `context_tokens`, `stay_cost` and `switch_cost` in dollars, so the log explains itself. Manual overrides (`!opus`) win over every guard. Costs are for this turn only; the fresh input and output tokens are left out because they are small next to the history.

**Subagents and forks.** Every request Claude Code makes goes through the proxy, including Agent tool subagents, forks and parallel agents. Each is routed on its own task prompt. Decisions are keyed by the task text plus the assistant reply it follows, so a fork that inherits its parent's history gets its own decision and never disturbs the parent's. Note: a `model:` set in an agent definition is overridden by the router like any other request, because the proxy cannot tell an explicit model from an inherited one. Put an override in the agent's prompt if you want a fixed model.

**Manual overrides.** Start a prompt with `!fable`, `!opus`, `!sonnet` or `!haiku`, and/or `!low`, `!medium`, `!high`, `!xhigh`, `!max`:

```
!opus !high fix the flaky auth test
```

The tokens are not stripped from the message. If both model and effort are overridden, Jev is not asked.

**Fallbacks.** Any Jev error, timeout (2.5s) or unexpected response forwards the request unchanged. If the upstream rejects a rewritten request with a 4xx (except 401, 403, 429), the proxy retries once with the original request and keeps that for the rest of the conversation. Haiku 4.5 needs extra care and gets it: effort, adaptive thinking, thinking-clearing edits and mid-conversation `role: "system"` messages are removed or folded when routing to it, and requests over roughly 150K tokens are bumped from Haiku to Sonnet.

## Statusline

Claude Code's own status bar shows the model you launched with, not the routed one. `statusline.ts` prints the last decision, e.g. `⇄ opus · high`. Add it to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "bun /absolute/path/to/claude-router/statusline.ts"
  }
}
```

It reads `~/.claude-router/last.json` (or `ROUTER_STATE_DIR`), which the proxy rewrites atomically after every decision. In dry-run mode it shows what would have been chosen.

## Testing it yourself

1. Terminal 1: `bun start`. Each routed request prints one line:

   ```
   11:42:03  new   #e1b32bb7 main  fable/max      58K  jev 0.99/0.68 295ms stay $0.012 switch $1.160  200 in 1.6s  "Design a plan for migrating a monolith's auth"
   11:42:09  cont  #e1b32bb7 main  fable/max      59K  cached                  200 in 1.2s
   11:43:30  new   #e1b32bb7 main  fable/max     121K  skipped context_too_large  200 in 1.1s  "yes do it"
   ```

   `#e1b32bb7` identifies the conversation, `main`/`subagent` where the request came from, then the routed model/effort, the estimated context size, how it was decided (Jev confidences for model/effort and latency plus the stay/switch cost of the turn, or cached, override, followup, fallback, skipped with its reason), the upstream status and time to first byte, and the prompt.

2. Terminal 2: `clauder` (the alias above). Try a spread of prompts:

   - `What is 2+2? Answer only the number.`
   - `Run ls here and count the entries.`
   - `Rename the variable foo to bar in src/x.ts.`
   - `Add a --json flag to the CLI and cover it with tests.`
   - `Why does this test fail only when run in parallel?`
   - `Review the last commit for security issues.`
   - `Design a plan for migrating our auth to a multi-tenant OAuth service. Just an outline.`
   - Then reply `yes do it` to the plan (should stay on the same model as the plan).
   - `Use the Agent tool to spawn one subagent whose task is: what is 17*23. Report its answer.` (main turn and subagent routed separately)
   - `!opus !high fix the failing test` (override, no Jev call)

3. `bun run report` (optionally `--since 2h`) summarises `decisions.jsonl`: requests per model/effort, decision sources, Jev latency p50/p95, fallbacks and retries with reasons, tokens and cache hit ratio per model, and the last 15 new-turn decisions with their prompts and confidences so you can eyeball whether the choices were sensible.

**Tuning.** Run with `ROUTER_DRY_RUN=1` to see decisions without acting on them, then edit `src/routing-policy.ts`: the option descriptions and examples are what Jev classifies against, and the thresholds decide when to trust it. `bun test` guards the mechanics; the policy itself is judged by the report.

**Logs.** Everything lives in `~/.claude-router/` (`last.json`, `decisions.jsonl`). Delete `decisions.jsonl` to start a fresh report. Set `ROUTER_LOG_PROMPTS=0` if prompts should not be written to disk.

## Known limits

- Each new message costs one Jev call, typically 0.3 to 1s, before the request goes out.
- Switching models (or effort) is a prompt cache miss for that turn. Decisions stick for the tool loop, and the main chat is only switched while that miss is cheap (see Scope). The router only knows which model a conversation is cached on while it has seen that conversation; after a proxy restart it assumes the requested model.
- Token counts are estimated as body chars / 4, which overestimates JSON tool schemas. Good enough for a gate, not for billing.
- Jev sees the text of your prompt and the previous reply. That text goes to a third party (TypeSafe). Use overrides or dry run if that is a problem for a given conversation.
- Your subscription plan must include the models routed to. If it does not, the 4xx fallback kicks in and the original model is used.
- Haiku 4.5 does not support effort or adaptive thinking, and its context is 200K. The proxy adapts requests for it, but a few Claude Code features may still be rejected; those fall back automatically.
- Detection of new turns relies on the request shapes Claude Code 2.1.x sends. Other clients pass through unless they match.

## Development

```sh
bun test              # unit tests plus an integration test against a fake upstream and fake Jev
bun run typecheck     # tsc --noEmit, strict
```

## License

MIT, see [LICENSE](LICENSE).
