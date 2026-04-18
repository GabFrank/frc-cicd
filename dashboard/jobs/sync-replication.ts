import { eq } from "drizzle-orm";
import { db, schema } from "../lib/db";
import { withClient } from "../lib/pg";

interface Result {
  ok: boolean;
  itemsIngested: number;
  error?: string;
}

interface ServerProbe {
  status: "up" | "down";
  version: string | null;
  error: string | null;
  slots: Map<string, { active: boolean; extra: unknown }>;
  publications: Set<string>;
  subscriptions: Map<string, { active: boolean; extra: unknown }>;
  statRepl: Array<{ application_name: string; state: string; sync_state: string | null }>;
  databaseSize: number | null;
  activeConnections: number | null;
  latencyMs: number;
  sucursales: Array<{ id: number; ip: string | null; puerto: number | null; activo: boolean | null; nombre: string | null }>;
}

const DEFAULT_PG_PASSWORD = process.env.PG_PASSWORD ?? "";
const DEFAULT_PG_USER = process.env.PG_USER ?? "";

async function probeServer(server: typeof schema.monitoredServers.$inferSelect): Promise<ServerProbe> {
  const probe: ServerProbe = {
    status: "down",
    version: null,
    error: null,
    slots: new Map(),
    publications: new Set(),
    subscriptions: new Map(),
    statRepl: [],
    databaseSize: null,
    activeConnections: null,
    latencyMs: 0,
    sucursales: [],
  };

  if (!server.pgHost || !server.pgPort || !server.pgDatabase) {
    probe.error = "PG endpoint incompleto (host/port/database)";
    return probe;
  }

  const user = server.pgUser ?? DEFAULT_PG_USER;
  const password = server.pgPassword ?? DEFAULT_PG_PASSWORD;
  if (!user) {
    probe.error = "Sin pg_user configurado";
    return probe;
  }

  const t0 = Date.now();
  try {
    await withClient(
      {
        host: server.pgHost,
        port: server.pgPort,
        user,
        password,
        database: server.pgDatabase,
        statementTimeoutMs: 6000,
      },
      async (c) => {
        const v = await c.query<{ version: string }>("SELECT version() as version");
        probe.version = v.rows[0]?.version ?? null;
        probe.status = "up";

        const sz = await c.query<{ size: string }>(
          "SELECT pg_database_size(current_database())::text AS size",
        );
        probe.databaseSize = Number(sz.rows[0]?.size ?? 0);

        const ac = await c.query<{ c: string }>(
          "SELECT count(*)::text AS c FROM pg_stat_activity WHERE datname = current_database()",
        );
        probe.activeConnections = Number(ac.rows[0]?.c ?? 0);

        const slots = await c.query<{
          slot_name: string;
          active: boolean;
          slot_type: string;
          restart_lsn: string | null;
          confirmed_flush_lsn: string | null;
        }>(
          `SELECT slot_name, active, slot_type, restart_lsn::text, confirmed_flush_lsn::text FROM pg_replication_slots`,
        );
        for (const s of slots.rows) {
          probe.slots.set(s.slot_name, {
            active: !!s.active,
            extra: { slot_type: s.slot_type, restart_lsn: s.restart_lsn, confirmed_flush_lsn: s.confirmed_flush_lsn },
          });
        }

        const pubs = await c.query<{ pubname: string }>("SELECT pubname FROM pg_publication");
        for (const p of pubs.rows) probe.publications.add(p.pubname);

        try {
          const subs = await c.query<{
            subname: string;
            subenabled: boolean;
            pid: number | null;
            received_lsn: string | null;
            latest_end_time: string | null;
          }>(
            `SELECT s.subname, s.subenabled, st.pid, st.received_lsn::text, st.latest_end_time::text
             FROM pg_subscription s
             LEFT JOIN pg_stat_subscription st ON st.subname = s.subname`,
          );
          for (const sub of subs.rows) {
            probe.subscriptions.set(sub.subname, {
              active: !!sub.subenabled && sub.pid != null,
              extra: { enabled: sub.subenabled, pid: sub.pid, received_lsn: sub.received_lsn, latest_end_time: sub.latest_end_time },
            });
          }
        } catch {
          /* requiere GRANT, silenciar */
        }

        const stat = await c.query<{
          application_name: string | null;
          state: string | null;
          sync_state: string | null;
        }>(`SELECT application_name, state, sync_state FROM pg_stat_replication`);
        for (const r of stat.rows) {
          if (!r.application_name) continue;
          probe.statRepl.push({
            application_name: r.application_name,
            state: r.state ?? "",
            sync_state: r.sync_state,
          });
        }

        try {
          const suc = await c.query<{
            id: number;
            ip: string | null;
            puerto: number | null;
            activo: boolean;
            nombre: string | null;
          }>(`SELECT id, ip, puerto, activo, NULL::text AS nombre FROM empresarial.sucursal`);
          probe.sucursales = suc.rows;
        } catch {
          /* tabla puede no existir en filiales */
        }
      },
    );
  } catch (e) {
    probe.error = e instanceof Error ? e.message.slice(0, 500) : String(e).slice(0, 500);
  }

  probe.latencyMs = Date.now() - t0;
  return probe;
}

