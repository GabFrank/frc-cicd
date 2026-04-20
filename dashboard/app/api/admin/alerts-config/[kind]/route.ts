import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { requireAuth } from "@/lib/admin-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(req: NextRequest, { params }: { params: Promise<{ kind: string }> }) {
  const guard = await requireAuth();
  if (guard) return guard;

  const { kind } = await params;
  const body = await req.json().catch(() => ({}));

  const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (typeof body.pendingCycles === "number" && body.pendingCycles >= 1 && body.pendingCycles <= 100) {
    updates.pendingCycles = Math.round(body.pendingCycles);
  }
  if (typeof body.resolvingCycles === "number" && body.resolvingCycles >= 1 && body.resolvingCycles <= 100) {
    updates.resolvingCycles = Math.round(body.resolvingCycles);
  }
  if (typeof body.enabled === "boolean") updates.enabled = body.enabled;
  if (typeof body.notes === "string") updates.notes = body.notes;
  if (typeof body.severityDefault === "string" && ["info", "warn", "critical"].includes(body.severityDefault)) {
    updates.severityDefault = body.severityDefault;
  }

  db.update(schema.alertRuleConfig).set(updates).where(eq(schema.alertRuleConfig.kind, kind)).run();
  return NextResponse.json({ ok: true });
}
