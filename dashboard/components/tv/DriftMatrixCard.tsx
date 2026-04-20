"use client";

interface DriftRow {
  id: number;
  nombre: string;
  empresa: string | null;
  channel: string | null;
  current: string | null;
  expected: string | null;
}

export function DriftMatrixCard({ rows }: { rows: DriftRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <div className="text-5xl mb-2">✓</div>
          <div className="text-status-ok font-semibold text-lg">Todas las versiones al día</div>
          <div className="text-xs text-text-muted mt-1">
            Todos los servers con canal asignado corren la release vigente
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="text-xs text-text-muted mb-2">
        <strong className="text-status-err">{rows.length}</strong> server(s) corren versión distinta a la última del canal asignado
      </div>
      <table className="w-full text-xs">
        <thead className="text-left text-text-muted">
          <tr>
            <th className="pb-1">Servidor</th>
            <th className="pb-1">Canal</th>
            <th className="pb-1">Corriendo</th>
            <th className="pb-1">Esperado</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-border-subtle">
              <td className="py-1 truncate">
                <div>{r.nombre}</div>
                {r.empresa && <div className="text-[10px] text-text-muted">{r.empresa}</div>}
              </td>
              <td>
                <span className="pill pill-info text-[10px]">{r.channel ?? "—"}</span>
              </td>
              <td className="font-mono text-status-err">{r.current ?? "—"}</td>
              <td className="font-mono">{r.expected ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
