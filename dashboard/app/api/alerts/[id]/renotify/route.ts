import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { requireAuth } from "@/lib/admin-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Marca esta alerta para re-notificación: borra notification_state por su
 * fingerprint, así el próximo notify-alerts la considera "nueva" y dispara.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAuth();
  if (guard) return guard;

  const { id } = await params;
  const alert = db.select().from(schema.alerts).where(eq(schema.alerts.id, Number(id))).get();
  if (!alert) return NextResponse.json({ error: "not found" }, { status: 404 });

  const removed = db
    .delete(schema.notificationState)
    .where(eq(schema.notificationState.alertFingerprint, alert.fingerprint))
    .run();

  return NextResponse.json({ ok: true, statesRemoved: removed.changes ?? 0 });
}
