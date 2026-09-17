// Three outputs per routed request: a readable stdout line, last.json for the statusline (latest decision),
// and an append-only decisions.jsonl for analysing routing quality afterwards.

import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Decision, DecisionSource, RequestKind } from "./decide.ts";
import type { JevAnswer } from "./jev.ts";
import type { Effort, ModelAlias } from "./routing-policy.ts";
import type { Usage } from "./usage.ts";

export const PROMPT_PREVIEW_CHARS = 300;
const LINE_PREVIEW_CHARS = 60;

export type DecisionRecord = {
  at: string;
  conv: string;
  kind?: RequestKind;
  turn: "new" | "continuation";
  source: DecisionSource | "dry_run";
  requested: { model: string; effort: Effort | null };
  routed: { alias: ModelAlias | null; model: string; effort: Effort | null };
  jev: { ms: number; model: JevAnswer; effort: JevAnswer; is_followup: number } | null;
  jev_error?: string;
  prompt_preview?: string;
  upstream: { status: number; ms_to_headers: number; retried_with_original: boolean };
  usage: Usage | null;
};

const clock = (iso: string): string => iso.slice(11, 19);
const oneLine = (s: string, max: number): string => JSON.stringify(s.replace(/\s+/g, " ").slice(0, max));

export function formatLine(r: Omit<DecisionRecord, "usage">, decision: Decision): string {
  const target = `${r.routed.alias ?? r.routed.model}/${r.routed.effort ?? "default"}`;
  const how =
    r.source === "cached"
      ? "cached"
      : r.source === "override"
        ? "override"
        : r.source === "followup"
          ? `followup ${decision.confidences.is_followup?.toFixed(2) ?? ""}`.trim()
          : r.source === "fallback"
            ? `fallback${r.jev_error ? ` (jev: ${r.jev_error})` : ""}`
            : `jev ${decision.confidences.model?.toFixed(2) ?? "?"}/${decision.confidences.effort?.toFixed(2) ?? "?"} ${r.jev?.ms ?? 0}ms`;
  const parts = [
    clock(r.at),
    r.turn === "new" ? "new " : "cont",
    `#${r.conv}${r.kind ? ` ${r.kind}` : ""}`,
    target.padEnd(12),
    how.padEnd(22),
    `${r.upstream.status} in ${(r.upstream.ms_to_headers / 1000).toFixed(1)}s`,
    r.upstream.retried_with_original ? "RETRIED" : "",
    decision.source !== r.source && r.source === "dry_run" ? `[dry, would be ${decision.source}]` : "",
    r.prompt_preview !== undefined ? oneLine(r.prompt_preview, LINE_PREVIEW_CHARS) : "",
  ];
  return parts.filter(Boolean).join("  ");
}

export async function writeLastDecision(path: string, d: Decision): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(d, null, 2) + "\n");
  await rename(tmp, path);
}

export async function appendRecord(path: string, r: DecisionRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(r) + "\n");
}
