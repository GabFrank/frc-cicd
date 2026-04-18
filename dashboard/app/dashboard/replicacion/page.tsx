"use client";

import Link from "next/link";
import { usePollJson } from "@/components/PollQuery";
import { statusToPill, timeAgo } from "@/lib/utils";

interface ServerData {
  id: number;
  kind: string;
  empresa: string | null;
  nombre: string;
  ip: string | null;
  pgHost: string | null;
  pgPort: number | null;
  pgDatabase: string | null;
  sucursalId: number | null;
  channel: string | null;
  pgStatus: string;
  pgVersion: string | null;
  pgError: string | null;
  pgCheckedAt: string | null;
  database: {
    sizeBytes: number | null;
    activeConnections: number | null;
    latencyMs: number | null;
  } | null;
  expected: Array<{
    id: number;
    kind: string;
    name: string;
    direction: string | null;
    peerName: string | null;
    notes: string | null;
    status: string | null;
    active: boolean | null;
    checkedAt: string | null;
  }>;
}

interface Data {
  servers: ServerData[];
  lastSync: { startedAt: string; finishedAt: string | null; ok: boolean; errorMessage: string | null } | null;
}

function fmtBytes(n: number | null | undefined) {
  if (n == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

function expectedPill(status: string | null, active: boolean | null) {
  if (status == null) return "pill pill-neutral";
  if (status === "missing") return "pill pill-err";
  if (status === "found" && active) return "pill pill-ok";
  if (status === "found") return "pill pill-warn";
  return "pill pill-neutral";
}

function expectedLabel(status: string | null, active: boolean | null) {
  if (status == null) return "no chequeado";
  if (status === "missing") return "missing";
  if (status === "found" && active) return "ok";
  if (status === "found") return "found · inactive";
  return status;
}

export default function ReplicacionPage() {
  const { data, isLoading, error } = usePollJson<Data>("/api/data/replicacion", ["replicacion-v2"]);

  if (isLoading) return <div className="text-text-secondary">Cargando…</div>;
  if (error) return <div className="text-status-err">Error: {(error as Error).message}</div>;
  if (!data) return null;

  const grouped = data.servers.reduce<Record<string, ServerData[]>>((acc, s) => {
    const key = s.empresa ?? "sin empresa";
    acc[key] = acc[key] ?? [];
    acc[key].push(s);
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Replicación · DB · Server</h1>
        <div className="flex items-center gap-3">
          {data.lastSync && (
            <span className="text-xs text-text-muted">
              Último sync: {timeAgo(data.lastSync.finishedAt ?? data.lastSync.startedAt)}
            </span>
          )}
          <Link href="/dashboard/admin" className="nav-link border border-border-subtle">
            Admin →
          </Link>
        </div>
      </div>

      {data.servers.length === 0 && (
        <div className="card text-text-muted">
          Sin servidores registrados. Ir a{" "}
          <Link href="/dashboard/admin" className="text-status-info hover:underline">Admin</Link>{" "}
          para registrar centrales y filiales.
        </div>
      )}

      {Object.entries(grouped).map(([empresa, list]) => (
        <section key={empresa} className="space-y-4">
          <h2 className="font-semibold capitalize text-lg">{empresa}</h2>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {list.map((s) => (
              <div key={s.id} className="card space-y-3">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className={`pill ${s.kind === "central" ? "pill-info" : "pill-neutral"}`}>{s.kind}</span>
                      <span className="font-semibold">{s.nombre}</span>
                    </div>
                    <div className="text-xs text-text-muted font-mono mt-1">
                      {s.pgHost ?? "—"}:{s.pgPort ?? "?"}/{s.pgDatabase ?? "?"}
                    </div>
                  </div>
                  <div className="text-right">
                    <span className={statusToPill(s.pgStatus)}>{s.pgStatus}</span>
                    {s.pgCheckedAt && (
                      <div className="text-xs text-text-muted mt-1">{timeAgo(s.pgCheckedAt)}</div>
                    )}
                  </div>
                </div>

                {s.pgError && <div className="text-xs text-status-err font-mono break-all">{s.pgError}</div>}

                {s.database && (
                  <div className="grid grid-cols-3 gap-2 text-sm">
                    <div>
                      <div className="text-[10px] uppercase text-text-muted">Tamaño DB</div>
                      <div>{fmtBytes(s.database.sizeBytes)}</div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase text-text-muted">Conexiones</div>
                      <div>{s.database.activeConnections ?? "—"}</div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase text-text-muted">Latencia</div>
                      <div>{s.database.latencyMs ?? "—"}ms</div>
                    </div>
                  </div>
                )}

                {s.expected.length === 0 ? (
                  <div className="text-xs text-text-muted border-t border-border-subtle pt-2">
                    Sin replicación esperada registrada.{" "}
                    <Link href={`/dashboard/admin/servers/${s.id}`} className="text-status-info hover:underline">
                      registrar →
                    </Link>
                  </div>
                ) : (
                  <div className="border-t border-border-subtle pt-2 space-y-1">
                    <div className="text-[10px] uppercase text-text-muted mb-1">Replicación esperada</div>
                    {s.expected.map((e) => (
                      <div key={e.id} className="flex items-center gap-2 text-sm">
                        <span className={expectedPill(e.status, e.active)}>{expectedLabel(e.status, e.active)}</span>
                        <span className="text-[10px] text-text-muted uppercase">{e.kind}</span>
                        <span className="font-mono text-xs truncate">{e.name}</span>
                        {e.direction && (
                          <span className="text-[10px] text-text-muted ml-auto shrink-0">
                            {e.direction === "central_to_filial" ? "C→F" : e.direction === "filial_to_central" ? "F→C" : e.direction}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {s.pgVersion && (
                  <div className="text-[10px] text-text-muted font-mono truncate border-t border-border-subtle pt-2">
                    {s.pgVersion}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
