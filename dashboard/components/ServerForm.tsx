"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

interface ServerInput {
  id?: number;
  kind?: string;
  empresa?: string | null;
  nombre?: string;
  ip?: string | null;
  appPort?: number | null;
  pgHost?: string | null;
  pgPort?: number | null;
  pgDatabase?: string | null;
  pgUser?: string | null;
  hasPassword?: boolean;
  channel?: string | null;
  os?: string | null;
  sucursalId?: number | null;
  githubEnvironment?: string | null;
  active?: boolean;
  notes?: string | null;
}

export function ServerForm({
  initial,
  mode,
}: {
  initial?: ServerInput;
  mode: "new" | "edit";
}) {
  const router = useRouter();
  const [form, setForm] = useState<ServerInput>({
    kind: "filial",
    active: true,
    pgPort: 5432,
    pgDatabase: "general",
    pgUser: "franco",
    ...initial,
  });
  const [pwd, setPwd] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        kind: form.kind,
        empresa: form.empresa || null,
        nombre: form.nombre,
        ip: form.ip || null,
        appPort: form.appPort ? Number(form.appPort) : null,
        pgHost: form.pgHost || form.ip || null,
        pgPort: form.pgPort ? Number(form.pgPort) : null,
        pgDatabase: form.pgDatabase || null,
        pgUser: form.pgUser || null,
        channel: form.channel || null,
        os: form.os || null,
        sucursalId: form.sucursalId ? Number(form.sucursalId) : null,
        githubEnvironment: form.githubEnvironment || null,
        active: !!form.active,
        notes: form.notes || null,
      };
      if (pwd.length > 0) payload.pgPassword = pwd;

      const url = mode === "new" ? "/api/admin/servers" : `/api/admin/servers/${initial?.id}`;
      const method = mode === "new" ? "POST" : "PUT";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `${res.status}`);
      }
      router.push("/dashboard/admin");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const onDelete = async () => {
    if (!initial?.id) return;
    if (!confirm(`Eliminar servidor "${initial.nombre}"?`)) return;
    await fetch(`/api/admin/servers/${initial.id}`, { method: "DELETE" });
    router.push("/dashboard/admin");
    router.refresh();
  };

  const setF = <K extends keyof ServerInput>(k: K, v: ServerInput[K]) =>
    setForm((s) => ({ ...s, [k]: v }));

  const inputCls = "w-full rounded bg-bg-raised border border-border-default px-2 py-1.5 text-sm";
  const labelCls = "block text-xs uppercase text-text-muted";

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="space-y-1">
          <span className={labelCls}>Tipo *</span>
          <select className={inputCls} value={form.kind} onChange={(e) => setF("kind", e.target.value)}>
            <option value="central">central</option>
            <option value="filial">filial</option>
          </select>
        </label>
        <label className="space-y-1">
          <span className={labelCls}>Empresa</span>
          <input className={inputCls} value={form.empresa ?? ""} onChange={(e) => setF("empresa", e.target.value)} placeholder="farmacia, bodega…" />
        </label>
        <label className="space-y-1 md:col-span-2">
          <span className={labelCls}>Nombre *</span>
          <input className={inputCls} required value={form.nombre ?? ""} onChange={(e) => setF("nombre", e.target.value)} placeholder="Farmacia · Filial 2 (windows)" />
        </label>
      </div>

      <fieldset className="border border-border-subtle rounded-lg p-3 space-y-3">
        <legend className="px-2 text-xs uppercase text-text-muted">Conectividad app</legend>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <label className="space-y-1">
            <span className={labelCls}>IP (ZeroTier)</span>
            <input className={inputCls} value={form.ip ?? ""} onChange={(e) => setF("ip", e.target.value)} placeholder="172.25.3.2" />
          </label>
          <label className="space-y-1">
            <span className={labelCls}>App port</span>
            <input className={inputCls} type="number" value={form.appPort ?? ""} onChange={(e) => setF("appPort", e.target.value ? Number(e.target.value) : null)} placeholder="8082" />
          </label>
          <label className="space-y-1">
            <span className={labelCls}>GitHub environment</span>
            <input className={inputCls} value={form.githubEnvironment ?? ""} onChange={(e) => setF("githubEnvironment", e.target.value)} placeholder="alpha-filial-2-linux" />
          </label>
        </div>
      </fieldset>

      <fieldset className="border border-border-subtle rounded-lg p-3 space-y-3">
        <legend className="px-2 text-xs uppercase text-text-muted">PostgreSQL</legend>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <label className="space-y-1">
            <span className={labelCls}>PG host</span>
            <input className={inputCls} value={form.pgHost ?? ""} onChange={(e) => setF("pgHost", e.target.value)} placeholder="igual a IP por defecto" />
          </label>
          <label className="space-y-1">
            <span className={labelCls}>PG port *</span>
            <input className={inputCls} type="number" required value={form.pgPort ?? ""} onChange={(e) => setF("pgPort", Number(e.target.value))} />
          </label>
          <label className="space-y-1">
            <span className={labelCls}>PG database *</span>
            <input className={inputCls} required value={form.pgDatabase ?? ""} onChange={(e) => setF("pgDatabase", e.target.value)} />
          </label>
          <label className="space-y-1">
            <span className={labelCls}>PG user *</span>
            <input className={inputCls} required value={form.pgUser ?? ""} onChange={(e) => setF("pgUser", e.target.value)} />
          </label>
          <label className="space-y-1 md:col-span-4">
            <span className={labelCls}>
              PG password {mode === "edit" && form.hasPassword && <em className="text-text-muted normal-case">(dejar vacío para mantener)</em>}
            </span>
            <input className={inputCls} type="password" value={pwd} onChange={(e) => setPwd(e.target.value)} autoComplete="new-password" />
          </label>
        </div>
      </fieldset>

      <fieldset className="border border-border-subtle rounded-lg p-3 space-y-3">
        <legend className="px-2 text-xs uppercase text-text-muted">Metadata</legend>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <label className="space-y-1">
            <span className={labelCls}>Sucursal ID</span>
            <input className={inputCls} type="number" value={form.sucursalId ?? ""} onChange={(e) => setF("sucursalId", e.target.value ? Number(e.target.value) : null)} />
          </label>
          <label className="space-y-1">
            <span className={labelCls}>Canal</span>
            <select className={inputCls} value={form.channel ?? ""} onChange={(e) => setF("channel", e.target.value || null)}>
              <option value="">—</option>
              <option value="alpha">alpha</option>
              <option value="beta">beta</option>
              <option value="stable">stable</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className={labelCls}>OS</span>
            <select className={inputCls} value={form.os ?? ""} onChange={(e) => setF("os", e.target.value || null)}>
              <option value="">—</option>
              <option value="linux">linux</option>
              <option value="windows">windows</option>
            </select>
          </label>
          <label className="space-y-1 flex items-center gap-2 mt-5">
            <input type="checkbox" checked={!!form.active} onChange={(e) => setF("active", e.target.checked)} />
            <span className="text-sm">Activo</span>
          </label>
        </div>
        <label className="space-y-1 block">
          <span className={labelCls}>Notas</span>
          <textarea className={inputCls} rows={2} value={form.notes ?? ""} onChange={(e) => setF("notes", e.target.value)} />
        </label>
      </fieldset>

      {error && <div className="card text-status-err text-sm">{error}</div>}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="rounded bg-status-info/20 border border-status-info/40 px-4 py-2 hover:bg-status-info/30 disabled:opacity-50"
        >
          {submitting ? "Guardando…" : mode === "new" ? "Crear" : "Guardar"}
        </button>
        {mode === "edit" && (
          <button
            type="button"
            onClick={onDelete}
            className="rounded bg-status-err/10 border border-status-err/40 px-4 py-2 text-status-err hover:bg-status-err/20"
          >
            Eliminar
          </button>
        )}
      </div>
    </form>
  );
}
