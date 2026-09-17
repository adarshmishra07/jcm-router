// TypeSafe System One (Jev) client. Any failure returns null so the caller can forward unchanged.

export const JEV_PATH = "/v1/systemone";
export const JEV_TIMEOUT_MS = 2500;

export type JevQuestion =
  | { type: "choice"; instructions: unknown; criteria: Record<string, unknown> }
  | { type: "noul"; instructions: unknown };

export type JevAnswer =
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "noul"; noul: number };

export type JevAnswers = Record<string, JevAnswer>;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function parseAnswer(raw: unknown, expectedType: JevQuestion["type"]): JevAnswer | null {
  if (!isRecord(raw) || raw.type !== expectedType) return null;
  if (raw.type === "noul") return isNum(raw.noul) ? { type: "noul", noul: raw.noul } : null;
  if (typeof raw.choice !== "string" || !isNum(raw.confidence) || !isRecord(raw.probabilities)) return null;
  const probabilities: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw.probabilities)) if (isNum(v)) probabilities[k] = v;
  return { type: "choice", choice: raw.choice, confidence: raw.confidence, probabilities };
}

// Every asked question must be answered with the right shape, otherwise the whole response is rejected.
export function parseJevResponse(json: unknown, questions: Record<string, JevQuestion>): JevAnswers | null {
  if (!isRecord(json) || !isRecord(json.answers)) return null;
  const answers: JevAnswers = {};
  for (const [id, q] of Object.entries(questions)) {
    const a = parseAnswer(json.answers[id], q.type);
    if (!a) return null;
    answers[id] = a;
  }
  return answers;
}

export type JevClient = {
  url: string;
  apiKey: string;
  timeoutMs: number;
};

export type JevResult = { ok: true; answers: JevAnswers; ms: number } | { ok: false; error: string; ms: number };

// Never throws. The error string is safe to log (no key, no prompt).
export async function askJev(client: JevClient, state: unknown, questions: Record<string, JevQuestion>): Promise<JevResult> {
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  try {
    const res = await fetch(client.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${client.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "jev-latest", state, questions }),
      signal: AbortSignal.timeout(client.timeoutMs),
    });
    if (!res.ok) return { ok: false, error: `http ${res.status}`, ms: ms() };
    const answers = parseJevResponse(await res.json(), questions);
    return answers ? { ok: true, answers, ms: ms() } : { ok: false, error: "unexpected response shape", ms: ms() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err), ms: ms() };
  }
}
