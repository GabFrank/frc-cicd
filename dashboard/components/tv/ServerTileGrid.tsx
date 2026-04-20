"use client";

import type { ServerStatus } from "../ServerStatusCard";

function tone(s: ServerStatus): "ok" | "warn" | "err" | "neutral" {
  if (s.appHealth === "down") return "err";
  if (s.pgStatus && s.pgStatus !== "up" && s.pgStatus !== "unknown") return "err";
  if (s.replicationErr > 0) return "err";
  if (s.versionDrift) return "warn";
  if (s.replicationWarn > 0) return "warn";
  if (s.appHealth === "unknown") return "neutral";
  return "ok";
}

function toneBg(t: "ok" | "warn" | "err" | "neutral"): string {
  if (t === "ok") return "bg-status-ok/15 border-status-ok/50";
  if (t === "warn") return "bg-status-warn/15 border-status-warn/50";
  if (t === "err") return "bg-status-err/15 border-status-err/50";
  return "bg-bg-raised border-border-subtle";
}

function shortName(s: ServerStatus): string {
  // Devuelve algo corto pero reconocible.
  const n = s.nombre;
  // Heurística: si el nombre tiene "·" usar la parte después; si tiene paréntesis, sacar
  return n.replace(/\s*\([^)]*\)\s*$/, "").replace(/^[^·]+·\s*/, "").slice(0, 18);
}

export function ServerTileGrid({
  servers,
  interactive = false,
  onTileClick,
}: {
  servers: ServerStatus[];
  interactive?: boolean;
  onTileClick?: (s: ServerStatus) => void;
}) {
  const grouped = servers.reduce<Record<string, ServerStatus[]>>((acc, s) => {
    const key = s.empresa ?? "otros";
    acc[key] = acc[key] ?? [];
    acc[key].push(s);
    return acc;
  }, {});

  return (
    <div className="space-y-3">
      {Object.entries(grouped).map(([empresa, list]) => (
        <div key={empresa}>
          <div className="text-[10px] uppercase tracking-wide text-text-muted mb-1 capitalize">
            {empresa} <span className="text-text-secondary">({list.length})</span>
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(110px,1fr))] gap-1.5">
            {list.map((s) => {
              const t = tone(s);
              const bg = toneBg(t);
              const Tile = (
                <div
                  className={`${bg} border rounded-md px-2 py-1.5 text-xs leading-tight ${
                    interactive ? "cursor-pointer hover:brightness-125" : ""
                  }`}
                  title={`${s.nombre}\nHTTP ${s.appHealth} · PG ${s.pgStatus}\n${s.runtimeVersion ?? "—"}${s.versionDrift ? ` (drift, esperado ${s.expectedTag})` : ""}`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium truncate">{shortName(s)}</span>
                    <span className="text-[10px] flex gap-0.5 ml-1 shrink-0">
                      <span title={`HTTP ${s.appHealth}`}>
                        {s.appHealth === "up" ? "●" : s.appHealth === "down" ? "✗" : "○"}
                      </span>
                      <span title={`PG ${s.pgStatus}`}>
                        {s.pgStatus === "up" ? "●" : s.pgStatus === "unknown" ? "○" : "✗"}
                      </span>
                    </span>
                  </div>
                  <div className="text-[10px] text-text-muted font-mono truncate">
                    {s.runtimeVersion ?? "—"}
                  </div>
                  {s.versionDrift && (
                    <div className="text-[10px] text-status-err">⚠ drift</div>
                  )}
                </div>
              );
              if (interactive && onTileClick) {
                return (
                  <button
                    key={s.id}
                    type="button"
                    className="text-left"
                    onClick={() => onTileClick(s)}
                  >
                    {Tile}
                  </button>
                );
              }
              return <div key={s.id}>{Tile}</div>;
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
