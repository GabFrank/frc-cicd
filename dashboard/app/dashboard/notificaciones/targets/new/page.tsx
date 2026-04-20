"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

export default function NewNotificationTargetPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"number" | "group">("number");
  const [jid, setJid] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch("/api/admin/notifications/targets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, kind, jid, active: true }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(`ERROR: ${JSON.stringify(j)}`);
        return;
      }
      router.push(`/dashboard/notificaciones/targets/${j.id}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-lg space-y-6">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">NUEVO DESTINATARIO</h1>
        <Link href="/dashboard/notificaciones" className="text-sm text-status-info hover:underline">
          ← VOLVER
        </Link>
      </div>
      <form onSubmit={submit} className="card space-y-4">
        <label className="block text-sm space-y-1">
          <span className="text-text-muted">NOMBRE (SE GUARDA EN MAYÚSCULAS)</span>
          <input className="w-full rounded bg-bg-raised border border-border-default px-2 py-2" value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label className="block text-sm space-y-1">
          <span className="text-text-muted">TIPO</span>
          <select className="w-full rounded bg-bg-raised border border-border-default px-2 py-2" value={kind} onChange={(e) => setKind(e.target.value as "number" | "group")}>
            <option value="number">NÚMERO (EJ 595981…)</option>
            <option value="group">GRUPO (JID …@G.US)</option>
          </select>
        </label>
        <label className="block text-sm space-y-1">
          <span className="text-text-muted">JID O NÚMERO CON CÓDIGO PAÍS</span>
          <input className="w-full rounded bg-bg-raised border border-border-default px-2 py-2 font-mono text-sm" value={jid} onChange={(e) => setJid(e.target.value)} required />
        </label>
        <button type="submit" className="rounded bg-status-ok/20 border border-status-ok/40 px-4 py-2 text-sm font-medium" disabled={busy}>
          {busy ? "GUARDANDO…" : "CREAR"}
        </button>
      </form>
    </div>
  );
}
