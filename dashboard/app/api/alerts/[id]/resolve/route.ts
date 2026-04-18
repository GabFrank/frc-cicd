import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { requireAuth } from "@/lib/admin-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST → resolve manualmente.
 * DELETE → reabrir (clear resolved_at).
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAuth();
  if (guard) return guard;

  const { id } = await params;
  db.update(schema.alerts)
    .set({ resolvedAt: new Date().toISOString() })
    .where(eq(schema.alerts.id, Number(id)))
    .run();
  return NextResponse.json({ ok: true, resolved: true });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAuth();
  if (guard) return guard;

  const { id } = await params;
  db.update(schema.alerts)
    .set({ resolvedAt: null, lastSeenAt: new Date().toISOString() })
    .where(eq(schema.alerts.id, Number(id)))
    .run();
  return NextResponse.json({ ok: true, reopened: true });
}
