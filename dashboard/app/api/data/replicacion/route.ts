import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const clusters = db.select().from(schema.pgClusterStatus).all();
  const databases = db.select().from(schema.pgDatabases).all();
  const items = db.select().from(schema.pgReplicationItems).all();
  const sucursalesRows = db.select().from(schema.sucursales).all();

  const lastSync = db
    .select()
    .from(schema.syncRuns)
    .where(eq(schema.syncRuns.jobName, "sync-replication"))
    .orderBy(desc(schema.syncRuns.startedAt))
    .limit(1)
    .all();

  const sucursalsById = new Map(sucursalesRows.map((s) => [s.id, s]));

  const clusterData = clusters.map((cluster) => {
    const dbs = databases.filter((d) => d.clusterPort === cluster.clusterPort);
    const clusterItems = items.filter((i) => i.clusterPort === cluster.clusterPort);

    const sucursalMap = new Map<number, {
      sucursalId: number;
      nombre: string | null;
      ip: string | null;
      puerto: number | null;
      activo: boolean | null;
      slotCentralToFilial: { name: string; active: boolean } | null;
      slotFilialToCentral: { name: string; active: boolean } | null;
      subscription: { name: string; active: boolean; extra: unknown } | null;
      publication: { name: string } | null;
      statReplication: { name: string; state: string; extra: unknown } | null;
    }>();

    const ensureSuc = (sid: number) => {
      if (!sucursalMap.has(sid)) {
        const row = sucursalsById.get(sid);
        sucursalMap.set(sid, {
          sucursalId: sid,
          nombre: row?.nombre ?? null,
          ip: row?.ip ?? null,
          puerto: row?.puerto ?? null,
          activo: row?.activo ?? null,
          slotCentralToFilial: null,
          slotFilialToCentral: null,
          subscription: null,
          publication: null,
          statReplication: null,
        });
      }
      return sucursalMap.get(sid)!;
    };

    const orphan: typeof clusterItems = [];
    for (const it of clusterItems) {
      if (it.sucursalId != null) {
        const s = ensureSuc(it.sucursalId);
        const extra = it.extraJson ? JSON.parse(it.extraJson) : null;
        if (it.kind === "slot") {
          if (it.direction === "central_to_filial") {
            s.slotCentralToFilial = { name: it.name, active: !!it.active };
          } else {
            s.slotFilialToCentral = { name: it.name, active: !!it.active };
          }
        } else if (it.kind === "subscription") {
          s.subscription = { name: it.name, active: !!it.active, extra };
        } else if (it.kind === "publication") {
          s.publication = { name: it.name };
        } else if (it.kind === "stat_replication") {
          s.statReplication = { name: it.name, state: extra?.state ?? "?", extra };
        }
      } else {
        orphan.push(it);
      }
    }

    return {
      clusterPort: cluster.clusterPort,
      label: cluster.label,
      status: cluster.status,
      version: cluster.version,
      errorMessage: cluster.errorMessage,
      checkedAt: cluster.checkedAt,
      databases: dbs.map((d) => ({
        name: d.name,
        status: d.status,
        sizeBytes: d.sizeBytes,
        activeConnections: d.activeConnections,
        latencyMs: d.latencyMs,
        errorMessage: d.errorMessage,
        checkedAt: d.checkedAt,
      })),
      sucursales: Array.from(sucursalMap.values()).sort((a, b) => a.sucursalId - b.sucursalId),
      orphanItems: orphan.map((o) => ({
        kind: o.kind,
        name: o.name,
        active: o.active,
        database: o.database,
        extra: o.extraJson ? JSON.parse(o.extraJson) : null,
      })),
    };
  });

  return NextResponse.json({
    clusters: clusterData,
    sucursales: sucursalesRows,
    lastSync: lastSync[0] ?? null,
  });
}
