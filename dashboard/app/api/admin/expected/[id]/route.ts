import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { requireAuth } from "@/lib/admin-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAuth();
  if (guard) return guard;

  const { id } = await params;
  db.delete(schema.expectedReplication).where(eq(schema.expectedReplication.id, Number(id))).run();
  return NextResponse.json({ ok: true });
}
