import { NextResponse } from "next/server";
import { db, schema } from "@/lib/db";
import { requireAuth } from "@/lib/admin-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await requireAuth();
  if (guard) return guard;

  const rows = db.select().from(schema.alertRuleConfig).all();
  rows.sort((a, b) => a.kind.localeCompare(b.kind));
  return NextResponse.json(rows);
}
