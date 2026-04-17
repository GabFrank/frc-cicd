"use client";

import { usePollJson } from "@/components/PollQuery";
import { statusToPill, timeAgo } from "@/lib/utils";

interface Filial {
  id: number;
  name: string;
  displayName: string;
  host: string | null;
  port: number | null;
  company: string | null;
  environment: string | null;
  notes: string | null;
  latest: {
    id: number;
    ref: string | null;
    status: string | null;
    statusAt: string | null;
    description: string | null;
    logUrl: string | null;
  } | null;
  lastSuccess: { ref: string | null; statusAt: string | null } | null;
  history: Array<{
    id: number;
    ref: string | null;
    status: string | null;
    createdAt: string | null;
  }>;
}

export default function FilialesPage() {
  const { data, isLoading, error } = usePollJson<Filial[]>("/api/data/filiales", ["filiales"]);

  if (isLoading) return <div className="text-text-secondary">Cargando…</div>;
  if (error) return <div className="text-status-err">Error: {(error as Error).message}</div>;
  if (!data) return null;

  const grouped = data.reduce<Record<string, Filial[]>>((acc, f) => {
    const key = f.company ?? "otros";
    acc[key] = acc[key] ?? [];
    acc[key].push(f);
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Filiales</h1>

      {Object.entries(grouped).map(([company, list]) => (
        <section key={company} className="space-y-3">
          <h2 className="font-semibold capitalize">{company}</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {list.map((f) => (
              <div key={f.id} className="card space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-semibold">{f.displayName}</div>
                    <div className="text-xs text-text-muted font-mono">
                      {f.host}:{f.port} · {f.environment}
                    </div>
                  </div>
                  <span className={statusToPill(f.latest?.status ?? "neutral")}>
                    {f.latest?.status ?? "sin datos"}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <div className="text-[10px] uppercase text-text-muted">Versión actual</div>
                    <div className="font-mono truncate">{f.lastSuccess?.ref ?? "—"}</div>
                    <div className="text-xs text-text-muted">{timeAgo(f.lastSuccess?.statusAt)}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase text-text-muted">Último intento</div>
                    <div className="font-mono truncate">{f.latest?.ref ?? "—"}</div>
                    <div className="text-xs text-text-muted">{timeAgo(f.latest?.statusAt)}</div>
                  </div>
                </div>

                {f.latest?.description && (
                  <div className="text-xs text-text-secondary border-t border-border-subtle pt-2 line-clamp-2">
                    {f.latest.description}
                  </div>
                )}

                <div className="flex flex-wrap gap-1 pt-1">
                  {f.history.map((h) => (
                    <span
                      key={h.id}
                      title={`${h.ref ?? "?"} · ${h.createdAt ?? ""}`}
                      className={`pill ${
                        h.status === "success"
                          ? "pill-ok"
                          : h.status === "failure"
                            ? "pill-err"
                            : "pill-neutral"
                      } !px-1.5 !py-0 text-[10px]`}
                    >
                      {h.status?.slice(0, 1).toUpperCase() ?? "?"}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
