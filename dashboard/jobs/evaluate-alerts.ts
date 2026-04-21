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

// host_unreachable: 3 tramos de severidad según cuánto lleva un host sin
// responder TCP. La inestabilidad de red es banal (info); recién a las 12h
// amerita atención (warn) y a las 24h es claramente no transitorio (critical).
const HOST_UNREACHABLE_WARN_HOURS = Number(process.env.HOST_UNREACHABLE_WARN_AFTER_HOURS ?? 12);
const HOST_UNREACHABLE_CRIT_HOURS = Number(process.env.HOST_UNREACHABLE_CRITICAL_AFTER_HOURS ?? 24);

function hostUnreachableSeverity(lastReachableAt: string | null | undefined): "info" | "warn" | "critical" {
  if (!lastReachableAt) return "info";
  const t = lastReachableAt.trim();
  const withZ = /(?:Z|[+-]\d{2}:?\d{2})$/.test(t) ? t.replace(" ", "T") : `${t.replace(" ", "T")}Z`;
  const last = new Date(withZ).getTime();
  if (!Number.isFinite(last)) return "info";
  const hours = (Date.now() - last) / 3_600_000;
  if (hours >= HOST_UNREACHABLE_CRIT_HOURS) return "critical";
  if (hours >= HOST_UNREACHABLE_WARN_HOURS) return "warn";
  return "info";
}

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

