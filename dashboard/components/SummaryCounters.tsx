"use client";

interface Summary {
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
}

function Cell({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: number | string;
  sub?: string;
  tone?: "ok" | "warn" | "err" | "neutral";
}) {
  const valueCls =
    tone === "ok"
      ? "text-status-ok"
      : tone === "warn"
        ? "text-status-warn"
        : tone === "err"
          ? "text-status-err"
          : "text-text-primary";
  return (
    <div className="card-raised">
      <div className="text-[10px] uppercase text-text-muted">{label}</div>
      <div className={`text-3xl font-bold ${valueCls}`}>{value}</div>
      {sub && <div className="text-xs text-text-muted">{sub}</div>}
    </div>
  );
}

export function SummaryCounters({ s }: { s: Summary }) {
  const serversDownTone = s.serversDown > 0 ? "err" : "ok";
  const replTone = s.replicationProblems > 0 ? "warn" : "ok";
  const driftTone = s.versionDriftCount > 0 ? "warn" : "ok";
  const alertTone =
    s.criticalAlerts > 0 ? "err" : s.warnAlerts > 0 ? "warn" : "ok";

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
      <Cell
        label="Servidores"
        value={`${s.serversUp} / ${s.serversTotal}`}
        sub={s.serversDown > 0 ? `${s.serversDown} DOWN` : "todos OK"}
        tone={serversDownTone}
      />
      <Cell
        label="Clusters PG"
        value={`${s.pgClustersUp} / ${s.pgClustersUp + s.pgClustersDown}`}
        sub={s.pgClustersDown > 0 ? `${s.pgClustersDown} DOWN` : "todos OK"}
        tone={s.pgClustersDown > 0 ? "err" : "ok"}
      />
      <Cell
        label="Replicación"
        value={`${s.replicationOk} OK`}
        sub={s.replicationProblems > 0 ? `${s.replicationProblems} con problemas` : "sin problemas"}
        tone={replTone}
      />
      <Cell
        label="Versión drift"
        value={s.versionDriftCount}
        sub={s.versionDriftCount > 0 ? "instancias desactualizadas" : "todo al día"}
        tone={driftTone}
      />
      <Cell
        label="Alertas activas"
        value={s.totalAlerts}
        sub={`${s.criticalAlerts} críticas · ${s.warnAlerts} warn`}
        tone={alertTone}
      />
    </div>
  );
}
