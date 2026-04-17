import { and, desc, eq, isNull } from "drizzle-orm";
import { db, schema } from "../lib/db";

interface Candidate {
  fingerprint: string;
  severity: "info" | "warn" | "critical";
  kind: string;
  instanceId?: number;
  componentId?: number;
  title: string;
  detail?: string;
}

const STALE_DEPLOYMENT_MS = 2 * 60 * 60 * 1000; // 2h
const HEALTH_FAIL_THRESHOLD = 3;

export async function evaluateAlerts() {
  const runId = db
    .insert(schema.syncRuns)
    .values({ jobName: "evaluate-alerts", ok: false, itemsIngested: 0 })
    .run();
  const sid = Number(runId.lastInsertRowid);

  const candidates: Candidate[] = [];
  try {
    const filiales = db
      .select()
      .from(schema.instances)
      .where(and(eq(schema.instances.kind, "filial"), eq(schema.instances.active, true)))
      .all();

    for (const f of filiales) {
      if (!f.environment) continue;
      const lastDeploys = db
        .select()
        .from(schema.deployments)
        .where(eq(schema.deployments.environment, f.environment))
        .orderBy(desc(schema.deployments.createdAt))
        .limit(5)
        .all();

      const lastSuccess = lastDeploys.find((d) => d.latestStatus === "success");
      const latestAttempt = lastDeploys[0];

      if (!lastSuccess || !lastSuccess.latestStatusAt) {
        candidates.push({
          fingerprint: `filial-no-success:${f.id}`,
          severity: "warn",
          kind: "filial_no_success",
          instanceId: f.id,
          componentId: f.componentId ?? undefined,
          title: `Filial ${f.displayName} sin deployment exitoso`,
          detail: `Último intento: ${latestAttempt?.latestStatus ?? "ninguno"}`,
        });
      } else {
        const age = Date.now() - new Date(lastSuccess.latestStatusAt).getTime();
        if (age > STALE_DEPLOYMENT_MS) {
          candidates.push({
            fingerprint: `filial-stale:${f.id}`,
            severity: age > 12 * 60 * 60 * 1000 ? "critical" : "warn",
            kind: "filial_stale",
            instanceId: f.id,
            componentId: f.componentId ?? undefined,
            title: `Filial ${f.displayName} sin update hace ${Math.round(age / 3600000)}h`,
            detail: `Último éxito: ${lastSuccess.latestStatusAt}`,
          });
        }
      }

      if (latestAttempt?.latestStatus === "failure") {
        candidates.push({
          fingerprint: `filial-failure:${f.id}:${latestAttempt.id}`,
          severity: "critical",
          kind: "filial_failure",
          instanceId: f.id,
          componentId: f.componentId ?? undefined,
          title: `Filial ${f.displayName} falló su último deploy`,
          detail: latestAttempt.latestStatusDescription ?? undefined,
        });
      }

      if (latestAttempt?.latestStatusDescription?.toLowerCase().includes("rolled back") ||
          latestAttempt?.latestStatusDescription?.toLowerCase().includes("rollback")) {
        candidates.push({
          fingerprint: `filial-rollback:${f.id}:${latestAttempt.id}`,
          severity: "critical",
          kind: "filial_rollback",
          instanceId: f.id,
          componentId: f.componentId ?? undefined,
          title: `Filial ${f.displayName} hizo rollback`,
          detail: latestAttempt.latestStatusDescription ?? undefined,
        });
      }
    }

    const centrals = db
      .select()
      .from(schema.instances)
      .where(and(eq(schema.instances.kind, "central_instance"), eq(schema.instances.active, true)))
      .all();

    for (const c of centrals) {
      const recent = db
        .select()
        .from(schema.healthChecks)
        .where(eq(schema.healthChecks.instanceId, c.id))
        .orderBy(desc(schema.healthChecks.checkedAt))
        .limit(HEALTH_FAIL_THRESHOLD)
        .all();

      if (recent.length >= HEALTH_FAIL_THRESHOLD && recent.every((h) => h.status === "down")) {
        candidates.push({
          fingerprint: `central-down:${c.id}`,
          severity: "critical",
          kind: "central_down",
          instanceId: c.id,
          componentId: c.componentId ?? undefined,
          title: `Instancia central ${c.displayName} DOWN`,
          detail: `Último HTTP: ${recent[0]?.httpCode ?? "timeout"}`,
        });
      }
    }

    const pgClusters = db.select().from(schema.pgClusterStatus).all();
    for (const cluster of pgClusters) {
      if (cluster.status !== "up") {
        candidates.push({
          fingerprint: `pg-cluster-down:${cluster.clusterPort}`,
          severity: "critical",
          kind: "pg_cluster_down",
          title: `Cluster PG ${cluster.label} (:${cluster.clusterPort}) DOWN`,
          detail: cluster.errorMessage ?? undefined,
        });
      }
    }

    const replItems = db.select().from(schema.pgReplicationItems).all();
    const slotsBySucursal = new Map<number, { c2f: boolean | null; f2c: boolean | null }>();
    for (const it of replItems) {
      if (it.kind !== "slot" || it.sucursalId == null) continue;
      const entry = slotsBySucursal.get(it.sucursalId) ?? { c2f: null, f2c: null };
      if (it.direction === "central_to_filial") entry.c2f = !!it.active;
      else if (it.direction === "filial_to_central") entry.f2c = !!it.active;
      slotsBySucursal.set(it.sucursalId, entry);
    }
    for (const [sid, entry] of slotsBySucursal.entries()) {
      if (entry.c2f === false || entry.f2c === false) {
        candidates.push({
          fingerprint: `repl-inactive:${sid}`,
          severity: "warn",
          kind: "replication_inactive",
          title: `Slot replicación inactivo en sucursal ${sid}`,
          detail: `C→F=${entry.c2f ?? "?"} · F→C=${entry.f2c ?? "?"}`,
        });
      }
    }

    const openFingerprints = new Set(candidates.map((c) => c.fingerprint));
    for (const c of candidates) {
      db.insert(schema.alerts)
        .values({
          severity: c.severity,
          kind: c.kind,
          instanceId: c.instanceId ?? null,
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

    const active = db
      .select()
      .from(schema.alerts)
      .where(isNull(schema.alerts.resolvedAt))
      .all();
    for (const a of active) {
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
