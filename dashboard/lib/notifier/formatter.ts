import type { Alert } from "../schema";
import type { MonitoredServer } from "../schema";

export type AlertFormatEvent = "fired" | "resend" | "resolved";

function severityEmoji(sev: string): string {
  if (sev === "critical") return "🔴";
  if (sev === "warn") return "🟡";
  return "🔵";
}

export function formatAlertMessage(args: {
  alert: Alert;
  server?: MonitoredServer | null;
  event: AlertFormatEvent;
  dashboardBaseUrl: string;
}): string {
  const { alert, server, event, dashboardBaseUrl } = args;
  const base = dashboardBaseUrl.replace(/\/$/, "");
  const link = `${base}/dashboard/alertas`;
  const who = server?.nombre ?? (alert.serverId != null ? `SERVER #${alert.serverId}` : "GLOBAL");

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

  const tag = event === "resend" ? "ACTUALIZACIÓN DE ALERTA" : "NUEVA ALERTA";
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
