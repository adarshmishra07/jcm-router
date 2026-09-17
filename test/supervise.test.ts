// The supervisor and its passthrough fallback. Fake children (one-line shell scripts), tiny timings, a fake
// upstream: nothing here starts the real router and nothing leaves the machine.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPassthrough, supervise, type SuperviseOptions } from "../scripts/supervise.ts";
import { healthBody, type Health, type Profile } from "../src/health.ts";

const ROOT = new URL("..", import.meta.url).pathname;

const PROFILE: Profile = {
  port: 0,
  upstream: "http://upstream.example",
  scope: "all",
  upgrades: "off",
  main_upgrades: false,
  dry_run: false,
  log_prompts: true,
};

type Seen = { path: string; headers: Record<string, string>; body: string };
const upstreamSeen: Seen[] = [];

const upstream = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    upstreamSeen.push({ path: url.pathname, headers: Object.fromEntries(req.headers), body: req.method === "GET" ? "" : await req.text() });
    if (url.pathname === "/teapot") return new Response("no", { status: 418 });
    // Compressed like the real API, so the forwarder has to drop content-encoding and content-length coming back.
    const gz = Bun.gzipSync("upstream body");
    return new Response(gz, {
      headers: { "content-encoding": "gzip", "content-length": String(gz.byteLength), "x-request-id": "req_1" },
    });
  },
});

afterAll(() => upstream.stop(true));

const freePort = (): number => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = Number(probe.port);
  probe.stop(true);
  return port;
};

const until = async (condition: () => boolean, timeoutMs = 5000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !condition()) await Bun.sleep(5);
  return condition();
};

const options = (over: Partial<SuperviseOptions> & Pick<SuperviseOptions, "command" | "port" | "log">): SuperviseOptions => ({
  cwd: ROOT,
  upstream: `http://localhost:${upstream.port}`,
  profile: PROFILE,
  jevKey: false,
  backoffMs: 10,
  maxBackoffMs: 40,
  crashThreshold: 3,
  retryMs: 5_000,
  settleMs: 40,
  ...over,
});

const passthroughHealth = (): Health =>
  healthBody({
    mode: "passthrough",
    supervision: { started_at: new Date().toISOString(), restarts: 3, last_crash: { at: "2026-09-17T08:00:00.000Z", code: 1, ran_ms: 12 } },
    profile: PROFILE,
    jevKey: false,
  });

