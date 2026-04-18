"use client";

import Link from "next/link";
import { usePollJson } from "@/components/PollQuery";
import { AlertSidebar } from "@/components/AlertSidebar";
import { SummaryCounters } from "@/components/SummaryCounters";
import { ServerStatusCard, type ServerStatus } from "@/components/ServerStatusCard";
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
    lastWorkflow: { status: string | null; conclusion: string | null; htmlUrl: string | null; runStartedAt: string | null } | null;
    openPRs: number;
  }>;
  alerts: { total: number; critical: number; warn: number };
  summary: {
    serversTotal: number;
    serversUp: number;
    serversDown: number;
    pgClustersUp: number;
    pgClustersDown: number;
    replicationOk: number;
    replicationProblems: number;
    versionDriftCount: number;
    criticalAlerts: number;
    warnAlerts: number;
    totalAlerts: number;
  };
  serverSummary: ServerStatus[];
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
  const { data, isLoading, error } = usePollJson<Overview>("/api/data/overview", ["overview-v2"]);

  if (isLoading && !data) return <div className="text-text-secondary">Cargando…</div>;
  if (error) return <div className="text-status-err">Error: {(error as Error).message}</div>;
  if (!data) return null;

  const grouped = data.serverSummary.reduce<Record<string, ServerStatus[]>>((acc, s) => {
    const key = s.empresa ?? "sin empresa";
    acc[key] = acc[key] ?? [];
    acc[key].push(s);
    return acc;
  }, {});

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-6">
      <div className="space-y-6 min-w-0">
        <SummaryCounters s={data.summary} />

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">CI/CD</h2>
            <Link href="/dashboard/cicd" className="text-xs text-status-info hover:underline">
              ver detalle →
            </Link>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {data.components.map((c) => (
              <div key={c.id} className="card space-y-2">
                <div className="flex items-start justify-between">
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
                  <div className="flex items-center gap-2">
                    {c.lastWorkflow && (
                      <a href={c.lastWorkflow.htmlUrl ?? "#"} target="_blank" rel="noreferrer">
                        <span className={statusToPill(c.lastWorkflow.conclusion ?? c.lastWorkflow.status)}>
                          {c.lastWorkflow.conclusion ?? c.lastWorkflow.status}
                        </span>
                      </a>
                    )}
                    {c.openPRs > 0 && (
                      <span className="pill pill-info">{c.openPRs} PR</span>
                    )}
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {c.channels.map((ch) => (
                    <div
                      key={ch.channel}
                      className="bg-bg-raised border border-border-subtle rounded px-2 py-1.5"
                    >
                      <div className="text-[10px] uppercase text-text-muted">{ch.channel}</div>
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
          </div>
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Servidores</h2>
            <div className="flex gap-2 text-xs">
              <Link href="/dashboard/central" className="text-status-info hover:underline">centrales →</Link>
              <Link href="/dashboard/filiales" className="text-status-info hover:underline">filiales →</Link>
              <Link href="/dashboard/replicacion" className="text-status-info hover:underline">replicación →</Link>
            </div>
          </div>
          {Object.entries(grouped).map(([empresa, list]) => (
            <div key={empresa} className="space-y-2">
              <h3 className="text-sm font-semibold capitalize text-text-secondary">{empresa}</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {list.map((s) => <ServerStatusCard key={s.id} s={s} />)}
              </div>
            </div>
          ))}
        </section>

        <section className="card space-y-2">
          <h2 className="font-semibold text-sm">Sincronización</h2>
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
                  ? `${Math.round((new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()) / 1000)}s`
                  : "—";
                return (
                  <tr key={r.id} className="border-t border-border-subtle">
                    <td className="py-1 font-mono text-xs">{r.jobName}</td>
                    <td className="text-text-secondary">{timeAgo(r.startedAt)}</td>
                    <td className="text-text-secondary">{dur}</td>
                    <td className="text-text-secondary">{r.itemsIngested ?? 0}</td>
                    <td>
                      <span className={statusToPill(r.ok ? "ok" : "failure")}>
                        {r.ok ? "ok" : (r.errorMessage ?? "failed").slice(0, 60)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      </div>

      <div className="xl:sticky xl:top-4 xl:self-start">
        <AlertSidebar maxItems={20} />
      </div>
    </div>
  );
}
