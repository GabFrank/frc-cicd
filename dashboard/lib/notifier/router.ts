import type { Alert } from "../schema";
import type { MonitoredServer, NotificationRule, NotificationTarget } from "../schema";

export type MatchedDelivery = {
  target: NotificationTarget;
  rule: NotificationRule;
};

function severityRank(s: string): number {
  if (s === "critical") return 3;
  if (s === "warn") return 2;
  return 1;
}

function parseCsv(csv: string | null | undefined): string[] {
  if (!csv?.trim()) return [];
  return csv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseCsvInts(csv: string | null | undefined): number[] {
  return parseCsv(csv)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n));
}

export function matchDeliveries(
  alert: Alert,
  rules: NotificationRule[],
  targetsById: Map<number, NotificationTarget>,
  serverById: Map<number, MonitoredServer>,
): MatchedDelivery[] {
  const out: MatchedDelivery[] = [];
  const server = alert.serverId != null ? serverById.get(alert.serverId) : undefined;
  const alertRank = severityRank(alert.severity);
  // Eventos informativos (github_*) bypasan el filtro min_severity — se
  // entregan aunque la regla pida warn+. No son alertas operativas.
  const isInformational = alert.kind.startsWith("github_");

  for (const rule of rules) {
    if (!rule.active) continue;
    const target = targetsById.get(rule.targetId);
    if (!target || !target.active) continue;

    if (!isInformational) {
      const minRank = severityRank(rule.minSeverity);
      if (alertRank < minRank) continue;
    }

    const kinds = parseCsv(rule.alertKindsCsv);
    if (kinds.length > 0 && !kinds.includes(alert.kind)) continue;

    const empresa = rule.empresaFilter?.trim();
    if (empresa) {
      const srvEmp = (server?.empresa ?? "").trim().toUpperCase();
      if (srvEmp !== empresa.toUpperCase()) continue;
    }

    const serverIds = parseCsvInts(rule.serverIdsCsv);
    if (serverIds.length > 0) {
      if (alert.serverId == null || !serverIds.includes(alert.serverId)) continue;
    }

    out.push({ target, rule });
  }
  return out;
}
