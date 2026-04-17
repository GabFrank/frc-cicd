"use client";

import { usePollJson } from "@/components/PollQuery";
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

function AlertCard({ a }: { a: Alert }) {
  const cls =
    a.severity === "critical"
      ? "border-status-err/50 bg-status-err/5"
      : a.severity === "warn"
        ? "border-status-warn/50 bg-status-warn/5"
        : "border-border-subtle";
  return (
    <div className={`card ${cls}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-semibold">{a.title}</div>
          <div className="text-xs text-text-muted font-mono">
            {a.kind} {a.instanceName ? `· ${a.instanceName}` : ""}
          </div>
        </div>
        <span
          className={`pill ${
            a.severity === "critical" ? "pill-err" : a.severity === "warn" ? "pill-warn" : "pill-info"
          }`}
        >
          {a.severity}
        </span>
      </div>
      {a.detail && <div className="text-sm text-text-secondary mt-2">{a.detail}</div>}
      <div className="text-xs text-text-muted mt-2 flex gap-3">
        <span>Primera: {timeAgo(a.firstSeenAt)}</span>
        <span>Última: {timeAgo(a.lastSeenAt)}</span>
        {a.resolvedAt && <span className="text-status-ok">Resuelta: {timeAgo(a.resolvedAt)}</span>}
      </div>
    </div>
  );
}

export default function AlertasPage() {
  const { data, isLoading, error } = usePollJson<AlertData>("/api/data/alertas", ["alertas"]);

  if (isLoading) return <div className="text-text-secondary">Cargando…</div>;
  if (error) return <div className="text-status-err">Error: {(error as Error).message}</div>;
  if (!data) return null;

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold">Alertas</h1>

      <section className="space-y-3">
        <h2 className="font-semibold">Activas ({data.active.length})</h2>
        {data.active.length === 0 ? (
          <div className="text-text-muted">Sin alertas activas.</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {data.active.map((a) => (
              <AlertCard key={a.id} a={a} />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="font-semibold">Recientemente resueltas</h2>
        {data.recentlyResolved.length === 0 ? (
          <div className="text-text-muted">—</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 opacity-70">
            {data.recentlyResolved.map((a) => (
              <AlertCard key={a.id} a={a} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
