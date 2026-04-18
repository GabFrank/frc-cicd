"use client";

import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { timeAgo } from "@/lib/utils";

interface Alert {
  id: number;
  severity: string;
  kind: string;
  title: string;
  detail: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  fingerprint: string;
  instanceName?: string | null;
}

interface LogEntry {
  id: number;
  targetId: number | null;
  targetName: string | null;
  eventKind: string;
  status: string;
  reason: string | null;
  evolutionMessageId: string | null;
  httpCode: number | null;
  errorMessage: string | null;
  sentAt: string;
}

interface StateEntry {
  alertFingerprint: string;
  targetId: number;
  targetName: string | null;
  lastSentAt: string;
  lastSeverity: string;
  lastEventKind: string;
}

interface DetailData {
  alert: Alert;
  log: LogEntry[];
  states: StateEntry[];
}

export function AlertDialog({
  alertId,
  open,
  onClose,
  onChange,
}: {
  alertId: number | null;
  open: boolean;
  onClose: () => void;
  onChange?: () => void;
}) {
  const [data, setData] = useState<DetailData | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open || alertId == null) return;
    setLoading(true);
    setMsg(null);
    fetch(`/api/alerts/${alertId}/log`)
      .then((r) => r.json())
      .then((d) => setData(d))
      .catch((e) => setMsg(`✗ ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => setLoading(false));
  }, [open, alertId]);

  const callAction = async (path: string, method: "POST" | "DELETE") => {
    if (!alertId) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/alerts/${alertId}${path}`, { method });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `${res.status}`);
      setMsg(`✓ ${JSON.stringify(j)}`);
      onChange?.();
      // refrescar detalle
      if (path !== "" /* delete */) {
        const r = await fetch(`/api/alerts/${alertId}/log`);
        if (r.ok) setData(await r.json());
      } else {
        onClose();
      }
    } catch (e) {
      setMsg(`✗ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Alerta · gestión" widthClass="max-w-3xl">
      {loading && <div className="text-text-muted">Cargando…</div>}
      {!loading && data && (
        <div className="space-y-4">
          <header className="card-raised space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-semibold">{data.alert.title}</div>
                <div className="text-xs text-text-muted font-mono">
                  kind={data.alert.kind} · fp=<span className="break-all">{data.alert.fingerprint}</span>
                </div>
              </div>
              <span
                className={`pill ${
                  data.alert.severity === "critical"
                    ? "pill-err"
                    : data.alert.severity === "warn"
                      ? "pill-warn"
                      : "pill-info"
                }`}
              >
                {data.alert.severity}
              </span>
            </div>
            {data.alert.detail && <div className="text-sm text-text-secondary">{data.alert.detail}</div>}
            <div className="text-xs text-text-muted grid grid-cols-3 gap-2">
              <div>Primera: {timeAgo(data.alert.firstSeenAt)}</div>
              <div>Última: {timeAgo(data.alert.lastSeenAt)}</div>
              <div>{data.alert.resolvedAt ? `Resuelta: ${timeAgo(data.alert.resolvedAt)}` : "Activa"}</div>
            </div>
          </header>

          <div className="flex flex-wrap items-center gap-2">
            {!data.alert.resolvedAt && (
              <button
                disabled={busy}
                onClick={() => callAction("/resolve", "POST")}
                className="rounded bg-status-ok/15 border border-status-ok/40 text-status-ok px-3 py-1.5 text-sm hover:bg-status-ok/25 disabled:opacity-50"
                title="Marcar como resuelta manualmente"
              >
                ✓ Marcar resuelta
              </button>
            )}
            {data.alert.resolvedAt && (
              <button
                disabled={busy}
                onClick={() => callAction("/resolve", "DELETE")}
                className="rounded bg-status-warn/15 border border-status-warn/40 text-status-warn px-3 py-1.5 text-sm hover:bg-status-warn/25 disabled:opacity-50"
                title="Reabrir (clear resolved_at)"
              >
                ↻ Reabrir
              </button>
            )}
            <button
              disabled={busy}
              onClick={() => callAction("/renotify", "POST")}
              className="rounded bg-status-info/15 border border-status-info/40 text-status-info px-3 py-1.5 text-sm hover:bg-status-info/25 disabled:opacity-50"
              title="Borra notification_state — el próximo job re-envía"
            >
              📤 Re-notificar
            </button>
            <button
              disabled={busy}
              onClick={() => {
                if (!confirm("Eliminar definitivamente esta alerta y su historial?")) return;
                callAction("", "DELETE");
              }}
              className="rounded bg-status-err/10 border border-status-err/40 text-status-err px-3 py-1.5 text-sm hover:bg-status-err/20 disabled:opacity-50 ml-auto"
            >
              🗑 Eliminar
            </button>
          </div>

          {msg && <div className={`card text-sm ${msg.startsWith("✓") ? "text-status-ok" : "text-status-err"}`}>{msg}</div>}

          <section className="space-y-2">
            <h3 className="font-semibold text-sm">Estado por destinatario</h3>
            {data.states.length === 0 ? (
              <div className="text-text-muted text-sm">Sin estados (no se notificó todavía).</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-text-muted">
                  <tr>
                    <th className="py-1">Destinatario</th>
                    <th>Último envío</th>
                    <th>Severity</th>
                    <th>Event</th>
                  </tr>
                </thead>
                <tbody>
                  {data.states.map((s) => (
                    <tr key={s.targetId} className="border-t border-border-subtle">
                      <td className="py-1">{s.targetName ?? `target#${s.targetId}`}</td>
                      <td className="text-text-muted">{timeAgo(s.lastSentAt)}</td>
                      <td>{s.lastSeverity}</td>
                      <td className="text-xs">{s.lastEventKind}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="space-y-2">
            <h3 className="font-semibold text-sm">Historial de notificaciones</h3>
            {data.log.length === 0 ? (
              <div className="text-text-muted text-sm">Sin envíos registrados.</div>
            ) : (
              <div className="card max-h-64 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="text-left text-text-muted sticky top-0 bg-bg-surface">
                    <tr>
                      <th className="py-1">Cuándo</th>
                      <th>Destinatario</th>
                      <th>Event</th>
                      <th>Status</th>
                      <th>Detalle</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.log.map((l) => (
                      <tr key={l.id} className="border-t border-border-subtle">
                        <td className="py-0.5 text-text-muted whitespace-nowrap">{timeAgo(l.sentAt)}</td>
                        <td>{l.targetName ?? `target#${l.targetId ?? "?"}`}</td>
                        <td>{l.eventKind}</td>
                        <td>
                          <span
                            className={`pill ${
                              l.status === "sent"
                                ? "pill-ok"
                                : l.status === "skipped"
                                  ? "pill-neutral"
                                  : "pill-err"
                            }`}
                          >
                            {l.status}
                          </span>
                        </td>
                        <td className="text-text-muted truncate max-w-[14rem]" title={l.errorMessage ?? l.reason ?? ""}>
                          {l.errorMessage ?? l.reason ?? (l.evolutionMessageId ? `id ${l.evolutionMessageId}` : "—")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </Modal>
  );
}
