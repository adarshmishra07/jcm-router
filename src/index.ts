import { loadEnv } from "./env.ts";
import { JEV_PATH, JEV_TIMEOUT_MS } from "./jev.ts";
import { startServer } from "./server.ts";

const config = loadEnv();
const log = (line: string) => console.log(line);

const server = startServer({
  port: config.port,
  upstream: config.anthropicUpstream,
  jev: { url: config.typesafeApiUrl + JEV_PATH, apiKey: config.typesafeApiKey, timeoutMs: JEV_TIMEOUT_MS },
  dryRun: config.dryRun,
  logPrompts: config.logPrompts,
  stateDir: config.stateDir,
  policy: { scope: config.scope, mainUpgrades: config.mainUpgrades, upgrades: config.upgrades },
  log,
});

log(
  `jcm-router listening on http://localhost:${server.port}, upstream ${config.anthropicUpstream}, logs in ${config.stateDir}` +
    (config.dryRun ? " (dry run: decisions are logged, requests forwarded unchanged)" : ""),
);
