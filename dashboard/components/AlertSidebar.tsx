"use client";

import Link from "next/link";
import { useState } from "react";
import { usePollJson } from "./PollQuery";
import { AlertDialog } from "./AlertDialog";
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
  state?: string;
  consecutiveHits?: number;
  consecutiveClears?: number;
  promotedAt?: string | null;
}

function stateIcon(state?: string): string {
  switch (state) {
    case "pending": return "⏳";
    case "firing": return "🔴";
    case "resolving": return "🟡";
    default: return "";
  }
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

export function AlertSidebar({
  heightClass = "h-[calc(100vh-9rem)]",
  maxItems,
  readOnly = false,
}: {
  heightClass?: string;
  maxItems?: number;
  readOnly?: boolean;
}) {
  const { data, isLoading } = usePollJson<AlertData>("/api/data/alertas", ["sidebar-alertas"]);
  const [openId, setOpenId] = useState<number | null>(null);

  if (isLoading) {
    return (
      <aside className="card text-text-muted text-sm">Cargando alertas…</aside>
    );
  }
  if (!data) return null;

  const active = data.active;
  // Split pending (no confirmadas aún) de las que ya promovieron (firing/resolving).
  const pending = active.filter((a) => a.state === "pending");
  const fired = active.filter((a) => a.state !== "pending");

  const grouped: Record<string, Alert[]> = { critical: [], warn: [], info: [] };
  for (const a of fired) {
    const key = SEVERITY_ORDER.includes(a.severity as any) ? a.severity : "info";
    grouped[key].push(a);
  }

  const total = fired.length;
  const counts = {
    critical: grouped.critical.length,
    warn: grouped.warn.length,
    info: grouped.info.length,
    pending: pending.length,
  };

  // Mostrar fired + pending al final. Limite de maxItems.
  const combined = [...fired, ...pending];
  let visible = combined;
  let overflow = 0;
  if (maxItems && combined.length > maxItems) {
    visible = combined.slice(0, maxItems);
    overflow = combined.length - maxItems;
  }

  return (
    <aside className="space-y-3">
      <div className="card-raised flex items-center justify-between">
        <div>
          <div className="text-xs uppercase text-text-muted">Alertas activas</div>
          <div className="text-2xl font-bold">{total}</div>
        </div>
        <div className="flex gap-1 text-xs flex-wrap justify-end">
          {counts.critical > 0 && <span className="pill pill-err">{counts.critical}</span>}
          {counts.warn > 0 && <span className="pill pill-warn">{counts.warn}</span>}
          {counts.info > 0 && <span className="pill pill-info">{counts.info}</span>}
          {counts.pending > 0 && (
            <span className="pill pill-neutral" title="Pendientes — aún no confirmadas">
              ⏳ {counts.pending}
            </span>
          )}
        </div>
      </div>

      <div className={`space-y-2 overflow-y-auto pr-1 ${heightClass}`}>
        {total === 0 && (
          <div className="card text-text-muted text-sm">Sin alertas activas 🎉</div>
        )}
        {visible.map((a) => {
          const cardCls = `card border ${a.state === "pending" ? "border-border-subtle bg-bg-raised opacity-70" : severityClass(a.severity)} space-y-1 w-full text-left ${readOnly ? "" : "hover:brightness-125 transition cursor-pointer"}`;
          const content = (
            <>
              <div className="flex items-start justify-between gap-2">
                <div className="font-medium text-sm leading-tight">
                  {stateIcon(a.state) && <span className="mr-1">{stateIcon(a.state)}</span>}
                  {a.title}
                </div>
                <span className={a.state === "pending" ? "pill pill-neutral" : severityPill(a.severity)}>
                  {a.state === "pending" ? "pending" : a.severity}
                </span>
              </div>
              {a.instanceName && (
                <div className="text-xs text-text-muted font-mono truncate">{a.instanceName}</div>
              )}
              {a.detail && <div className="text-xs text-text-secondary line-clamp-2">{a.detail}</div>}
              <div className="text-[10px] text-text-muted">
                {timeAgo(a.lastSeenAt)} · 1ra: {timeAgo(a.firstSeenAt)}
              </div>
            </>
          );
          if (readOnly) {
            return <div key={a.id} className={cardCls}>{content}</div>;
          }
          return (
            <button
              key={a.id}
              type="button"
              onClick={() => setOpenId(a.id)}
              className={cardCls}
              title={`Click para gestionar${a.state ? ` · estado: ${a.state}` : ""}`}
            >
              {content}
            </button>
          );
        })}
        {overflow > 0 && (
          <Link
            href="/dashboard/alertas"
            className="card block text-center text-sm text-status-info hover:underline"
          >
            …y {overflow} más →
          </Link>
        )}
      </div>
      {!readOnly && (
        <AlertDialog
          alertId={openId}
          open={openId != null}
          onClose={() => setOpenId(null)}
        />
      )}
    </aside>
  );
}
