import { and, desc, eq, isNull, inArray } from "drizzle-orm";
import { db, schema } from "../lib/db";

interface Candidate {
  fingerprint: string;
  severity: "info" | "warn" | "critical";
  kind: string;
  serverId?: number;
  componentId?: number;
  title: string;
  detail?: string;
}

const STALE_DEPLOYMENT_MS = 2 * 60 * 60 * 1000; // 2h
const HEALTH_FAIL_THRESHOLD = 3;

const PG_CONN_WARN = Number(process.env.PG_CONN_WARN ?? 50);
const PG_CONN_CRIT = Number(process.env.PG_CONN_CRIT ?? 90);

export async function evaluateAlerts() {
  const runId = db
    .insert(schema.syncRuns)
    .values({ jobName: "evaluate-alerts", ok: false, itemsIngested: 0 })
    .run();
  const sid = Number(runId.lastInsertRowid);

  const candidates: Candidate[] = [];
  try {
    const servers = db
      .select()
      .from(schema.monitoredServers)
      .where(eq(schema.monitoredServers.active, true))
      .all();
    const serversById = new Map(servers.map((s) => [s.id, s]));

    // Filiales: chequear deployments por github_environment
    const filiales = servers.filter((s) => s.kind === "filial" && s.githubEnvironment);
    for (const f of filiales) {
      const env = f.githubEnvironment as string;
      const deps: typeof schema.deployments.$inferSelect[] = db
        .select()
        .from(schema.deployments)
        .where(eq(schema.deployments.environment, env))
        .orderBy(desc(schema.deployments.createdAt))
        .limit(5)
        .all();

      const lastSuccess = deps.find((d) => d.latestStatus === "success");
      const latestAttempt = deps[0];

      if (!latestAttempt) {
        // No hay ningún deployment para este environment — no generar alerta zombie.
        continue;
      }

      if (!lastSuccess) {
        candidates.push({
          fingerprint: `filial-no-success:srv:${f.id}`,
          severity: "warn",
          kind: "filial_no_success",
          serverId: f.id,
          
          title: `Filial ${f.nombre} sin deployment exitoso`,
          detail: `Último intento: ${latestAttempt.latestStatus ?? "desconocido"}`,
        });
      } else if (lastSuccess.latestStatusAt) {
        const age = Date.now() - new Date(lastSuccess.latestStatusAt).getTime();
        if (age > STALE_DEPLOYMENT_MS) {
          candidates.push({
            fingerprint: `filial-stale:srv:${f.id}`,
            severity: age > 12 * 60 * 60 * 1000 ? "critical" : "warn",
            kind: "filial_stale",
            serverId: f.id,
            
            title: `Filial ${f.nombre} sin update hace ${Math.round(age / 3600000)}h`,
            detail: `Último éxito: ${lastSuccess.latestStatusAt}`,
          });
        }
      }

      if (latestAttempt.latestStatus === "failure") {
        candidates.push({
          fingerprint: `filial-failure:srv:${f.id}:${latestAttempt.id}`,
          severity: "critical",
          kind: "filial_failure",
          serverId: f.id,
          
          title: `Filial ${f.nombre} falló su último deploy`,
          detail: latestAttempt.latestStatusDescription ?? undefined,
        });
      }

      const descLower = latestAttempt.latestStatusDescription?.toLowerCase() ?? "";
      if (descLower.includes("rolled back") || descLower.includes("rollback")) {
        candidates.push({
          fingerprint: `filial-rollback:srv:${f.id}:${latestAttempt.id}`,
          severity: "critical",
          kind: "filial_rollback",
          serverId: f.id,
          
          title: `Filial ${f.nombre} hizo rollback`,
          detail: latestAttempt.latestStatusDescription ?? undefined,
        });
      }
    }

    // Centrales: chequear health_checks por server_id
    const centrales = servers.filter((s) => s.kind === "central");
    for (const c of centrales) {
      const recent = db
        .select()
        .from(schema.healthChecks)
        .where(eq(schema.healthChecks.serverId, c.id))
        .orderBy(desc(schema.healthChecks.checkedAt))
        .limit(HEALTH_FAIL_THRESHOLD)
        .all();

      if (recent.length >= HEALTH_FAIL_THRESHOLD && recent.every((h) => h.status === "down")) {
        candidates.push({
          fingerprint: `central-down:srv:${c.id}`,
          severity: "critical",
          kind: "central_down",
          serverId: c.id,
          
          title: `Instancia central ${c.nombre} DOWN`,
          detail: `Último HTTP: ${recent[0]?.httpCode ?? "timeout"}`,
        });
      }
    }

    // Cluster PG por server
    const pgClusters = db.select().from(schema.pgClusterStatus).all();
    for (const cluster of pgClusters) {
      if (cluster.status !== "up" && cluster.serverId) {
        const srv = serversById.get(cluster.serverId);
        candidates.push({
          fingerprint: `pg-cluster-down:srv:${cluster.serverId}`,
          severity: "critical",
          kind: "pg_cluster_down",
          serverId: cluster.serverId,
          title: `Cluster PG ${srv?.nombre ?? cluster.label} DOWN`,
          detail: cluster.errorMessage ?? undefined,
        });
      }
    }

    // Replicación esperada vs encontrada
    const checkResults = db
      .select()
      .from(schema.replicationCheckResults)
      .all();
    const expected = db.select().from(schema.expectedReplication).all();
    const expectedById = new Map(expected.map((e) => [e.id, e]));
    for (const r of checkResults) {
      const exp = expectedById.get(r.expectedId);
      if (!exp) continue;
      const isOk = r.status === "found" && r.active === true;
      if (isOk) continue;
      const srv = serversById.get(exp.serverId);
      if (!srv) continue;
      const sev: "warn" | "critical" =
        r.status === "missing" ? "critical" : "warn";
      candidates.push({
        fingerprint: `repl:srv:${exp.serverId}:exp:${exp.id}`,
        severity: sev,
        kind: "replication_problem",
        serverId: exp.serverId,
        title: `${exp.kind} '${exp.name}' ${r.status === "missing" ? "NO encontrado" : "INACTIVO"} en ${srv.nombre}`,
        detail: `Status=${r.status} active=${r.active}`,
      });
    }

    // Conexiones PG altas
    const pgDbs = db.select().from(schema.pgDatabases).all();
    for (const d of pgDbs) {
      if (d.activeConnections == null || d.serverId == null) continue;
      if (d.activeConnections >= PG_CONN_CRIT) {
        const srv = serversById.get(d.serverId);
        candidates.push({
          fingerprint: `pg-conn:srv:${d.serverId}:${d.name}`,
          severity: "critical",
          kind: "pg_connections_high",
          serverId: d.serverId,
          title: `${d.activeConnections} conexiones en ${srv?.nombre ?? "?"}/${d.name}`,
          detail: `Threshold critical: ${PG_CONN_CRIT}`,
        });
      } else if (d.activeConnections >= PG_CONN_WARN) {
        const srv = serversById.get(d.serverId);
        candidates.push({
          fingerprint: `pg-conn:srv:${d.serverId}:${d.name}`,
          severity: "warn",
          kind: "pg_connections_high",
          serverId: d.serverId,
          title: `${d.activeConnections} conexiones en ${srv?.nombre ?? "?"}/${d.name}`,
          detail: `Threshold warn: ${PG_CONN_WARN}`,
        });
      }
    }

    // Persistir candidatos
    const openFingerprints = new Set(candidates.map((c) => c.fingerprint));
    for (const c of candidates) {
      db.insert(schema.alerts)
        .values({
          severity: c.severity,
          kind: c.kind,
          serverId: c.serverId ?? null,
          componentId: c.componentId ?? null,
          title: c.title,
          detail: c.detail ?? null,
          fingerprint: c.fingerprint,
        })
        .onConflictDoUpdate({
          target: schema.alerts.fingerprint,
          set: {
            severity: c.severity,
            title: c.title,
            detail: c.detail ?? null,
            lastSeenAt: new Date().toISOString(),
            resolvedAt: null,
          },
        })
        .run();
    }

    // Auto-resolver alertas que ya no aplican (con prefix :srv:)
    const active = db
      .select()
      .from(schema.alerts)
      .where(isNull(schema.alerts.resolvedAt))
      .all();
    for (const a of active) {
      if (!a.fingerprint.includes(":srv:")) continue;
      if (!openFingerprints.has(a.fingerprint)) {
        db.update(schema.alerts)
          .set({ resolvedAt: new Date().toISOString() })
          .where(eq(schema.alerts.id, a.id))
          .run();
      }
    }

    db.update(schema.syncRuns)
      .set({
        finishedAt: new Date().toISOString(),
        ok: true,
        itemsIngested: candidates.length,
      })
      .where(eq(schema.syncRuns.id, sid))
      .run();

    return { ok: true, itemsIngested: candidates.length };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    db.update(schema.syncRuns)
      .set({ finishedAt: new Date().toISOString(), ok: false, errorMessage: msg })
      .where(eq(schema.syncRuns.id, sid))
      .run();
    throw err;
  }
}
