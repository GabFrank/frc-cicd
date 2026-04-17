import { NextResponse } from "next/server";
import { desc, isNotNull, isNull } from "drizzle-orm";
import { db, schema } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const active = db
    .select()
    .from(schema.alerts)
    .where(isNull(schema.alerts.resolvedAt))
    .orderBy(desc(schema.alerts.lastSeenAt))
    .all();

  const recentlyResolved = db
    .select()
    .from(schema.alerts)
    .where(isNotNull(schema.alerts.resolvedAt))
    .orderBy(desc(schema.alerts.resolvedAt))
    .limit(20)
    .all();

  const instances = db.select().from(schema.instances).all();
  const byId = new Map(instances.map((i) => [i.id, i]));

  const enrich = (a: typeof active[number]) => ({
    ...a,
    instanceName: a.instanceId ? byId.get(a.instanceId)?.displayName : null,
  });

  return NextResponse.json({
    active: active.map(enrich),
    recentlyResolved: recentlyResolved.map(enrich),
  });
}
