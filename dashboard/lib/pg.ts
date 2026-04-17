import { Client } from "pg";

export interface ClusterDef {
  port: number;
  label: string;
  databases: string[];
}

export function parseClusters(raw: string | undefined): ClusterDef[] {
  if (!raw) return [];
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const clusters: ClusterDef[] = [];
  let current: ClusterDef | null = null;

  for (const token of parts) {
    if (/^\d+:/.test(token)) {
      if (current) clusters.push(current);
      const [portStr, label, dbs] = token.split(":");
      current = {
        port: Number(portStr),
        label: label ?? `cluster-${portStr}`,
        databases: dbs ? dbs.split(/[,;]/).map((s) => s.trim()).filter(Boolean) : [],
      };
    } else if (current) {
      current.databases.push(token);
    }
  }
  if (current) clusters.push(current);
  return clusters;
}

export async function withClient<T>(
  opts: { host: string; port: number; user: string; password: string; database: string; statementTimeoutMs?: number },
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({
    host: opts.host,
    port: opts.port,
    user: opts.user,
    password: opts.password,
    database: opts.database,
    connectionTimeoutMillis: 4000,
    statement_timeout: opts.statementTimeoutMs ?? 4000,
    query_timeout: opts.statementTimeoutMs ?? 4000,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export function parseSucursalFromSlot(name: string): { sucursalId: number | null; direction: "central_to_filial" | "filial_to_central" | null } {
  const m = name.match(/filial(\d+)(_central)?/i);
  if (!m) return { sucursalId: null, direction: null };
  return {
    sucursalId: Number(m[1]),
    direction: m[2] ? "central_to_filial" : "filial_to_central",
  };
}

export function parseSucursalFromPublication(name: string): { sucursalId: number | null } {
  const m = name.match(/filial(\d+)/i);
  return { sucursalId: m ? Number(m[1]) : null };
}
