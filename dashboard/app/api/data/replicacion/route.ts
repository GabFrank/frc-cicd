import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const servers = db.select().from(schema.monitoredServers).all();
  const expected = db.select().from(schema.expectedReplication).all();
  const checks = db.select().from(schema.replicationCheckResults).all();
  const databases = db.select().from(schema.pgDatabases).all();
  const clusterStatus = db.select().from(schema.pgClusterStatus).all();
  const sucursalesRows = db.select().from(schema.sucursales).all();

  const checkMap = new Map(checks.map((c) => [c.expectedId, c]));
  const clusterByPort = new Map(clusterStatus.map((c) => [c.clusterPort, c]));

  const data = servers.map((s) => {
    const ownExpected = expected.filter((e) => e.serverId === s.id);
    const ownDatabases = databases.filter((d) => d.clusterPort === (s.pgPort ?? 0) && d.name === s.pgDatabase);
    const cluster = s.pgPort ? clusterByPort.get(s.pgPort) : null;

    return {
      id: s.id,
      kind: s.kind,
      empresa: s.empresa,
      nombre: s.nombre,
      ip: s.ip,
      appPort: s.appPort,
      pgHost: s.pgHost,
      pgPort: s.pgPort,
      pgDatabase: s.pgDatabase,
      sucursalId: s.sucursalId,
      channel: s.channel,
      active: s.active,
      pgStatus: cluster?.status ?? "unknown",
      pgVersion: cluster?.version ?? null,
      pgError: cluster?.errorMessage ?? null,
      pgCheckedAt: cluster?.checkedAt ?? null,
      database: ownDatabases[0]
        ? {
            sizeBytes: ownDatabases[0].sizeBytes,
            activeConnections: ownDatabases[0].activeConnections,
            latencyMs: ownDatabases[0].latencyMs,
          }
        : null,
      expected: ownExpected.map((e) => {
        const check = checkMap.get(e.id);
        const peer = e.peerServerId ? servers.find((x) => x.id === e.peerServerId) : null;
        return {
          id: e.id,
          kind: e.kind,
          name: e.name,
          direction: e.direction,
          peerName: peer?.nombre ?? null,
          notes: e.notes,
          status: check?.status ?? null,
          active: check?.active ?? null,
          checkedAt: check?.checkedAt ?? null,
        };
      }),
    };
  });

  const lastSync = db
    .select()
    .from(schema.syncRuns)
    .where(eq(schema.syncRuns.jobName, "sync-replication"))
    .orderBy(desc(schema.syncRuns.startedAt))
    .limit(1)
    .all();

  return NextResponse.json({
    servers: data,
    sucursales: sucursalesRows,
    lastSync: lastSync[0] ?? null,
  });
}
