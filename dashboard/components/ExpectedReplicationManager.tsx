"use client";

import { FormEvent, useEffect, useState } from "react";
import { statusToPill, timeAgo } from "@/lib/utils";

interface Expected {
  id: number;
  serverId: number;
  kind: string;
  name: string;
  peerServerId: number | null;
  direction: string | null;
  notes: string | null;
  check: {
    status: string;
    active: boolean | null;
    checkedAt: string;
  } | null;
}

interface PeerServer {
  id: number;
  nombre: string;
  kind: string;
}

export function ExpectedReplicationManager({ serverId }: { serverId: number }) {
  const [items, setItems] = useState<Expected[]>([]);
  const [peers, setPeers] = useState<PeerServer[]>([]);
  const [form, setForm] = useState({
    kind: "subscription",
    name: "",
    peerServerId: "",
    direction: "",
    notes: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoverMsg, setDiscoverMsg] = useState<string | null>(null);

  const load = async () => {
    const [a, b] = await Promise.all([
      fetch(`/api/admin/expected?serverId=${serverId}`).then((r) => r.json()),
      fetch(`/api/admin/servers`).then((r) => r.json()),
    ]);
    setItems(a);
    setPeers(b.filter((s: PeerServer) => s.id !== serverId));
  };

  useEffect(() => {
    load();
  }, [serverId]);

  const onAdd = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const res = await fetch("/api/admin/expected", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serverId,
        kind: form.kind,
        name: form.name,
        peerServerId: form.peerServerId ? Number(form.peerServerId) : null,
        direction: form.direction || null,
        notes: form.notes || null,
      }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? `${res.status}`);
      return;
    }
    setForm({ kind: form.kind, name: "", peerServerId: form.peerServerId, direction: form.direction, notes: "" });
    load();
  };

  const onDel = async (id: number) => {
    if (!confirm("Eliminar entrada?")) return;
    await fetch(`/api/admin/expected/${id}`, { method: "DELETE" });
    load();
  };

  const onDiscover = async () => {
    setDiscovering(true);
    setDiscoverMsg(null);
    setError(null);
    try {
      const res = await fetch(`/api/admin/servers/${serverId}/discover`, { method: "POST" });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `${res.status}`);
      setDiscoverMsg(`✓ ${j.discovered} encontrados · ${j.inserted} nuevos · ${j.updated} actualizados`);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDiscovering(false);
    }
  };

  const inputCls = "w-full rounded bg-bg-raised border border-border-default px-2 py-1.5 text-sm";
  const labelCls = "block text-xs uppercase text-text-muted";

  return (
    <section className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-bold">Replicación esperada</h2>
          <p className="text-sm text-text-muted">
            Pub/sub/slots que el dashboard debe encontrar activos en este servidor.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <button
            type="button"
            onClick={onDiscover}
            disabled={discovering}
            className="rounded bg-status-info/20 border border-status-info/40 px-3 py-1.5 text-sm hover:bg-status-info/30 disabled:opacity-50"
            title="Conecta al PG del servidor y registra todas las publicaciones, subscripciones y slots existentes"
          >
            {discovering ? "Descubriendo…" : "🔍 Descubrir replicación"}
          </button>
          {discoverMsg && <span className="text-xs text-status-ok">{discoverMsg}</span>}
        </div>
      </div>

      <div className="card">
        {items.length === 0 ? (
          <div className="text-text-muted text-sm">Sin entradas. Agregar abajo.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-text-muted">
              <tr>
                <th className="py-1">Tipo</th>
                <th>Nombre</th>
                <th>Peer</th>
                <th>Dirección</th>
                <th>Estado</th>
                <th>Chequeado</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const peer = peers.find((p) => p.id === it.peerServerId);
                const checkLabel =
                  it.check == null
                    ? "—"
                    : it.check.status === "found" && it.check.active
                      ? "ok"
                      : it.check.status === "found"
                        ? "found · inactive"
                        : it.check.status;
                return (
                  <tr key={it.id} className="border-t border-border-subtle">
                    <td className="py-1">
                      <span className="pill pill-info">{it.kind}</span>
                    </td>
                    <td className="font-mono">{it.name}</td>
                    <td className="text-xs">{peer?.nombre ?? "—"}</td>
                    <td className="text-xs">{it.direction ?? "—"}</td>
                    <td>
                      <span
                        className={statusToPill(
                          checkLabel === "ok"
                            ? "ok"
                            : checkLabel === "—"
                              ? "neutral"
                              : checkLabel.startsWith("found")
                                ? "warn"
                                : "failure",
                        )}
                      >
                        {checkLabel}
                      </span>
                    </td>
                    <td className="text-xs text-text-muted">{it.check ? timeAgo(it.check.checkedAt) : "—"}</td>
                    <td>
                      <button onClick={() => onDel(it.id)} className="text-status-err text-xs hover:underline">
                        eliminar
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <form onSubmit={onAdd} className="card-raised space-y-3">
        <h3 className="font-semibold">Agregar</h3>
        <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
          <label className="space-y-1">
            <span className={labelCls}>Tipo</span>
            <select className={inputCls} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              <option value="publication">publication</option>
              <option value="subscription">subscription</option>
              <option value="slot">slot</option>
            </select>
          </label>
          <label className="space-y-1 md:col-span-2">
            <span className={labelCls}>Nombre</span>
            <input
              className={inputCls}
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="beta_filial2_sub"
            />
          </label>
          <label className="space-y-1">
            <span className={labelCls}>Peer</span>
            <select className={inputCls} value={form.peerServerId} onChange={(e) => setForm({ ...form, peerServerId: e.target.value })}>
              <option value="">—</option>
              {peers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nombre}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className={labelCls}>Dirección</span>
            <select className={inputCls} value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value })}>
              <option value="">—</option>
              <option value="central_to_filial">C → F</option>
              <option value="filial_to_central">F → C</option>
            </select>
          </label>
        </div>
        <label className="space-y-1 block">
          <span className={labelCls}>Notas</span>
          <input className={inputCls} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </label>
        {error && <div className="text-status-err text-sm">{error}</div>}
        <button
          type="submit"
          className="rounded bg-status-info/20 border border-status-info/40 px-3 py-1.5 text-sm hover:bg-status-info/30"
        >
          + Agregar
        </button>
      </form>
    </section>
  );
}
