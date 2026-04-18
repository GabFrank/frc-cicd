import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/lib/db";
import { requireAuth } from "@/lib/admin-guard";
import { writeSnapshotToDisk, type ConfigSnapshot } from "@/lib/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ImportBody {
  snapshot: ConfigSnapshot;
  mode?: "replace" | "merge";
}

export async function POST(req: NextRequest) {
  const guard = await requireAuth();
  if (guard) return guard;

  let body: ImportBody;
  try {
    body = (await req.json()) as ImportBody;
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }
  if (!body?.snapshot?.monitoredServers || !Array.isArray(body.snapshot.monitoredServers)) {
    return NextResponse.json({ error: "snapshot.monitoredServers requerido" }, { status: 400 });
  }
  const mode = body.mode ?? "merge";

  const snap = body.snapshot;
  let serversInserted = 0, serversUpdated = 0, expectedInserted = 0, expectedRemoved = 0;
  const idMap = new Map<number, number>(); // old id → new id

  try {
    if (mode === "replace") {
      // Borrar todo y rehacer (CASCADE limpia expected_replication)
      db.delete(schema.expectedReplication).run();
      db.delete(schema.monitoredServers).run();
    }

    for (const s of snap.monitoredServers) {
      const existing = db
        .select()
        .from(schema.monitoredServers)
        .all()
        .find((r) => r.nombre === s.nombre);
      const values = {
        kind: s.kind,
        empresa: s.empresa ?? null,
        nombre: s.nombre,
        ip: s.ip ?? null,
        appPort: s.appPort ?? null,
        pgHost: s.pgHost ?? null,
        pgPort: s.pgPort ?? null,
        pgDatabase: s.pgDatabase ?? null,
        pgUser: s.pgUser ?? null,
        pgPassword: s.pgPassword ?? null,
        channel: s.channel ?? null,
        os: s.os ?? null,
        sucursalId: s.sucursalId ?? null,
        githubEnvironment: s.githubEnvironment ?? null,
        active: s.active ?? true,
        notes: s.notes ?? null,
        updatedAt: new Date().toISOString(),
      };
      if (existing) {
        const { eq } = await import("drizzle-orm");
        db.update(schema.monitoredServers).set(values).where(eq(schema.monitoredServers.id, existing.id)).run();
        idMap.set(s.id, existing.id);
        serversUpdated += 1;
      } else {
        const r = db.insert(schema.monitoredServers).values(values).run();
        idMap.set(s.id, Number(r.lastInsertRowid));
        serversInserted += 1;
      }
    }

    if (Array.isArray(snap.expectedReplication)) {
      if (mode === "merge") {
        // Para merge, también limpiar expected duplicados de los servers que importamos
        for (const e of snap.expectedReplication) {
          const newServerId = idMap.get(e.serverId);
          if (!newServerId) continue;
          const dup = db
            .select()
            .from(schema.expectedReplication)
            .all()
            .find((r) => r.serverId === newServerId && r.kind === e.kind && r.name === e.name);
          if (dup) continue; // ya existe — skip
          const newPeerId = e.peerServerId ? idMap.get(e.peerServerId) ?? null : null;
          db.insert(schema.expectedReplication).values({
            serverId: newServerId,
            kind: e.kind,
            name: e.name,
            peerServerId: newPeerId,
            direction: e.direction ?? null,
            notes: e.notes ?? null,
          }).run();
          expectedInserted += 1;
        }
      } else {
        // replace ya borró todo
        for (const e of snap.expectedReplication) {
          const newServerId = idMap.get(e.serverId);
          if (!newServerId) continue;
          const newPeerId = e.peerServerId ? idMap.get(e.peerServerId) ?? null : null;
          db.insert(schema.expectedReplication).values({
            serverId: newServerId,
            kind: e.kind,
            name: e.name,
            peerServerId: newPeerId,
            direction: e.direction ?? null,
            notes: e.notes ?? null,
          }).run();
          expectedInserted += 1;
        }
      }
    }

    writeSnapshotToDisk();

    return NextResponse.json({
      ok: true,
      mode,
      serversInserted,
      serversUpdated,
      expectedInserted,
      expectedRemoved,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
