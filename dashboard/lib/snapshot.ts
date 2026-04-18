import fs from "node:fs";
import path from "node:path";
import { db, schema } from "./db";

interface ConfigSnapshot {
  version: 1;
  takenAt: string;
  monitoredServers: typeof schema.monitoredServers.$inferSelect[];
  expectedReplication: typeof schema.expectedReplication.$inferSelect[];
  notificationTargets?: typeof schema.notificationTargets.$inferSelect[];
  notificationRules?: typeof schema.notificationRules.$inferSelect[];
}

function snapshotPath(): string {
  const dbPath = process.env.DB_PATH ?? "./dev.db";
  const dir = path.dirname(path.resolve(dbPath));
  return path.join(dir, "config-snapshot.json");
}

export function snapshotConfig(): ConfigSnapshot {
  const monitored = db.select().from(schema.monitoredServers).all();
  const expected = db.select().from(schema.expectedReplication).all();
  let targets: ConfigSnapshot["notificationTargets"];
  let rules: ConfigSnapshot["notificationRules"];
  try { targets = db.select().from(schema.notificationTargets).all(); } catch { /* tabla puede no existir aún */ }
  try { rules = db.select().from(schema.notificationRules).all(); } catch { /* idem */ }
  return {
    version: 1,
    takenAt: new Date().toISOString(),
    monitoredServers: monitored,
    expectedReplication: expected,
    notificationTargets: targets,
    notificationRules: rules,
  };
}

export function writeSnapshotToDisk(): { ok: boolean; path: string; error?: string } {
  const filePath = snapshotPath();
  try {
    const snap = snapshotConfig();
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snap, null, 2), "utf8");
    fs.renameSync(tmp, filePath); // atomic
    return { ok: true, path: filePath };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[snapshot] write failed: ${msg}`);
    return { ok: false, path: filePath, error: msg };
  }
}

export function readSnapshotFromDisk(): ConfigSnapshot | null {
  const filePath = snapshotPath();
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as ConfigSnapshot;
  } catch (err) {
    console.warn(`[snapshot] read failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

export type { ConfigSnapshot };
