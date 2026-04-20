"use client";

import Link from "next/link";
import { useState } from "react";
import { usePollJson } from "@/components/PollQuery";
import { AlertSidebar } from "@/components/AlertSidebar";
import { SummaryCounters } from "@/components/SummaryCounters";
import { ServerStatusCard, type ServerStatus } from "@/components/ServerStatusCard";
import { ServerTileGrid } from "@/components/tv/ServerTileGrid";
import { CicdFlowCard } from "@/components/tv/CicdFlowCard";
import { ReplicationLagCard } from "@/components/tv/ReplicationLagCard";
import { DriftMatrixCard } from "@/components/tv/DriftMatrixCard";
import { Modal } from "@/components/Modal";
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
  topLag: any[];
  recentRuns: any[];
  latestReleases: any[];
  driftRows: any[];
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

function CardShell({
  title,
  count,
  href,
  children,
}: {
  title: string;
  count?: string;
  href?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="card-raised flex flex-col min-h-0">
      <header className="flex items-baseline justify-between mb-2 shrink-0">
        <h2 className="text-base font-semibold">{title}</h2>
        <div className="flex items-center gap-2 text-xs">
          {count && <span className="text-text-muted tabular-nums">{count}</span>}
          {href && (
            <Link href={href} className="text-status-info hover:underline">
              ver →
            </Link>
          )}
        </div>
      </header>
      <div className="flex-1 min-h-0 overflow-auto">{children}</div>
    </section>
  );
}

export default function OverviewPage() {
  const { data, isLoading, error } = usePollJson<Overview>("/api/data/overview", ["overview-v2"]);
  const [selectedServer, setSelectedServer] = useState<ServerStatus | null>(null);

  if (isLoading && !data) return <div className="text-text-secondary">Cargando…</div>;
  if (error) return <div className="text-status-err">Error: {(error as Error).message}</div>;
  if (!data) return null;

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px] gap-4">
      <div className="space-y-4 min-w-0">
        <SummaryCounters s={data.summary} />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 min-h-[600px]">
          <CardShell
            title="Servidores"
            count={`${data.summary.serversUp}/${data.summary.serversTotal} up`}
            href="/dashboard/central"
          >
            <ServerTileGrid
              servers={data.serverSummary}
              interactive
              onTileClick={(s) => setSelectedServer(s)}
            />
          </CardShell>

          <CardShell title="CI/CD" href="/dashboard/cicd">
            <CicdFlowCard
              runs={data.recentRuns ?? []}
              releases={data.latestReleases ?? []}
              interactive
            />
          </CardShell>

          <CardShell
            title="Replicación · top lag"
            href="/dashboard/replicacion"
          >
            <ReplicationLagCard rows={data.topLag ?? []} />
          </CardShell>

          <CardShell
            title="Version drift"
            count={data.summary.versionDriftCount > 0 ? `${data.summary.versionDriftCount} affected` : undefined}
          >
            <DriftMatrixCard rows={data.driftRows ?? []} />
          </CardShell>
        </div>

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

      <Modal
        open={selectedServer != null}
        onClose={() => setSelectedServer(null)}
        title={selectedServer?.nombre ?? ""}
        widthClass="max-w-2xl"
      >
        {selectedServer && (
          <div className="space-y-3">
            <ServerStatusCard s={selectedServer} />
            <div className="flex items-center gap-3 text-sm">
              <Link
                href={`/dashboard/admin/servers/${selectedServer.id}`}
                className="text-status-info hover:underline"
              >
                Editar servidor →
              </Link>
              <Link
                href="/dashboard/replicacion"
                className="text-status-info hover:underline"
              >
                Ver replicación →
              </Link>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
