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

Both `bun run up` and `bun start` run the proxy under `scripts/supervise.ts`, which restarts it and, if it
will not stay up, forwards requests unchanged instead so Claude Code keeps working. The README section
[Staying up](../README.md#staying-up) has the behaviour, the log lines and `/healthz`.

`env-on.sh` backs up `~/.claude/settings.json` into `~/.claude-router/backup/` and then sets
exactly one key, `env.ANTHROPIC_BASE_URL`. `env-off.sh` removes that one key (and drops `env`
if it becomes empty). Both validate the rewritten JSON before replacing the file, both are safe
to run twice, and both need `jq`. Neither starts or stops the proxy: stopping is ctrl-c on
`bun run up`.

The state directory is `~/.claude-router` (the `ROUTER_STATE_DIR` default), still named that from
before the project was renamed to jcm-router.

Claude Code reads settings at startup, so restart it after either script.

### Surviving reboots (launchd)

The supervisor keeps the router up. Nothing keeps the supervisor up across a reboot, a `kill -9` on it, or a
laptop going to sleep. On macOS that job belongs to launchd. The following is an example for you to install
yourself, not something this project installs or writes: save it, change the two paths, load it.

`~/Library/LaunchAgents/ai.jcm-router.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.jcm-router</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/bun</string>
    <string>run</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key><string>/absolute/path/to/jcm-router</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/jcm-router.log</string>
  <key>StandardErrorPath</key><string>/tmp/jcm-router.log</string>
</dict>
</plist>
```

```sh
launchctl load -w ~/Library/LaunchAgents/ai.jcm-router.plist     # start now, and at every login
curl -s localhost:8787/healthz                                   # check it came up
launchctl unload -w ~/Library/LaunchAgents/ai.jcm-router.plist   # stop it for good
```

Two things to know. A launchd agent does not see your shell environment, so `TYPESAFE_API_KEY` has to come
from the `.env` file in `WorkingDirectory` (which `bun run` loads). And this runs the proxy only: start the
dashboard with `bun run dashboard` when you want it.

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
worth the cache loss). `confidence` is Jev's confidence in the model choice; below `MODEL_MIN_CONFIDENCE`
(0.7) the router keeps whatever Claude Code asked for.

**Jev health.** Call count, p50 and p95 latency (this is added to every new message's time to
first token), errors grouped by reason with how many caused a fallback, and the distribution of
model-choice confidence. If most calls land under 0.7, the router is mostly a no-op.

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
signal is at or above the harness's own `FOLLOWUP_MIN_NOUL` (0.55), which a test holds equal to
`THRESHOLDS.FOLLOWUP_MIN_NOUL` in the router, because a follow-up reuses the previous decision
instead of being re-classified.

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
- **`FOLLOWUP_MIN_NOUL`.** If the bare follow-ups ("yes do it", "continue", "hmm") score below the
  threshold, lower it; each miss re-classifies a continuation from scratch and can switch models
  mid-conversation, which the dashboard will then show you as a re-cache.

Overrides (`!haiku write me a compiler`) are decided before Jev is ever called, so the harness
marks them as such and excludes them from accuracy on Jev's behalf.

The run cost uses TypeSafe's homepage price (checked 2026-09-17): $0.042 per million input tokens,
output free. There is no /pricing page, so it may drift; override with `JEV_PRICE_IN` and
`JEV_PRICE_OUT` (USD per million tokens). The dashboard does not show Jev spend because decision
records carry Jev latency but not its token counts, so there is nothing honest to sum.

## Tuner

```sh
bun run tune                # every threshold, whole log
bun run tune --since 7d     # last week only
bun run tune --json         # same data, machine readable
```

Replays `<ROUTER_STATE_DIR>/decisions.jsonl` and reports, for each threshold in
`src/routing-policy.ts`, what the log would have cost with other values in force. It is a report,
not a control loop: it never edits `src/` and never changes routing. You read the table and change
one constant by hand.

### How the sweep works

A decision the candidate value would have blocked reverts to its baseline (the request priced as
Claude Code sent it), and every tool-loop continuation of that turn reverts with it, since a
continuation runs on whatever its turn decided. Everything the value never gated (overrides,
fallbacks, skips) keeps its logged cost. Summed over the log, that gives one delta per candidate;
`vs_current` is the difference against the value in `src/routing-policy.ts`, and `*` marks it.

The sweep only undoes decisions the router took. It cannot invent the ones a looser value would
have made, so the curve is flat below whatever floor the log was collected under. For the two main
chat gates it also lists how many skipped turns a looser value would have exposed to Jev, with the
re-cache each was priced at (an estimate from context size, not a bill).

### How to read it honestly

- **It measures money and reliability, not quality.** The log does not record whether the routed
  model did the job well. The verdict line pairs the money-optimal value with the range the eval
  supports and, where they disagree, recommends the safer one. `EVAL_SUPPORTED` in
  `scripts/tune.ts` is hand-copied from the last `bun run eval` run and dated; Jev's confidences
  move a case or two between runs, so re-run the eval before trusting an edge.
- **"Resting on N decisions"** says how many decisions separate the money-optimal value from the
  current one. A $6 gap resting on four decisions is one long main-chat turn, not a trend.
- **Effort is not priced.** Its sweep counts decisions and nothing else, because effort has no line
  on the price list and the log cannot separate its output tokens from the task's.
- **Reliability** groups upstream 4xx/5xx and retries by the target that was attempted. A retried
  record is one failure, filed under the model Jev picked (the one that was rejected), not the one
  that eventually answered. A target with a failure rate far above the rest is called out.
- **Jev cost** is not in the log (records carry latency, not token counts). `bun run eval` prints
  the per-call price.
