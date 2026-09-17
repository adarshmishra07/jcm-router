// Claude Code statusLine command: prints the last routing decision, e.g. "⇄ opus · high".
// Claude Code pipes its own JSON to stdin; it is ignored.

import { join } from "node:path";
import { loadStateDir } from "./src/env.ts";

const file = Bun.file(join(loadStateDir(), "last.json"));
if (!(await file.exists())) {
  console.log("⇄ no route yet");
  process.exit(0);
}
const d = (await file.json()) as { alias: string | null; model: string; effort: string | null; source: string };
const tag = d.source === "jev" || d.source === "cached" ? "" : ` (${d.source})`;
console.log(`⇄ ${d.alias ?? d.model} · ${d.effort ?? "default"}${tag}`);
