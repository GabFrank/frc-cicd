import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { requireAuth } from "@/lib/admin-guard";
import { checkOne, enrichRuntime } from "@/jobs/sync-health";
import { probeServer, persistServerSnapshot, evaluateExpected } from "@/jobs/sync-replication";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Refresca un servidor específico: HTTP health + PG probe + eval expected replication.
 * Permite forzar refresh sin esperar al próximo ciclo de los jobs (health=1m, replication=2m).
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAuth();
  if (guard) return guard;

  const { id } = await params;
  const numId = Number(id);
  const server = db
    .select()
    .from(schema.monitoredServers)
    .where(eq(schema.monitoredServers.id, numId))
    .get();
  if (!server) return NextResponse.json({ error: "server not found" }, { status: 404 });

  const result = {
    ok: true,
    http: null as null | { status: string; httpCode: number | null; latencyMs: number },
    pg: null as null | { status: "up" | "down"; error: string | null },
    replication: null as null | { checked: number },
  };

  // HTTP health (solo si tiene ip + app_port)
  if (server.ip && server.appPort) {
    const base = `http://${server.ip}:${server.appPort}`;
    const hc = await checkOne(`${base}/actuator/health`);
    db.insert(schema.healthChecks).values({
      instanceId: null,
      serverId: server.id,
      status: hc.status,
      httpCode: hc.httpCode ?? null,
      latencyMs: hc.latencyMs,
      bodyExcerpt: hc.body,
    }).run();
    result.http = { status: hc.status, httpCode: hc.httpCode, latencyMs: hc.latencyMs };
    if (hc.status === "up") {
      await enrichRuntime(server.id, base);
    }
  }

  // PG probe + expected replication check (si hay pg endpoint)
  if (server.pgHost && server.pgPort && server.pgDatabase) {
    const probe = await probeServer(server);
    persistServerSnapshot(server, probe);
    result.pg = { status: probe.status, error: probe.error };
    if (probe.status === "up") {
      evaluateExpected(server.id, probe);
      const expected = db
        .select()
        .from(schema.expectedReplication)
        .where(eq(schema.expectedReplication.serverId, server.id))
        .all();
      result.replication = { checked: expected.length };
    }
  }

  return NextResponse.json(result);
}
