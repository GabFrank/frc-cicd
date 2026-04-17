import { eq } from "drizzle-orm";
import { db, schema } from "../lib/db";
import {
  parseClusters,
  parseSucursalFromPublication,
  parseSucursalFromSlot,
  withClient,
} from "../lib/pg";

interface Result {
  ok: boolean;
  itemsIngested: number;
  error?: string;
}

async function probeCluster(clusterPort: number, label: string, pgHost: string, pgUser: string, pgPass: string, databases: string[]): Promise<{ status: "up" | "down"; error: string | null }> {
  let version: string | null = null;
  let status: "up" | "down" = "down";
  let error: string | null = null;

  const connectDb = databases[0] ?? "postgres";
  try {
    await withClient(
      { host: pgHost, port: clusterPort, user: pgUser, password: pgPass, database: connectDb },
      async (c) => {
        const v = await c.query<{ version: string }>("SELECT version() as version");
        version = v.rows[0]?.version ?? null;
        status = "up";
      },
    );
  } catch (e) {
    error = e instanceof Error ? e.message.slice(0, 500) : String(e).slice(0, 500);
  }

  db.insert(schema.pgClusterStatus)
    .values({
      clusterPort,
      label,
      status,
      version,
      errorMessage: error,
      checkedAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: schema.pgClusterStatus.clusterPort,
      set: { label, status, version, errorMessage: error, checkedAt: new Date().toISOString() },
    })
    .run();

  return { status, error };
}

async function probeDatabase(
  clusterPort: number,
  dbName: string,
  pgHost: string,
  pgUser: string,
  pgPass: string,
) {
  const t0 = Date.now();
  let size: number | null = null;
  let conns: number | null = null;
  let dbStatus: "up" | "down" = "down";
  let error: string | null = null;

  try {
    await withClient(
      { host: pgHost, port: clusterPort, user: pgUser, password: pgPass, database: dbName },
      async (c) => {
        const s = await c.query<{ size: string }>(
          "SELECT pg_database_size(current_database())::text AS size",
        );
        size = Number(s.rows[0]?.size ?? 0);
        const a = await c.query<{ c: string }>(
          "SELECT count(*)::text AS c FROM pg_stat_activity WHERE datname = current_database()",
        );
        conns = Number(a.rows[0]?.c ?? 0);
        dbStatus = "up";
      },
    );
  } catch (e) {
    error = e instanceof Error ? e.message.slice(0, 500) : String(e).slice(0, 500);
  }

  const latency = Date.now() - t0;

  const existing = db
    .select()
    .from(schema.pgDatabases)
    .all()
    .filter((r) => r.clusterPort === clusterPort && r.name === dbName);

  const values = {
    clusterPort,
    name: dbName,
    sizeBytes: size,
    activeConnections: conns,
    latencyMs: latency,
    status: dbStatus,
    errorMessage: error,
    checkedAt: new Date().toISOString(),
  };

  if (existing.length === 0) {
    db.insert(schema.pgDatabases).values(values).run();
  } else {
    db.update(schema.pgDatabases).set(values).where(eq(schema.pgDatabases.id, existing[0].id)).run();
  }
}

