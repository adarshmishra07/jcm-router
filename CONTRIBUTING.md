# Contributing

Small project, short rules.

## Setup

```sh
bun install
cp .env.example .env     # TYPESAFE_API_KEY, from https://typesafe.ai
bun test
bun run typecheck
```

Both must pass before a pull request. CI runs exactly those two commands.

## What changes where

- `src/routing-policy.ts` is the policy: the three questions Jev answers, the option descriptions it
  classifies against, and the thresholds. Most routing-quality changes belong here and nowhere else.
- `src/` is the proxy. `scripts/` is the tooling around it (dashboard, report, eval, the two env
  helpers). `docs/dashboard.md` documents the tooling.
- `eval/questions.json` is a hand-kept copy of `QUESTIONS` in `src/routing-policy.ts`, so the eval
  harness can run while the router is being edited. If you change the questions, copy them across.

## Changing routing behaviour

Claims about routing quality need evidence, not opinion:

```sh
bun run eval          # scores the prompt set through Jev only, seconds and cents
bun run dashboard     # actual versus baseline cost on your own decision log
```

Run with `ROUTER_DRY_RUN=1` to see decisions without acting on them.

Anything that makes the router switch models more eagerly in the main chat needs a cost argument.
The README explains why: switching mid conversation throws away the prompt cache, and an early
unguarded version lost $19.53 over 309 requests learning that.

## Pull requests

- Tests for the mechanics you touch. The policy itself is judged by eval output, not assertions.
- Conventional commit subjects (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
- Never commit `.env`, a real API key, a decision log, or anything from `~/.claude-router/`.