function isInQuietWindow(
  quietStart: string | null | undefined,
  quietEnd: string | null | undefined,
  timeZone: string,
  now: Date,
): boolean {
  if (!quietStart || !quietEnd) return false;
  // Parse HH:MM
  const m = /^(\d{1,2}):(\d{2})$/;
  const ms = quietStart.match(m), me = quietEnd.match(m);
  if (!ms || !me) return false;
  const startMin = Number(ms[1]) * 60 + Number(ms[2]);
  const endMin = Number(me[1]) * 60 + Number(me[2]);
  // "Now" local al TZ
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const mm = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const nowMin = h * 60 + mm;
  // Wraparound (22:00 → 06:00)
  if (startMin <= endMin) return nowMin >= startMin && nowMin < endMin;
  return nowMin >= startMin || nowMin < endMin;
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

    // Host reachability (D): IPs con 2+ probes TCP fallidos consecutivos.
    // Mientras un host esté en esta lista, NO emitir alerts de servicios sobre él —
    // se reemplazan por un único host_unreachable:<ip>.
    const HOST_UNREACHABLE_THRESHOLD = 2;
    const reachabilityRows = db.select().from(schema.hostReachability).all();
    const unreachableIps = new Set(
      reachabilityRows
        .filter((r) => !r.reachable && r.consecutiveUnreachable >= HOST_UNREACHABLE_THRESHOLD)
        .map((r) => r.ip),
    );
    // Helper: server is on an unreachable host.
    const isHostUnreachable = (serverId: number | undefined): boolean => {
      if (serverId == null) return false;
      const srv = serversById.get(serverId);
      return !!(srv?.ip && unreachableIps.has(srv.ip));
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
    // Gating C: si sync-health no está sano, no promover falsas caídas — la data está stale.
    if (ruleConfig.get("central_down")?.enabled !== false && healthyDeps.health) {
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
    // Gating C: sync-replication es el que escribe pg_cluster_status.
    if (ruleConfig.get("pg_cluster_down")?.enabled !== false && healthyDeps.replication) {
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
    // Gating C: los check_results viejos si sync-replication falló pueden dar falsos missing.
    if (ruleConfig.get("replication_problem")?.enabled !== false && healthyDeps.replication) {
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
    if (ruleConfig.get("replication_lag_high")?.enabled !== false && healthyDeps.replication) {
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
    if ((ruleConfig.get("replication_apply_error")?.enabled !== false
        || ruleConfig.get("replication_stale")?.enabled !== false) && healthyDeps.replication) {
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

    // ========== Per-server alerts toggle + quiet windows ==========
    // Un server está "silenciado" si:
    //   - alerts_enabled=false, O
    //   - ahora está dentro de su quiet_start/quiet_end (ej. filial apaga de noche)
    // Durante el silencio: no se emiten candidates ni se sintetiza host_*.
    // Declarado arriba (antes de D/B1/B2) porque todos lo consultan.
    const timeZone = process.env.WHATSAPP_TZ ?? "America/Asuncion";
    const nowDate = new Date();
    const silencedServers = new Set(
      servers
        .filter(
          (s) =>
            !s.alertsEnabled ||
            isInQuietWindow(s.quietStart, s.quietEnd, timeZone, nowDate),
        )
        .map((s) => s.id),
    );
    const isHostFullySilenced = (ip: string): boolean => {
      const onIp = servers.filter((s) => s.ip === ip);
      if (onIp.length === 0) return false;
      return onIp.every((s) => silencedServers.has(s.id));
    };

    // ========== GitHub events (one-shot) ==========
    // PR abierto, release publicada, workflow failed en ramas importantes.
    // Ventana: si el evento ocurrió en las últimas GITHUB_EVENT_WINDOW_MS → fire.
    // Fuera de ventana → no aparece en candidates → auto-resolve silencioso
    // (notify-alerts suprime 'resolved' para kinds github_*).
    const GITHUB_EVENT_WINDOW_MS = 2 * 60 * 60 * 1000; // 2h
    const windowCutoffIso = new Date(Date.now() - GITHUB_EVENT_WINDOW_MS).toISOString();
    const componentsById = new Map(
      db.select().from(schema.components).all().map((c) => [c.id, c]),
    );

    // PR abierto
    if (ruleConfig.get("github_pr_opened")?.enabled !== false) {
      const prs = db.select().from(schema.pullRequests).where(eq(schema.pullRequests.state, "open")).all();
      for (const pr of prs) {
        if (!pr.createdAt) continue;
        if (pr.createdAt < windowCutoffIso) continue;
        if (pr.draft) continue;
        const comp = componentsById.get(pr.componentId);
        candidates.push({
          fingerprint: `github-pr:${comp?.slug ?? pr.componentId}:${pr.number}`,
          severity: "info",
          kind: "github_pr_opened",
          title: `PR #${pr.number} abierto en ${comp?.slug ?? "?"}`,
          detail: `${pr.title} · autor: ${pr.author ?? "?"} · ${pr.headRef ?? "?"} → ${pr.baseRef ?? "?"}${pr.htmlUrl ? `\nURL: ${pr.htmlUrl}` : ""}`,
        });
      }
    }

    // Release publicada — separada por canal para permitir filtros por severidad
    const releaseKinds = ["github_release_alpha", "github_release_beta", "github_release_stable"] as const;
    if (releaseKinds.some((k) => ruleConfig.get(k)?.enabled !== false)) {
      const rels = db.select().from(schema.releases).all();
      for (const r of rels) {
        if (!r.publishedAt || r.publishedAt < windowCutoffIso) continue;
        if (r.draft) continue;
        const channel = (r.channel ?? "").toLowerCase();
        let kind: string | null = null;
        const sev: "info" | "warn" | "critical" = "info";
        if (channel === "alpha") kind = "github_release_alpha";
        else if (channel === "beta") kind = "github_release_beta";
        else if (channel === "stable") kind = "github_release_stable";
        else continue;
        if (ruleConfig.get(kind)?.enabled === false) continue;
        const comp = componentsById.get(r.componentId);
        candidates.push({
          fingerprint: `github-release:${comp?.slug ?? r.componentId}:${r.tagName}`,
          severity: sev,
          kind,
          title: `Release ${r.tagName} en ${comp?.slug ?? "?"} (${channel})`,
          detail: `${r.name ?? r.tagName}${r.htmlUrl ? `\nURL: ${r.htmlUrl}` : ""}`,
        });
      }
    }

    // Workflow failed en ramas importantes
    if (ruleConfig.get("github_workflow_failed")?.enabled !== false) {
      const runs = db.select().from(schema.workflowRuns).all();
      const RELEVANT_BRANCHES = new Set(["master", "main", "release/beta", "develop"]);
      for (const w of runs) {
        if (w.conclusion !== "failure") continue;
        if (w.status !== "completed") continue;
        if (!w.runStartedAt || w.runStartedAt < windowCutoffIso) continue;
        if (!w.headBranch || !RELEVANT_BRANCHES.has(w.headBranch)) continue;
        const comp = componentsById.get(w.componentId);
        candidates.push({
          fingerprint: `github-workflow-failed:${comp?.slug ?? w.componentId}:${w.id}`,
          severity: "info",
          kind: "github_workflow_failed",
          title: `Workflow "${w.name ?? "?"}" falló en ${comp?.slug ?? "?"}/${w.headBranch}`,
          detail: `Run #${w.runNumber ?? "?"} · event: ${w.event ?? "?"}${w.htmlUrl ? `\nURL: ${w.htmlUrl}` : ""}`,
        });
      }
    }

    // ========== D: host unreachable (TCP probe) ==========
    // Si el host no responde TCP 2+ ciclos, todas las alerts de apps sobre ese host
    // son consecuencia (no causa). Se reemplazan por una sola `host_unreachable:<ip>`.
    if (unreachableIps.size > 0 && ruleConfig.get("host_unreachable")?.enabled !== false) {
      // Kinds que dependen de conectividad al host de la app.
      const HOST_DEP_KINDS = new Set([
        "central_down",
        "pg_cluster_down",
        "replication_problem",
        "replication_lag_high",
        "replication_apply_error",
        "replication_stale",
      ]);
      let suppressedByHost = 0;
      const afterHost = candidates.filter((c) => {
        if (HOST_DEP_KINDS.has(c.kind) && isHostUnreachable(c.serverId)) {
          suppressedByHost += 1;
          return false;
        }
        return true;
      });
      candidates.length = 0;
      candidates.push(...afterHost);

      // Emitir un host_unreachable por IP, listando servers afectados.
      // Severidad escalonada: info (<12h), warn (12-24h), critical (≥24h).
      for (const ip of unreachableIps) {
        if (isHostFullySilenced(ip)) continue;
        const affected = servers.filter((s) => s.ip === ip).map((s) => s.nombre);
        const row = reachabilityRows.find((r) => r.ip === ip);
        const since = row?.lastReachableAt ?? row?.lastProbeAt ?? "desconocido";
        const sev = hostUnreachableSeverity(row?.lastReachableAt);
        candidates.push({
          fingerprint: `host-unreachable:ip:${ip}`,
          severity: sev,
          kind: "host_unreachable",
          title: `Host ${ip} no alcanzable (TCP)`,
          detail: `IP ${ip} · último OK: ${since} · afectados: ${affected.join(", ")}`,
        });
      }
      if (suppressedByHost > 0) {
        console.log(`[evaluate-alerts] host unreachable (${unreachableIps.size} IP): suprimidas ${suppressedByHost} alertas de apps`);
      }
    }

    // ========== Filter silenced per-server candidates ==========
    if (silencedServers.size > 0) {
      const before = candidates.length;
      const afterToggle = candidates.filter(
        (c) => c.serverId == null || !silencedServers.has(c.serverId),
      );
      candidates.length = 0;
      candidates.push(...afterToggle);
      const dropped = before - candidates.length;
      if (dropped > 0) console.log(`[evaluate-alerts] silenced: ${dropped} candidates de ${silencedServers.size} servers (toggle+quiet)`);
    }

    // ========== B0: agrupación de replication_problem por server ==========
    // Un mismo server suele tener varios slots/subs/pubs. Cuando el enlace
    // cae, todos aparecen como inactive/missing a la vez → antes: 3+ alertas.
    // Ahora: ≥2 items del mismo server colapsan en un replication_batch.
    if (ruleConfig.get("replication_batch")?.enabled !== false) {
      const replBySrv = new Map<number, typeof candidates>();
      for (const c of candidates) {
        if (c.kind !== "replication_problem" || c.serverId == null) continue;
        const arr = replBySrv.get(c.serverId) ?? [];
        arr.push(c);
        replBySrv.set(c.serverId, arr);
      }
      for (const [srvId, group] of replBySrv) {
        if (group.length < 2) continue;
        const srv = serversById.get(srvId);
        if (!srv) continue;
        // Reemplazar las individuales por una batch
        const groupFps = new Set(group.map((c) => c.fingerprint));
        const afterBatch = candidates.filter((c) => !groupFps.has(c.fingerprint));
        candidates.length = 0;
        candidates.push(...afterBatch);
        // Severity: si hay al menos un critical (status=missing) → critical, sino warn
        const batchSev: "warn" | "critical" = group.some((c) => c.severity === "critical") ? "critical" : "warn";
        const items = group.map((c) => c.title.replace(/ en .+$/, "")).sort();
        candidates.push({
          fingerprint: `replication-batch:srv:${srvId}`,
          severity: batchSev,
          kind: "replication_batch",
          serverId: srvId,
          title: `${group.length} objetos de replicación con problemas en ${srv.nombre}`,
          detail: items.map((it) => `• ${it}`).join("\n"),
        });
        console.log(`[evaluate-alerts] replication batch: srv=${srvId} (${srv.nombre}) colapsa ${group.length} → 1`);
      }
    }

    // ========== B1: dep-tree suppression ==========
    // Si pg_cluster_down firing para server X, los slots/subs de X aparecen missing/inactive
    // como síntoma — no emitir alertas de replicación encima. Suprime el ruido aditivo.
    const pgDownServers = new Set(
      candidates.filter((c) => c.kind === "pg_cluster_down" && c.serverId != null).map((c) => c.serverId!),
    );
    const REPL_KINDS = new Set([
      "replication_problem",
      "replication_lag_high",
      "replication_apply_error",
      "replication_stale",
    ]);
    let suppressedDep = 0;
    const afterDep = candidates.filter((c) => {
      if (REPL_KINDS.has(c.kind) && c.serverId != null && pgDownServers.has(c.serverId)) {
        suppressedDep += 1;
        return false;
      }
      return true;
    });
    candidates.length = 0;
    candidates.push(...afterDep);
    if (suppressedDep > 0) {
      console.log(`[evaluate-alerts] dep-tree: suprimidas ${suppressedDep} alertas de replicación por pg_cluster_down en mismo server`);
    }

    // ========== B2: correlación host-level ==========
    // Si ≥2 central_down candidates comparten IP, reemplazar por 1 host_down:<ip>.
    // Motivo: todas las instancias de un host caen juntas cuando el host/red falla.
    if (ruleConfig.get("host_down")?.enabled !== false) {
      const centralCands = candidates.filter((c) => c.kind === "central_down" && c.serverId != null);
      const byIp = new Map<string, typeof centralCands>();
      for (const c of centralCands) {
        const srv = serversById.get(c.serverId!);
        if (!srv?.ip) continue;
        const list = byIp.get(srv.ip) ?? [];
        list.push(c);
        byIp.set(srv.ip, list);
      }
      for (const [ip, group] of byIp) {
        if (group.length < 2) continue;
        if (isHostFullySilenced(ip)) continue;
        const names = group
          .map((c) => serversById.get(c.serverId!)?.nombre ?? "?")
          .join(", ");
        const groupFps = new Set(group.map((c) => c.fingerprint));
        const afterHost = candidates.filter((c) => !groupFps.has(c.fingerprint));
        candidates.length = 0;
        candidates.push(...afterHost);
        candidates.push({
          fingerprint: `host-down:ip:${ip}`,
          severity: "critical",
          kind: "host_down",
          title: `Host ${ip} DOWN (${group.length} instancias)`,
          detail: `Instancias caídas simultáneo: ${names}. Probable red o host.`,
        });
        console.log(`[evaluate-alerts] host correlation: ${group.length} central_down en ${ip} → host_down sintetizado`);
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
      const isHealthKind = ["central_down", "host_down", "host_unreachable"].includes(a.kind);
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
