import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface FilialPayload {
  id: number | null;
  name: string;
  displayName: string;
  environment: string | null;
  company: string | null;
  host: string | null;
  port: number | null;
  channel: string | null;
  os: string | null;
  notes: string | null;
  registered: boolean;
  health: {
    status: string;
    httpCode: number | null;
    latencyMs: number | null;
    checkedAt: string;
  } | null;
  latest: {
    id: number;
    ref: string | null;
    status: string | null;
    statusAt: string | null;
    description: string | null;
    logUrl: string | null;
  } | null;
  lastSuccess: { ref: string | null; statusAt: string | null } | null;
  history: Array<{ id: number; ref: string | null; status: string | null; createdAt: string | null }>;
}

export async function GET() {
  // Filiales del registry (fuente de verdad)
  const registered = db
    .select()
    .from(schema.monitoredServers)
    .where(and(eq(schema.monitoredServers.kind, "filial"), eq(schema.monitoredServers.active, true)))
    .all();

  const filialEnvs = new Set(
    registered.map((r) => r.githubEnvironment).filter((e): e is string => !!e),
  );

  const data: FilialPayload[] = [];

  for (const r of registered) {
    const deps = r.githubEnvironment
      ? db
          .select()
          .from(schema.deployments)
          .where(eq(schema.deployments.environment, r.githubEnvironment))
          .orderBy(desc(schema.deployments.createdAt))
          .limit(10)
          .all()
      : [];

    const latest = deps[0];
    const lastSuccess = deps.find((d) => d.latestStatus === "success");

    const health = db
      .select()
      .from(schema.healthChecks)
      .where(eq(schema.healthChecks.serverId, r.id))
      .orderBy(desc(schema.healthChecks.checkedAt))
      .limit(1)
      .all()[0];

    data.push({
      id: r.id,
      name: r.nombre,
      displayName: r.nombre,
      environment: r.githubEnvironment,
      company: r.empresa,
      host: r.ip,
      port: r.appPort,
      channel: r.channel,
      os: r.os,
      notes: r.notes,
      registered: true,
      health: health
        ? {
            status: health.status,
            httpCode: health.httpCode,
            latencyMs: health.latencyMs,
            checkedAt: health.checkedAt,
          }
        : null,
      latest: latest
        ? {
            id: latest.id,
            ref: latest.ref,
            status: latest.latestStatus,
            statusAt: latest.latestStatusAt,
            description: latest.latestStatusDescription,
            logUrl: latest.logUrl,
          }
        : null,
      lastSuccess: lastSuccess
        ? { ref: lastSuccess.ref, statusAt: lastSuccess.latestStatusAt }
        : null,
      history: deps.slice(0, 6).map((d) => ({
        id: d.id,
        ref: d.ref,
        status: d.latestStatus,
        createdAt: d.createdAt,
      })),
    });
  }

  // Huérfanas: environments en deployments que no están registrados
  const filialComponent = db
    .select()
    .from(schema.components)
    .where(eq(schema.components.slug, "filial"))
    .get();
  if (filialComponent) {
    const orphanRows = db
      .selectDistinct({ environment: schema.deployments.environment })
      .from(schema.deployments)
      .where(eq(schema.deployments.componentId, filialComponent.id))
      .all();
    for (const row of orphanRows) {
      const env = row.environment;
      if (!env || filialEnvs.has(env) || !/filial/i.test(env)) continue;
      const deps = db
        .select()
        .from(schema.deployments)
        .where(eq(schema.deployments.environment, env))
        .orderBy(desc(schema.deployments.createdAt))
        .limit(10)
        .all();
      const latest = deps[0];
      const lastSuccess = deps.find((d) => d.latestStatus === "success");
      data.push({
        id: null,
        name: env,
        displayName: env,
        environment: env,
        company: null,
        host: null,
        port: null,
        channel: null,
        os: null,
        notes: "huérfano: no registrado en /admin",
        registered: false,
        health: null,
        latest: latest
          ? {
              id: latest.id,
              ref: latest.ref,
              status: latest.latestStatus,
              statusAt: latest.latestStatusAt,
              description: latest.latestStatusDescription,
              logUrl: latest.logUrl,
            }
          : null,
        lastSuccess: lastSuccess
          ? { ref: lastSuccess.ref, statusAt: lastSuccess.latestStatusAt }
          : null,
        history: deps.slice(0, 6).map((d) => ({
          id: d.id,
          ref: d.ref,
          status: d.latestStatus,
          createdAt: d.createdAt,
        })),
      });
    }
  }

  data.sort((a, b) => (a.company ?? "").localeCompare(b.company ?? "") || a.displayName.localeCompare(b.displayName));

  return NextResponse.json(data);
}
