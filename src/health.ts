// The /healthz body, and the state the supervisor hands a freshly spawned router. Pure: the caller supplies
// the supervision state and the routing profile, so the same shape comes out of the router and out of the
// passthrough forwarder. The Jev key is reported as a boolean and never appears here in any other form.

export const HEALTH_PATH = "/healthz";
// How the supervisor tells the router what it already knows. Read back with parseSupervision.
export const SUPERVISION_ENV = "ROUTER_SUPERVISION";

export type Mode = "routing" | "passthrough";
export type Crash = { at: string; code: number; ran_ms: number };
export type Supervision = { started_at: string; restarts: number; last_crash: Crash | null };

// The settings that decide where a request goes. Descriptive only: the router's behaviour comes from Config.
export type Profile = {
  port: number;
  upstream: string;
  scope: string;
  upgrades: string;
  main_upgrades: boolean;
  dry_run: boolean;
  log_prompts: boolean;
};

export type Health = {
  mode: Mode;
  uptime_s: number;
  restarts: number;
  last_crash: Crash | null;
  jev_key: boolean;
  profile: Profile;
};

const crashOf = (v: unknown): Crash | null => {
  if (typeof v !== "object" || v === null) return null;
  const c = v as Partial<Crash>;
  const ok = typeof c.at === "string" && typeof c.code === "number" && typeof c.ran_ms === "number";
  return ok ? { at: c.at as string, code: c.code as number, ran_ms: c.ran_ms as number } : null;
};

// Environment is external input even when we wrote it ourselves: anything unreadable means "no supervisor".
export function parseSupervision(raw: string | undefined, startedAt: string = new Date().toISOString()): Supervision {
  const fresh: Supervision = { started_at: startedAt, restarts: 0, last_crash: null };
  if (!raw) return fresh;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null) return fresh;
    const s = v as Partial<Supervision>;
    return {
      started_at: typeof s.started_at === "string" ? s.started_at : startedAt,
      restarts: typeof s.restarts === "number" && Number.isFinite(s.restarts) ? s.restarts : 0,
      last_crash: crashOf(s.last_crash),
    };
  } catch {
    return fresh;
  }
}

export function healthBody(input: { mode: Mode; supervision: Supervision; profile: Profile; jevKey: boolean; now?: number }): Health {
  const started = Date.parse(input.supervision.started_at);
  const now = input.now ?? Date.now();
  const uptimeMs = Number.isNaN(started) ? 0 : now - started;
  return {
    mode: input.mode,
    uptime_s: Math.max(0, Math.round(uptimeMs / 100) / 10),
    restarts: input.supervision.restarts,
    last_crash: input.supervision.last_crash,
    jev_key: input.jevKey,
    profile: input.profile,
  };
}
