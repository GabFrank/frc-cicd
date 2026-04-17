"use client";

import Link from "next/link";
import { usePollJson } from "@/components/PollQuery";
import { statusToPill, timeAgo } from "@/lib/utils";

interface Overview {
  components: Array<{
    id: number;
    slug: string;
    displayName: string;
    repoFullName: string;
    channels: Array<{
      channel: string;
      branch: string;
      latestTag: string | null;
      publishedAt: string | null;
      htmlUrl: string | null;
    }>;
  }>;
  alerts: { total: number; critical: number; warn: number };
  lastSync: Array<{
    id: number;
    jobName: string;
    startedAt: string;
    finishedAt: string | null;
    ok: boolean;
    itemsIngested: number | null;
    errorMessage: string | null;
  }>;
}

export default function OverviewPage() {
  const { data, isLoading, error } = usePollJson<Overview>("/api/data/overview", ["overview"]);

  if (isLoading) return <div className="text-text-secondary">Cargando…</div>;
  if (error) return <div className="text-status-err">Error: {(error as Error).message}</div>;
  if (!data) return null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Overview</h1>
        <div className="flex items-center gap-2">
          <span className={`pill ${data.alerts.critical > 0 ? "pill-err" : data.alerts.warn > 0 ? "pill-warn" : "pill-ok"}`}>
            {data.alerts.total} alertas activas
          </span>
          <Link href="/dashboard/alertas" className="nav-link">Ver →</Link>
        </div>
      </div>

      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {data.components.map((c) => (
          <div key={c.id} className="card space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-semibold">{c.displayName}</div>
                <a
                  href={`https://github.com/${c.repoFullName}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-text-muted hover:text-text-secondary"
                >
                  {c.repoFullName} ↗
                </a>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {c.channels.map((ch) => (
                <div
                  key={ch.channel}
                  className="bg-bg-raised border border-border-subtle rounded px-2 py-2"
                >
                  <div className="text-[10px] uppercase text-text-muted tracking-wide">{ch.channel}</div>
                  <div className="font-mono text-sm truncate">
                    {ch.latestTag ? (
                      <a href={ch.htmlUrl ?? "#"} target="_blank" rel="noreferrer" className="hover:underline">
                        {ch.latestTag}
                      </a>
                    ) : (
                      <span className="text-text-muted">—</span>
                    )}
                  </div>
                  <div className="text-xs text-text-muted">{timeAgo(ch.publishedAt)}</div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </section>

      <section className="card space-y-2">
        <h2 className="font-semibold">Sincronización</h2>
        <table className="w-full text-sm">
          <thead className="text-left text-text-muted">
            <tr>
              <th className="py-1">Job</th>
              <th>Inicio</th>
              <th>Duración</th>
              <th>Ítems</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            {data.lastSync.map((r) => {
              const dur = r.finishedAt
                ? `${Math.round(
                    (new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()) / 1000,
                  )}s`
                : "—";
              return (
                <tr key={r.id} className="border-t border-border-subtle">
                  <td className="py-1 font-mono text-xs">{r.jobName}</td>
                  <td className="text-text-secondary">{timeAgo(r.startedAt)}</td>
                  <td className="text-text-secondary">{dur}</td>
                  <td className="text-text-secondary">{r.itemsIngested ?? 0}</td>
                  <td>
                    <span className={statusToPill(r.ok ? "ok" : "failure")}>
                      {r.ok ? "ok" : r.errorMessage ?? "failed"}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
