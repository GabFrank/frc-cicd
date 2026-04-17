"use client";

import { usePollJson } from "@/components/PollQuery";
import { statusToPill, timeAgo } from "@/lib/utils";

interface ReplicacionData {
  clusters: Array<{
    clusterPort: number;
    label: string;
    status: string;
    version: string | null;
    errorMessage: string | null;
    checkedAt: string;
    databases: Array<{
      name: string;
      status: string;
      sizeBytes: number | null;
      activeConnections: number | null;
      latencyMs: number | null;
      errorMessage: string | null;
      checkedAt: string;
    }>;
    sucursales: Array<{
      sucursalId: number;
      nombre: string | null;
      ip: string | null;
      puerto: number | null;
      activo: boolean | null;
      slotCentralToFilial: { name: string; active: boolean } | null;
      slotFilialToCentral: { name: string; active: boolean } | null;
      subscription: { name: string; active: boolean; extra: any } | null;
      publication: { name: string } | null;
      statReplication: { name: string; state: string; extra: any } | null;
    }>;
    orphanItems: Array<{
      kind: string;
      name: string;
      active: boolean | null;
      database: string | null;
    }>;
  }>;
  lastSync: {
    startedAt: string;
    finishedAt: string | null;
    ok: boolean;
    errorMessage: string | null;
  } | null;
}

function fmtBytes(n: number | null | undefined) {
  if (n == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

function Dot({ active, title }: { active: boolean | null | undefined; title?: string }) {
  return (
    <span
      title={title}
      className={`inline-block h-2.5 w-2.5 rounded-full ${
        active === true ? "bg-status-ok" : active === false ? "bg-status-err" : "bg-status-neutral/60"
      }`}
    />
  );
}

export default function ReplicacionPage() {
  const { data, isLoading, error } = usePollJson<ReplicacionData>(
    "/api/data/replicacion",
    ["replicacion"],
  );

  if (isLoading) return <div className="text-text-secondary">Cargando…</div>;
  if (error) return <div className="text-status-err">Error: {(error as Error).message}</div>;
  if (!data) return null;

  const disabled = data.lastSync?.errorMessage === "PG_CLUSTERS o PG_USER vacíos — skip";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Replicación</h1>
        {data.lastSync && (
          <span className="text-xs text-text-muted">
            Último sync: {timeAgo(data.lastSync.finishedAt ?? data.lastSync.startedAt)}
          </span>
        )}
      </div>

      {disabled && (
        <div className="card border-status-warn/40 bg-status-warn/5 text-sm">
          <strong>Monitoreo PG deshabilitado.</strong> Setear <code>PG_USER</code>,{" "}
          <code>PG_PASSWORD</code> y <code>PG_CLUSTERS</code> en <code>.env.local</code>.
          <br />
          Ejemplo: <code>PG_CLUSTERS=5551:central-prod:alpha,farmacia,bodega,5552:central-beta:beta</code>
        </div>
      )}

      {!disabled && data.clusters.length === 0 && (
        <div className="card text-text-muted">Sin datos aún — esperar al primer sync.</div>
      )}

      {data.clusters.map((cluster) => (
        <section key={cluster.clusterPort} className="space-y-3">
          <div className="flex items-center gap-3 flex-wrap">
            <h2 className="font-semibold text-lg">
              {cluster.label} · :{cluster.clusterPort}
            </h2>
            <span className={statusToPill(cluster.status)}>{cluster.status}</span>
            <span className="text-xs text-text-muted">{timeAgo(cluster.checkedAt)}</span>
            {cluster.version && (
              <span className="text-xs text-text-muted font-mono truncate max-w-md">{cluster.version}</span>
            )}
          </div>

          {cluster.errorMessage && (
            <div className="card text-sm text-status-err">{cluster.errorMessage}</div>
          )}

          {cluster.databases.length > 0 && (
            <div className="card">
              <h3 className="text-sm font-semibold mb-2">Bases de datos</h3>
              <table className="w-full text-sm">
                <thead className="text-left text-text-muted">
                  <tr>
                    <th className="py-1">Nombre</th>
                    <th>Estado</th>
                    <th>Tamaño</th>
                    <th>Conexiones</th>
                    <th>Latencia</th>
                  </tr>
                </thead>
                <tbody>
                  {cluster.databases.map((d) => (
                    <tr key={d.name} className="border-t border-border-subtle">
                      <td className="py-1 font-mono">{d.name}</td>
                      <td>
                        <span className={statusToPill(d.status)}>{d.status}</span>
                      </td>
                      <td>{fmtBytes(d.sizeBytes)}</td>
                      <td>{d.activeConnections ?? "—"}</td>
                      <td>{d.latencyMs != null ? `${d.latencyMs}ms` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {cluster.sucursales.length > 0 && (
            <div className="card overflow-x-auto">
              <h3 className="text-sm font-semibold mb-2">Sucursales / Filiales</h3>
              <table className="w-full text-sm">
                <thead className="text-left text-text-muted">
                  <tr>
                    <th className="py-1">ID</th>
                    <th>Nombre / IP</th>
                    <th title="Slot en central para replicación central→filial">Slot C→F</th>
                    <th title="Slot en central para replicación filial→central">Slot F→C</th>
                    <th>Suscripción</th>
                    <th>Publicación</th>
                    <th>Streaming</th>
                    <th>Activa</th>
                  </tr>
                </thead>
                <tbody>
                  {cluster.sucursales.map((s) => (
                    <tr key={s.sucursalId} className="border-t border-border-subtle">
                      <td className="py-1 font-mono">{s.sucursalId}</td>
                      <td className="text-xs">
                        <div>{s.nombre ?? "—"}</div>
                        <div className="text-text-muted font-mono">
                          {s.ip ?? "—"}
                          {s.puerto ? `:${s.puerto}` : ""}
                        </div>
                      </td>
                      <td>
                        <Dot active={s.slotCentralToFilial?.active} title={s.slotCentralToFilial?.name} />
                        <span className="text-[10px] text-text-muted ml-1">{s.slotCentralToFilial?.name ?? "—"}</span>
                      </td>
                      <td>
                        <Dot active={s.slotFilialToCentral?.active} title={s.slotFilialToCentral?.name} />
                        <span className="text-[10px] text-text-muted ml-1">{s.slotFilialToCentral?.name ?? "—"}</span>
                      </td>
                      <td>
                        <Dot active={s.subscription?.active} title={s.subscription?.name} />
                        <span className="text-[10px] text-text-muted ml-1">{s.subscription?.name ?? "—"}</span>
                      </td>
                      <td className="text-[10px] text-text-muted">{s.publication?.name ?? "—"}</td>
                      <td>
                        <Dot
                          active={s.statReplication ? s.statReplication.state === "streaming" : null}
                          title={s.statReplication?.state}
                        />
                        <span className="text-[10px] text-text-muted ml-1">
                          {s.statReplication?.state ?? "—"}
                        </span>
                      </td>
                      <td>
                        <Dot active={s.activo} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {cluster.orphanItems.length > 0 && (
            <details className="card text-xs">
              <summary className="cursor-pointer text-text-secondary">
                Ítems sin sucursal matcheada ({cluster.orphanItems.length})
              </summary>
              <ul className="mt-2 space-y-1 font-mono">
                {cluster.orphanItems.map((o, i) => (
                  <li key={i}>
                    <span className="text-text-muted">{o.kind}</span> · {o.name}{" "}
                    <span className="text-text-muted">({o.database})</span>{" "}
                    <Dot active={o.active} />
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      ))}
    </div>
  );
}
