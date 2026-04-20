"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { usePollJson } from "@/components/PollQuery";

interface Target {
  id: number;
  name: string;
  kind: string;
  jid: string;
  active: boolean;
}

interface InstancePayload {
  configured: boolean;
  instanceName?: string;
  message?: string;
  evolution?: { ok: boolean; status: number; data?: { instance?: { state?: string; instanceName?: string } } };
}

export default function NotificacionesPage() {
  const { data: targets } = usePollJson<Target[]>("/api/admin/notifications/targets", ["notif-targets"]);
  const { data: inst, refetch: refetchInst } = usePollJson<InstancePayload>("/api/admin/notifications/instance", [
    "notif-instance",
  ]);
  const [busy, setBusy] = useState<string | null>(null);
  const [testTargetId, setTestTargetId] = useState<string>("");

  const doAction = useCallback(
    async (action: string) => {
      setBusy(action);
      try {
        const res = await fetch("/api/admin/notifications/instance", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) alert(`ERROR ${res.status}: ${JSON.stringify(j)}`);
        void refetchInst();
      } finally {
        setBusy(null);
      }
    },
    [refetchInst],
  );

  const sendTest = useCallback(async () => {
    const id = Number(testTargetId);
    if (!Number.isFinite(id)) {
      alert("ELEGÍ UN TARGET ID VÁLIDO");
      return;
    }
    setBusy("test");
    try {
      const res = await fetch("/api/admin/notifications/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId: id }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) alert(`ERROR ${res.status}: ${JSON.stringify(j)}`);
      else alert("OK · REVISÁ WHATSAPP");
    } finally {
      setBusy(null);
    }
  }, [testTargetId]);

  useEffect(() => {
    if (targets && targets.length === 1 && !testTargetId) {
      setTestTargetId(String(targets[0].id));
    }
  }, [targets, testTargetId]);

  const state = inst?.evolution?.data && typeof inst.evolution.data === "object" ? (inst.evolution.data as { instance?: { state?: string } }).instance?.state : undefined;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">NOTIFICACIONES · WHATSAPP</h1>
        <div className="flex gap-2 flex-wrap text-sm">
          <Link className="nav-link" href="/dashboard/notificaciones/rules">
            REGLAS
          </Link>
          <Link className="nav-link" href="/dashboard/notificaciones/log">
            LOG
          </Link>
          <Link className="nav-link" href="/dashboard/notificaciones/targets/new">
            + DESTINATARIO
          </Link>
        </div>
      </div>

      <section className="card space-y-3">
        <h2 className="font-semibold">EVOLUTION API · INSTANCIA</h2>
        {!inst?.configured ? (
          <div className="text-status-warn text-sm">{inst?.message ?? "NO CONFIGURADO"}</div>
        ) : (
          <div className="text-sm space-y-2">
            <div>
              INSTANCIA: <span className="font-mono">{inst.instanceName}</span>
            </div>
            <div>
              ESTADO:{" "}
              <span className="font-mono">{state ?? (inst.evolution?.ok ? "?" : `HTTP ${inst.evolution?.status}`)}</span>
            </div>
            <div className="flex flex-wrap gap-2 pt-2">
              <button type="button" className="rounded border px-3 py-1 text-xs" disabled={!!busy} onClick={() => doAction("connect")}>
                {busy === "connect" ? "…" : "OBTENER QR (CONNECT)"}
              </button>
              <button type="button" className="rounded border px-3 py-1 text-xs" disabled={!!busy} onClick={() => doAction("restart")}>
                {busy === "restart" ? "…" : "REINICIAR SESIÓN"}
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="card space-y-3">
        <h2 className="font-semibold">PRUEBA DE ENVÍO</h2>
        <div className="flex flex-wrap gap-2 items-end">
          <label className="text-xs text-text-muted flex flex-col gap-1">
            TARGET ID
            <input
              className="rounded bg-bg-raised border border-border-default px-2 py-1 font-mono text-sm"
              value={testTargetId}
              onChange={(e) => setTestTargetId(e.target.value)}
            />
          </label>
          <button type="button" className="rounded bg-status-info/20 border border-status-info/40 px-3 py-1.5 text-sm" disabled={!!busy} onClick={sendTest}>
            {busy === "test" ? "…" : "ENVIAR PRUEBA"}
          </button>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="font-semibold">DESTINATARIOS</h2>
        {!targets?.length ? (
          <div className="text-text-muted text-sm">SIN DESTINATARIOS.</div>
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-text-muted">
                <tr>
                  <th className="py-1">ID</th>
                  <th>NOMBRE</th>
                  <th>TIPO</th>
                  <th>JID / NÚMERO</th>
                  <th>ACTIVO</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {targets.map((t) => (
                  <tr key={t.id} className="border-t border-border-subtle">
                    <td className="py-1 font-mono">{t.id}</td>
                    <td className="font-medium">{t.name}</td>
                    <td>{t.kind}</td>
                    <td className="font-mono text-xs">{t.jid}</td>
                    <td>{t.active ? "SÍ" : "NO"}</td>
                    <td>
                      <Link href={`/dashboard/notificaciones/targets/${t.id}`} className="text-status-info text-xs hover:underline">
                        EDITAR →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
