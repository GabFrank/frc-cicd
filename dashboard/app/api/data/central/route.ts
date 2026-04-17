import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const centrals = db
    .select()
    .from(schema.instances)
    .where(and(eq(schema.instances.kind, "central_instance"), eq(schema.instances.active, true)))
    .all();

  const data = centrals.map((c) => {
    const recent = db
      .select()
      .from(schema.healthChecks)
      .where(eq(schema.healthChecks.instanceId, c.id))
      .orderBy(desc(schema.healthChecks.checkedAt))
      .limit(20)
      .all();

    const latest = recent[0];
    const runtime = db
      .select()
      .from(schema.instanceRuntime)
      .where(eq(schema.instanceRuntime.instanceId, c.id))
      .get();
    const deps = c.environment
      ? db
          .select()
          .from(schema.deployments)
          .where(eq(schema.deployments.environment, c.environment))
          .orderBy(desc(schema.deployments.createdAt))
          .limit(5)
          .all()
      : [];

    return {
      id: c.id,
      name: c.name,
      displayName: c.displayName,
      host: c.host,
      port: c.port,
      environment: c.environment,
      notes: c.notes,
      channelId: c.channelId,
      health: latest
        ? {
            status: latest.status,
            httpCode: latest.httpCode,
            latencyMs: latest.latencyMs,
            checkedAt: latest.checkedAt,
          }
        : null,
      recentChecks: recent.map((r) => ({
        status: r.status,
        httpCode: r.httpCode,
        latencyMs: r.latencyMs,
        checkedAt: r.checkedAt,
      })),
      deployments: deps.map((d) => ({
        id: d.id,
        ref: d.ref,
        status: d.latestStatus,
        statusAt: d.latestStatusAt,
      })),
      runtime: runtime
        ? {
            version: runtime.version,
            build: runtime.build,
            gitCommit: runtime.gitCommit,
            uptimeSec: runtime.uptimeSec,
            heapUsedBytes: runtime.heapUsedBytes,
            heapMaxBytes: runtime.heapMaxBytes,
            threads: runtime.threads,
            updatedAt: runtime.updatedAt,
          }
        : null,
    };
  });

  return NextResponse.json(data);
}
