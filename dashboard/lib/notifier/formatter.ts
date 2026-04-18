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
    return [
      "✅ ALERTA RESUELTA",
      `TÍTULO: ${alert.title}`,
      `TIPO: ${alert.kind}`,
      `SERVIDOR: ${who}`,
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
