import { and, desc, eq, isNotNull, isNull, ne } from "drizzle-orm";
import { db, schema } from "../lib/db";
import { formatAlertMessage } from "../lib/notifier/formatter";
import { formatRecipientNumber, getEvolutionConfig, sendTextMessage } from "../lib/notifier/evolution";
import { dispatchAlertWebhook } from "../lib/notifier/n8n";
import { matchDeliveries } from "../lib/notifier/router";
import { shouldSendOpenAlert } from "../lib/notifier/throttle";
import { alertPayloadHash } from "../lib/notifier/payload-hash";

const RESOLVED_LOOKBACK_MS = 5 * 60_000;

function isoNow() {
  return new Date().toISOString();
}

export async function notifyAlerts() {
  const runId = db
    .insert(schema.syncRuns)
    .values({ jobName: "notify-alerts", ok: false, itemsIngested: 0 })
    .run();
  const sid = Number(runId.lastInsertRowid);

  let items = 0;
  try {
    const enabled = (process.env.NOTIFY_ALERTS_ENABLED ?? "true").toLowerCase() !== "false";
    if (!enabled) {
      db.update(schema.syncRuns)
        .set({ finishedAt: isoNow(), ok: true, itemsIngested: 0 })
        .where(eq(schema.syncRuns.id, sid))
        .run();
      return { ok: true, itemsIngested: 0, skipped: "disabled" as const };
    }

    const { apiKey } = getEvolutionConfig();
    const hasEvolution = !!apiKey;
    const hasN8n = !!process.env.N8N_ALERT_WEBHOOK_URL?.trim();
    if (!hasEvolution && !hasN8n) {
      db.update(schema.syncRuns)
        .set({ finishedAt: isoNow(), ok: true, itemsIngested: 0 })
        .where(eq(schema.syncRuns.id, sid))
        .run();
      return { ok: true, itemsIngested: 0, skipped: "no_channels" as const };
    }

    const timeZone = process.env.WHATSAPP_TZ ?? "America/Asuncion";
    const dashboardBase = (process.env.DASHBOARD_PUBLIC_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
    const now = new Date();

    const servers = db.select().from(schema.monitoredServers).all();
    const serverById = new Map(servers.map((s) => [s.id, s]));

    const targets = db
      .select()
      .from(schema.notificationTargets)
      .where(eq(schema.notificationTargets.active, true))
      .all();
    const rules = db
      .select()
      .from(schema.notificationRules)
      .where(eq(schema.notificationRules.active, true))
      .all();
    const targetsById = new Map(targets.map((t) => [t.id, t]));

    if (targets.length === 0 || rules.length === 0) {
      db.update(schema.syncRuns)
        .set({ finishedAt: isoNow(), ok: true, itemsIngested: 0 })
        .where(eq(schema.syncRuns.id, sid))
        .run();
      return { ok: true, itemsIngested: 0, skipped: "no_rules" as const };
    }

    const states = db.select().from(schema.notificationState).all();
    const stateByKey = new Map(states.map((s) => [`${s.alertFingerprint}:${s.targetId}`, s]));

    // Lifecycle: solo notificar firing (promoted) o resolving. Pending/resolved no gatillan envío.
    const openAlerts = db
      .select()
      .from(schema.alerts)
      .where(
        and(
          isNull(schema.alerts.resolvedAt),
          // filtrar solo firing con promoted_at (ya confirmada) o resolving
          // (escribimos en SQL crudo porque drizzle no tiene IN con strings fácil)
        ),
      )
      .orderBy(desc(schema.alerts.lastSeenAt))
      .all()
      .filter((a) => (a.state === "firing" && a.promotedAt) || a.state === "resolving");

    for (const alert of openAlerts) {
      const deliveries = matchDeliveries(alert, rules, targetsById, serverById);
      const server = alert.serverId != null ? serverById.get(alert.serverId) : undefined;
      const hash = alertPayloadHash(alert);
      let anyDeliverySent = false;

      for (const { target, rule } of deliveries) {
        const key = `${alert.fingerprint}:${target.id}`;
        const st = stateByKey.get(key);
        const decision = shouldSendOpenAlert({ now, timeZone, alert, rule, state: st });

        if (decision.action === "skip") {
          if (decision.reason === "noop") continue;
          db.insert(schema.notificationLog)
            .values({
              alertId: alert.id,
              alertFingerprint: alert.fingerprint,
              targetId: target.id,
              ruleId: rule.id,
              eventKind: "skipped",
              status: decision.reason === "quiet" ? "skipped_quiet" : "skipped_throttle",
              reason: decision.reason,
              sentAt: isoNow(),
            })
            .run();
          items += 1;
          continue;
        }

        const text = formatAlertMessage({
          alert,
          server: server ?? null,
          event: decision.eventKind === "fired" ? "fired" : "resend",
          dashboardBaseUrl: dashboardBase,
        });

        const webhookOk = await dispatchAlertWebhook({
          event: decision.eventKind,
          alert,
          server: server ?? null,
          target: { id: target.id, name: target.name, jid: target.jid },
          rule: { id: rule.id, minSeverity: rule.minSeverity },
          dashboardUrl: `${dashboardBase}/dashboard/alertas`,
        });

        if (!hasEvolution) {
          const sentAt = isoNow();
          if (hasN8n && webhookOk) {
            db.insert(schema.notificationLog)
              .values({
                alertId: alert.id,
                alertFingerprint: alert.fingerprint,
                targetId: target.id,
                ruleId: rule.id,
                eventKind: decision.eventKind,
                status: "sent",
                reason: "n8n_webhook_only",
                sentAt: sentAt,
              })
              .run();
            items += 1;
            db.insert(schema.notificationState)
              .values({
                alertFingerprint: alert.fingerprint,
                targetId: target.id,
                lastSentAt: sentAt,
                lastSeverity: alert.severity,
                lastEventKind: decision.eventKind,
                lastAlertLastSeenAt: alert.lastSeenAt,
                lastPayloadHash: hash,
                resolvedNotifiedAt: null,
              })
              .onConflictDoUpdate({
                target: [schema.notificationState.alertFingerprint, schema.notificationState.targetId],
                set: {
                  lastSentAt: sentAt,
                  lastSeverity: alert.severity,
                  lastEventKind: decision.eventKind,
                  lastAlertLastSeenAt: alert.lastSeenAt,
                  lastPayloadHash: hash,
                },
              })
              .run();
            stateByKey.set(key, {
              alertFingerprint: alert.fingerprint,
              targetId: target.id,
              lastSentAt: sentAt,
              lastSeverity: alert.severity,
              lastEventKind: decision.eventKind,
              lastAlertLastSeenAt: alert.lastSeenAt,
              lastPayloadHash: hash,
              resolvedNotifiedAt: st?.resolvedNotifiedAt ?? null,
            });
          } else if (hasN8n && !webhookOk) {
            db.insert(schema.notificationLog)
              .values({
                alertId: alert.id,
                alertFingerprint: alert.fingerprint,
                targetId: target.id,
                ruleId: rule.id,
                eventKind: decision.eventKind,
                status: "failed",
                reason: "n8n_webhook_failed",
                sentAt: sentAt,
              })
              .run();
            items += 1;
          }
          continue;
        }

        const number = formatRecipientNumber(target.jid);
        const res = await sendTextMessage({ number, text });
        const ok = res.ok && (res.status === 200 || res.status === 201);
        const msgId =
          ok && res.data && typeof res.data === "object" && res.data !== null && "key" in res.data
            ? String((res.data as { key?: { id?: string } }).key?.id ?? "")
            : null;

        db.insert(schema.notificationLog)
          .values({
            alertId: alert.id,
            alertFingerprint: alert.fingerprint,
            targetId: target.id,
            ruleId: rule.id,
            eventKind: decision.eventKind,
            status: ok ? "sent" : "failed",
            reason: ok ? null : `http_${res.status}`,
            evolutionMessageId: msgId || null,
            httpCode: res.status || null,
            errorMessage: ok ? null : JSON.stringify(res.data).slice(0, 2000),
            sentAt: isoNow(),
          })
          .run();
        items += 1;

        if (ok) {
          anyDeliverySent = true;
          const sentAt = isoNow();
          db.insert(schema.notificationState)
            .values({
              alertFingerprint: alert.fingerprint,
              targetId: target.id,
              lastSentAt: sentAt,
              lastSeverity: alert.severity,
              lastEventKind: decision.eventKind,
              lastAlertLastSeenAt: alert.lastSeenAt,
              lastPayloadHash: hash,
              resolvedNotifiedAt: null,
            })
            .onConflictDoUpdate({
              target: [schema.notificationState.alertFingerprint, schema.notificationState.targetId],
              set: {
                lastSentAt: sentAt,
                lastSeverity: alert.severity,
                lastEventKind: decision.eventKind,
                lastAlertLastSeenAt: alert.lastSeenAt,
                lastPayloadHash: hash,
              },
            })
            .run();
          stateByKey.set(key, {
            alertFingerprint: alert.fingerprint,
            targetId: target.id,
            lastSentAt: sentAt,
            lastSeverity: alert.severity,
            lastEventKind: decision.eventKind,
            lastAlertLastSeenAt: alert.lastSeenAt,
            lastPayloadHash: hash,
            resolvedNotifiedAt: st?.resolvedNotifiedAt ?? null,
          });
        }
      }

      // Eventos informativos (github_*) son one-shot: tras notificar OK,
      // marcar resuelta inmediatamente. No ocupan el sidebar; queda
      // registro en notification_log / alerts histórico.
      if (anyDeliverySent && alert.kind.startsWith("github_")) {
        db.update(schema.alerts)
          .set({ state: "resolved", resolvedAt: isoNow() })
          .where(eq(schema.alerts.id, alert.id))
          .run();
      }
    }

    const cutoff = Date.now() - RESOLVED_LOOKBACK_MS;
    const recentlyResolved = db
      .select()
      .from(schema.alerts)
      .where(isNotNull(schema.alerts.resolvedAt))
      .orderBy(desc(schema.alerts.resolvedAt))
      .limit(80)
      .all()
      .filter((a) => a.resolvedAt && new Date(a.resolvedAt).getTime() >= cutoff);

    // GitHub events son one-shot — fire una vez, no tiene sentido notificar 'resolved'
    // después (el PR sigue abierto, el release sigue publicado, el workflow falló y ya).
    const EVENT_KINDS_NO_RESOLVED = new Set([
      "github_pr_opened",
      "github_release_alpha",
      "github_release_beta",
      "github_release_stable",
      "github_workflow_failed",
    ]);

    for (const alert of recentlyResolved) {
      if (EVENT_KINDS_NO_RESOLVED.has(alert.kind)) continue;
      const deliveries = matchDeliveries(alert, rules, targetsById, serverById);
      const server = alert.serverId != null ? serverById.get(alert.serverId) : undefined;
      const text = formatAlertMessage({
        alert,
        server: server ?? null,
        event: "resolved",
        dashboardBaseUrl: dashboardBase,
      });

      for (const { target, rule } of deliveries) {
        const key = `${alert.fingerprint}:${target.id}`;
        const st = stateByKey.get(key);

        const priorSent = db
          .select()
          .from(schema.notificationLog)
          .where(
            and(
              eq(schema.notificationLog.alertFingerprint, alert.fingerprint),
              eq(schema.notificationLog.targetId, target.id),
              eq(schema.notificationLog.status, "sent"),
              ne(schema.notificationLog.eventKind, "resolved"),
            ),
          )
          .limit(1)
          .all();
        if (priorSent.length === 0) continue;

        const alreadyResolved = db
          .select()
          .from(schema.notificationLog)
          .where(
            and(
              eq(schema.notificationLog.alertFingerprint, alert.fingerprint),
              eq(schema.notificationLog.targetId, target.id),
              eq(schema.notificationLog.eventKind, "resolved"),
              eq(schema.notificationLog.status, "sent"),
            ),
          )
          .limit(1)
          .all();
        if (alreadyResolved.length > 0) continue;

        if (st?.resolvedNotifiedAt) continue;

        const webhookResolvedOk = await dispatchAlertWebhook({
          event: "resolved",
          alert,
          server: server ?? null,
          target: { id: target.id, name: target.name, jid: target.jid },
          rule: { id: rule.id },
          dashboardUrl: `${dashboardBase}/dashboard/alertas`,
        });

        if (!hasEvolution) {
          const rn = isoNow();
          if (hasN8n && webhookResolvedOk) {
            db.insert(schema.notificationLog)
              .values({
                alertId: alert.id,
                alertFingerprint: alert.fingerprint,
                targetId: target.id,
                ruleId: rule.id,
                eventKind: "resolved",
                status: "sent",
                reason: "n8n_webhook_only",
                sentAt: rn,
              })
              .run();
            items += 1;
            db.insert(schema.notificationState)
              .values({
                alertFingerprint: alert.fingerprint,
                targetId: target.id,
                lastSentAt: rn,
                lastSeverity: alert.severity,
                lastEventKind: "resolved",
                lastAlertLastSeenAt: alert.lastSeenAt,
                lastPayloadHash: alertPayloadHash(alert),
                resolvedNotifiedAt: rn,
              })
              .onConflictDoUpdate({
                target: [schema.notificationState.alertFingerprint, schema.notificationState.targetId],
                set: {
                  lastSentAt: rn,
                  lastEventKind: "resolved",
                  resolvedNotifiedAt: rn,
                },
              })
              .run();
          }
          continue;
        }

        const number = formatRecipientNumber(target.jid);
        const res = await sendTextMessage({ number, text });
        const ok = res.ok && (res.status === 200 || res.status === 201);
        const msgId =
          ok && res.data && typeof res.data === "object" && res.data !== null && "key" in res.data
            ? String((res.data as { key?: { id?: string } }).key?.id ?? "")
            : null;

        db.insert(schema.notificationLog)
          .values({
            alertId: alert.id,
            alertFingerprint: alert.fingerprint,
            targetId: target.id,
            ruleId: rule.id,
            eventKind: "resolved",
            status: ok ? "sent" : "failed",
            reason: ok ? null : `http_${res.status}`,
            evolutionMessageId: msgId || null,
            httpCode: res.status || null,
            errorMessage: ok ? null : JSON.stringify(res.data).slice(0, 2000),
            sentAt: isoNow(),
          })
          .run();
        items += 1;

        if (ok) {
          const rn = isoNow();
          db.insert(schema.notificationState)
            .values({
              alertFingerprint: alert.fingerprint,
              targetId: target.id,
              lastSentAt: rn,
              lastSeverity: alert.severity,
              lastEventKind: "resolved",
              lastAlertLastSeenAt: alert.lastSeenAt,
              lastPayloadHash: alertPayloadHash(alert),
              resolvedNotifiedAt: rn,
            })
            .onConflictDoUpdate({
              target: [schema.notificationState.alertFingerprint, schema.notificationState.targetId],
              set: {
                lastSentAt: rn,
                lastEventKind: "resolved",
                resolvedNotifiedAt: rn,
              },
            })
            .run();
        }
      }
    }

    db.update(schema.syncRuns)
      .set({ finishedAt: isoNow(), ok: true, itemsIngested: items })
      .where(eq(schema.syncRuns.id, sid))
      .run();

    return { ok: true, itemsIngested: items };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    db.update(schema.syncRuns)
      .set({ finishedAt: isoNow(), ok: false, errorMessage: msg })
      .where(eq(schema.syncRuns.id, sid))
      .run();
    throw err;
  }
}
