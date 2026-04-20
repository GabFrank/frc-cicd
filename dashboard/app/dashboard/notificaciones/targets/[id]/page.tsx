"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

interface Target {
  id: number;
  name: string;
  kind: string;
  jid: string;
  active: boolean;
}

export default function EditNotificationTargetPage() {
  const params = useParams();
  const router = useRouter();
  const id = String(params.id);
  const [row, setRow] = useState<Target | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/admin/notifications/targets/${id}`, { cache: "no-store" });
      if (!res.ok) return;
      const j = (await res.json()) as Target;
      if (!cancelled) setRow(j);
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!row) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/notifications/targets/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(row),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        alert(`ERROR: ${JSON.stringify(j)}`);
        return;
      }
      router.push("/dashboard/notificaciones");
    } finally {
      setBusy(false);
    }
  }

  async function del() {
    if (!confirm("¿BORRAR DESTINATARIO Y REGLAS ASOCIADAS (CASCADE)?")) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/notifications/targets/${id}`, { method: "DELETE" });
      if (!res.ok) {
        alert("ERROR AL BORRAR");
        return;
      }
      router.push("/dashboard/notificaciones");
    } finally {
      setBusy(false);
    }
  }

  if (!row) return <div className="text-text-secondary">CARGANDO…</div>;

  return (
    <div className="max-w-lg space-y-6">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">EDITAR DESTINATARIO</h1>
        <Link href="/dashboard/notificaciones" className="text-sm text-status-info hover:underline">
          ← VOLVER
        </Link>
      </div>
      <form onSubmit={save} className="card space-y-4">
        <label className="block text-sm space-y-1">
          <span className="text-text-muted">NOMBRE</span>
          <input
            className="w-full rounded bg-bg-raised border border-border-default px-2 py-2"
            value={row.name}
            onChange={(e) => setRow({ ...row, name: e.target.value.toUpperCase() })}
            required
          />
        </label>
        <label className="block text-sm space-y-1">
          <span className="text-text-muted">TIPO</span>
          <select
            className="w-full rounded bg-bg-raised border border-border-default px-2 py-2"
            value={row.kind}
            onChange={(e) => setRow({ ...row, kind: e.target.value })}
          >
            <option value="number">NÚMERO</option>
            <option value="group">GRUPO</option>
          </select>
        </label>
        <label className="block text-sm space-y-1">
          <span className="text-text-muted">JID / NÚMERO</span>
          <input className="w-full rounded bg-bg-raised border border-border-default px-2 py-2 font-mono text-sm" value={row.jid} onChange={(e) => setRow({ ...row, jid: e.target.value })} required />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={row.active} onChange={(e) => setRow({ ...row, active: e.target.checked })} />
          ACTIVO
        </label>
        <div className="flex gap-2">
          <button type="submit" className="rounded bg-status-ok/20 border border-status-ok/40 px-4 py-2 text-sm font-medium" disabled={busy}>
            {busy ? "…" : "GUARDAR"}
          </button>
          <button type="button" className="rounded border border-status-err/40 px-4 py-2 text-sm text-status-err" disabled={busy} onClick={del}>
            BORRAR
          </button>
        </div>
      </form>
    </div>
  );
}
