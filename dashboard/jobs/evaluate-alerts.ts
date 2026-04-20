import { and, desc, eq, isNull } from "drizzle-orm";
import { db, schema } from "../lib/db";

interface Candidate {
  fingerprint: string;
  severity: "info" | "warn" | "critical";
  kind: string;
  serverId?: number;
  title: string;
  detail?: string;
}

const STALE_DEPLOYMENT_MS = 2 * 60 * 60 * 1000; // 2h

// Thresholds fuera de la state machine (confirmación interna previa).
const HEALTH_FAIL_THRESHOLD = 3;

const REPL_LAG_WARN = Number(process.env.REPL_LAG_WARN ?? 100 * 1024 * 1024); // 100MB
const REPL_LAG_CRIT = Number(process.env.REPL_LAG_CRIT ?? 1024 * 1024 * 1024); // 1GB
const REPL_STALE_WARN_SEC = Number(process.env.REPL_STALE_WARN_SEC ?? 600); // 10 min
const REPL_STALE_CRIT_SEC = Number(process.env.REPL_STALE_CRIT_SEC ?? 3600); // 1h

const PG_CONN_WARN = Number(process.env.PG_CONN_WARN ?? 0);
const PG_CONN_CRIT = Number(process.env.PG_CONN_CRIT ?? 0);

interface RuleConfig {
  kind: string;
  pendingCycles: number;
  resolvingCycles: number;
  enabled: boolean;
}

function loadRuleConfig(): Map<string, RuleConfig> {
  const rows = db.select().from(schema.alertRuleConfig).all();
  return new Map(
    rows.map((r) => [
      r.kind,
      {
        kind: r.kind,
        pendingCycles: Math.max(1, r.pendingCycles),
        resolvingCycles: Math.max(1, r.resolvingCycles),
        enabled: !!r.enabled,
      },
    ]),
  );
}

