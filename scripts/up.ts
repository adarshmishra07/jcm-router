// Starts the proxy and the dashboard together and keeps them in the foreground.
// Ctrl-c stops both. Usage: bun run up [--port 8788]

import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PORT } from "./dashboard.ts";

const DEFAULT_PROXY_PORT = 8787;

export function portInUse(port: number): boolean {
  try {
    const server = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("") });
    server.stop(true);
    return false;
  } catch {
    return true;
  }
}

async function prefix(stream: ReadableStream<Uint8Array> | undefined, tag: string, to: (s: string) => void): Promise<void> {
  if (!stream) return;
  const decoder = new TextDecoder();
  let rest = "";
  for await (const chunk of stream) {
    const lines = (rest + decoder.decode(chunk)).split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) to(`[${tag}] ${line}`);
  }
  if (rest) to(`[${tag}] ${rest}`);
}

if (import.meta.main) {
  const flag = process.argv.indexOf("--port");
  const dashPort = flag >= 0 ? Number(process.argv[flag + 1]) : DEFAULT_PORT;
  const proxyPort = Number(process.env.PORT ?? DEFAULT_PROXY_PORT);
  for (const [name, port] of [["proxy", proxyPort], ["dashboard", dashPort]] as const) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error(`up: ${name} port ${port} is not a valid port number.`);
      process.exit(1);
    }
    if (portInUse(port)) {
      console.error(`up: port ${port} (${name}) is already in use. Stop whatever is on it, or set ${name === "proxy" ? "PORT" : "--port"} to a free port.`);
      process.exit(1);
    }
  }

  const root = new URL("..", import.meta.url).pathname;
  const children = [
    { tag: "proxy", proc: Bun.spawn(["bun", "src/index.ts"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] }) },
    { tag: "dash", proc: Bun.spawn(["bun", "scripts/dashboard.ts", "--port", String(dashPort)], { cwd: root, stdio: ["ignore", "pipe", "pipe"] }) },
  ];

  const logs = join(process.env.ROUTER_STATE_DIR || join(homedir(), ".claude-router"), "decisions.jsonl");
  console.log(
    [
      "claude-router is up",
      `  proxy      http://localhost:${proxyPort}   (point Claude Code at this)`,
      `  dashboard  http://localhost:${dashPort}`,
      `  logs       ${logs}`,
      "  stop       ctrl-c",
      "",
    ].join("\n"),
  );

  let stopping = false;
  const stop = (code: number) => {
    if (stopping) return;
    stopping = true;
    for (const c of children) c.proc.kill();
    process.exit(code);
  };
  process.on("SIGINT", () => stop(0));
  process.on("SIGTERM", () => stop(0));
  process.on("exit", () => {
    for (const c of children) c.proc.kill();
  });

  for (const c of children) {
    void prefix(c.proc.stdout, c.tag, console.log);
    void prefix(c.proc.stderr, c.tag, console.error);
  }
  // If one child dies the other is useless, so take everything down.
  stop(await Promise.race(children.map((c) => c.proc.exited)));
}
