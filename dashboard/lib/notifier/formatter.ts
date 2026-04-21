import type { Alert } from "../schema";
import type { MonitoredServer } from "../schema";

export type AlertFormatEvent = "fired" | "resend" | "resolved";

function severityEmoji(sev: string): string {
  if (sev === "critical") return "🔴";
  if (sev === "warn") return "🟡";
  return "🔵";
}

function severityRank(s: string): number {
  if (s === "critical") return 3;
  if (s === "warn") return 2;
  return 1;
}

export function formatAlertMessage(args: {
  alert: Alert;
  server?: MonitoredServer | null;
  event: AlertFormatEvent;
  /** Severidad con la que se notificó por última vez. Si la actual es mayor,
   *  el mensaje se formatea como escalation. */
  previousSeverity?: string | null;
  dashboardBaseUrl: string;
}): string {
  const { alert, server, event, previousSeverity, dashboardBaseUrl } = args;
  const base = dashboardBaseUrl.replace(/\/$/, "");
  const link = `${base}/dashboard/alertas`;
  const who = server?.nombre ?? (alert.serverId != null ? `SERVER #${alert.serverId}` : "GLOBAL");

  // Eventos informativos (GitHub) — formato distinto, sin lenguaje de alerta.
  if (alert.kind.startsWith("github_")) {
    const icon =
      alert.kind === "github_pr_opened" ? "🔀"
      : alert.kind.startsWith("github_release") ? "🚀"
      : alert.kind === "github_workflow_failed" ? "⚠️"
      : "📢";
    return [
      `${icon} EVENTO GITHUB`,
      alert.title,
      alert.detail ?? null,
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (event === "resolved") {
    let duration: string | null = null;
    if (alert.promotedAt && alert.resolvedAt) {
      const parseTs = (s: string) => {
        const t = s.trim();
        const withZ = /(?:Z|[+-]\d{2}:?\d{2})$/.test(t) ? t.replace(" ", "T") : `${t.replace(" ", "T")}Z`;
        return new Date(withZ).getTime();
      };
      const ms = Math.max(0, parseTs(alert.resolvedAt) - parseTs(alert.promotedAt));
      const sec = Math.floor(ms / 1000);
      if (sec < 60) duration = `${sec}s`;
      else if (sec < 3600) duration = `${Math.floor(sec / 60)}m ${sec % 60}s`;
      else duration = `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
    }
    return [
      "✅ ALERTA RESUELTA",
      `TÍTULO: ${alert.title}`,
      `TIPO: ${alert.kind}`,
      `SERVIDOR: ${who}`,
      duration ? `DURACIÓN: ${duration}` : null,
      alert.detail ? `DETALLE: ${alert.detail}` : null,
      `PANEL: ${link}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  // Si es resend y la severidad subió respecto al último envío, renderizar
  // como escalation con prefijo explícito.
  const escalated =
    event === "resend" &&
    previousSeverity != null &&
    severityRank(alert.severity) > severityRank(previousSeverity);
  let tag: string;
  if (escalated) {
    tag = alert.severity === "critical" ? "ESCALADO A CRITICAL" : "ESCALADO A WARN";
  } else {
    tag = event === "resend" ? "ACTUALIZACIÓN DE ALERTA" : "NUEVA ALERTA";
  }

  return [
    `${severityEmoji(alert.severity)} ${tag}`,
    `SEVERIDAD: ${alert.severity.toUpperCase()}`,
    `TÍTULO: ${alert.title}`,
    `TIPO: ${alert.kind}`,
    `SERVIDOR: ${who}`,
    alert.detail ? `DETALLE: ${alert.detail}` : null,
    `PANEL: ${link}`,
  ]
    .filter(Boolean)
    .join("\n");
}
