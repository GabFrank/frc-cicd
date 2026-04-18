"use client";

import Link from "next/link";
import { usePollJson } from "@/components/PollQuery";

interface LogRow {
  id: number;
  alertFingerprint: string;
  targetId: number;
  ruleId: number;
  eventKind: string;
  status: string;
  reason: string | null;
  sentAt: string;
}

interface LogPayload {
  rows: LogRow[];
  limit: number;
  offset: number;
}

export default function NotificationLogPage() {
  const { data, isLoading, error } = usePollJson<LogPayload>("/api/admin/notifications/log?limit=80", ["notif-log"]);

  if (isLoading) return <div className="text-text-secondary">CARGANDO…</div>;
  if (error) return <div className="text-status-err">ERROR: {(error as Error).message}</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">LOG DE NOTIFICACIONES</h1>
        <Link href="/dashboard/notificaciones" className="text-sm text-status-info hover:underline">
          ← VOLVER
        </Link>
      </div>
      <div className="card overflow-x-auto text-sm">
        <table className="w-full">
          <thead className="text-left text-text-muted">
            <tr>
              <th className="py-1">ID</th>
              <th>ENVIADO</th>
              <th>TARGET</th>
              <th>EVENTO</th>
              <th>ESTADO</th>
              <th>FINGERPRINT</th>
            </tr>
          </thead>
          <tbody>
            {(data?.rows ?? []).map((r) => (
              <tr key={r.id} className="border-t border-border-subtle">
                <td className="py-1 font-mono">{r.id}</td>
                <td className="text-xs whitespace-nowrap">{r.sentAt}</td>
                <td className="font-mono">{r.targetId}</td>
                <td>{r.eventKind}</td>
                <td>{r.status}</td>
                <td className="font-mono text-xs max-w-[220px] truncate" title={r.alertFingerprint}>
                  {r.alertFingerprint}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
