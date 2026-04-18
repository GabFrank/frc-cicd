"use client";

import Link from "next/link";
import { usePollJson } from "./PollQuery";
import { timeAgo } from "@/lib/utils";

interface Alert {
  id: number;
  severity: string;
  kind: string;
  title: string;
  detail: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  instanceName: string | null;
}

interface AlertData {
  active: Alert[];
  recentlyResolved: Alert[];
}

const SEVERITY_ORDER = ["critical", "warn", "info"] as const;

function severityClass(s: string): string {
  if (s === "critical") return "border-status-err/50 bg-status-err/5";
  if (s === "warn") return "border-status-warn/50 bg-status-warn/5";
  return "border-border-subtle bg-bg-raised";
}

function severityPill(s: string): string {
  if (s === "critical") return "pill pill-err";
  if (s === "warn") return "pill pill-warn";
  return "pill pill-info";
}

export function AlertSidebar({ heightClass = "h-[calc(100vh-9rem)]", maxItems }: { heightClass?: string; maxItems?: number }) {
  const { data, isLoading } = usePollJson<AlertData>("/api/data/alertas", ["sidebar-alertas"]);

  if (isLoading) {
    return (
      <aside className="card text-text-muted text-sm">Cargando alertas…</aside>
    );
  }
  if (!data) return null;

  const active = data.active;
  const grouped: Record<string, Alert[]> = { critical: [], warn: [], info: [] };
  for (const a of active) {
    const key = SEVERITY_ORDER.includes(a.severity as any) ? a.severity : "info";
    grouped[key].push(a);
  }

  const total = active.length;
  const counts = {
    critical: grouped.critical.length,
    warn: grouped.warn.length,
    info: grouped.info.length,
  };

  let visible = active;
  let overflow = 0;
  if (maxItems && active.length > maxItems) {
    visible = active.slice(0, maxItems);
    overflow = active.length - maxItems;
  }

  return (
    <aside className="space-y-3">
      <div className="card-raised flex items-center justify-between">
        <div>
          <div className="text-xs uppercase text-text-muted">Alertas activas</div>
          <div className="text-2xl font-bold">{total}</div>
        </div>
        <div className="flex gap-1 text-xs">
          {counts.critical > 0 && <span className="pill pill-err">{counts.critical}</span>}
          {counts.warn > 0 && <span className="pill pill-warn">{counts.warn}</span>}
          {counts.info > 0 && <span className="pill pill-info">{counts.info}</span>}
        </div>
      </div>

      <div className={`space-y-2 overflow-y-auto pr-1 ${heightClass}`}>
        {total === 0 && (
          <div className="card text-text-muted text-sm">Sin alertas activas 🎉</div>
        )}
        {visible.map((a) => (
          <div key={a.id} className={`card border ${severityClass(a.severity)} space-y-1`}>
            <div className="flex items-start justify-between gap-2">
              <div className="font-medium text-sm leading-tight">{a.title}</div>
              <span className={severityPill(a.severity)}>{a.severity}</span>
            </div>
            {a.instanceName && (
              <div className="text-xs text-text-muted font-mono truncate">{a.instanceName}</div>
            )}
            {a.detail && <div className="text-xs text-text-secondary line-clamp-2">{a.detail}</div>}
            <div className="text-[10px] text-text-muted">
              {timeAgo(a.lastSeenAt)} · 1ra: {timeAgo(a.firstSeenAt)}
            </div>
          </div>
        ))}
        {overflow > 0 && (
          <Link
            href="/dashboard/alertas"
            className="card block text-center text-sm text-status-info hover:underline"
          >
            …y {overflow} más →
          </Link>
        )}
      </div>
    </aside>
  );
}