async function collectReplication(
  clusterPort: number,
  pgHost: string,
  pgUser: string,
  pgPass: string,
  databases: string[],
) {
  db.delete(schema.pgReplicationItems).where(eq(schema.pgReplicationItems.clusterPort, clusterPort)).run();

  const now = new Date().toISOString();

  for (const dbName of databases) {
    try {
      await withClient(
        { host: pgHost, port: clusterPort, user: pgUser, password: pgPass, database: dbName },
        async (c) => {
          const slots = await c.query<{
            slot_name: string;
            active: boolean;
            database: string | null;
            slot_type: string;
            restart_lsn: string | null;
            confirmed_flush_lsn: string | null;
          }>(
            `SELECT slot_name, active, database, slot_type, restart_lsn::text, confirmed_flush_lsn::text
             FROM pg_replication_slots`,
          );
          for (const s of slots.rows) {
            const parsed = parseSucursalFromSlot(s.slot_name);
            db.insert(schema.pgReplicationItems)
              .values({
                clusterPort,
                kind: "slot",
                name: s.slot_name,
                database: s.database ?? dbName,
                active: !!s.active,
                sucursalId: parsed.sucursalId ?? undefined,
                direction: parsed.direction ?? undefined,
                extraJson: JSON.stringify({
                  slot_type: s.slot_type,
                  restart_lsn: s.restart_lsn,
                  confirmed_flush_lsn: s.confirmed_flush_lsn,
                }),
                checkedAt: now,
              })
              .run();
          }

          const pubs = await c.query<{ pubname: string }>(
            "SELECT pubname FROM pg_publication",
          );
          for (const p of pubs.rows) {
            const parsed = parseSucursalFromPublication(p.pubname);
            db.insert(schema.pgReplicationItems)
              .values({
                clusterPort,
                kind: "publication",
                name: p.pubname,
                database: dbName,
                active: true,
                sucursalId: parsed.sucursalId ?? undefined,
                direction: null,
                checkedAt: now,
              })
              .run();
          }

          try {
            const subs = await c.query<{
              subname: string;
              subenabled: boolean;
              pid: number | null;
              received_lsn: string | null;
              latest_end_time: string | null;
              last_msg_receipt_time: string | null;
            }>(
              `SELECT s.subname,
                      s.subenabled,
                      st.pid,
                      st.received_lsn::text,
                      st.latest_end_time::text,
                      st.last_msg_receipt_time::text
               FROM pg_subscription s
               LEFT JOIN pg_stat_subscription st ON st.subname = s.subname`,
            );
            for (const sub of subs.rows) {
              const parsed = parseSucursalFromSlot(sub.subname);
              db.insert(schema.pgReplicationItems)
                .values({
                  clusterPort,
                  kind: "subscription",
                  name: sub.subname,
                  database: dbName,
                  active: !!sub.subenabled && sub.pid != null,
                  sucursalId: parsed.sucursalId ?? undefined,
                  direction: parsed.direction ?? undefined,
                  extraJson: JSON.stringify({
                    enabled: sub.subenabled,
                    pid: sub.pid,
                    received_lsn: sub.received_lsn,
                    latest_end_time: sub.latest_end_time,
                    last_msg_receipt_time: sub.last_msg_receipt_time,
                  }),
                  checkedAt: now,
                })
                .run();
            }
          } catch (err) {
            // pg_subscription requiere SELECT grant; si falla se silencia.
            console.warn(`[sync-replication] pg_subscription en ${dbName}:`, err instanceof Error ? err.message : String(err));
          }

          const stat = await c.query<{
            application_name: string | null;
            state: string | null;
            sync_state: string | null;
            write_lag: string | null;
            flush_lag: string | null;
            replay_lag: string | null;
          }>(
            `SELECT application_name, state, sync_state,
                    write_lag::text, flush_lag::text, replay_lag::text
             FROM pg_stat_replication`,
          );
          for (const r of stat.rows) {
            if (!r.application_name) continue;
            db.insert(schema.pgReplicationItems)
              .values({
                clusterPort,
                kind: "stat_replication",
                name: r.application_name,
                database: dbName,
                active: r.state === "streaming",
                extraJson: JSON.stringify(r),
                checkedAt: now,
              })
              .run();
          }

          try {
            const suc = await c.query<{
              id: number;
              ip: string | null;
              puerto: number | null;
              activo: boolean;
              nombre: string | null;
            }>(
              `SELECT id, ip, puerto, activo,
                      COALESCE(
                        (SELECT nombre FROM empresarial.sucursal s2 WHERE s2.id = empresarial.sucursal.id),
                        NULL
                      ) AS nombre
               FROM empresarial.sucursal`,
            );
            for (const s of suc.rows) {
              db.insert(schema.sucursales)
                .values({
                  id: s.id,
                  nombre: s.nombre,
                  ip: s.ip,
                  puerto: s.puerto,
                  activo: s.activo,
                  sourceClusterPort: clusterPort,
                  sourceDatabase: dbName,
                  updatedAt: now,
                })
                .onConflictDoUpdate({
                  target: schema.sucursales.id,
                  set: {
                    nombre: s.nombre,
                    ip: s.ip,
                    puerto: s.puerto,
                    activo: s.activo,
                    sourceClusterPort: clusterPort,
                    sourceDatabase: dbName,
                    updatedAt: now,
                  },
                })
                .run();
            }
          } catch {
            /* tabla puede no existir en todas las DBs */
          }
        },
      );
    } catch (err) {
      console.warn(
        `[sync-replication] cluster ${clusterPort} db=${dbName}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

export async function syncReplication(): Promise<Result> {
  const runId = db
    .insert(schema.syncRuns)
    .values({ jobName: "sync-replication", ok: false, itemsIngested: 0 })
    .run();
  const sid = Number(runId.lastInsertRowid);

  const pgHost = process.env.PG_HOST ?? "localhost";
  const pgUser = process.env.PG_USER ?? "";
  const pgPass = process.env.PG_PASSWORD ?? "";
  const clusters = parseClusters(process.env.PG_CLUSTERS);

  if (clusters.length === 0 || !pgUser) {
    db.update(schema.syncRuns)
      .set({
        finishedAt: new Date().toISOString(),
        ok: true,
        itemsIngested: 0,
        errorMessage: "PG_CLUSTERS o PG_USER vacíos — skip",
      })
      .where(eq(schema.syncRuns.id, sid))
      .run();
    return { ok: true, itemsIngested: 0, error: "disabled" };
  }

  let total = 0;
  try {
    for (const cluster of clusters) {
      const probe = await probeCluster(cluster.port, cluster.label, pgHost, pgUser, pgPass, cluster.databases);
      if (probe.status !== "up") {
        console.warn(`[sync-replication] cluster ${cluster.port} down: ${probe.error}`);
        continue;
      }
      for (const dbName of cluster.databases) {
        await probeDatabase(cluster.port, dbName, pgHost, pgUser, pgPass);
        total += 1;
      }
      await collectReplication(cluster.port, pgHost, pgUser, pgPass, cluster.databases);
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
