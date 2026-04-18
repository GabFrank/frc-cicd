import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { requireAuth } from "@/lib/admin-guard";
import { writeSnapshotToDisk } from "@/lib/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const guard = await requireAuth();
  if (guard) return guard;

  const url = new URL(req.url);
  const serverId = url.searchParams.get("serverId");

  let rows;
  if (serverId) {
    rows = db.select().from(schema.expectedReplication).where(eq(schema.expectedReplication.serverId, Number(serverId))).all();
  } else {
    rows = db.select().from(schema.expectedReplication).all();
  }

  const checks = db.select().from(schema.replicationCheckResults).all();
  const checkMap = new Map(checks.map((c) => [c.expectedId, c]));

  return NextResponse.json(
    rows.map((r) => ({
      ...r,
      check: checkMap.get(r.id) ?? null,
    })),
  );
}

export async function POST(req: NextRequest) {
  const guard = await requireAuth();
  if (guard) return guard;

  const body = await req.json();
  if (!body.serverId || !body.kind || !body.name) {
    return NextResponse.json({ error: "missing serverId/kind/name" }, { status: 400 });
  }

  try {
    const result = db.insert(schema.expectedReplication).values({
      serverId: Number(body.serverId),
      kind: body.kind,
      name: body.name,
      peerServerId: body.peerServerId ?? null,
      direction: body.direction ?? null,
      notes: body.notes ?? null,
    }).run();
    writeSnapshotToDisk();
    return NextResponse.json({ id: Number(result.lastInsertRowid) }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
