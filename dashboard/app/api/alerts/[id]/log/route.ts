import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { requireAuth } from "@/lib/admin-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAuth();
  if (guard) return guard;

  const { id } = await params;
  const alert = db.select().from(schema.alerts).where(eq(schema.alerts.id, Number(id))).get();
  if (!alert) return NextResponse.json({ error: "not found" }, { status: 404 });

  const log = db
    .select()
    .from(schema.notificationLog)
    .where(eq(schema.notificationLog.alertFingerprint, alert.fingerprint))
    .orderBy(desc(schema.notificationLog.sentAt))
    .limit(50)
    .all();

  const states = db
    .select()
    .from(schema.notificationState)
    .where(eq(schema.notificationState.alertFingerprint, alert.fingerprint))
    .all();

  const targets = db.select().from(schema.notificationTargets).all();
  const byTarget = new Map(targets.map((t) => [t.id, t]));

  return NextResponse.json({
    alert,
    log: log.map((l) => ({ ...l, targetName: byTarget.get(l.targetId)?.name ?? null })),
    states: states.map((s) => ({ ...s, targetName: byTarget.get(s.targetId)?.name ?? null })),
  });
}
