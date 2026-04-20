import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/lib/db";
import { requireAuth } from "@/lib/admin-guard";
import { writeSnapshotToDisk } from "@/lib/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await requireAuth();
  if (guard) return guard;

  const rows = db.select().from(schema.monitoredServers).all();
  const safe = rows.map(({ pgPassword, ...rest }) => ({
    ...rest,
    hasPassword: !!pgPassword,
  }));
  return NextResponse.json(safe);
}

export async function POST(req: NextRequest) {
  const guard = await requireAuth();
  if (guard) return guard;

  const body = await req.json();
  const required = ["kind", "nombre"];
  for (const k of required) {
    if (!body[k]) return NextResponse.json({ error: `missing ${k}` }, { status: 400 });
  }

  const now = new Date().toISOString();
  const result = db.insert(schema.monitoredServers).values({
    kind: body.kind,
    empresa: body.empresa ?? null,
    nombre: body.nombre,
    ip: body.ip ?? null,
    appPort: body.appPort ?? null,
    pgHost: body.pgHost ?? body.ip ?? null,
    pgPort: body.pgPort ?? null,
    pgDatabase: body.pgDatabase ?? null,
    pgUser: body.pgUser ?? null,
    pgPassword: body.pgPassword ?? null,
    channel: body.channel ?? null,
    os: body.os ?? null,
    sucursalId: body.sucursalId ?? null,
    githubEnvironment: body.githubEnvironment ?? null,
    active: body.active ?? true,
    alertsEnabled: body.alertsEnabled ?? true,
    notes: body.notes ?? null,
    createdAt: now,
    updatedAt: now,
  }).run();

  writeSnapshotToDisk();
  return NextResponse.json({ id: Number(result.lastInsertRowid) }, { status: 201 });
}
