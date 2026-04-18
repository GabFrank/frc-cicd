"use client";

import { useEffect, useState } from "react";
import { usePollJson } from "@/components/PollQuery";
import { AlertSidebar } from "@/components/AlertSidebar";
import { statusToPill, timeAgo } from "@/lib/utils";
import type { ServerStatus } from "@/components/ServerStatusCard";

interface Overview {
  components: Array<{
    id: number;
    slug: string;
    displayName: string;
    channels: Array<{ channel: string; latestTag: string | null; publishedAt: string | null }>;
  }>;
  alerts: { total: number; critical: number; warn: number };
  summary: {
    serversTotal: number;
    serversUp: number;
    serversDown: number;
    pgClustersUp: number;
    pgClustersDown: number;
    replicationOk: number;
    replicationProblems: number;
    versionDriftCount: number;
    totalAlerts: number;
    criticalAlerts: number;
    warnAlerts: number;
  };
  serverSummary: ServerStatus[];
}

interface Filial {
  id: number | null;
  displayName: string;
  company: string | null;
  channel: string | null;
  health: { status: string; latencyMs: number | null; checkedAt: string } | null;
  latest: { status: string | null; statusAt: string | null; ref: string | null } | null;
}

interface ReplData {
  servers: Array<{
    id: number;
    nombre: string;
    empresa: string | null;
    pgStatus: string;
    pgVersion: string | null;
    database: { sizeBytes: number | null; activeConnections: number | null; latencyMs: number | null } | null;
    expected: Array<{ kind: string; status: string | null; active: boolean | null }>;
  }>;
}

const SLIDE_DURATION_MS = 18_000;

