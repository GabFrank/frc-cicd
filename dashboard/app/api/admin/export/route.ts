import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/admin-guard";
import { snapshotConfig } from "@/lib/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await requireAuth();
  if (guard) return guard;

  const snap = snapshotConfig();
  const filename = `frc-dashboard-config-${new Date().toISOString().slice(0, 10)}.json`;
  return new NextResponse(JSON.stringify(snap, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
