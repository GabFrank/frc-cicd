import { NextRequest, NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { requireAuth } from "@/lib/admin-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const guard = await requireAuth();
  if (guard) return guard;
  const targetId = req.nextUrl.searchParams.get("targetId");
  const tid = targetId && Number.isFinite(Number(targetId)) ? Number(targetId) : null;
  const rows = tid
    ? db
        .select()
        .from(schema.notificationRules)
        .where(eq(schema.notificationRules.targetId, tid))
        .orderBy(asc(schema.notificationRules.id))
        .all()
    : db.select().from(schema.notificationRules).orderBy(asc(schema.notificationRules.id)).all();
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  const guard = await requireAuth();
  if (guard) return guard;
  const body = await req.json();
  if (!body.targetId) return NextResponse.json({ error: "missing targetId" }, { status: 400 });
  const targetId = Number(body.targetId);
  if (!Number.isFinite(targetId)) return NextResponse.json({ error: "bad targetId" }, { status: 400 });

  const minSeverity = String(body.minSeverity ?? "warn").toLowerCase();
  if (!["info", "warn", "critical"].includes(minSeverity)) {
    return NextResponse.json({ error: "bad minSeverity" }, { status: 400 });
  }

  const r = db
    .insert(schema.notificationRules)
    .values({
      targetId,
      minSeverity,
      alertKindsCsv: body.alertKindsCsv != null ? String(body.alertKindsCsv) : null,
      empresaFilter: body.empresaFilter != null ? String(body.empresaFilter).trim().toUpperCase() || null : null,
      serverIdsCsv: body.serverIdsCsv != null ? String(body.serverIdsCsv) : null,
      quietStart: body.quietStart != null ? String(body.quietStart) : null,
      quietEnd: body.quietEnd != null ? String(body.quietEnd) : null,
      quietBypassCritical: body.quietBypassCritical !== false,
      resendIntervalMin: body.resendIntervalMin != null ? Number(body.resendIntervalMin) : 60,
      active: body.active !== false,
    })
    .run();
  return NextResponse.json({ id: Number(r.lastInsertRowid) }, { status: 201 });
}
