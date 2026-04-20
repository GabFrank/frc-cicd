import { and, eq } from "drizzle-orm";
import { inArray } from "drizzle-orm";
import net from "node:net";
import { db, schema } from "../lib/db";

interface Result {
  ok: boolean;
  itemsIngested: number;
  error?: string;
}

const HEALTH_TIMEOUT_MS = 5000;
const TCP_PROBE_TIMEOUT_MS = 3000;

async function probeTcp(
  ip: string,
  port: number,
  timeoutMs = TCP_PROBE_TIMEOUT_MS,
): Promise<{ reachable: boolean; latencyMs: number; error: string | null }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (reachable: boolean, error: string | null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ reachable, latencyMs: Date.now() - started, error });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true, null));
    socket.once("timeout", () => finish(false, "timeout"));
    socket.once("error", (err) => finish(false, err.message.slice(0, 200)));
    try {
      socket.connect(port, ip);
    } catch (err) {
      finish(false, err instanceof Error ? err.message : String(err));
    }
  });
}

async function syncHostReachability(
  servers: Array<{ ip: string | null; appPort: number | null; pgPort: number | null }>,
): Promise<void> {
  // Agrupar por IP, elegir el primer puerto conocido para probar.
  const byIp = new Map<string, number>();
  for (const s of servers) {
    if (!s.ip) continue;
    if (byIp.has(s.ip)) continue;
    const port = s.appPort ?? s.pgPort ?? 22;
    byIp.set(s.ip, port);
  }
  const now = new Date().toISOString();
  for (const [ip, port] of byIp) {
    const probe = await probeTcp(ip, port);
    const existing = db
      .select()
      .from(schema.hostReachability)
      .where(eq(schema.hostReachability.ip, ip))
      .get();
    const consecutiveUnreachable = probe.reachable
      ? 0
      : (existing?.consecutiveUnreachable ?? 0) + 1;
    const lastReachableAt = probe.reachable ? now : existing?.lastReachableAt ?? null;
    if (existing) {
      db.update(schema.hostReachability)
        .set({
          lastProbeAt: now,
          reachable: probe.reachable,
          consecutiveUnreachable,
          lastReachableAt,
          probePort: port,
          latencyMs: probe.latencyMs,
          errorMessage: probe.error,
        })
        .where(eq(schema.hostReachability.ip, ip))
        .run();
    } else {
      db.insert(schema.hostReachability)
        .values({
          ip,
          lastProbeAt: now,
          reachable: probe.reachable,
          consecutiveUnreachable,
          lastReachableAt,
          probePort: port,
          latencyMs: probe.latencyMs,
          errorMessage: probe.error,
        })
        .run();
    }
  }
}

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

    // Host reachability probe (TCP, independiente del HTTP app-level).
    await syncHostReachability(servers);

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
