import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { requireAuth } from "@/lib/admin-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const guard = await requireAuth();
  if (guard) return guard;
  const limit = Math.min(200, Math.max(1, Number(req.nextUrl.searchParams.get("limit") ?? 50)));
  const offset = Math.max(0, Number(req.nextUrl.searchParams.get("offset") ?? 0));
  const status = req.nextUrl.searchParams.get("status");
  const targetIdRaw = req.nextUrl.searchParams.get("targetId");
  const targetId = targetIdRaw && Number.isFinite(Number(targetIdRaw)) ? Number(targetIdRaw) : null;

  const conds = [];
  if (status) conds.push(eq(schema.notificationLog.status, status));
  if (targetId != null) conds.push(eq(schema.notificationLog.targetId, targetId));

  let q = db.select().from(schema.notificationLog);
  if (conds.length === 1) {
    q = q.where(conds[0]) as typeof q;
  } else if (conds.length > 1) {
    q = q.where(and(...conds)) as typeof q;
  }
  const rows = q.orderBy(desc(schema.notificationLog.sentAt)).limit(limit).offset(offset).all();

  return NextResponse.json({ rows, limit, offset });
}
