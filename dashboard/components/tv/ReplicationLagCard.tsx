"use client";

import { timeAgo } from "@/lib/utils";

interface LagRow {
  expectedId: number;
  slotName: string;
  serverId: number;
  serverName: string;
  active: boolean;
  lagBytes: number | null;
  checkedAt: string;
}

function fmtBytes(n: number | null): string {
  if (n == null) return "—";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

function lagTone(n: number | null): string {
  if (n == null) return "text-text-muted";
  if (n < 10 * 1024 * 1024) return "text-status-ok";
  if (n < 100 * 1024 * 1024) return "text-status-warn";
  return "text-status-err";
}

function lagBarPct(n: number | null): number {
  if (n == null || n <= 0) return 0;
  // escala log, 1KB→10%, 1MB→40%, 100MB→70%, 1GB→90%, 10GB+→100%
  const log = Math.log10(n + 1);
  return Math.min(100, Math.max(2, (log / 10) * 100));
}

function barColor(n: number | null): string {
  if (n == null) return "bg-text-muted/30";
  if (n < 10 * 1024 * 1024) return "bg-status-ok";
  if (n < 100 * 1024 * 1024) return "bg-status-warn";
  return "bg-status-err";
}

export function ReplicationLagCard({ rows }: { rows: LagRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted">
        Sin datos de replicación
      </div>
    );
  }

  const active = rows.filter((r) => r.active).length;
  const withLag = rows.filter((r) => (r.lagBytes ?? 0) > 100 * 1024 * 1024).length;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between text-xs text-text-muted mb-2">
        <span>
          <strong className="text-text-primary">{active}</strong> activos · {" "}
          {withLag > 0 && <strong className="text-status-err">{withLag} con lag &gt;100MB</strong>}
          {withLag === 0 && <span className="text-status-ok">sin lag alto</span>}
        </span>
        <span>top 12 por lag</span>
      </div>

      <div className="space-y-1 overflow-hidden">
        {rows.map((r) => (
          <div key={r.expectedId} className="text-xs">
            <div className="flex items-center gap-2">
              <span className={`${r.active ? "text-status-ok" : "text-status-err"}`}>
                {r.active ? "●" : "○"}
              </span>
              <span className="font-mono truncate flex-1">{r.slotName}</span>
              <span className="text-text-muted truncate max-w-[30%]" title={r.serverName}>
                {r.serverName}
              </span>
              <span className={`font-mono tabular-nums text-right w-16 ${lagTone(r.lagBytes)}`}>
                {fmtBytes(r.lagBytes)}
              </span>
            </div>
            <div className="mt-0.5 h-1 bg-bg-raised rounded overflow-hidden">
              <div
                className={`h-full ${barColor(r.lagBytes)} transition-all`}
                style={{ width: `${lagBarPct(r.lagBytes)}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
