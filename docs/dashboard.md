# Dashboard, eval harness and daily use

Three tools sit on top of the proxy: a live dashboard that tells you whether the router is
saving you money, an eval harness that tunes the routing thresholds without spending anything
on Claude, and two shell helpers that point Claude Code at the proxy and back again.

## Daily use

```sh
bun run up            # proxy on 8787 + dashboard on 8788, ctrl-c stops both
scripts/env-on.sh     # points Claude Code at the proxy
# restart Claude Code, then work as usual
scripts/env-off.sh    # back to calling the API directly
```

`bun run up` streams both children's output prefixed `[proxy]` and `[dash]`, and refuses to
start if either port is taken. `bun start` (proxy only) and `bun run dashboard` still work on
their own. Ports: `PORT` for the proxy (default 8787), `--port` for the dashboard (default 8788).

`env-on.sh` backs up `~/.claude/settings.json` into `~/.claude-router/backup/` and then sets
exactly one key, `env.ANTHROPIC_BASE_URL`. `env-off.sh` removes that one key (and drops `env`
if it becomes empty). Both validate the rewritten JSON before replacing the file, both are safe
to run twice, and both need `jq`. Neither starts or stops the proxy: stopping is ctrl-c on
`bun run up`. `~/.claude-router/revert.sh` does env-off plus killing a detached proxy.

Claude Code reads settings at startup, so restart it after either script.

## Dashboard

```sh
bun run dashboard            # http://localhost:8788
bun run dashboard --port 9000
```

It is a separate process from the proxy, reads `<ROUTER_STATE_DIR>/decisions.jsonl` on every
request, and works with an empty or missing log. The page refreshes every 5 seconds by fetching
`/api.json`, which is the same data as JSON if you want to script against it.

### What the numbers mean

**Verdict banner.** `actual` is what the routed requests cost. `baseline` is what the same token
counts would have cost on the model Claude Code originally asked for. `delta` is actual minus
baseline: positive means the router lost you money.

The baseline has one twist, and it is the whole story of this project. Switching models dumps the
prompt cache, so the next request has to write the entire conversation into a new cache at 2x the
input price instead of reading it at 0.1x. When a request was switched, its `cache_creation`
tokens are priced as a cache read in the baseline, because without the router that history was
already cached. On a long main-chat conversation this dwarfs any saving from a cheaper model,
which is why the split by main chat and subagents matters: subagents start cold, so switching
them is nearly free.

Prices are USD per million tokens, hardcoded in `scripts/cost.ts` (a copy of `src/cost.ts`,
keep the two in sync): fable 10/50, opus 5/25, sonnet 2/10, haiku 1/5 (input/output). Cache read
is 0.1x input, cache write 2x input (Claude Code uses a 1-hour cache TTL).

Requests with no `usage` (streaming failures, dry runs) or an unrecognised model are counted as
unpriced and left out of the totals. The count is shown next to the record count.

**Cache health.** Cache read versus cache created tokens per routed model, and a hit rate of
read / (read + created). `switches` is how many requests went to a different model than was asked
for; `recaches` is how many of those then had to write a new cache, with the token count. A high
recache number with a low delta means you got lucky; a high recache number in the main chat is
the router paying for its own switches.

**Decisions table.** The last 100 requests, newest first. A red row cost more than the baseline,
a green row less. `source` says how the decision was made (`jev`, `override`, `followup`,
`fallback`, `cached`, `dry_run`, or `skipped: <reason>` when the router decided a switch was not
worth the cache loss). `confidence` is Jev's confidence in the model choice; below 0.5 the router
keeps whatever Claude Code asked for.

**Jev health.** Call count, p50 and p95 latency (this is added to every new message's time to
first token), errors grouped by reason with how many caused a fallback, and the distribution of
model-choice confidence. If most calls land under 0.5, the router is mostly a no-op.

## Eval harness

```sh
bun run eval            # table plus summary
bun run eval --json     # same data, machine readable
```

Runs `eval/prompts.json` through the Jev API only. No Claude calls, so a full run is seconds and
cents. Needs `TYPESAFE_API_KEY` in `.env` (Bun loads it) or the environment.

`eval/questions.json` is a hand-kept copy of `QUESTIONS` in `src/routing-policy.ts`. The harness
deliberately does not import the source, so it can run while the router is being edited, and it
prints a warning on every run. If you change the questions in the router, copy them across or
the eval measures a router you are not running.

### Using the output to pick thresholds

The prompt set is labeled by tier: `trivial` (should land on haiku), `normal` (sonnet), `hard`
(opus or fable). Follow-up cases are scored differently: they pass when Jev's `is_followup`
signal is at or above 0.7, because a follow-up reuses the previous decision instead of being
re-classified.

- **`MODEL_MIN_CONFIDENCE`.** Compare mean confidence on hits versus misses. If hits average 0.9
  and misses 0.4, a threshold around 0.6 discards most mistakes and keeps most wins. If the two
  means are close, confidence is not separating anything and raising the threshold only turns the
  router off.
- **The low-confidence list** is exactly the set of prompts that will fall through to whatever
  Claude Code asked for. Read it: if the cases there are ones you would rather route, the
  questions need work, not the threshold.
- **Confusion pairs** point at the criteria. `hard -> normal` misses cost you quality;
  `trivial -> hard` misses cost you money. Fix the tier descriptions in `src/routing-policy.ts`
  (then re-copy `eval/questions.json`) and re-run.
- **`FOLLOWUP_MIN_NOUL`.** If the bare follow-ups ("yes do it", "continue", "hmm") score below
  0.7, lower it; each miss re-classifies a continuation from scratch and can switch models
  mid-conversation, which the dashboard will then show you as a re-cache.

Overrides (`!haiku write me a compiler`) are decided before Jev is ever called, so the harness
marks them as such and excludes them from accuracy on Jev's behalf.

The run cost uses TypeSafe's homepage price (checked 2026-09-17): $0.042 per million input tokens,
output free. There is no /pricing page, so it may drift; override with `JEV_PRICE_IN` and
`JEV_PRICE_OUT` (USD per million tokens). The dashboard does not show Jev spend because decision
records carry Jev latency but not its token counts, so there is nothing honest to sum.
