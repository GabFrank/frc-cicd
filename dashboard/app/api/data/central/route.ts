import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const centrals = db
    .select()
    .from(schema.monitoredServers)
    .where(and(eq(schema.monitoredServers.kind, "central"), eq(schema.monitoredServers.active, true)))
    .all();

  const data = centrals.map((c) => {
    const recent = db
      .select()
      .from(schema.healthChecks)
      .where(eq(schema.healthChecks.serverId, c.id))
      .orderBy(desc(schema.healthChecks.checkedAt))
      .limit(20)
      .all();

    const latest = recent[0];
    const runtime = db
      .select()
      .from(schema.instanceRuntime)
      .all()
      .find((r) => r.serverId === c.id);

    const deps = c.githubEnvironment
      ? db
          .select()
          .from(schema.deployments)
          .where(eq(schema.deployments.environment, c.githubEnvironment))
          .orderBy(desc(schema.deployments.createdAt))
          .limit(5)
          .all()
      : [];

    return {
      id: c.id,
      name: c.nombre,
      displayName: c.nombre,
      host: c.ip,
      port: c.appPort,
      environment: c.githubEnvironment,
      notes: c.notes,
      channelId: null as number | null,
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
