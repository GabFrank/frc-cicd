"use client";

import Link from "next/link";
import { usePollJson } from "@/components/PollQuery";
import { statusToPill, timeAgo } from "@/lib/utils";

interface Server {
  id: number;
  kind: string;
  empresa: string | null;
  nombre: string;
  ip: string | null;
  appPort: number | null;
  pgHost: string | null;
  pgPort: number | null;
  pgDatabase: string | null;
  pgUser: string | null;
  hasPassword: boolean;
  channel: string | null;
  os: string | null;
  sucursalId: number | null;
  active: boolean;
  notes: string | null;
}

export default function AdminPage() {
  const { data, isLoading, error, refetch } = usePollJson<Server[]>("/api/admin/servers", ["admin-servers"]);

  if (isLoading) return <div className="text-text-secondary">Cargando…</div>;
  if (error) return <div className="text-status-err">Error: {(error as Error).message}</div>;

  const servers = data ?? [];
  const grouped = servers.reduce<Record<string, Server[]>>((acc, s) => {
    const key = s.empresa ?? "sin empresa";
    acc[key] = acc[key] ?? [];
    acc[key].push(s);
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Admin · Servidores monitoreados</h1>
          <p className="text-sm text-text-muted mt-1">
            Cada servidor declara su PG endpoint y los pub/sub que se esperan encontrar.
          </p>
        </div>
        <Link
          href="/dashboard/admin/servers/new"
          className="rounded bg-status-info/20 border border-status-info/40 px-3 py-1.5 text-sm hover:bg-status-info/30"
        >
          + Nuevo servidor
        </Link>
      </div>

      {servers.length === 0 && (
        <div className="card text-text-muted">Sin servidores registrados.</div>
      )}

      {Object.entries(grouped).map(([empresa, list]) => (
        <section key={empresa} className="space-y-3">
          <h2 className="font-semibold capitalize">{empresa}</h2>
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-text-muted">
                <tr>
                  <th className="py-1">Tipo</th>
                  <th>Nombre</th>
                  <th>IP : app</th>
                  <th>PG endpoint</th>
                  <th>Sucursal</th>
                  <th>Canal / OS</th>
                  <th>Activo</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {list.map((s) => (
                  <tr key={s.id} className="border-t border-border-subtle">
                    <td className="py-1">
                      <span className={`pill ${s.kind === "central" ? "pill-info" : "pill-neutral"}`}>
                        {s.kind}
                      </span>
                    </td>
                    <td className="font-medium">{s.nombre}</td>
                    <td className="font-mono text-xs">
                      {s.ip ?? "—"}
                      {s.appPort ? `:${s.appPort}` : ""}
                    </td>
                    <td className="font-mono text-xs">
                      {s.pgHost ?? "—"}:{s.pgPort ?? "?"}/{s.pgDatabase ?? "?"}
                      <br />
                      <span className="text-text-muted">
                        {s.pgUser ?? "?"} {s.hasPassword ? "·🔑" : ""}
                      </span>
                    </td>
                    <td>{s.sucursalId ?? "—"}</td>
                    <td className="text-xs">
                      {s.channel ?? "—"} / {s.os ?? "—"}
                    </td>
                    <td>
                      <span className={statusToPill(s.active ? "ok" : "neutral")}>
                        {s.active ? "sí" : "no"}
                      </span>
                    </td>
                    <td>
                      <Link
                        href={`/dashboard/admin/servers/${s.id}`}
                        className="text-status-info hover:underline text-xs"
                      >
                        Editar →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}
