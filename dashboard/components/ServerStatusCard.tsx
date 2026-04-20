"use client";

import { statusToPill, timeAgo } from "@/lib/utils";
import { RefreshButton } from "./RefreshButton";

export interface ServerStatus {
  id: number;
  kind: string;
  empresa: string | null;
  nombre: string;
  channel: string | null;
  appHealth: "up" | "down" | "unknown";
  appHealthAt: string | null;
  appHealthLatency: number | null;
  pgStatus: string;
  pgCheckedAt: string | null;
  runtimeVersion: string | null;
  expectedTag: string | null;
  versionDrift: boolean;
  uptimeSec: number | null;
  replicationOk: number;
  replicationWarn: number;
  replicationErr: number;
  ip: string | null;
  appPort: number | null;
}

function fmtUptime(s: number | null | undefined): { txt: string; tone: "ok" | "warn" | "err" | "neutral" } {
  if (s == null) return { txt: "—", tone: "neutral" };
  if (s < 3600) return { txt: `${Math.round(s / 60)}m`, tone: "err" };
  if (s < 86400) return { txt: `${(s / 3600).toFixed(1)}h`, tone: "warn" };
  return { txt: `${Math.round(s / 86400)}d`, tone: "ok" };
}

export function ServerStatusCard({ s }: { s: ServerStatus }) {
  const uptime = fmtUptime(s.uptimeSec);
  const totalRepl = s.replicationOk + s.replicationWarn + s.replicationErr;
  const replPill =
    totalRepl === 0
      ? "pill pill-neutral"
      : s.replicationErr > 0
        ? "pill pill-err"
        : s.replicationWarn > 0
          ? "pill pill-warn"
          : "pill pill-ok";

  return (
    <div className="card space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`pill ${s.kind === "central" ? "pill-info" : "pill-neutral"}`}>{s.kind}</span>
            <span className="font-semibold truncate">{s.nombre}</span>
          </div>
          <div className="text-xs text-text-muted font-mono mt-0.5 truncate">
            {s.ip}:{s.appPort ?? "?"} · canal {s.channel ?? "—"}
          </div>
        </div>
        <div className="text-right shrink-0 flex items-start gap-2">
          <div>
            <span className={statusToPill(s.appHealth)}>{s.appHealth}</span>
            <div className="text-[10px] text-text-muted mt-0.5">
              {s.appHealthLatency ? `${s.appHealthLatency}ms · ` : ""}{timeAgo(s.appHealthAt)}
            </div>
          </div>
          <RefreshButton serverId={s.id} className="text-sm mt-0.5" />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 text-sm">
        <div>
          <div className="text-[10px] uppercase text-text-muted">PG</div>
          <span className={statusToPill(s.pgStatus)}>{s.pgStatus}</span>
        </div>
        <div>
          <div className="text-[10px] uppercase text-text-muted">Replicación</div>
          {totalRepl > 0 ? (
            <span className={replPill}>
              {s.replicationOk}✓ {s.replicationWarn}? {s.replicationErr}✗
            </span>
          ) : (
            <span className="text-text-muted text-xs">sin esperadas</span>
          )}
        </div>
        <div>
          <div className="text-[10px] uppercase text-text-muted">Uptime</div>
          <span
            className={
              uptime.tone === "ok"
                ? "text-status-ok"
                : uptime.tone === "warn"
                  ? "text-status-warn"
                  : uptime.tone === "err"
                    ? "text-status-err"
                    : "text-text-muted"
            }
          >
            {uptime.txt}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-sm border-t border-border-subtle pt-2">
        <div>
          <div className="text-[10px] uppercase text-text-muted">Versión actual</div>
          <div className={`font-mono text-xs truncate ${s.versionDrift ? "text-status-err" : ""}`}>
            {s.runtimeVersion ?? "—"}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase text-text-muted">Esperada ({s.channel ?? "—"})</div>
          <div className="font-mono text-xs truncate">{s.expectedTag ?? "—"}</div>
        </div>
        {s.versionDrift && (
          <div className="col-span-2">
            <span className="pill pill-err">⚠ drift</span>
          </div>
        )}
      </div>
    </div>
  );
}
