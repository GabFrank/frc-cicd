"use client";

import Link from "next/link";
import { useRef, useState } from "react";
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
  const { data, isLoading, error } = usePollJson<Server[]>("/api/admin/servers", ["admin-servers"]);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const onImport = async (file: File, mode: "merge" | "replace") => {
    setImportMsg(null);
    try {
      const text = await file.text();
      const snapshot = JSON.parse(text);
      const res = await fetch("/api/admin/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ snapshot, mode }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `${res.status}`);
      setImportMsg(`✓ ${j.serversInserted} insertados · ${j.serversUpdated} actualizados · ${j.expectedInserted} expected`);
      window.location.reload();
    } catch (err) {
      setImportMsg(`✗ ${err instanceof Error ? err.message : String(err)}`);
    }
  };

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
        <div className="flex items-center gap-2">
          <a
            href="/api/admin/export"
            download
            className="rounded bg-bg-raised border border-border-default px-3 py-1.5 text-sm hover:bg-bg-surface"
            title="Descargar JSON con monitored_servers + expected_replication"
          >
            ⬇ Export
          </a>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="rounded bg-bg-raised border border-border-default px-3 py-1.5 text-sm hover:bg-bg-surface"
            title="Restaurar desde JSON exportado"
          >
            ⬆ Import
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              const mode = confirm("OK = MERGE (preservar locales y agregar/actualizar)\nCancel = REPLACE (borrar todo y restaurar)") ? "merge" : "replace";
              onImport(f, mode);
              e.target.value = "";
            }}
          />
          <Link
            href="/dashboard/admin/servers/new"
            className="rounded bg-status-info/20 border border-status-info/40 px-3 py-1.5 text-sm hover:bg-status-info/30"
          >
            + Nuevo servidor
          </Link>
        </div>
      </div>
      {importMsg && (
        <div className={`card text-sm ${importMsg.startsWith("✓") ? "text-status-ok" : "text-status-err"}`}>
          {importMsg}
        </div>
      )}

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
                        {s.pgUser ?? "?"}{" "}
                        {s.hasPassword ? (
                          <span className="text-status-ok">🔑</span>
                        ) : (
                          <span
                            className="text-status-err"
                            title="Sin password configurado — PG conn fallará con SASL error"
                          >
                            ⚠ sin password
                          </span>
                        )}
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
