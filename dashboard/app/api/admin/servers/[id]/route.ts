import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { requireAuth } from "@/lib/admin-guard";
import { writeSnapshotToDisk } from "@/lib/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAuth();
  if (guard) return guard;

  const { id } = await params;
  const row = db.select().from(schema.monitoredServers).where(eq(schema.monitoredServers.id, Number(id))).get();
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  const { pgPassword, ...rest } = row;
  return NextResponse.json({ ...rest, hasPassword: !!pgPassword });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAuth();
  if (guard) return guard;

  const { id } = await params;
  const body = await req.json();
  const numId = Number(id);

  const updates: Record<string, unknown> = {
    updatedAt: new Date().toISOString(),
  };
  const fields = [
    "kind", "empresa", "nombre", "ip", "appPort", "pgHost", "pgPort", "pgDatabase",
    "pgUser", "channel", "os", "sucursalId", "githubEnvironment", "active", "alertsEnabled", "notes",
  ];
  for (const f of fields) if (f in body) updates[f] = body[f];
  // pgPassword: solo si viene non-empty, sino preservar
  if (typeof body.pgPassword === "string" && body.pgPassword.length > 0) {
    updates.pgPassword = body.pgPassword;
  } else if (body.pgPassword === null) {
    updates.pgPassword = null;
  }

  db.update(schema.monitoredServers).set(updates).where(eq(schema.monitoredServers.id, numId)).run();
  writeSnapshotToDisk();
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAuth();
  if (guard) return guard;

  const { id } = await params;
  db.delete(schema.monitoredServers).where(eq(schema.monitoredServers.id, Number(id))).run();
  writeSnapshotToDisk();
  return NextResponse.json({ ok: true });
}