function lastSyncRunOk(jobName: string): { recent: boolean; ok: boolean } {
  const row = db
    .select()
    .from(schema.syncRuns)
    .where(eq(schema.syncRuns.jobName, jobName))
    .orderBy(desc(schema.syncRuns.startedAt))
    .limit(1)
    .all()[0];
  if (!row) return { recent: false, ok: false };
  const started = new Date(row.startedAt.replace(" ", "T") + (row.startedAt.endsWith("Z") ? "" : "Z")).getTime();
  const ageMs = Date.now() - started;
  return { recent: ageMs < 3 * 60 * 1000, ok: !!row.ok };
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

export async function evaluateAlerts() {
  const runId = db
    .insert(schema.syncRuns)
    .values({ jobName: "evaluate-alerts", ok: false, itemsIngested: 0 })
    .run();
  const sid = Number(runId.lastInsertRowid);

  try {
    const ruleConfig = loadRuleConfig();
    const candidates: Candidate[] = [];

    const servers = db
      .select()
      .from(schema.monitoredServers)
      .where(eq(schema.monitoredServers.active, true))
      .all();
    const serversById = new Map(servers.map((s) => [s.id, s]));

    const healthHealth = lastSyncRunOk("sync-health");
    const replicationHealth = lastSyncRunOk("sync-replication");
    const healthyDeps = {
      health: healthHealth.recent && healthHealth.ok,
      replication: replicationHealth.recent && replicationHealth.ok,
    };

    // ========== Reglas que generan candidates ==========

    // Filial deployment rules
    if (ruleConfig.get("filial_no_success")?.enabled !== false
        || ruleConfig.get("filial_stale")?.enabled !== false
        || ruleConfig.get("filial_failure")?.enabled !== false
        || ruleConfig.get("filial_rollback")?.enabled !== false) {
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
        if (!latestAttempt) continue;

        if (ruleConfig.get("filial_no_success")?.enabled !== false && !lastSuccess) {
          candidates.push({
            fingerprint: `filial-no-success:srv:${f.id}`,
            severity: "warn",
            kind: "filial_no_success",
            serverId: f.id,
            title: `Filial ${f.nombre} sin deployment exitoso`,
            detail: `Último intento: ${latestAttempt.latestStatus ?? "desconocido"}`,
          });
        } else if (ruleConfig.get("filial_stale")?.enabled !== false && lastSuccess?.latestStatusAt) {
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

        if (ruleConfig.get("filial_failure")?.enabled !== false && latestAttempt.latestStatus === "failure") {
          candidates.push({
            fingerprint: `filial-failure:srv:${f.id}:${latestAttempt.id}`,
            severity: "critical",
            kind: "filial_failure",
            serverId: f.id,
            title: `Filial ${f.nombre} falló su último deploy`,
            detail: latestAttempt.latestStatusDescription ?? undefined,
          });
        }

        if (ruleConfig.get("filial_rollback")?.enabled !== false) {
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
      }
    }

    // Central down — threshold interno de 3 health_checks
    if (ruleConfig.get("central_down")?.enabled !== false) {
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
    }

    // PG cluster down
    if (ruleConfig.get("pg_cluster_down")?.enabled !== false) {
      const pgClusters = db.select().from(schema.pgClusterStatus).all();
      for (const cluster of pgClusters) {
        if (cluster.status === "up" || !cluster.serverId) continue;
        const srv = serversById.get(cluster.serverId);
        if (!srv) continue;
        candidates.push({
          fingerprint: `pg-cluster-down:srv:${cluster.serverId}`,
          severity: "critical",
          kind: "pg_cluster_down",
          serverId: cluster.serverId,
          title: `Cluster PG ${srv.nombre} DOWN`,
          detail: cluster.errorMessage ?? undefined,
        });
      }
    }

    // Replicación esperada vs encontrada
    if (ruleConfig.get("replication_problem")?.enabled !== false) {
      const checkResults = db.select().from(schema.replicationCheckResults).all();
      const expected = db.select().from(schema.expectedReplication).all();
      const expectedById = new Map(expected.map((e) => [e.id, e]));
      for (const r of checkResults) {
        const exp = expectedById.get(r.expectedId);
        if (!exp) continue;
        const isOk = r.status === "found" && r.active === true;
        if (isOk) continue;
        const srv = serversById.get(exp.serverId);
        if (!srv) continue;
        const sev: "warn" | "critical" = r.status === "missing" ? "critical" : "warn";
        candidates.push({
          fingerprint: `repl:srv:${exp.serverId}:exp:${exp.id}`,
          severity: sev,
          kind: "replication_problem",
          serverId: exp.serverId,
          title: `${exp.kind} '${exp.name}' ${r.status === "missing" ? "NO encontrado" : "INACTIVO"} en ${srv.nombre}`,
          detail: `Status=${r.status} active=${r.active}`,
        });
      }
    }

    // Replication lag high — lee replication_check_results.extra_json para slots
    if (ruleConfig.get("replication_lag_high")?.enabled !== false) {
      const expected = db.select().from(schema.expectedReplication).all();
      const expectedById = new Map(expected.map((e) => [e.id, e]));
      const checkResults = db.select().from(schema.replicationCheckResults).all();
      for (const r of checkResults) {
        const exp = expectedById.get(r.expectedId);
        if (!exp || exp.kind !== "slot" || r.status !== "found") continue;
        const srv = serversById.get(exp.serverId);
        if (!srv) continue;
        const extra = r.extraJson ? JSON.parse(r.extraJson) : null;
        const lag: number | null = extra?.lag_bytes ?? null;
        if (lag == null || lag < REPL_LAG_WARN) continue;
        const sev: "warn" | "critical" = lag >= REPL_LAG_CRIT ? "critical" : "warn";
        candidates.push({
          fingerprint: `repl-lag:srv:${exp.serverId}:${exp.name}`,
          severity: sev,
          kind: "replication_lag_high",
          serverId: exp.serverId,
          title: `Slot '${exp.name}' con lag ${fmtBytes(lag)} en ${srv.nombre}`,
          detail: `confirmed_flush vs current_wal_lsn = ${fmtBytes(lag)}`,
        });
      }
    }

    // Replication apply error / stale — lee de replication_check_results para subs
    if (ruleConfig.get("replication_apply_error")?.enabled !== false
        || ruleConfig.get("replication_stale")?.enabled !== false) {
      const expected = db.select().from(schema.expectedReplication).all();
      const expectedById = new Map(expected.map((e) => [e.id, e]));
      const checkResults = db.select().from(schema.replicationCheckResults).all();
      for (const r of checkResults) {
        const exp = expectedById.get(r.expectedId);
        if (!exp || exp.kind !== "subscription" || r.status !== "found") continue;
        const srv = serversById.get(exp.serverId);
        if (!srv) continue;
        const extra = r.extraJson ? JSON.parse(r.extraJson) : null;

        // apply error: el probeServer registra en subscriptionErrors si apply_error_count>0
        // que se persiste aparte en probe.subscriptionErrors → necesitaría pasarse. Por ahora
        // evaluamos sólo via pg_stat_subscription last_msg_receipt_time age.

        // Stale: subscription enabled pero age > threshold
        if (ruleConfig.get("replication_stale")?.enabled !== false) {
          const ageSec: number | null = extra?.age_sec ?? null;
          const enabled: boolean = extra?.enabled === true;
          if (enabled && ageSec != null && ageSec >= REPL_STALE_WARN_SEC) {
            const sev: "warn" | "critical" = ageSec >= REPL_STALE_CRIT_SEC ? "critical" : "warn";
            candidates.push({
              fingerprint: `repl-stale:srv:${exp.serverId}:${exp.name}`,
              severity: sev,
              kind: "replication_stale",
              serverId: exp.serverId,
              title: `Sub '${exp.name}' sin msg hace ${Math.round(ageSec / 60)}min en ${srv.nombre}`,
              detail: `last_msg_receipt_time age = ${ageSec}s`,
            });
          }
        }
      }
    }

    // PG connections high (deshabilitada salvo env threshold > 0)
    if (ruleConfig.get("pg_connections_high")?.enabled !== false && (PG_CONN_WARN > 0 || PG_CONN_CRIT > 0)) {
      const pgDbs = db.select().from(schema.pgDatabases).all();
      for (const d of pgDbs) {
        if (d.activeConnections == null || d.serverId == null) continue;
        if (PG_CONN_CRIT > 0 && d.activeConnections >= PG_CONN_CRIT) {
          const srv = serversById.get(d.serverId);
          candidates.push({
            fingerprint: `pg-conn:srv:${d.serverId}:${d.name}`,
            severity: "critical",
            kind: "pg_connections_high",
            serverId: d.serverId,
            title: `${d.activeConnections} conexiones en ${srv?.nombre ?? "?"}/${d.name}`,
            detail: `Threshold critical: ${PG_CONN_CRIT}`,
          });
        } else if (PG_CONN_WARN > 0 && d.activeConnections >= PG_CONN_WARN) {
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
    }

    // ========== State machine ==========

    const openFingerprints = new Set(candidates.map((c) => c.fingerprint));
    const now = new Date().toISOString();

    // Procesar cada candidato
    for (const c of candidates) {
      const existing = db.select().from(schema.alerts).where(eq(schema.alerts.fingerprint, c.fingerprint)).get();
      const conf = ruleConfig.get(c.kind);
      const pendingCycles = conf?.pendingCycles ?? 1;

      if (!existing) {
        // Nuevo candidato
        const epoch = db
          .select()
          .from(schema.alerts)
          .all()
          .reduce((max, a) => Math.max(max, a.promotionEpoch), 0) + 1;
        const initialState = pendingCycles <= 1 ? "firing" : "pending";
        const promotedAt = initialState === "firing" ? now : null;
        db.insert(schema.alerts).values({
          severity: c.severity,
          kind: c.kind,
          serverId: c.serverId ?? null,
          componentId: null,
          title: c.title,
          detail: c.detail ?? null,
          fingerprint: c.fingerprint,
          state: initialState,
          consecutiveHits: 1,
          consecutiveClears: 0,
          promotedAt,
          promotionEpoch: epoch,
        }).run();
        continue;
      }

      // Alerta existente
      if (existing.state === "resolved") {
        // Reseed: limpiar notification_state para forzar re-fire
        db.delete(schema.notificationState).where(eq(schema.notificationState.alertFingerprint, c.fingerprint)).run();
        const newState = pendingCycles <= 1 ? "firing" : "pending";
        const newPromotedAt = newState === "firing" ? now : null;
        db.update(schema.alerts).set({
          severity: c.severity,
          title: c.title,
          detail: c.detail ?? null,
          state: newState,
          consecutiveHits: 1,
          consecutiveClears: 0,
          resolvedAt: null,
          promotedAt: newPromotedAt,
          promotionEpoch: existing.promotionEpoch + 1,
          lastSeenAt: now,
        }).where(eq(schema.alerts.id, existing.id)).run();
        continue;
      }

      if (existing.state === "pending") {
        const newHits = existing.consecutiveHits + 1;
        const promote = newHits >= pendingCycles;
        db.update(schema.alerts).set({
          severity: c.severity,
          title: c.title,
          detail: c.detail ?? null,
          consecutiveHits: newHits,
          consecutiveClears: 0,
          state: promote ? "firing" : "pending",
          promotedAt: promote && !existing.promotedAt ? now : existing.promotedAt,
          lastSeenAt: now,
        }).where(eq(schema.alerts.id, existing.id)).run();
        continue;
      }

      // state === 'firing' or 'resolving' → refrescar
      db.update(schema.alerts).set({
        severity: c.severity,
        title: c.title,
        detail: c.detail ?? null,
        state: "firing", // si venía de resolving, vuelve a firing
        consecutiveClears: 0,
        consecutiveHits: existing.consecutiveHits + 1,
        lastSeenAt: now,
      }).where(eq(schema.alerts.id, existing.id)).run();
    }

    // Procesar alertas open NO presentes en candidates (cleanup / resolving)
    const opens = db
      .select()
      .from(schema.alerts)
      .where(
        and(
          isNull(schema.alerts.resolvedAt),
        ),
      )
      .all();

    for (const a of opens) {
      if (a.state === "resolved") continue;
      if (openFingerprints.has(a.fingerprint)) continue;

      // Mitigación sync-crash: no auto-resolve reglas que dependen de un job que falló
      const isReplKind = ["replication_problem", "replication_lag_high", "replication_apply_error", "replication_stale", "pg_cluster_down", "pg_connections_high"].includes(a.kind);
      const isHealthKind = ["central_down"].includes(a.kind);
      if (isReplKind && !healthyDeps.replication) continue;
      if (isHealthKind && !healthyDeps.health) continue;

      const conf = ruleConfig.get(a.kind);
      const resolvingCycles = conf?.resolvingCycles ?? 3;

      if (a.state === "pending") {
        // Falso positivo que nunca confirmó → resolved inmediato
        db.update(schema.alerts).set({
          state: "resolved",
          resolvedAt: now,
        }).where(eq(schema.alerts.id, a.id)).run();
        continue;
      }

      if (a.state === "firing") {
        db.update(schema.alerts).set({
          state: "resolving",
          consecutiveClears: 1,
        }).where(eq(schema.alerts.id, a.id)).run();
        continue;
      }

      if (a.state === "resolving") {
        const newClears = a.consecutiveClears + 1;
        if (newClears >= resolvingCycles) {
          db.update(schema.alerts).set({
            state: "resolved",
            resolvedAt: now,
            consecutiveClears: newClears,
          }).where(eq(schema.alerts.id, a.id)).run();
        } else {
          db.update(schema.alerts).set({
            consecutiveClears: newClears,
          }).where(eq(schema.alerts.id, a.id)).run();
        }
      }
    }

    db.update(schema.syncRuns)
      .set({
        finishedAt: now,
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
