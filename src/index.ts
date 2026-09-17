import { describeEnv, hasJevKey, loadEnv } from "./env.ts";
import { SUPERVISION_ENV, healthBody, parseSupervision } from "./health.ts";
import { JEV_PATH, JEV_TIMEOUT_MS } from "./jev.ts";
import { startServer } from "./server.ts";

const config = loadEnv();
const log = (line: string) => console.log(line);

// Set by scripts/supervise.ts when this process is a respawn. Run on its own, this is a first start.
const supervision = parseSupervision(process.env[SUPERVISION_ENV]);
const profile = describeEnv(process.env);
const jevKey = hasJevKey(process.env);

const server = startServer({
  port: config.port,
  upstream: config.anthropicUpstream,
  jev: { url: config.typesafeApiUrl + JEV_PATH, apiKey: config.typesafeApiKey, timeoutMs: JEV_TIMEOUT_MS },
  dryRun: config.dryRun,
  logPrompts: config.logPrompts,
  stateDir: config.stateDir,
  policy: { scope: config.scope, mainUpgrades: config.mainUpgrades, upgrades: config.upgrades },
  health: () => healthBody({ mode: "routing", supervision, profile, jevKey }),
  log,
});

log(
  `jcm-router listening on http://localhost:${server.port}, upstream ${config.anthropicUpstream}, logs in ${config.stateDir}` +
    (config.dryRun ? " (dry run: decisions are logged, requests forwarded unchanged)" : ""),
);