function fmtBytes(n: number | null | undefined) {
  if (n == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

function fmtUptime(s: number | null | undefined) {
  if (!s) return "—";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${Math.round(s / 86400)}d`;
}

function uptimeTone(s: number | null | undefined): string {
  if (!s) return "text-text-muted";
  if (s < 3600) return "text-status-err";
  if (s < 86400) return "text-status-warn";
  return "text-status-ok";
}

const SLIDES = ["CI/CD", "Centrales", "Filiales", "Replicación", "Bases de datos"];

export default function TvPage() {
  const { data: overview } = usePollJson<Overview>("/api/data/overview", ["tv-overview-v2"]);
  const { data: filiales } = usePollJson<Filial[]>("/api/data/filiales", ["tv-filiales-v2"]);
  const { data: repl } = usePollJson<ReplData>("/api/data/replicacion", ["tv-repl-v2"]);

  const [slide, setSlide] = useState(0);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const t = setInterval(() => setSlide((s) => (s + 1) % SLIDES.length), SLIDE_DURATION_MS);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const centrales = (overview?.serverSummary ?? []).filter((s) => s.kind === "central");
  const filialesSrv = (overview?.serverSummary ?? []).filter((s) => s.kind === "filial");

  return (
    <div className="fixed inset-0 bg-bg-base text-text-primary flex flex-col">
      <header className="px-6 py-4 border-b border-border-subtle flex items-center justify-between bg-bg-surface">
        <div>
          <h1 className="text-2xl font-bold">FRC · Estado del SaaS</h1>
          <div className="text-xs text-text-muted">{SLIDES[slide]}</div>
        </div>
        <div className="text-right">
          <div className="text-2xl font-mono">{now.toLocaleTimeString()}</div>
          <div className="text-xs text-text-muted">{now.toLocaleDateString("es-PY", { weekday: "long", day: "numeric", month: "long" })}</div>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        <main className="flex-1 p-6 overflow-hidden">
          {slide === 0 && (
            <div className="grid grid-cols-2 gap-4 h-full">
              {overview?.components.map((c) => (
                <div key={c.id} className="card-raised">
                  <div className="text-2xl font-semibold mb-3">{c.displayName}</div>
                  <div className="grid grid-cols-3 gap-3">
                    {c.channels.map((ch) => (
                      <div key={ch.channel}>
                        <div className="text-xs uppercase text-text-muted">{ch.channel}</div>
                        <div className="font-mono text-2xl">{ch.latestTag ?? "—"}</div>
                        <div className="text-xs text-text-muted">{timeAgo(ch.publishedAt)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {slide === 1 && (
            <div className="grid grid-cols-2 gap-4 h-full content-start">
              {centrales.map((c) => (
                <div key={c.id} className="card-raised space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="text-xl font-semibold">{c.nombre}</div>
                    <span className={statusToPill(c.appHealth)}>{c.appHealth}</span>
                  </div>
                  <div className="text-sm text-text-muted font-mono">{c.ip}:{c.appPort} · canal {c.channel}</div>
                  <div className="grid grid-cols-3 gap-3 text-sm">
                    <div>
                      <div className="text-xs uppercase text-text-muted">Versión</div>
                      <div className={`font-mono ${c.versionDrift ? "text-status-err" : ""}`}>{c.runtimeVersion ?? "—"}</div>
                    </div>
                    <div>
                      <div className="text-xs uppercase text-text-muted">Uptime</div>
                      <div className={`text-lg ${uptimeTone(c.uptimeSec)}`}>{fmtUptime(c.uptimeSec)}</div>
                    </div>
                    <div>
                      <div className="text-xs uppercase text-text-muted">PG</div>
                      <span className={statusToPill(c.pgStatus)}>{c.pgStatus}</span>
                    </div>
                  </div>
                </div>
              ))}
              {centrales.length === 0 && (
                <div className="text-text-muted text-lg">Sin centrales registrados.</div>
              )}
            </div>
          )}

          {slide === 2 && (
            <div className="grid grid-cols-3 gap-3 h-full content-start">
              {filialesSrv.map((f) => (
                <div key={f.id} className="card-raised space-y-1">
                  <div className="flex items-center justify-between">
                    <div className="font-semibold">{f.nombre}</div>
                    <span className={statusToPill(f.appHealth)}>{f.appHealth}</span>
                  </div>
                  <div className="text-sm font-mono">{f.runtimeVersion ?? "—"}</div>
                  <div className="text-xs text-text-muted">canal {f.channel ?? "—"} · uptime {fmtUptime(f.uptimeSec)}</div>
                  {f.versionDrift && <div className="text-xs text-status-err">⚠ drift</div>}
                </div>
              ))}
              {filialesSrv.length === 0 && filiales && filiales.length > 0 && (
                filiales.map((f) => (
                  <div key={f.displayName} className="card-raised space-y-1">
                    <div className="font-semibold">{f.displayName}</div>
                    <div className="text-sm font-mono">{f.latest?.ref ?? "—"}</div>
                    <div className="text-xs text-text-muted">{timeAgo(f.latest?.statusAt)}</div>
                  </div>
                ))
              )}
            </div>
          )}

          {slide === 3 && (
            <div className="grid grid-cols-3 gap-3 h-full content-start">
              {repl?.servers.map((s) => {
                const pubs = s.expected.filter((e) => e.kind === "publication");
                const subs = s.expected.filter((e) => e.kind === "subscription");
                const pubOk = pubs.filter((p) => p.status === "found" && p.active).length;
                const pubErr = pubs.filter((p) => p.status === "missing" || (p.status === "found" && !p.active)).length;
                const subOk = subs.filter((p) => p.status === "found" && p.active).length;
                const subErr = subs.filter((p) => p.status === "missing" || (p.status === "found" && !p.active)).length;
                return (
                  <div key={s.id} className="card-raised space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="font-semibold">{s.nombre}</div>
                      <span className={statusToPill(s.pgStatus)}>{s.pgStatus}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div>
                        <div className="text-xs uppercase text-text-muted">Pub</div>
                        <div className="text-lg">
                          <span className="text-status-ok">{pubOk}</span>
                          {pubErr > 0 && <span className="text-status-err"> / {pubErr}✗</span>}
                          <span className="text-text-muted text-sm"> de {pubs.length}</span>
                        </div>
                      </div>
                      <div>
                        <div className="text-xs uppercase text-text-muted">Sub</div>
                        <div className="text-lg">
                          <span className="text-status-ok">{subOk}</span>
                          {subErr > 0 && <span className="text-status-err"> / {subErr}✗</span>}
                          <span className="text-text-muted text-sm"> de {subs.length}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
              {(!repl || repl.servers.length === 0) && (
                <div className="text-text-muted">Sin datos de replicación.</div>
              )}
            </div>
          )}

          {slide === 4 && (
            <div className="grid grid-cols-2 gap-3 h-full content-start">
              {repl?.servers.filter((s) => s.database).map((s) => {
                const conn = s.database!.activeConnections ?? 0;
                const connTone = conn > 90 ? "text-status-err" : conn > 50 ? "text-status-warn" : "text-status-ok";
                return (
                  <div key={s.id} className="card-raised space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="font-semibold">{s.nombre}</div>
                      <span className={statusToPill(s.pgStatus)}>{s.pgStatus}</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-sm">
                      <div>
                        <div className="text-xs uppercase text-text-muted">Tamaño</div>
                        <div className="text-lg">{fmtBytes(s.database!.sizeBytes)}</div>
                      </div>
                      <div>
                        <div className="text-xs uppercase text-text-muted">Conexiones</div>
                        <div className={`text-lg ${connTone}`}>{conn}</div>
                      </div>
                      <div>
                        <div className="text-xs uppercase text-text-muted">Latencia</div>
                        <div className="text-lg">{s.database!.latencyMs ?? "—"}ms</div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </main>

        <div className="w-[320px] shrink-0 border-l border-border-subtle p-4 overflow-hidden flex flex-col bg-bg-surface">
          <AlertSidebar heightClass="h-[calc(100vh-12rem)]" maxItems={15} />
        </div>
      </div>

      <footer className="border-t border-border-subtle px-6 py-3 flex justify-center gap-2 bg-bg-surface">
        {SLIDES.map((label, i) => (
          <div key={label} className="flex items-center gap-1.5">
            <div
              className={`h-1.5 w-12 rounded transition-colors ${i === slide ? "bg-text-primary" : "bg-border-subtle"}`}
            />
            <span className={`text-xs ${i === slide ? "text-text-primary" : "text-text-muted"}`}>{label}</span>
          </div>
        ))}
      </footer>
    </div>
  );
}
