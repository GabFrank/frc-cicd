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

const ALERT_RULE_DEFAULTS: Array<{
  kind: string;
  display_name: string;
  severity_default: string;
  pending_cycles: number;
  resolving_cycles: number;
  notes: string;
}> = [
  { kind: "filial_no_success", display_name: "Filial sin deployment exitoso", severity_default: "warn", pending_cycles: 3, resolving_cycles: 3, notes: "3 ciclos para evitar blip de red" },
  { kind: "filial_stale", display_name: "Filial sin update reciente", severity_default: "warn", pending_cycles: 3, resolving_cycles: 3, notes: ">2h warn, >12h critical" },
  { kind: "filial_failure", display_name: "Filial con último deploy failure", severity_default: "critical", pending_cycles: 1, resolving_cycles: 3, notes: "Evento discreto" },
  { kind: "filial_rollback", display_name: "Filial con rollback detectado", severity_default: "critical", pending_cycles: 1, resolving_cycles: 3, notes: "Evento discreto" },
  { kind: "central_down", display_name: "Instancia central DOWN", severity_default: "critical", pending_cycles: 1, resolving_cycles: 3, notes: "health_fail=3 interno" },
  { kind: "pg_cluster_down", display_name: "Cluster PG DOWN", severity_default: "critical", pending_cycles: 2, resolving_cycles: 3, notes: "2 ciclos para tolerar restart breve" },
  { kind: "replication_problem", display_name: "Replicación expected missing/inactive", severity_default: "warn", pending_cycles: 4, resolving_cycles: 3, notes: "4 ciclos — slots pueden parpadear" },
  { kind: "pg_connections_high", display_name: "Conexiones PG altas", severity_default: "warn", pending_cycles: 2, resolving_cycles: 3, notes: "Deshabilitada por default (env threshold=0)" },
  { kind: "replication_lag_high", display_name: "Lag WAL alto en slot", severity_default: "warn", pending_cycles: 3, resolving_cycles: 3, notes: ">100MB warn, >1GB critical" },
  { kind: "replication_apply_error", display_name: "Apply error en subscription", severity_default: "critical", pending_cycles: 2, resolving_cycles: 3, notes: "PG 15+ · transitorio en restart" },
  { kind: "replication_stale", display_name: "Subscription sin mensajes recientes", severity_default: "warn", pending_cycles: 3, resolving_cycles: 3, notes: ">10min warn, >1h critical" },
  { kind: "host_down", display_name: "Host DOWN (correlación)", severity_default: "critical", pending_cycles: 1, resolving_cycles: 3, notes: "Síntesis cuando ≥2 instancias del mismo IP caen simultáneo" },
  { kind: "host_unreachable", display_name: "Host no alcanzable (TCP)", severity_default: "critical", pending_cycles: 1, resolving_cycles: 3, notes: "TCP al host falla 2+ ciclos. Suprime todas las alertas de apps en ese host" },
];

function apply0003() {
  const cols = sqlite.prepare(`PRAGMA table_info(alerts)`).all() as Array<{ name: string }>;
  const hasState = cols.some((c) => c.name === "state");

  if (!hasState) {
    sqlite.exec(`
      ALTER TABLE alerts ADD COLUMN state TEXT NOT NULL DEFAULT 'pending';
      ALTER TABLE alerts ADD COLUMN consecutive_hits INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE alerts ADD COLUMN consecutive_clears INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE alerts ADD COLUMN promoted_at TEXT;
      ALTER TABLE alerts ADD COLUMN promotion_epoch INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS idx_alerts_state ON alerts(state);
    `);
    // Backfill alertas existentes
    sqlite.exec(`
      UPDATE alerts SET state='firing', consecutive_hits=10, promoted_at=first_seen_at
        WHERE resolved_at IS NULL;
      UPDATE alerts SET state='resolved' WHERE resolved_at IS NOT NULL;
    `);
    console.log("[migrate] 0003: alerts lifecycle columns + backfill");
  }

  // alert_rule_config table (idempotente)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS alert_rule_config (
      kind TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      severity_default TEXT NOT NULL,
      pending_cycles INTEGER NOT NULL DEFAULT 1,
      resolving_cycles INTEGER NOT NULL DEFAULT 3,
      enabled INTEGER NOT NULL DEFAULT 1,
      notes TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Seed defaults si no existe el kind (no sobreescribir ediciones del user)
  const stmt = sqlite.prepare(`
    INSERT OR IGNORE INTO alert_rule_config
      (kind, display_name, severity_default, pending_cycles, resolving_cycles, enabled, notes)
    VALUES (?, ?, ?, ?, ?, 1, ?)
  `);
  let seeded = 0;
  for (const r of ALERT_RULE_DEFAULTS) {
    const res = stmt.run(r.kind, r.display_name, r.severity_default, r.pending_cycles, r.resolving_cycles, r.notes);
    if (res.changes > 0) seeded += 1;
  }
  if (seeded > 0) console.log(`[migrate] 0003: seed alert_rule_config (${seeded} kinds nuevos)`);
}

