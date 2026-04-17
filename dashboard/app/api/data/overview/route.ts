import { NextResponse } from "next/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db, schema } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const comps = db.select().from(schema.components).all();
  const chs = db.select().from(schema.channels).all();
  const channelsByComp = new Map<number, typeof chs>();
  for (const c of chs) {
    const list = channelsByComp.get(c.componentId) ?? [];
    list.push(c);
    channelsByComp.set(c.componentId, list);
  }

  const components = comps.map((c) => {
    const compChannels = channelsByComp.get(c.id) ?? [];
    const channelVersions = compChannels.map((ch) => {
      const r = db
        .select()
        .from(schema.releases)
        .where(and(eq(schema.releases.componentId, c.id), eq(schema.releases.channel, ch.name)))
        .orderBy(desc(schema.releases.publishedAt))
        .limit(1)
        .all();
      return {
        channel: ch.name,
        branch: ch.branch,
        latestTag: r[0]?.tagName ?? null,
        publishedAt: r[0]?.publishedAt ?? null,
        htmlUrl: r[0]?.htmlUrl ?? null,
      };
    });
    return {
      id: c.id,
      slug: c.slug,
      displayName: c.displayName,
      repoFullName: c.repoFullName,
      channels: channelVersions,
    };
  });

  const activeAlerts = db
    .select()
    .from(schema.alerts)
    .where(isNull(schema.alerts.resolvedAt))
    .all();

  const lastSync = db
    .select()
    .from(schema.syncRuns)
    .orderBy(desc(schema.syncRuns.startedAt))
    .limit(10)
    .all();

  return NextResponse.json({
    components,
    alerts: {
      total: activeAlerts.length,
      critical: activeAlerts.filter((a) => a.severity === "critical").length,
      warn: activeAlerts.filter((a) => a.severity === "warn").length,
    },
    lastSync,
  });
}
