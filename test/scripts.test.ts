// Covers the two shell helpers and the port guard in scripts/up.ts.
// Nothing here touches the real ~/.claude/settings.json: every run points CLAUDE_SETTINGS
// and ROUTER_STATE_DIR at a temporary directory.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

const SETTINGS = {
  model: "opus",
  env: { OTHER_KEY: "keep me" },
  permissions: { allow: ["Bash(bun test:*)"] },
  statusLine: { type: "command", command: "bun statusline.ts" },
};

describe("env-on.sh and env-off.sh", () => {
  let dir = "";
  let settings = "";
  const run = (script: string, env: Record<string, string> = {}) =>
    Bun.spawn(["bash", join(ROOT, "scripts", script)], {
      env: { ...process.env, CLAUDE_SETTINGS: settings, ROUTER_STATE_DIR: join(dir, "state"), PORT: "9911", ...env },
      stdout: "pipe",
      stderr: "pipe",
    });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "router-env-"));
    settings = join(dir, "settings.json");
    await Bun.write(settings, JSON.stringify(SETTINGS, null, 2));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("on then off round-trips and leaves every other key alone", async () => {
    const on = run("env-on.sh");
    expect(await on.exited).toBe(0);
    expect(await new Response(on.stdout).text()).toContain("http://localhost:9911");

    const afterOn = await Bun.file(settings).json();
    expect(afterOn.env.ANTHROPIC_BASE_URL).toBe("http://localhost:9911");
    expect(afterOn.env.OTHER_KEY).toBe("keep me");
    expect(afterOn.model).toBe("opus");
    expect(afterOn.permissions).toEqual(SETTINGS.permissions);

    expect(await run("env-off.sh").exited).toBe(0);
    expect(await Bun.file(settings).json()).toEqual(SETTINGS);
  });

  test("both are safe to run twice", async () => {
    expect(await run("env-on.sh").exited).toBe(0);
    expect(await run("env-on.sh").exited).toBe(0);
    expect((await Bun.file(settings).json()).env.ANTHROPIC_BASE_URL).toBe("http://localhost:9911");
    expect(await run("env-off.sh").exited).toBe(0);
    expect(await run("env-off.sh").exited).toBe(0);
    expect(await Bun.file(settings).json()).toEqual(SETTINGS);
  });

  test("env-off drops an env object that becomes empty, and backs up first", async () => {
    await Bun.write(settings, JSON.stringify({ model: "opus", env: { ANTHROPIC_BASE_URL: "http://localhost:8787" } }));
    expect(await run("env-off.sh").exited).toBe(0);
    expect(await Bun.file(settings).json()).toEqual({ model: "opus" });
    expect((await readdir(join(dir, "state", "backup"))).length).toBeGreaterThan(0);
  });

  test("a missing settings file fails with a clear message", async () => {
    const proc = run("env-on.sh", { CLAUDE_SETTINGS: join(dir, "nope.json") });
    expect(await proc.exited).toBe(1);
    expect(await new Response(proc.stderr).text()).toContain("does not exist");
  });
});

describe("up.ts", () => {
  test("refuses to start when a port is already taken", async () => {
    const spare = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const freePort = spare.port;
    spare.stop(true);
    const busy = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    try {
      const proc = Bun.spawn(["bun", "scripts/up.ts", "--port", String(busy.port)], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(freePort) },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, err] = [await proc.exited, await new Response(proc.stderr).text()];
      expect(code).toBe(1);
      expect(err).toContain(`port ${busy.port}`);
      expect(err).toContain("already in use");
    } finally {
      busy.stop(true);
    }
  });
});
