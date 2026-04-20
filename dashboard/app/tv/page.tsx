"use client";

import { useEffect, useState } from "react";
import { usePollJson } from "@/components/PollQuery";
import { AlertSidebar } from "@/components/AlertSidebar";
import { ServerTileGrid } from "@/components/tv/ServerTileGrid";
import { CicdFlowCard } from "@/components/tv/CicdFlowCard";
import { ReplicationLagCard } from "@/components/tv/ReplicationLagCard";
import { DriftMatrixCard } from "@/components/tv/DriftMatrixCard";
import type { ServerStatus } from "@/components/ServerStatusCard";

interface Overview {
  serverSummary: ServerStatus[];
  summary: {
    serversTotal: number;
    serversUp: number;
    serversDown: number;
    replicationProblems: number;
    versionDriftCount: number;
    totalAlerts: number;
    criticalAlerts: number;
  };
  topLag: Array<{
    expectedId: number;
    slotName: string;
    serverId: number;
    serverName: string;
    active: boolean;
    lagBytes: number | null;
    checkedAt: string;
  }>;
  recentRuns: any[];
  latestReleases: any[];
  driftRows: Array<{
    id: number;
    nombre: string;
    empresa: string | null;
    channel: string | null;
    current: string | null;
    expected: string | null;
  }>;
}

function CardShell({ title, count, children }: { title: string; count?: string; children: React.ReactNode }) {
  return (
    <section className="card-raised flex flex-col min-h-0 overflow-hidden">
      <header className="flex items-baseline justify-between mb-2 shrink-0">
        <h2 className="text-lg font-semibold">{title}</h2>
        {count && <span className="text-xs text-text-muted tabular-nums">{count}</span>}
      </header>
      <div className="flex-1 min-h-0 overflow-hidden">{children}</div>
    </section>
  );
}

export default function TvPage() {
  const { data } = usePollJson<Overview>("/api/data/overview", ["tv-overview-v3"]);

  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const servers = data?.serverSummary ?? [];
  const s = data?.summary;

  return (
    <div className="fixed inset-0 bg-bg-base text-text-primary flex flex-col">
      <header className="px-6 py-3 border-b border-border-subtle flex items-center justify-between bg-bg-surface shrink-0">
        <div className="flex items-center gap-6">
          <h1 className="text-2xl font-bold">FRC · Estado del SaaS</h1>
          {s && (
            <div className="flex items-center gap-4 text-sm">
              <span>
                <strong className={s.serversDown > 0 ? "text-status-err" : "text-status-ok"}>
                  {s.serversUp}
                </strong>
                <span className="text-text-muted">/{s.serversTotal}</span>
                <span className="text-text-muted ml-1">servers</span>
              </span>
              <span>
                <strong className={s.replicationProblems > 0 ? "text-status-warn" : "text-status-ok"}>
                  {s.replicationProblems}
                </strong>
                <span className="text-text-muted ml-1">repl issues</span>
              </span>
              <span>
                <strong className={s.versionDriftCount > 0 ? "text-status-warn" : "text-status-ok"}>
                  {s.versionDriftCount}
                </strong>
                <span className="text-text-muted ml-1">drift</span>
              </span>
              <span>
                <strong className={s.criticalAlerts > 0 ? "text-status-err" : s.totalAlerts > 0 ? "text-status-warn" : "text-status-ok"}>
                  {s.totalAlerts}
                </strong>
                <span className="text-text-muted ml-1">alertas</span>
              </span>
            </div>
          )}
        </div>
        <div className="text-right">
          <div className="text-2xl font-mono">{now.toLocaleTimeString()}</div>
          <div className="text-xs text-text-muted">
            {now.toLocaleDateString("es-PY", { weekday: "long", day: "numeric", month: "long" })}
          </div>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        <main className="flex-1 p-3 overflow-hidden">
          <div className="grid grid-cols-2 grid-rows-2 gap-3 h-full">
            <CardShell
              title="Servidores"
              count={s ? `${s.serversUp}/${s.serversTotal} up` : undefined}
            >
              <div className="overflow-auto h-full">
                <ServerTileGrid servers={servers} />
              </div>
            </CardShell>

            <CardShell title="CI/CD">
              <CicdFlowCard
                runs={data?.recentRuns ?? []}
                releases={data?.latestReleases ?? []}
              />
            </CardShell>

            <CardShell title="Replicación · top lag">
              <ReplicationLagCard rows={data?.topLag ?? []} />
            </CardShell>

            <CardShell
              title="Version drift"
              count={s && s.versionDriftCount > 0 ? `${s.versionDriftCount} affected` : undefined}
            >
              <DriftMatrixCard rows={data?.driftRows ?? []} />
            </CardShell>
          </div>
        </main>

        <aside className="w-[360px] shrink-0 border-l border-border-subtle p-3 overflow-hidden flex flex-col bg-bg-surface">
          <AlertSidebar heightClass="h-[calc(100vh-8rem)]" maxItems={25} readOnly />
        </aside>
      </div>
    </div>
  );
}
