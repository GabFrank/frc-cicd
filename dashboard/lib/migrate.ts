import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env" });
loadEnv({ path: ".env.local", override: true });
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import * as schema from "./schema";
import { COMPONENTS, CHANNELS, INSTANCES } from "./config";

const dbPath = process.env.DB_PATH ?? "./dev.db";
const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

const db = drizzle(sqlite, { schema });

function applySchema() {
  const sqlPath = path.join(process.cwd(), "drizzle", "0000_init.sql");
  if (!fs.existsSync(sqlPath)) {
    throw new Error(`Missing migration file: ${sqlPath}`);
  }
  const sql = fs.readFileSync(sqlPath, "utf8");
  sqlite.exec(sql);
}

function columnExists(table: string, column: string): boolean {
  const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

function columnIsNotNull(table: string, column: string): boolean {
  const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number }>;
  return rows.some((r) => r.name === column && r.notnull === 1);
}

function rebuildInstanceRuntimeServerPk() {
  if (!columnExists("instance_runtime", "server_id")) return;
  const cols = sqlite.prepare(`PRAGMA table_info(instance_runtime)`).all() as Array<{ name: string; pk: number }>;
  const instanceIdCol = cols.find((c) => c.name === "instance_id");
  if (!instanceIdCol || instanceIdCol.pk === 0) return; // ya no es PK, OK

  console.log("[migrate] 0001: rebuild instance_runtime (PK = server_id)");
  sqlite.exec(`
    PRAGMA foreign_keys=off;
    BEGIN TRANSACTION;
    CREATE TABLE instance_runtime_new (
      server_id INTEGER PRIMARY KEY,
      instance_id INTEGER REFERENCES instances(id),
      version TEXT,
      build TEXT,
      git_commit TEXT,
      uptime_sec INTEGER,
      heap_used_bytes INTEGER,
      heap_max_bytes INTEGER,
      threads INTEGER,
      info_json TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO instance_runtime_new (server_id, instance_id, version, build, git_commit, uptime_sec, heap_used_bytes, heap_max_bytes, threads, info_json, updated_at)
      SELECT
        COALESCE(server_id, (SELECT ms.id FROM monitored_servers ms JOIN instances i ON ms.ip = i.host AND ms.app_port = i.port WHERE i.id = instance_runtime.instance_id LIMIT 1)),
        instance_id, version, build, git_commit, uptime_sec, heap_used_bytes, heap_max_bytes, threads, info_json, updated_at
      FROM instance_runtime
      WHERE COALESCE(server_id, (SELECT ms.id FROM monitored_servers ms JOIN instances i ON ms.ip = i.host AND ms.app_port = i.port WHERE i.id = instance_runtime.instance_id LIMIT 1)) IS NOT NULL;
    DROP TABLE instance_runtime;
    ALTER TABLE instance_runtime_new RENAME TO instance_runtime;
    CREATE INDEX IF NOT EXISTS idx_instance_runtime_instance ON instance_runtime(instance_id);
    COMMIT;
    PRAGMA foreign_keys=on;
  `);
}

function rebuildHealthChecksNullableInstanceId() {
  if (!columnIsNotNull("health_checks", "instance_id")) return;
  console.log("[migrate] 0001: rebuild health_checks (instance_id NULLABLE)");
  sqlite.exec(`
    PRAGMA foreign_keys=off;
    BEGIN TRANSACTION;
    CREATE TABLE health_checks_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id INTEGER REFERENCES instances(id),
      server_id INTEGER REFERENCES monitored_servers(id),
      checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      status TEXT NOT NULL,
      http_code INTEGER,
      latency_ms INTEGER,
      body_excerpt TEXT
    );
    INSERT INTO health_checks_new (id, instance_id, server_id, checked_at, status, http_code, latency_ms, body_excerpt)
      SELECT id, instance_id,
             ${columnExists("health_checks", "server_id") ? "server_id" : "NULL"},
             checked_at, status, http_code, latency_ms, body_excerpt
      FROM health_checks;
    DROP TABLE health_checks;
    ALTER TABLE health_checks_new RENAME TO health_checks;
    CREATE INDEX IF NOT EXISTS idx_health_checks_instance   ON health_checks(instance_id);
    CREATE INDEX IF NOT EXISTS idx_health_checks_checked_at ON health_checks(checked_at);
    CREATE INDEX IF NOT EXISTS idx_health_checks_server     ON health_checks(server_id);
    COMMIT;
    PRAGMA foreign_keys=on;
  `);
}

