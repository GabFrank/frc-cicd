import { NextResponse } from "next/server";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function classify(env: string): { company: string; channel: string; os: string | null; number: number | null } {
  const m = env.match(/^([a-z0-9]+)[-_]filial[-_](\d+)?[-_]?(linux|windows)?/i);
  if (m) {
    return {
      company: m[1].toLowerCase(),
      channel: m[1].toLowerCase(),
      number: m[2] ? Number(m[2]) : null,
      os: m[3]?.toLowerCase() ?? null,
    };
  }
  if (/filial/i.test(env)) {
    return { company: "filial", channel: "unknown", os: null, number: null };
  }
  return { company: env, channel: "unknown", os: null, number: null };
}

export async function GET() {
  const filialComponent = db
    .select()
    .from(schema.components)
    .where(eq(schema.components.slug, "filial"))
    .get();

  if (!filialComponent) return NextResponse.json([]);

  const envs = db
    .select({
      environment: schema.deployments.environment,
      count: sql<number>`count(*)`.as("count"),
    })
    .from(schema.deployments)
    .where(eq(schema.deployments.componentId, filialComponent.id))
    .groupBy(schema.deployments.environment)
    .all();

  const filialEnvs = envs.filter((e) => /filial/i.test(e.environment) || /farmacia/i.test(e.environment));

  const allInstances = db
    .select()
    .from(schema.instances)
    .where(inArray(schema.instances.environment, filialEnvs.map((e) => e.environment)))
    .all();
  const byEnv = new Map(allInstances.map((i) => [i.environment ?? "", i]));

  const data = filialEnvs.map(({ environment }) => {
    const deps = db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.environment, environment))
      .orderBy(desc(schema.deployments.createdAt))
      .limit(10)
      .all();

    const latest = deps[0];
    const lastSuccess = deps.find((d) => d.latestStatus === "success");
    const meta = classify(environment);
    const known = byEnv.get(environment);

    return {
      id: known?.id ?? null,
      name: known?.name ?? environment,
      displayName:
        known?.displayName ??
        (meta.number
          ? `${meta.company[0].toUpperCase()}${meta.company.slice(1)} · Filial ${meta.number}${meta.os ? ` (${meta.os})` : ""}`
          : environment),
      environment,
      company: known?.company ?? meta.company,
      host: known?.host ?? null,
      port: known?.port ?? null,
      channel: meta.channel,
      os: meta.os,
      notes: known?.notes ?? null,
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
    };
  });

  data.sort((a, b) => a.company.localeCompare(b.company) || a.displayName.localeCompare(b.displayName));

  return NextResponse.json(data);
}
