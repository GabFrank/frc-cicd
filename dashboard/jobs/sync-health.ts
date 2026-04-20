import { and, eq } from "drizzle-orm";
import { inArray } from "drizzle-orm";
import { db, schema } from "../lib/db";

interface Result {
  ok: boolean;
  itemsIngested: number;
  error?: string;
}

const HEALTH_TIMEOUT_MS = 5000;

async function fetchJson<T = unknown>(url: string): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function checkOne(url: string): Promise<{
  status: "up" | "down";
  httpCode: number | null;
  latencyMs: number;
  body: string | null;
}> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    const body = await res.text().catch(() => "");
    const latency = Date.now() - started;
    const ok = res.status === 200 || res.status === 503;
    return {
      status: ok ? "up" : "down",
      httpCode: res.status,
      latencyMs: latency,
      body: body.slice(0, 500) || null,
    };
  } catch (err) {
    return {
      status: "down",
      httpCode: null,
      latencyMs: Date.now() - started,
      body: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function enrichRuntime(serverId: number, base: string) {
  const info = await fetchJson<Record<string, any>>(`${base}/actuator/info`);
  const memUsed = await fetchJson<{ measurements?: Array<{ value: number }> }>(
    `${base}/actuator/metrics/jvm.memory.used`,
  );
  const memMax = await fetchJson<{ measurements?: Array<{ value: number }> }>(
    `${base}/actuator/metrics/jvm.memory.max`,
  );
  const uptime = await fetchJson<{ measurements?: Array<{ value: number }> }>(
    `${base}/actuator/metrics/process.uptime`,
  );
  const threads = await fetchJson<{ measurements?: Array<{ value: number }> }>(
    `${base}/actuator/metrics/jvm.threads.live`,
  );

  const heapUsed = memUsed?.measurements?.[0]?.value ?? null;
  const heapMax = memMax?.measurements?.[0]?.value ?? null;
  const uptimeSec = uptime?.measurements?.[0]?.value ?? null;
  const threadCount = threads?.measurements?.[0]?.value ?? null;

  const version =
    info?.build?.version ?? info?.app?.version ?? info?.git?.build?.version ?? null;
  const build = info?.build?.name ?? info?.app?.name ?? null;
  const gitCommit = info?.git?.commit?.id ?? info?.git?.commit ?? null;

  const values = {
    version,
    build,
    gitCommit,
    uptimeSec: uptimeSec != null ? Math.round(uptimeSec) : null,
    heapUsedBytes: heapUsed != null ? Math.round(heapUsed) : null,
    heapMaxBytes: heapMax != null ? Math.round(heapMax) : null,
    threads: threadCount != null ? Math.round(threadCount) : null,
    infoJson: info ? JSON.stringify(info) : null,
    updatedAt: new Date().toISOString(),
  };

  const existing = db
    .select()
    .from(schema.instanceRuntime)
    .all()
    .find((r) => r.serverId === serverId);

  if (existing) {
    db.update(schema.instanceRuntime)
      .set(values)
      .where(eq(schema.instanceRuntime.serverId, serverId))
      .run();
  } else {
    db.insert(schema.instanceRuntime).values({ serverId, ...values }).run();
  }
}

function recordStart(): number {
  const res = db
    .insert(schema.syncRuns)
    .values({ jobName: "sync-health", ok: false, itemsIngested: 0 })
    .run();
  return Number(res.lastInsertRowid);
}

function recordFinish(id: number, r: Result) {
  db.update(schema.syncRuns)
    .set({
      finishedAt: new Date().toISOString(),
      ok: r.ok,
      itemsIngested: r.itemsIngested,
      errorMessage: r.error ?? null,
    })
    .where(eq(schema.syncRuns.id, id))
    .run();
}

export async function syncHealth(): Promise<Result> {
  const runId = recordStart();
  let total = 0;

  try {
    const servers = db
      .select()
      .from(schema.monitoredServers)
      .where(
        and(
          inArray(schema.monitoredServers.kind, ["central", "filial"]),
          eq(schema.monitoredServers.active, true),
        ),
      )
      .all();

    for (const s of servers) {
      if (!s.ip || !s.appPort) continue;
      const base = `http://${s.ip}:${s.appPort}`;
      const url = `${base}/actuator/health`;
      const result = await checkOne(url);
      db.insert(schema.healthChecks)
        .values({
          instanceId: null,
          serverId: s.id,
          status: result.status,
          httpCode: result.httpCode ?? null,
          latencyMs: result.latencyMs,
          bodyExcerpt: result.body,
        })
        .run();
      total += 1;

      if (result.status === "up") {
        await enrichRuntime(s.id, base);
      }
    }

    const r: Result = { ok: true, itemsIngested: total };
    recordFinish(runId, r);
    return r;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const r: Result = { ok: false, itemsIngested: total, error: msg };
    recordFinish(runId, r);
    throw err;
  }
}
