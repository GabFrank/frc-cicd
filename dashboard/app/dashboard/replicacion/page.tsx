"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { usePollJson } from "@/components/PollQuery";
import { Modal } from "@/components/Modal";
import { RefreshButton } from "@/components/RefreshButton";
import { statusToPill, timeAgo } from "@/lib/utils";

interface ExpectedItem {
  id: number;
  kind: string;
  name: string;
  direction: string | null;
  peerName: string | null;
  notes: string | null;
  status: string | null;
  active: boolean | null;
  checkedAt: string | null;
}

interface ServerData {
  id: number;
  kind: string;
  empresa: string | null;
  nombre: string;
  ip: string | null;
  pgHost: string | null;
  pgPort: number | null;
  pgDatabase: string | null;
  sucursalId: number | null;
  channel: string | null;
  pgStatus: string;
  pgVersion: string | null;
  pgError: string | null;
  pgCheckedAt: string | null;
  database: {
    sizeBytes: number | null;
    activeConnections: number | null;
    latencyMs: number | null;
  } | null;
  expected: ExpectedItem[];
}

interface Data {
  servers: ServerData[];
  lastSync: { startedAt: string; finishedAt: string | null; ok: boolean; errorMessage: string | null } | null;
}

type Tone = "ok" | "err" | "warn" | "neutral";

interface BucketCounts {
  ok: number;
  err: number;
  warn: number;
  total: number;
}

function classify(item: ExpectedItem): Tone {
  if (item.status === null) return "warn";
  if (item.status === "missing") return "err";
  if (item.status === "found" && item.active === true) return "ok";
  if (item.status === "found") return "err";
  return "neutral";
}

function bucketize(items: ExpectedItem[]): BucketCounts {
  const c: BucketCounts = { ok: 0, err: 0, warn: 0, total: items.length };
  for (const it of items) {
    const t = classify(it);
    if (t === "ok") c.ok += 1;
    else if (t === "err") c.err += 1;
    else if (t === "warn") c.warn += 1;
  }
  return c;
}

function fmtBytes(n: number | null | undefined) {
  if (n == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

function CountBadge({ label, c }: { label: string; c: BucketCounts }) {
  const tone =
    c.total === 0
      ? "neutral"
      : c.err > 0
        ? "err"
        : c.warn > 0
          ? "warn"
          : "ok";
  const cls = `pill ${tone === "ok" ? "pill-ok" : tone === "err" ? "pill-err" : tone === "warn" ? "pill-warn" : "pill-neutral"}`;
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] uppercase text-text-muted">{label}</span>
      <span className={cls}>{c.total}</span>
      {c.total > 0 && (
        <span className="text-[10px] text-text-muted font-mono">
          {c.ok > 0 && <span className="text-status-ok">{c.ok}✓ </span>}
          {c.warn > 0 && <span className="text-status-warn">{c.warn}? </span>}
          {c.err > 0 && <span className="text-status-err">{c.err}✗</span>}
        </span>
      )}
    </div>
  );
}

function ItemRow({ it }: { it: ExpectedItem }) {
  const tone = classify(it);
  const label =
    it.status === null
      ? "no chequeado"
      : it.status === "found" && it.active
        ? "ok"
        : it.status === "found"
          ? "inactive"
          : it.status;
  const cls = `pill ${tone === "ok" ? "pill-ok" : tone === "err" ? "pill-err" : tone === "warn" ? "pill-warn" : "pill-neutral"}`;
  return (
    <div className="flex items-center gap-2 text-sm py-1 border-b border-border-subtle/50">
      <span className={cls}>{label}</span>
      <span className="font-mono text-xs truncate flex-1">{it.name}</span>
      {it.direction && (
        <span className="text-[10px] text-text-muted shrink-0">
          {it.direction === "central_to_filial" ? "C→F" : it.direction === "filial_to_central" ? "F→C" : it.direction}
        </span>
      )}
    </div>
  );
}

function ServerCard({ s, onOpen }: { s: ServerData; onOpen: () => void }) {
  const pubs = useMemo(() => s.expected.filter((e) => e.kind === "publication"), [s.expected]);
  const subs = useMemo(() => s.expected.filter((e) => e.kind === "subscription"), [s.expected]);
  const slots = useMemo(() => s.expected.filter((e) => e.kind === "slot"), [s.expected]);
  const pubCounts = bucketize(pubs);
  const subCounts = bucketize(subs);

  return (
    <div className="card space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`pill ${s.kind === "central" ? "pill-info" : "pill-neutral"}`}>{s.kind}</span>
            <span className="font-semibold truncate">{s.nombre}</span>
          </div>
          <div className="text-xs text-text-muted font-mono mt-1 truncate">
            {s.pgHost ?? "—"}:{s.pgPort ?? "?"}/{s.pgDatabase ?? "?"}
          </div>
        </div>
        <div className="text-right shrink-0 flex items-start gap-2">
          <div>
            <span className={statusToPill(s.pgStatus)}>{s.pgStatus}</span>
            {s.pgCheckedAt && (
              <div className="text-xs text-text-muted mt-1">{timeAgo(s.pgCheckedAt)}</div>
            )}
          </div>
          <RefreshButton serverId={s.id} className="text-sm mt-0.5" />
        </div>
      </div>

      {s.pgError && <div className="text-xs text-status-err font-mono break-all">{s.pgError}</div>}

      {s.database && (
        <div className="grid grid-cols-3 gap-2 text-sm">
          <div>
            <div className="text-[10px] uppercase text-text-muted">Tamaño DB</div>
            <div>{fmtBytes(s.database.sizeBytes)}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase text-text-muted">Conexiones</div>
            <div>{s.database.activeConnections ?? "—"}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase text-text-muted">Latencia</div>
            <div>{s.database.latencyMs ?? "—"}ms</div>
          </div>
        </div>
      )}

      {s.expected.length === 0 ? (
        <div className="text-xs text-text-muted border-t border-border-subtle pt-2">
          Sin replicación esperada registrada.{" "}
          <Link href={`/dashboard/admin/servers/${s.id}`} className="text-status-info hover:underline">
            registrar / descubrir →
          </Link>
        </div>
      ) : (
        <div className="border-t border-border-subtle pt-2 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-4 flex-wrap">
            <CountBadge label="pub" c={pubCounts} />
            <CountBadge label="sub" c={subCounts} />
            {slots.length > 0 && (
              <span className="text-[10px] text-text-muted">+{slots.length} slots</span>
            )}
          </div>
          <button
            onClick={onOpen}
            className="text-xs text-status-info hover:underline"
          >
            Ver detalles →
          </button>
        </div>
      )}
    </div>
  );
}

