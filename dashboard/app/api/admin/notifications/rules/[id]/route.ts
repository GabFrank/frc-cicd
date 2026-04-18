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
  const row = db.select().from(schema.notificationRules).where(eq(schema.notificationRules.id, nid)).get();
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
  if (body.targetId != null) patch.targetId = Number(body.targetId);
  if (body.minSeverity != null) {
    const m = String(body.minSeverity).toLowerCase();
    if (!["info", "warn", "critical"].includes(m)) return NextResponse.json({ error: "bad minSeverity" }, { status: 400 });
    patch.minSeverity = m;
  }
  if (body.alertKindsCsv !== undefined) patch.alertKindsCsv = body.alertKindsCsv == null ? null : String(body.alertKindsCsv);
  if (body.empresaFilter !== undefined)
    patch.empresaFilter =
      body.empresaFilter == null || String(body.empresaFilter).trim() === ""
        ? null
        : String(body.empresaFilter).trim().toUpperCase();
  if (body.serverIdsCsv !== undefined) patch.serverIdsCsv = body.serverIdsCsv == null ? null : String(body.serverIdsCsv);
  if (body.quietStart !== undefined) patch.quietStart = body.quietStart == null ? null : String(body.quietStart);
  if (body.quietEnd !== undefined) patch.quietEnd = body.quietEnd == null ? null : String(body.quietEnd);
  if (body.quietBypassCritical != null) patch.quietBypassCritical = !!body.quietBypassCritical;
  if (body.resendIntervalMin != null) patch.resendIntervalMin = Number(body.resendIntervalMin);
  if (body.active != null) patch.active = !!body.active;
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: "empty patch" }, { status: 400 });
  db.update(schema.notificationRules).set(patch as never).where(eq(schema.notificationRules.id, nid)).run();
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireAuth();
  if (guard) return guard;
  const { id } = await ctx.params;
  const nid = Number(id);
  if (!Number.isFinite(nid)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  db.delete(schema.notificationRules).where(eq(schema.notificationRules.id, nid)).run();
  return NextResponse.json({ ok: true });
}
