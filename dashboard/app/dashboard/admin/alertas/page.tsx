"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface RuleConfig {
  kind: string;
  displayName: string;
  severityDefault: string;
  pendingCycles: number;
  resolvingCycles: number;
  enabled: boolean;
  notes: string | null;
}

export default function AlertasConfigPage() {
  const [rows, setRows] = useState<RuleConfig[]>([]);
  const [saving, setSaving] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = async () => {
    const res = await fetch("/api/admin/alerts-config");
    if (res.ok) setRows(await res.json());
  };

  useEffect(() => { load(); }, []);

  const update = async (kind: string, patch: Partial<RuleConfig>) => {
    setSaving(kind);
    setMsg(null);
    try {
      const res = await fetch(`/api/admin/alerts-config/${encodeURIComponent(kind)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(await res.text());
      setRows((prev) => prev.map((r) => r.kind === kind ? { ...r, ...patch } : r));
    } catch (e) {
      setMsg(`✗ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(null);
    }
  };

  const inputCls = "w-16 text-center rounded bg-bg-raised border border-border-default px-1 py-0.5 text-sm";

  return (
    <div className="space-y-4">
      <div className="text-sm text-text-muted">
        <Link href="/dashboard/admin" className="hover:underline">← Admin</Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold">Configuración de alertas</h1>
        <p className="text-sm text-text-muted mt-1">
          Thresholds de confirmación (ciclos consecutivos antes de promover de <em>pending</em> a <em>firing</em>)
          y resolución (ciclos sin detección antes de cerrar). Cada ciclo = 1 minuto (default evaluate-alerts).
        </p>
      </div>

      {msg && <div className="card text-sm text-status-err">{msg}</div>}

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-text-muted">
            <tr>
              <th className="py-1">Kind</th>
              <th>Nombre</th>
              <th>Severidad</th>
              <th title="Ciclos consecutivos de detección antes de promover a firing (notificar)">Pending cycles</th>
              <th title="Ciclos consecutivos sin detección antes de marcar resolved">Resolving cycles</th>
              <th>Activa</th>
              <th>Notas</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.kind} className={`border-t border-border-subtle ${!r.enabled ? "opacity-50" : ""}`}>
                <td className="py-1 font-mono text-xs">{r.kind}</td>
                <td>{r.displayName}</td>
                <td>
                  <span
                    className={`pill ${
                      r.severityDefault === "critical" ? "pill-err" : r.severityDefault === "warn" ? "pill-warn" : "pill-info"
                    }`}
                  >
                    {r.severityDefault}
                  </span>
                </td>
                <td>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    defaultValue={r.pendingCycles}
                    className={inputCls}
                    disabled={saving === r.kind}
                    onBlur={(e) => {
                      const v = Number(e.target.value);
                      if (v !== r.pendingCycles && v >= 1 && v <= 100) update(r.kind, { pendingCycles: v });
                    }}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    defaultValue={r.resolvingCycles}
                    className={inputCls}
                    disabled={saving === r.kind}
                    onBlur={(e) => {
                      const v = Number(e.target.value);
                      if (v !== r.resolvingCycles && v >= 1 && v <= 100) update(r.kind, { resolvingCycles: v });
                    }}
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={r.enabled}
                    disabled={saving === r.kind}
                    onChange={(e) => update(r.kind, { enabled: e.target.checked })}
                  />
                </td>
                <td className="text-xs text-text-muted max-w-md">{r.notes ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card text-xs text-text-muted space-y-1">
        <p><strong className="text-text-secondary">Cambios</strong> — se aplican en el próximo ciclo de <code>evaluate-alerts</code> (default 60s).</p>
        <p>
          <strong className="text-text-secondary">Escala de <code>host_unreachable</code></strong> — severidad dinámica según horas sin respuesta TCP:{" "}
          <span className="pill pill-info">info</span> &lt;12h, <span className="pill pill-warn">warn</span> 12–24h,{" "}
          <span className="pill pill-err">critical</span> ≥24h. Umbrales editables vía env{" "}
          <code>HOST_UNREACHABLE_WARN_AFTER_HOURS</code> y <code>HOST_UNREACHABLE_CRITICAL_AFTER_HOURS</code>.
        </p>
        <p>
          <strong className="text-text-secondary">Re-envíos</strong> — las <code>notification_rules</code> con{" "}
          <code>resend_interval_min = 0</code> no re-envían por intervalo (default nuevo). Cada alerta dispara{" "}
          <em>1 fire</em> + <em>1 resolved</em>. Cada escalation de severidad dispara 1 notificación adicional automáticamente.
        </p>
      </div>
    </div>
  );
}
