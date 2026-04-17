"use client";

import { useEffect, useState } from "react";
import { usePollJson } from "@/components/PollQuery";
import { statusToPill, timeAgo } from "@/lib/utils";

interface Overview {
  components: Array<{
    id: number;
    slug: string;
    displayName: string;
    channels: Array<{ channel: string; latestTag: string | null; publishedAt: string | null }>;
  }>;
  alerts: { total: number; critical: number; warn: number };
}

interface Filial {
  id: number;
  displayName: string;
  company: string | null;
  latest: { status: string | null; statusAt: string | null; ref: string | null } | null;
}

interface Central {
  id: number;
  displayName: string;
  health: { status: string; latencyMs: number | null; checkedAt: string } | null;
}

export default function TvPage() {
  const { data: overview } = usePollJson<Overview>("/api/data/overview", ["tv-overview"]);
  const { data: filiales } = usePollJson<Filial[]>("/api/data/filiales", ["tv-filiales"]);
  const { data: central } = usePollJson<Central[]>("/api/data/central", ["tv-central"]);

  const [slide, setSlide] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSlide((s) => (s + 1) % 3), 15_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="fixed inset-0 bg-bg-base p-8 overflow-hidden flex flex-col">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold">FRC · Estado general</h1>
        <div className="flex items-center gap-3">
          <span
            className={`pill text-base ${
              (overview?.alerts.critical ?? 0) > 0
                ? "pill-err"
                : (overview?.alerts.warn ?? 0) > 0
                  ? "pill-warn"
                  : "pill-ok"
            }`}
          >
            {overview?.alerts.total ?? 0} alertas
          </span>
          <span className="text-text-muted">{new Date().toLocaleTimeString()}</span>
        </div>
      </div>

      <div className="flex-1 overflow-hidden">
        {slide === 0 && (
          <div className="grid grid-cols-2 gap-4 h-full">
            {overview?.components.map((c) => (
              <div key={c.id} className="card-raised">
                <div className="text-xl font-semibold mb-3">{c.displayName}</div>
                <div className="grid grid-cols-3 gap-3">
                  {c.channels.map((ch) => (
                    <div key={ch.channel}>
                      <div className="text-xs uppercase text-text-muted">{ch.channel}</div>
                      <div className="font-mono text-lg">{ch.latestTag ?? "—"}</div>
                      <div className="text-xs text-text-muted">{timeAgo(ch.publishedAt)}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {slide === 1 && (
          <div className="grid grid-cols-3 gap-3 h-full content-start">
            {filiales?.map((f) => (
              <div key={f.id} className="card">
                <div className="flex items-center justify-between">
                  <div className="font-semibold">{f.displayName}</div>
                  <span className={statusToPill(f.latest?.status ?? "neutral")}>
                    {f.latest?.status ?? "—"}
                  </span>
                </div>
                <div className="font-mono text-sm mt-1">{f.latest?.ref ?? "—"}</div>
                <div className="text-xs text-text-muted">{timeAgo(f.latest?.statusAt)}</div>
              </div>
            ))}
          </div>
        )}

        {slide === 2 && (
          <div className="grid grid-cols-2 gap-3">
            {central?.map((c) => (
              <div key={c.id} className="card-raised">
                <div className="flex items-center justify-between">
                  <div className="font-semibold text-lg">{c.displayName}</div>
                  <span className={statusToPill(c.health?.status ?? "neutral")}>
                    {c.health?.status ?? "—"}
                  </span>
                </div>
                <div className="text-sm text-text-muted mt-2">
                  {c.health?.latencyMs ?? "—"}ms · {timeAgo(c.health?.checkedAt)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex justify-center gap-2 mt-4">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className={`h-1 w-12 rounded ${i === slide ? "bg-text-primary" : "bg-border-subtle"}`}
          />
        ))}
      </div>
    </div>
  );
}
