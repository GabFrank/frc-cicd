import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env" });
loadEnv({ path: ".env.local", override: true });
import { syncGithub } from "./sync-github";
import { syncHealth } from "./sync-health";
import { syncReplication } from "./sync-replication";
import { evaluateAlerts } from "./evaluate-alerts";

const SYNC_GITHUB_MS = Number(process.env.SYNC_GITHUB_INTERVAL_MS ?? 300_000);
const SYNC_HEALTH_MS = Number(process.env.SYNC_HEALTH_INTERVAL_MS ?? 60_000);
const SYNC_REPLICATION_MS = Number(process.env.SYNC_REPLICATION_INTERVAL_MS ?? 120_000);
const EVAL_ALERTS_MS = Number(process.env.EVALUATE_ALERTS_INTERVAL_MS ?? 60_000);

let running = false;

async function safeRun<T>(name: string, fn: () => Promise<T>) {
  if (running && name !== "sync-health") {
    console.warn(`[runner] ${name} skipped (another job running)`);
    return;
  }
  running = true;
  const t0 = Date.now();
  try {
    const result = await fn();
    console.log(`[runner] ${name} ok in ${Date.now() - t0}ms`, result);
  } catch (err) {
    console.error(`[runner] ${name} FAILED`, err);
  } finally {
    running = false;
  }
}

async function main() {
  console.log("[runner] starting...", {
    SYNC_GITHUB_MS,
    SYNC_HEALTH_MS,
    SYNC_REPLICATION_MS,
    EVAL_ALERTS_MS,
  });

  await safeRun("sync-github", syncGithub);
  await safeRun("sync-health", syncHealth);
  await safeRun("sync-replication", syncReplication);
  await safeRun("evaluate-alerts", evaluateAlerts);

  setInterval(() => void safeRun("sync-github", syncGithub), SYNC_GITHUB_MS);
  setInterval(() => void safeRun("sync-health", syncHealth), SYNC_HEALTH_MS);
  setInterval(() => void safeRun("sync-replication", syncReplication), SYNC_REPLICATION_MS);
  setInterval(() => void safeRun("evaluate-alerts", evaluateAlerts), EVAL_ALERTS_MS);
}

main().catch((err) => {
  console.error("[runner] fatal", err);
  process.exit(1);
});