function apply0001() {
  const tables: Array<[string, string]> = [
    ["health_checks", "server_id"],
    ["instance_runtime", "server_id"],
    ["alerts", "server_id"],
    ["pg_cluster_status", "server_id"],
    ["pg_databases", "server_id"],
  ];
  let added = 0;
  for (const [tbl, col] of tables) {
    if (!columnExists(tbl, col)) {
      sqlite.exec(`ALTER TABLE ${tbl} ADD COLUMN ${col} INTEGER REFERENCES monitored_servers(id)`);
      added += 1;
    }
  }
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_health_checks_server    ON health_checks(server_id);
    CREATE INDEX IF NOT EXISTS idx_instance_runtime_server ON instance_runtime(server_id);
    CREATE INDEX IF NOT EXISTS idx_alerts_server           ON alerts(server_id);
    CREATE INDEX IF NOT EXISTS idx_pg_cluster_server       ON pg_cluster_status(server_id);
    CREATE INDEX IF NOT EXISTS idx_pg_databases_server     ON pg_databases(server_id);
  `);
  if (added > 0) console.log(`[migrate] 0001_server_registry: ${added} cols agregadas`);

  rebuildHealthChecksNullableInstanceId();
  rebuildInstanceRuntimeServerPk();
}

function backfillServerIds() {
  const updates = sqlite.prepare(`
    UPDATE health_checks
    SET server_id = (
      SELECT ms.id FROM monitored_servers ms
      JOIN instances i ON ms.ip = i.host AND ms.app_port = i.port
      WHERE i.id = health_checks.instance_id
      LIMIT 1
    )
    WHERE server_id IS NULL AND instance_id IS NOT NULL
  `).run();
  if (updates.changes > 0) console.log(`[migrate] backfill health_checks.server_id: ${updates.changes} rows`);

  const u2 = sqlite.prepare(`
    UPDATE instance_runtime
    SET server_id = (
      SELECT ms.id FROM monitored_servers ms
      JOIN instances i ON ms.ip = i.host AND ms.app_port = i.port
      WHERE i.id = instance_runtime.instance_id
      LIMIT 1
    )
    WHERE server_id IS NULL AND instance_id IS NOT NULL
  `).run();
  if (u2.changes > 0) console.log(`[migrate] backfill instance_runtime.server_id: ${u2.changes} rows`);
}

function tableExists(name: string): boolean {
  const row = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name);
  return !!row;
}

function apply0002() {
  if (tableExists("notification_targets")) {
    return;
  }
  const sqlPath = path.join(process.cwd(), "drizzle", "0002_notifications.sql");
  if (!fs.existsSync(sqlPath)) {
    throw new Error(`Missing migration file: ${sqlPath}`);
  }
  const sql0002 = fs.readFileSync(sqlPath, "utf8");
  sqlite.exec(sql0002);
  console.log("[migrate] 0002_notifications applied");
}

function cleanupZombieAlerts() {
  const r = sqlite.prepare(`
    UPDATE alerts SET resolved_at = datetime('now')
    WHERE resolved_at IS NULL
      AND fingerprint NOT LIKE '%:srv:%'
      AND kind IN ('filial_no_success','filial_stale','filial_failure','filial_rollback','central_down','replication_inactive','pg_cluster_down')
  `).run();
  if (r.changes > 0) console.log(`[migrate] cleanup zombie alerts: ${r.changes} resolved`);
}

async function main() {
  console.log(`[migrate] DB: ${dbPath}`);
  applySchema();
  console.log("[migrate] schema ok");
  apply0001();
  apply0002();

  for (const c of COMPONENTS) {
    const existing = db.select().from(schema.components).where(eq(schema.components.slug, c.slug)).all();
    if (existing.length === 0) {
      db.insert(schema.components).values({
        slug: c.slug,
        displayName: c.displayName,
        repoFullName: c.repoFullName,
        kind: c.kind,
      }).run();
    } else {
      db.update(schema.components)
        .set({ displayName: c.displayName, repoFullName: c.repoFullName, kind: c.kind })
        .where(eq(schema.components.slug, c.slug))
        .run();
    }
  }

  const allComponents = db.select().from(schema.components).all();
  const bySlug = new Map(allComponents.map((c) => [c.slug, c]));

  for (const [slug, chs] of Object.entries(CHANNELS)) {
    const comp = bySlug.get(slug);
    if (!comp) continue;
    for (const ch of chs) {
      const existing = db
        .select()
        .from(schema.channels)
        .where(eq(schema.channels.componentId, comp.id))
        .all()
        .filter((row) => row.name === ch.name);
      if (existing.length === 0) {
        db.insert(schema.channels).values({
          componentId: comp.id,
          name: ch.name,
          branch: ch.branch,
        }).run();
      }
    }
  }

  const allChannels = db.select().from(schema.channels).all();
  const channelByCompName = new Map(allChannels.map((c) => [`${c.componentId}:${c.name}`, c]));

  for (const inst of INSTANCES) {
    const comp = bySlug.get(inst.componentSlug);
    if (!comp) continue;
    const ch = inst.channelName ? channelByCompName.get(`${comp.id}:${inst.channelName}`) : undefined;
    const existing = db.select().from(schema.instances).where(eq(schema.instances.name, inst.name)).all();
    const values = {
      kind: inst.kind,
      name: inst.name,
      displayName: inst.displayName,
      host: inst.host ?? null,
      port: inst.port ?? null,
      componentId: comp.id,
      channelId: ch?.id ?? null,
      company: inst.company ?? null,
      environment: inst.environment ?? null,
      notes: inst.notes ?? null,
      active: true,
    };
    if (existing.length === 0) {
      db.insert(schema.instances).values(values).run();
    } else {
      db.update(schema.instances).set(values).where(eq(schema.instances.name, inst.name)).run();
    }
  }

  console.log(
    `[migrate] seed ok: ${COMPONENTS.length} components, ${INSTANCES.length} instances`,
  );

  // Recovery / auto-seed con guard
  await ensureRegistry();

  backfillServerIds();
  cleanupZombieAlerts();

  // Snapshot final de seguridad: si hay registry, guardar JSON ahora.
  try {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dir = path.dirname(path.resolve(dbPath));
    const filePath = path.join(dir, "config-snapshot.json");
    const monitored = db.select().from(schema.monitoredServers).all();
    const expected = db.select().from(schema.expectedReplication).all();
    let targets: any[] = [];
    let rules: any[] = [];
    try { targets = db.select().from(schema.notificationTargets).all(); } catch { /* opt */ }
    try { rules = db.select().from(schema.notificationRules).all(); } catch { /* opt */ }
    if (monitored.length > 0) {
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({
        version: 1,
        takenAt: new Date().toISOString(),
        monitoredServers: monitored,
        expectedReplication: expected,
        notificationTargets: targets,
        notificationRules: rules,
      }, null, 2), "utf8");
      fs.renameSync(tmp, filePath);
      console.log(`[migrate] snapshot escrito: ${filePath}`);
    }
  } catch (err) {
    console.warn(`[migrate] snapshot final falló: ${err instanceof Error ? err.message : err}`);
  }
}

async function ensureRegistry() {
  const existingServers = db.select().from(schema.monitoredServers).all();
  if (existingServers.length > 0) {
    console.log(`[migrate] monitored_servers OK (${existingServers.length} filas, no toco)`);
    return;
  }

  // Vacío. Detectar si la DB ya tuvo uso previo.
  const syncs = db.select().from(schema.syncRuns).all().length;
  const releases = db.select().from(schema.releases).all().length;
  const dbHasHistory = syncs > 50 || releases > 0;

  // Buscar snapshot.
  const fs = await import("node:fs");
  const path = await import("node:path");
  const dir = path.dirname(path.resolve(dbPath));
  const snapPath = path.join(dir, "config-snapshot.json");
  const hasSnapshot = fs.existsSync(snapPath);

  console.log(`[migrate] monitored_servers VACÍO. dbHasHistory=${dbHasHistory} (sync_runs=${syncs}, releases=${releases}) hasSnapshot=${hasSnapshot}`);

  if (hasSnapshot) {
    console.log(`[migrate] Restaurando registry desde ${snapPath}`);
    try {
      const raw = fs.readFileSync(snapPath, "utf8");
      const snap = JSON.parse(raw) as {
        monitoredServers: typeof schema.monitoredServers.$inferSelect[];
        expectedReplication: typeof schema.expectedReplication.$inferSelect[];
        notificationTargets?: typeof schema.notificationTargets.$inferSelect[];
        notificationRules?: typeof schema.notificationRules.$inferSelect[];
      };
      const idMap = new Map<number, number>();
      for (const s of snap.monitoredServers) {
        const r = db.insert(schema.monitoredServers).values({
          kind: s.kind, empresa: s.empresa ?? null, nombre: s.nombre,
          ip: s.ip ?? null, appPort: s.appPort ?? null,
          pgHost: s.pgHost ?? null, pgPort: s.pgPort ?? null,
          pgDatabase: s.pgDatabase ?? null, pgUser: s.pgUser ?? null, pgPassword: s.pgPassword ?? null,
          channel: s.channel ?? null, os: s.os ?? null,
          sucursalId: s.sucursalId ?? null, githubEnvironment: s.githubEnvironment ?? null,
          active: s.active ?? true, notes: s.notes ?? null,
        }).run();
        idMap.set(s.id, Number(r.lastInsertRowid));
      }
      for (const e of snap.expectedReplication ?? []) {
        const newSrv = idMap.get(e.serverId);
        if (!newSrv) continue;
        const newPeer = e.peerServerId ? idMap.get(e.peerServerId) ?? null : null;
        db.insert(schema.expectedReplication).values({
          serverId: newSrv, kind: e.kind, name: e.name,
          peerServerId: newPeer, direction: e.direction ?? null, notes: e.notes ?? null,
        }).run();
      }
      console.log(`[migrate] ✓ restauradas ${snap.monitoredServers.length} servers + ${snap.expectedReplication?.length ?? 0} expected desde snapshot`);
      return;
    } catch (err) {
      console.error(`[migrate] FALLÓ restore desde snapshot: ${err instanceof Error ? err.message : err}`);
      // continuar a guard
    }
  }

  if (dbHasHistory && process.env.ALLOW_REGISTRY_RESEED !== "1") {
    console.error("");
    console.error("🛑 [migrate] ABORT: monitored_servers VACÍO pero la DB tiene historial previo");
    console.error("   (sync_runs=" + syncs + ", releases=" + releases + ") y NO existe config-snapshot.json.");
    console.error("");
    console.error("   Esto sugiere que tu registry fue borrado accidentalmente. Para evitar perder");
    console.error("   data adicional, no se ejecutará el auto-seed por defecto.");
    console.error("");
    console.error("   Opciones:");
    console.error("   1. Restaurar config-snapshot.json desde backup en " + snapPath);
    console.error("   2. POST /api/admin/import con tu JSON exportado");
    console.error("   3. Forzar re-seed default: ALLOW_REGISTRY_RESEED=1 npm run db:migrate");
    console.error("");
    process.exit(2);
  }

  // DB nueva (sin historial) O reseed forzado: ejecutar seed default.
  console.log(`[migrate] auto-seed monitored_servers (${dbHasHistory ? "FORCED via ALLOW_REGISTRY_RESEED" : "DB nueva sin historial"})`);
  const allInstances = db.select().from(schema.instances).all();
  for (const inst of allInstances) {
    if (inst.kind !== "central_instance" && inst.kind !== "filial") continue;
    const sucursalMatch = inst.environment?.match(/filial[-_]?(\d+)/i);
    db.insert(schema.monitoredServers).values({
      kind: inst.kind === "central_instance" ? "central" : "filial",
      empresa: inst.company,
      nombre: inst.displayName,
      ip: inst.host,
      appPort: inst.port,
      pgHost: inst.host,
      pgPort: inst.kind === "central_instance"
        ? (inst.port === 8084 ? 5552 : 5551)
        : 5432,
      pgDatabase: inst.kind === "central_instance"
        ? (inst.environment ?? null)
        : "general",
      pgUser: "franco",
      pgPassword: null,
      channel: null,
      os: inst.environment?.includes("windows") ? "windows" : (inst.environment?.includes("linux") ? "linux" : null),
      sucursalId: sucursalMatch ? Number(sucursalMatch[1]) : null,
      githubEnvironment: inst.environment,
      active: inst.active,
      notes: inst.notes,
    }).run();
  }
  const created = db.select().from(schema.monitoredServers).all();
  console.log(`[migrate] auto-seed: ${created.length} servers desde instances`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