function persistServerSnapshot(server: typeof schema.monitoredServers.$inferSelect, probe: ServerProbe) {
  const port = server.pgPort ?? 0;
  const label = `${server.empresa ?? "?"}/${server.nombre}`;

  db.insert(schema.pgClusterStatus)
    .values({
      clusterPort: port,
      label,
      status: probe.status,
      version: probe.version,
      errorMessage: probe.error,
      checkedAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: schema.pgClusterStatus.clusterPort,
      set: {
        label,
        status: probe.status,
        version: probe.version,
        errorMessage: probe.error,
        checkedAt: new Date().toISOString(),
      },
    })
    .run();

  if (server.pgDatabase) {
    const existing = db
      .select()
      .from(schema.pgDatabases)
      .all()
      .filter((r) => r.clusterPort === port && r.name === server.pgDatabase);
    const values = {
      clusterPort: port,
      name: server.pgDatabase,
      sizeBytes: probe.databaseSize,
      activeConnections: probe.activeConnections,
      latencyMs: probe.latencyMs,
      status: probe.status,
      errorMessage: probe.error,
      checkedAt: new Date().toISOString(),
    };
    if (existing.length === 0) {
      db.insert(schema.pgDatabases).values(values).run();
    } else {
      db.update(schema.pgDatabases).set(values).where(eq(schema.pgDatabases.id, existing[0].id)).run();
    }
  }

  for (const s of probe.sucursales) {
    db.insert(schema.sucursales)
      .values({
        id: s.id,
        nombre: s.nombre,
        ip: s.ip,
        puerto: s.puerto,
        activo: s.activo,
        sourceClusterPort: port,
        sourceDatabase: server.pgDatabase,
        updatedAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: schema.sucursales.id,
        set: {
          nombre: s.nombre,
          ip: s.ip,
          puerto: s.puerto,
          activo: s.activo,
          sourceClusterPort: port,
          sourceDatabase: server.pgDatabase,
          updatedAt: new Date().toISOString(),
        },
      })
      .run();
  }
}

function evaluateExpected(serverId: number, probe: ServerProbe) {
  const expected = db
    .select()
    .from(schema.expectedReplication)
    .where(eq(schema.expectedReplication.serverId, serverId))
    .all();

  for (const e of expected) {
    let status: "found" | "missing" = "missing";
    let active: boolean | null = null;
    let extra: unknown = null;

    if (e.kind === "publication") {
      if (probe.publications.has(e.name)) {
        status = "found";
        active = true;
      }
    } else if (e.kind === "slot") {
      const s = probe.slots.get(e.name);
      if (s) {
        status = "found";
        active = s.active;
        extra = s.extra;
      }
    } else if (e.kind === "subscription") {
      const s = probe.subscriptions.get(e.name);
      if (s) {
        status = "found";
        active = s.active;
        extra = s.extra;
      }
    }

    db.insert(schema.replicationCheckResults)
      .values({
        expectedId: e.id,
        status,
        active,
        extraJson: extra ? JSON.stringify(extra) : null,
        checkedAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: schema.replicationCheckResults.expectedId,
        set: {
          status,
          active,
          extraJson: extra ? JSON.stringify(extra) : null,
          checkedAt: new Date().toISOString(),
        },
      })
      .run();
  }
}

export async function syncReplication(): Promise<Result> {
  const runId = db
    .insert(schema.syncRuns)
    .values({ jobName: "sync-replication", ok: false, itemsIngested: 0 })
    .run();
  const sid = Number(runId.lastInsertRowid);

  const servers = db
    .select()
    .from(schema.monitoredServers)
    .where(eq(schema.monitoredServers.active, true))
    .all();

  if (servers.length === 0) {
    db.update(schema.syncRuns)
      .set({
        finishedAt: new Date().toISOString(),
        ok: true,
        itemsIngested: 0,
        errorMessage: "Sin monitored_servers activos",
      })
      .where(eq(schema.syncRuns.id, sid))
      .run();
    return { ok: true, itemsIngested: 0 };
  }

  let total = 0;
  try {
    for (const server of servers) {
      const probe = await probeServer(server);
      persistServerSnapshot(server, probe);
      if (probe.status === "up") {
        evaluateExpected(server.id, probe);
        total += 1;
      } else {
        console.warn(`[sync-replication] ${server.nombre}: ${probe.error}`);
      }
    }

    db.update(schema.syncRuns)
      .set({ finishedAt: new Date().toISOString(), ok: true, itemsIngested: total })
      .where(eq(schema.syncRuns.id, sid))
      .run();

    return { ok: true, itemsIngested: total };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    db.update(schema.syncRuns)
      .set({ finishedAt: new Date().toISOString(), ok: false, errorMessage: msg })
      .where(eq(schema.syncRuns.id, sid))
      .run();
    throw err;
  }
}
