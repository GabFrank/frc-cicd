"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

export function RefreshButton({
  serverId,
  className = "",
  title = "Refrescar este servidor (HTTP health + PG probe + replicación)",
}: {
  serverId: number;
  className?: string;
  title?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<"ok" | "err" | null>(null);
  const qc = useQueryClient();

  const onClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    setFlash(null);
    try {
      const res = await fetch(`/api/admin/servers/${serverId}/refresh`, { method: "POST" });
      if (!res.ok) throw new Error(`${res.status}`);
      setFlash("ok");
      // invalidar queries para repintar con datos frescos
      qc.invalidateQueries({ queryKey: ["overview-v2"] });
      qc.invalidateQueries({ queryKey: ["replicacion-v3"] });
      qc.invalidateQueries({ queryKey: ["central"] });
      qc.invalidateQueries({ queryKey: ["filiales"] });
      qc.invalidateQueries({ queryKey: ["sidebar-alertas"] });
      setTimeout(() => setFlash(null), 2000);
    } catch {
      setFlash("err");
      setTimeout(() => setFlash(null), 3000);
    } finally {
      setBusy(false);
    }
  };

  const color =
    flash === "ok"
      ? "text-status-ok"
      : flash === "err"
        ? "text-status-err"
        : "text-text-muted hover:text-text-primary";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={`${color} transition disabled:opacity-50 ${className}`}
      title={title}
      aria-label="Refrescar"
    >
      <span className={`inline-block ${busy ? "animate-spin" : ""}`}>⟳</span>
    </button>
  );
}