export default function ReplicacionPage() {
  const { data, isLoading, error } = usePollJson<Data>("/api/data/replicacion", ["replicacion-v3"]);
  const [openId, setOpenId] = useState<number | null>(null);

  if (isLoading) return <div className="text-text-secondary">Cargando…</div>;
  if (error) return <div className="text-status-err">Error: {(error as Error).message}</div>;
  if (!data) return null;

  const grouped = data.servers.reduce<Record<string, ServerData[]>>((acc, s) => {
    const key = s.empresa ?? "sin empresa";
    acc[key] = acc[key] ?? [];
    acc[key].push(s);
    return acc;
  }, {});

  const openServer = openId != null ? data.servers.find((s) => s.id === openId) ?? null : null;
  const openPubs = openServer?.expected.filter((e) => e.kind === "publication") ?? [];
  const openSubs = openServer?.expected.filter((e) => e.kind === "subscription") ?? [];
  const openSlots = openServer?.expected.filter((e) => e.kind === "slot") ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Replicación · DB · Server</h1>
        <div className="flex items-center gap-3">
          {data.lastSync && (
            <span className="text-xs text-text-muted">
              Último sync: {timeAgo(data.lastSync.finishedAt ?? data.lastSync.startedAt)}
            </span>
          )}
          <Link href="/dashboard/admin" className="nav-link border border-border-subtle">
            Admin →
          </Link>
        </div>
      </div>

      {data.servers.length === 0 && (
        <div className="card text-text-muted">
          Sin servidores registrados. Ir a{" "}
          <Link href="/dashboard/admin" className="text-status-info hover:underline">Admin</Link>{" "}
          para registrar centrales y filiales.
        </div>
      )}

      {Object.entries(grouped).map(([empresa, list]) => (
        <section key={empresa} className="space-y-3">
          <h2 className="font-semibold capitalize text-lg">{empresa}</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {list.map((s) => (
              <ServerCard key={s.id} s={s} onOpen={() => setOpenId(s.id)} />
            ))}
          </div>
        </section>
      ))}

      <Modal
        open={openServer != null}
        onClose={() => setOpenId(null)}
        title={openServer ? `${openServer.nombre} · replicación` : ""}
        widthClass="max-w-5xl"
      >
        {openServer && (
          <div className="space-y-4">
            <div className="text-xs text-text-muted font-mono">
              {openServer.pgHost}:{openServer.pgPort}/{openServer.pgDatabase}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <div className="font-semibold mb-2 flex items-center justify-between">
                  <span>Publicaciones</span>
                  <span className="text-xs text-text-muted">{openPubs.length}</span>
                </div>
                {openPubs.length === 0 ? (
                  <div className="text-xs text-text-muted">—</div>
                ) : (
                  <div>{openPubs.map((it) => <ItemRow key={it.id} it={it} />)}</div>
                )}
              </div>
              <div>
                <div className="font-semibold mb-2 flex items-center justify-between">
                  <span>Subscripciones</span>
                  <span className="text-xs text-text-muted">{openSubs.length}</span>
                </div>
                {openSubs.length === 0 ? (
                  <div className="text-xs text-text-muted">—</div>
                ) : (
                  <div>{openSubs.map((it) => <ItemRow key={it.id} it={it} />)}</div>
                )}
              </div>
            </div>
            {openSlots.length > 0 && (
              <details className="border-t border-border-subtle pt-3">
                <summary className="cursor-pointer text-sm text-text-secondary">
                  Slots ({openSlots.length})
                </summary>
                <div className="mt-2">
                  {openSlots.map((it) => <ItemRow key={it.id} it={it} />)}
                </div>
              </details>
            )}
            <div className="border-t border-border-subtle pt-3 flex items-center gap-4">
              <Link
                href={`/dashboard/admin/servers/${openServer.id}`}
                className="text-sm text-status-info hover:underline"
              >
                Editar servidor / replicación esperada →
              </Link>
              <RefreshButton
                serverId={openServer.id}
                className="text-base"
                title="Refrescar ahora (no esperar al próximo ciclo del job)"
              />
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
