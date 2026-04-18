import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { requireAuth } from "@/lib/admin-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireAuth();
  if (guard) return guard;
  const { id } = await ctx.params;
  const nid = Number(id);
  if (!Number.isFinite(nid)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  const row = db.select().from(schema.notificationTargets).where(eq(schema.notificationTargets.id, nid)).get();
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(row);
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireAuth();
  if (guard) return guard;
  const { id } = await ctx.params;
  const nid = Number(id);
  if (!Number.isFinite(nid)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  const body = await req.json();
  const patch: Record<string, unknown> = {};
  if (body.name != null) patch.name = String(body.name).trim().toUpperCase();
  if (body.kind != null) {
    const k = String(body.kind).trim().toLowerCase();
    if (k !== "number" && k !== "group") return NextResponse.json({ error: "bad kind" }, { status: 400 });
    patch.kind = k;
  }
  if (body.jid != null) patch.jid = String(body.jid).trim();
  if (body.active != null) patch.active = !!body.active;
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: "empty patch" }, { status: 400 });
  db.update(schema.notificationTargets).set(patch as never).where(eq(schema.notificationTargets.id, nid)).run();
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireAuth();
  if (guard) return guard;
  const { id } = await ctx.params;
  const nid = Number(id);
  if (!Number.isFinite(nid)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  db.delete(schema.notificationTargets).where(eq(schema.notificationTargets.id, nid)).run();
  return NextResponse.json({ ok: true });
}
