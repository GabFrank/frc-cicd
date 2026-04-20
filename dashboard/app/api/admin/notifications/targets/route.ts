import { NextRequest, NextResponse } from "next/server";
import { asc } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { requireAuth } from "@/lib/admin-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await requireAuth();
  if (guard) return guard;
  const rows = db.select().from(schema.notificationTargets).orderBy(asc(schema.notificationTargets.id)).all();
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  const guard = await requireAuth();
  if (guard) return guard;
  const body = await req.json();
  if (!body.name || !body.kind || !body.jid) {
    return NextResponse.json({ error: "missing name, kind or jid" }, { status: 400 });
  }
  const name = String(body.name).trim().toUpperCase();
  const kind = String(body.kind).trim().toLowerCase();
  if (kind !== "number" && kind !== "group") {
    return NextResponse.json({ error: "kind must be number or group" }, { status: 400 });
  }
  const jid = String(body.jid).trim();
  const active = body.active !== false;
  const r = db
    .insert(schema.notificationTargets)
    .values({ name, kind, jid, active })
    .run();
  const targetId = Number(r.lastInsertRowid);
  // Auto-create default rule: warn+, resend 60min, todas las alertas.
  // Editable después desde /dashboard/notificaciones/rules.
  db.insert(schema.notificationRules)
    .values({ targetId, minSeverity: "warn", resendIntervalMin: 60, active: true })
    .run();
  return NextResponse.json({ id: targetId, defaultRuleCreated: true }, { status: 201 });
}
