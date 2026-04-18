"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

interface Target {
  id: number;
  name: string;
}

interface Rule {
  id: number;
  targetId: number;
  minSeverity: string;
  alertKindsCsv: string | null;
  empresaFilter: string | null;
  serverIdsCsv: string | null;
  quietStart: string | null;
  quietEnd: string | null;
  quietBypassCritical: boolean;
  resendIntervalMin: number;
  active: boolean;
}

export default function NotificationRulesPage() {
  const [targets, setTargets] = useState<Target[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [tRes, rRes] = await Promise.all([
      fetch("/api/admin/notifications/targets", { cache: "no-store" }),
      fetch("/api/admin/notifications/rules", { cache: "no-store" }),
    ]);
    if (tRes.ok) setTargets(await tRes.json());
    if (rRes.ok) setRules(await rRes.json());
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const byTarget = useMemo(() => {
    const m = new Map<number, Target>();
    for (const t of targets) m.set(t.id, t);
    return m;
  }, [targets]);

  async function addRule(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const targetId = Number(fd.get("targetId"));
    if (!Number.isFinite(targetId)) {
      alert("ELEGÍ DESTINATARIO");
      return;
    }
    setBusy(true);
    try {
      const body = {
        targetId,
        minSeverity: String(fd.get("minSeverity") ?? "warn"),
        alertKindsCsv: String(fd.get("alertKindsCsv") ?? "").trim() || null,
        empresaFilter: String(fd.get("empresaFilter") ?? "").trim() || null,
        serverIdsCsv: String(fd.get("serverIdsCsv") ?? "").trim() || null,
        quietStart: String(fd.get("quietStart") ?? "").trim() || null,
        quietEnd: String(fd.get("quietEnd") ?? "").trim() || null,
        quietBypassCritical: fd.get("quietBypassCritical") === "on",
        resendIntervalMin: Number(fd.get("resendIntervalMin") ?? 60),
        active: true,
      };
      const res = await fetch("/api/admin/notifications/rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        alert(`ERROR: ${await res.text()}`);
        return;
      }
      e.currentTarget.reset();
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function toggleRule(r: Rule) {
    setBusy(true);
    try {
      await fetch(`/api/admin/notifications/rules/${r.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !r.active }),
      });
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function deleteRule(id: number) {
    if (!confirm("¿BORRAR REGLA?")) return;
    setBusy(true);
    try {
      await fetch(`/api/admin/notifications/rules/${id}`, { method: "DELETE" });
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">REGLAS DE NOTIFICACIÓN</h1>
        <Link href="/dashboard/notificaciones" className="text-sm text-status-info hover:underline">
          ← VOLVER
        </Link>
      </div>

      <form onSubmit={addRule} className="card space-y-3 text-sm">
        <h2 className="font-semibold">NUEVA REGLA</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="space-y-1">
            <span className="text-text-muted">DESTINATARIO</span>
            <select name="targetId" className="w-full rounded border bg-background px-2 py-2" required>
              <option value="">—</option>
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} (#{t.id})
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-text-muted">SEVERIDAD MÍNIMA</span>
            <select name="minSeverity" className="w-full rounded border bg-background px-2 py-2" defaultValue="warn">
              <option value="info">INFO</option>
              <option value="warn">WARN</option>
              <option value="critical">CRITICAL</option>
            </select>
          </label>
          <label className="space-y-1 md:col-span-2">
            <span className="text-text-muted">KINDS (CSV, VACÍO = TODOS)</span>
            <input name="alertKindsCsv" className="w-full rounded border bg-background px-2 py-2 font-mono text-xs" placeholder="central_down,filial_stale" />
          </label>
          <label className="space-y-1">
            <span className="text-text-muted">EMPRESA (FILTRO)</span>
            <input name="empresaFilter" className="w-full rounded border bg-background px-2 py-2" placeholder="FARMACIA" />
          </label>
          <label className="space-y-1">
            <span className="text-text-muted">SERVER IDS (CSV)</span>
            <input name="serverIdsCsv" className="w-full rounded border bg-background px-2 py-2 font-mono text-xs" placeholder="1,2,3" />
          </label>
          <label className="space-y-1">
            <span className="text-text-muted">QUIET START (HH:MM)</span>
            <input name="quietStart" className="w-full rounded border bg-background px-2 py-2 font-mono" placeholder="22:00" />
          </label>
          <label className="space-y-1">
            <span className="text-text-muted">QUIET END (HH:MM)</span>
            <input name="quietEnd" className="w-full rounded border bg-background px-2 py-2 font-mono" placeholder="07:00" />
          </label>
          <label className="space-y-1">
            <span className="text-text-muted">RE-ENVÍO CADA (MIN)</span>
            <input name="resendIntervalMin" type="number" min={1} defaultValue={60} className="w-full rounded border bg-background px-2 py-2" />
          </label>
          <label className="flex items-center gap-2 md:col-span-2">
            <input name="quietBypassCritical" type="checkbox" defaultChecked />
            BYPASS SILENCIO SI ES CRITICAL
          </label>
        </div>
        <button type="submit" className="rounded bg-status-ok/20 border border-status-ok/40 px-4 py-2 text-sm font-medium" disabled={busy}>
          AGREGAR REGLA
        </button>
      </form>

      <section className="card overflow-x-auto">
        <h2 className="font-semibold mb-3">LISTADO</h2>
        <table className="w-full text-sm">
          <thead className="text-left text-text-muted">
            <tr>
              <th className="py-1">ID</th>
              <th>TARGET</th>
              <th>MIN SEV</th>
              <th>KINDS</th>
              <th>QUIET</th>
              <th>REINT</th>
              <th>ON</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id} className="border-t border-border-subtle">
                <td className="py-1 font-mono">{r.id}</td>
                <td>{byTarget.get(r.targetId)?.name ?? r.targetId}</td>
                <td>{r.minSeverity}</td>
                <td className="font-mono text-xs max-w-[180px] truncate">{r.alertKindsCsv ?? "—"}</td>
                <td className="text-xs">
                  {r.quietStart ?? "—"} – {r.quietEnd ?? "—"}
                </td>
                <td>{r.resendIntervalMin}M</td>
                <td>{r.active ? "SÍ" : "NO"}</td>
                <td className="space-x-2 whitespace-nowrap">
                  <button type="button" className="text-xs text-status-info hover:underline" disabled={busy} onClick={() => toggleRule(r)}>
                    {r.active ? "OFF" : "ON"}
                  </button>
                  <button type="button" className="text-xs text-status-err hover:underline" disabled={busy} onClick={() => deleteRule(r.id)}>
                    BORRAR
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