function apply0005() {
  // Host reachability probe table (TCP-level, independiente de la app).
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS host_reachability (
      ip TEXT PRIMARY KEY,
      last_probe_at TEXT NOT NULL,
      reachable INTEGER NOT NULL,
      consecutive_unreachable INTEGER NOT NULL DEFAULT 0,
      last_reachable_at TEXT,
      probe_port INTEGER,
      latency_ms INTEGER,
      error_message TEXT
    );
  `);
}

function apply0004() {
  // Bump pending_cycles de kinds ruidosos si siguen en el default viejo.
  // Idempotente: solo actualiza si el valor actual coincide con el default viejo
  // (preserva ediciones manuales del user vía UI).
  const bumps: Array<{ kind: string; from: number; to: number }> = [
    { kind: "replication_problem", from: 2, to: 4 },
    { kind: "filial_stale", from: 1, to: 3 },
    { kind: "filial_no_success", from: 1, to: 3 },
    { kind: "replication_stale", from: 2, to: 3 },
    { kind: "replication_lag_high", from: 2, to: 3 },
    { kind: "pg_cluster_down", from: 1, to: 2 },
  ];
  let bumped = 0;
  const stmt = sqlite.prepare(
    `UPDATE alert_rule_config SET pending_cycles = ?, updated_at = CURRENT_TIMESTAMP
       WHERE kind = ? AND pending_cycles = ?`,
  );
  for (const b of bumps) {
    const res = stmt.run(b.to, b.kind, b.from);
    if (res.changes > 0) bumped += 1;
  }
  if (bumped > 0) console.log(`[migrate] 0004: bumped pending_cycles de ${bumped} kinds ruidosos`);
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

function cleanupStalePgRows() {
  // Filas con server_id IS NULL: legacy del modelo viejo (cluster_port era PK).
  const r1 = sqlite.prepare(`DELETE FROM pg_cluster_status WHERE server_id IS NULL`).run();
  const r2 = sqlite.prepare(`DELETE FROM pg_databases WHERE server_id IS NULL`).run();
  if (r1.changes > 0) console.log(`[migrate] cleanup pg_cluster_status legacy NULL: ${r1.changes}`);
  if (r2.changes > 0) console.log(`[migrate] cleanup pg_databases legacy NULL: ${r2.changes}`);

  // Filas con server_id huérfano (apuntan a un monitored_servers.id que ya no existe).
  // Ocurren cuando el registry se re-registra: los IDs nuevos no coinciden con los viejos
  // y las filas viejas quedan apuntando al vacío, generando alertas zombie.
  const o1 = sqlite.prepare(`
    DELETE FROM pg_cluster_status
    WHERE server_id IS NOT NULL
      AND server_id NOT IN (SELECT id FROM monitored_servers)
  `).run();
  const o2 = sqlite.prepare(`
    DELETE FROM pg_databases
    WHERE server_id IS NOT NULL
      AND server_id NOT IN (SELECT id FROM monitored_servers)
  `).run();
  const o3 = sqlite.prepare(`
    DELETE FROM health_checks
    WHERE server_id IS NOT NULL
      AND server_id NOT IN (SELECT id FROM monitored_servers)
  `).run();
  const o4 = sqlite.prepare(`
    DELETE FROM instance_runtime
    WHERE server_id IS NOT NULL
      AND server_id NOT IN (SELECT id FROM monitored_servers)
  `).run();
  if (o1.changes > 0) console.log(`[migrate] cleanup pg_cluster_status orphan: ${o1.changes}`);
  if (o2.changes > 0) console.log(`[migrate] cleanup pg_databases orphan: ${o2.changes}`);
  if (o3.changes > 0) console.log(`[migrate] cleanup health_checks orphan: ${o3.changes}`);
  if (o4.changes > 0) console.log(`[migrate] cleanup instance_runtime orphan: ${o4.changes}`);

  // Auto-resolver alertas con server_id huérfano (zombies por reseed del registry).
  const a1 = sqlite.prepare(`
    UPDATE alerts SET resolved_at = datetime('now')
    WHERE resolved_at IS NULL
      AND server_id IS NOT NULL
      AND server_id NOT IN (SELECT id FROM monitored_servers)
  `).run();
  if (a1.changes > 0) console.log(`[migrate] auto-resolve alertas con server_id huérfano: ${a1.changes}`);
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
  apply0003();
  apply0004();
  apply0005();

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
  cleanupStalePgRows();
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