describe("supervise", () => {
  test("respawns a child that exits non-zero, backs off, and gives up into passthrough", async () => {
    const logs: string[] = [];
    const handle = supervise(options({ command: ["sh", "-c", "exit 7"], port: freePort(), log: (l) => logs.push(l) }));
    expect(await until(() => handle.state().mode === "passthrough")).toBe(true);
    handle.stop();

    expect(handle.state().lastCrash?.code).toBe(7);
    // Two restarts, doubling, then the third crash inside the window stops trying.
    expect(logs.filter((l) => l.includes("exited with code 7"))).toHaveLength(2);
    expect(logs[0]).toContain("restart 1 in 10ms");
    expect(logs[1]).toContain("restart 2 in 20ms");
    expect(logs.at(-1)).toContain("PASSTHROUGH MODE: ROUTING IS OFF");
    expect(logs.at(-1)).toContain("last exit code 7");
    expect(handle.state().restarts).toBe(2);
  });

  test("passthrough forwards the request unchanged and returns the upstream's body, status and headers", async () => {
    const port = freePort();
    const server = startPassthrough({ port, upstream: `http://localhost:${upstream.port}`, health: passthroughHealth, log: () => {} });
    try {
      const body = JSON.stringify({ model: "claude-fable-5-1", messages: [] });
      const res = await fetch(`http://localhost:${port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer sk-ant-oat-test", "accept-encoding": "identity" },
        body,
      });
      const out = await res.text();
      expect(res.status).toBe(200);
      expect(out).toBe("upstream body");
      expect(res.headers.get("x-request-id")).toBe("req_1");
      // fetch already decompressed, so both of these would be lies if they were passed on.
      expect(res.headers.get("content-encoding")).toBeNull();
      const len = res.headers.get("content-length");
      expect(len === null || Number(len) === Buffer.byteLength(out)).toBe(true);

      const seen = upstreamSeen.at(-1)!;
      expect(seen.path).toBe("/v1/messages");
      expect(seen.body).toBe(body); // byte for byte, no rewriting
      expect(seen.headers.authorization).toBe("Bearer sk-ant-oat-test");
      expect(seen.headers.host).toBe(`localhost:${upstream.port}`); // ours was dropped, fetch set its own
      expect(seen.headers["accept-encoding"]).not.toBe("identity"); // ours was dropped, fetch set its own
      expect(seen.headers["content-length"]).toBe(String(Buffer.byteLength(body)));

      const teapot = await fetch(`http://localhost:${port}/teapot`);
      expect(teapot.status).toBe(418);
    } finally {
      server.stop(true);
    }
  });

  test("passthrough writes no journal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "router-passthrough-"));
    const before = process.env.ROUTER_STATE_DIR;
    process.env.ROUTER_STATE_DIR = dir;
    const port = freePort();
    const server = startPassthrough({ port, upstream: `http://localhost:${upstream.port}`, health: passthroughHealth, log: () => {} });
    try {
      const res = await fetch(`http://localhost:${port}/v1/messages`, { method: "POST", body: JSON.stringify({ model: "claude-haiku-4-5" }) });
      expect(res.status).toBe(200);
      await res.text();
      await Bun.sleep(20); // a journal write would have landed by now
      expect(await readdir(dir)).toEqual([]);
    } finally {
      server.stop(true);
      if (before === undefined) delete process.env.ROUTER_STATE_DIR;
      else process.env.ROUTER_STATE_DIR = before;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("/healthz answers in passthrough, never carries the key, and does not touch the upstream", async () => {
    const port = freePort();
    const server = startPassthrough({ port, upstream: `http://localhost:${upstream.port}`, health: passthroughHealth, log: () => {} });
    try {
      const calls = upstreamSeen.length;
      const res = await fetch(`http://localhost:${port}/healthz`);
      expect(res.status).toBe(200);
      const health = (await res.json()) as Health;
      expect(health).toMatchObject({
        mode: "passthrough",
        restarts: 3,
        jev_key: false,
        last_crash: { code: 1, ran_ms: 12 },
        profile: { scope: "all", upgrades: "off", dry_run: false },
      });
      expect(typeof health.uptime_s).toBe("number");
      expect(JSON.stringify(health)).not.toContain("apikey");
      expect(upstreamSeen).toHaveLength(calls);
    } finally {
      server.stop(true);
    }
  });

  test("once the router starts cleanly the supervisor leaves passthrough", async () => {
    const dir = await mkdtemp(join(tmpdir(), "router-recover-"));
    const marker = join(dir, "attempts");
    const logs: string[] = [];
    // Fails the first three times, then stays up.
    const script = `n=$(cat ${marker} 2>/dev/null || echo 0); n=$((n+1)); echo $n >${marker}; [ "$n" -le 3 ] && exit 1; exec sleep 30`;
    const handle = supervise(options({ command: ["sh", "-c", script], port: freePort(), log: (l) => logs.push(l), retryMs: 40, settleMs: 60 }));
    try {
      expect(await until(() => handle.state().mode === "passthrough")).toBe(true);
      expect(await until(() => handle.state().mode === "routing")).toBe(true);
      expect(logs.some((l) => l.includes("RECOVERED"))).toBe(true);
    } finally {
      handle.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a child that exits cleanly is not restarted", async () => {
    const logs: string[] = [];
    const handle = supervise(options({ command: ["sh", "-c", "exit 0"], port: freePort(), log: (l) => logs.push(l) }));
    await handle.done;
    expect(handle.state().mode).toBe("routing");
    expect(handle.state().restarts).toBe(0);
    expect(logs.at(-1)).toContain("exited cleanly");
  });
});
