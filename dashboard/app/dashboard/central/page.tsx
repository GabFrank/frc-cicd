"use client";

import { usePollJson } from "@/components/PollQuery";
import { statusToPill, timeAgo } from "@/lib/utils";

interface CentralInstance {
  id: number;
  name: string;
  displayName: string;
  host: string | null;
  port: number | null;
  environment: string | null;
  notes: string | null;
  health: {
    status: string;
    httpCode: number | null;
    latencyMs: number | null;
    checkedAt: string;
  } | null;
  recentChecks: Array<{
    status: string;
    httpCode: number | null;
    latencyMs: number | null;
    checkedAt: string;
  }>;
  deployments: Array<{
    id: number;
    ref: string | null;
    status: string | null;
    statusAt: string | null;
  }>;
  runtime: {
    version: string | null;
    build: string | null;
    gitCommit: string | null;
    uptimeSec: number | null;
    heapUsedBytes: number | null;
    heapMaxBytes: number | null;
    threads: number | null;
    updatedAt: string;
  } | null;
}

function fmtBytes(n: number | null | undefined) {
  if (n == null) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

function fmtUptime(s: number | null | undefined) {
  if (!s) return "—";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${Math.round(s / 86400)}d`;
}

export default function CentralPage() {
  const { data, isLoading, error } = usePollJson<CentralInstance[]>("/api/data/central", ["central"]);

  if (isLoading) return <div className="text-text-secondary">Cargando…</div>;
  if (error) return <div className="text-status-err">Error: {(error as Error).message}</div>;
  if (!data) return null;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Central · Instancias</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {data.map((c) => (
          <div key={c.id} className="card space-y-3">
            <div className="flex items-start justify-between">
              <div>
                <div className="font-semibold">{c.displayName}</div>
                <div className="text-xs text-text-muted font-mono">
                  {c.host}:{c.port}
                </div>
                {c.notes && <div className="text-xs text-text-muted mt-1">{c.notes}</div>}
              </div>
              <span className={statusToPill(c.health?.status ?? "neutral")}>
                {c.health?.status ?? "sin datos"}
              </span>
            </div>

            <div className="grid grid-cols-3 gap-2 text-sm">
              <div>
                <div className="text-[10px] uppercase text-text-muted">HTTP</div>
                <div className="font-mono">{c.health?.httpCode ?? "—"}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase text-text-muted">Latencia</div>
                <div className="font-mono">{c.health?.latencyMs ?? "—"} ms</div>
              </div>
              <div>
                <div className="text-[10px] uppercase text-text-muted">Chequeado</div>
                <div>{timeAgo(c.health?.checkedAt)}</div>
              </div>
            </div>

            <div>
              <div className="text-[10px] uppercase text-text-muted mb-1">Últimos 20 checks</div>
              <div className="flex gap-0.5">
                {c.recentChecks
                  .slice()
                  .reverse()
                  .map((h, i) => (
                    <div
                      key={i}
                      title={`${h.status} · ${h.httpCode ?? "?"} · ${h.latencyMs}ms · ${h.checkedAt}`}
                      className={`h-4 flex-1 ${
                        h.status === "up" ? "bg-status-ok/60" : "bg-status-err/60"
                      } rounded-sm`}
                    />
                  ))}
                {c.recentChecks.length === 0 && (
                  <div className="text-text-muted text-xs">—</div>
                )}
              </div>
            </div>

            {c.runtime && (
              <div className="border-t border-border-subtle pt-2 grid grid-cols-4 gap-2 text-sm">
                <div>
                  <div className="text-[10px] uppercase text-text-muted">Versión</div>
                  <div className="font-mono text-xs truncate">{c.runtime.version ?? "—"}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase text-text-muted">Uptime</div>
                  <div>{fmtUptime(c.runtime.uptimeSec)}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase text-text-muted">Heap</div>
                  <div>{fmtBytes(c.runtime.heapUsedBytes)} / {fmtBytes(c.runtime.heapMaxBytes)}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase text-text-muted">Threads</div>
                  <div>{c.runtime.threads ?? "—"}</div>
                </div>
              </div>
            )}

            <div>
              <div className="text-[10px] uppercase text-text-muted mb-1">Últimos deployments</div>
              <ul className="space-y-1 text-sm">
                {c.deployments.length === 0 && <li className="text-text-muted">—</li>}
                {c.deployments.map((d) => (
                  <li key={d.id} className="flex items-center gap-2">
                    <span className={statusToPill(d.status)}>{d.status ?? "?"}</span>
                    <span className="font-mono text-xs truncate">{d.ref}</span>
                    <span className="text-xs text-text-muted ml-auto">{timeAgo(d.statusAt)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
