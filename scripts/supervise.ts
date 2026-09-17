// Keeps the router alive, and keeps the port answering even when the router will not stay alive.
//
// Claude Code points ANTHROPIC_BASE_URL at this port, so nothing listening there means no API at all, routed or
// not. A crash loop therefore falls back to passthrough: the same port, every request streamed to the upstream
// unchanged. No Jev, no rewriting, no journal. Routing stops, Claude Code keeps working.
//
// This never edits ~/.claude/settings.json. See the README: Claude Code reads that at session start, so
// rewriting it mid-crash rescues nothing, and a process that edits global config while dying is worse than the
// problem it is trying to solve.
//
// Usage: bun run start   (bun run up runs this too)

import { describeEnv, hasJevKey } from "../src/env.ts";
import { HEALTH_PATH, SUPERVISION_ENV, healthBody, type Crash, type Health, type Mode, type Profile, type Supervision } from "../src/health.ts";
import { forward } from "../src/proxy.ts";

export type Timings = {
  backoffMs: number;
  maxBackoffMs: number;
  healthyMs: number;
  crashWindowMs: number;
  crashThreshold: number;
  retryMs: number;
  settleMs: number;
};

export const TIMINGS: Timings = {
  backoffMs: 200,
  maxBackoffMs: 5_000,
  // A child that ran this long was healthy: the next crash starts from the shortest backoff again.
  healthyMs: 60_000,
  // This many crashes inside this window means routing is not coming back on its own.
  crashWindowMs: 60_000,
  crashThreshold: 3,
  // How often passthrough tries the router again, and how long a retry must stay up to count as started.
  retryMs: 60_000,
  settleMs: 3_000,
};

export type SuperviseOptions = Partial<Timings> & {
  command: string[];
  cwd: string;
  port: number;
  upstream: string;
  profile: Profile;
  jevKey: boolean;
  log: (line: string) => void;
};

export type Handle = {
  state: () => { mode: Mode; restarts: number; lastCrash: Crash | null };
  stop: () => void;
  done: Promise<void>;
};

// The whole of passthrough: the same header handling as the real proxy, and nothing else.
export function startPassthrough(o: { port: number; upstream: string; health: () => Health; log: (line: string) => void }) {
  return Bun.serve({
    port: o.port,
    idleTimeout: 255,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (req.method === "GET" && pathname === HEALTH_PATH) return Response.json(o.health());
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      return forward(o.upstream, req, hasBody ? await req.text() : undefined);
    },
    error(err) {
      o.log(`passthrough error: ${err.message}`);
      return new Response(`jcm-router passthrough: ${err.message}`, { status: 502 });
    },
  });
}

export function supervise(o: SuperviseOptions): Handle {
  const t = { ...TIMINGS, ...o };
  const startedAt = new Date().toISOString();
  const seconds = (ms: number) => Math.round(ms / 1000);

  let mode: Mode = "routing";
  let restarts = 0;
  let lastCrash: Crash | null = null;
  let crashes: number[] = [];
  let backoff = t.backoffMs;
  let stopped = false;
  let child: Bun.Subprocess | null = null;
  let adopted: Bun.Subprocess | null = null; // started by passthrough, supervised by the main loop
  let server: ReturnType<typeof startPassthrough> | null = null;

  const supervision = (): Supervision => ({ started_at: startedAt, restarts, last_crash: lastCrash });
  const health = (): Health => healthBody({ mode, supervision: supervision(), profile: o.profile, jevKey: o.jevKey });
  const bind = () => startPassthrough({ port: o.port, upstream: o.upstream, health, log: o.log });

  const spawn = (): Bun.Subprocess =>
    Bun.spawn(o.command, {
      cwd: o.cwd,
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, [SUPERVISION_ENV]: JSON.stringify(supervision()) },
    });

  const noteCrash = (code: number, ranMs: number): void => {
    lastCrash = { at: new Date().toISOString(), code, ran_ms: ranMs };
    crashes = [...crashes.filter((at) => Date.now() - at < t.crashWindowMs), Date.now()];
  };

  // Holds the port until the router starts and stays up. Nothing is routed or journalled while we are here.
  const passthrough = async (): Promise<void> => {
    mode = "passthrough";
    o.log(
      `PASSTHROUGH MODE: ROUTING IS OFF. The router crashed ${crashes.length} times in ${seconds(t.crashWindowMs)}s ` +
        `(last exit code ${lastCrash?.code ?? "?"}). Port ${o.port} now forwards every request to ${o.upstream} ` +
        `unchanged, so Claude Code keeps working. Retrying the router every ${seconds(t.retryMs)}s.`,
    );
    server = bind();
    while (!stopped) {
      await Bun.sleep(t.retryMs);
      if (stopped) return;
      server.stop(true); // the router cannot bind the port while passthrough holds it
      const candidate = spawn();
      const started = Date.now();
      restarts += 1;
      const code = await Promise.race([candidate.exited, Bun.sleep(t.settleMs).then(() => null)]);
      if (code === null) {
        mode = "routing";
        crashes = [];
        backoff = t.backoffMs;
        adopted = candidate;
        o.log(`RECOVERED: the router started and stayed up for ${t.settleMs}ms. Leaving passthrough, routing is back on.`);
        return;
      }
      noteCrash(code, Date.now() - started);
      o.log(`still in passthrough: the router exited with code ${code} again, next try in ${seconds(t.retryMs)}s`);
      server = bind();
    }
  };

  const run = async (): Promise<void> => {
    while (!stopped) {
      child = adopted ?? spawn();
      adopted = null;
      const started = Date.now();
      const code = await child.exited;
      const ranMs = Date.now() - started;
      child = null;
      if (stopped) return;
      if (code === 0) {
        o.log(`router exited cleanly after ${ranMs}ms, not restarting`);
        return;
      }
      noteCrash(code, ranMs);
      if (ranMs >= t.healthyMs) backoff = t.backoffMs;
      if (crashes.length >= t.crashThreshold) {
        await passthrough();
        continue;
      }
      restarts += 1;
      o.log(`router exited with code ${code} after ${ranMs}ms, restart ${restarts} in ${backoff}ms`);
      await Bun.sleep(backoff);
      backoff = Math.min(backoff * 2, t.maxBackoffMs);
    }
  };

  const stop = (): void => {
    stopped = true;
    child?.kill();
    adopted?.kill();
    server?.stop(true);
  };

  return { state: () => ({ mode, restarts, lastCrash }), stop, done: run() };
}

if (import.meta.main) {
  const profile = describeEnv(process.env);
  const handle = supervise({
    command: ["bun", "src/index.ts"],
    cwd: new URL("..", import.meta.url).pathname,
    port: profile.port,
    upstream: profile.upstream,
    profile,
    jevKey: hasJevKey(process.env),
    log: (line) => console.log(line),
  });
  const stop = () => {
    handle.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await handle.done;
}
