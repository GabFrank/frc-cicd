import { NextResponse } from "next/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db, schema } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ServerSummary {
  id: number;
  kind: string;
  empresa: string | null;
  nombre: string;
  channel: string | null;
  appHealth: "up" | "down" | "unknown";
  appHealthAt: string | null;
  appHealthLatency: number | null;
  pgStatus: string;
  pgCheckedAt: string | null;
  runtimeVersion: string | null;
  expectedTag: string | null;
  versionDrift: boolean;
  uptimeSec: number | null;
  replicationOk: number;
  replicationWarn: number;
  replicationErr: number;
  ip: string | null;
  appPort: number | null;
}

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
    const lastRun = db
      .select()
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.componentId, c.id))
      .orderBy(desc(schema.workflowRuns.runStartedAt))
      .limit(1)
      .all()[0];
    const openPRs = db
      .select()
      .from(schema.pullRequests)
      .where(and(eq(schema.pullRequests.componentId, c.id), eq(schema.pullRequests.state, "open")))
      .all().length;
    return {
      id: c.id,
      slug: c.slug,
      displayName: c.displayName,
      repoFullName: c.repoFullName,
      channels: channelVersions,
      lastWorkflow: lastRun
        ? { status: lastRun.status, conclusion: lastRun.conclusion, htmlUrl: lastRun.htmlUrl, runStartedAt: lastRun.runStartedAt }
        : null,
      openPRs,
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

  // Server summary consolidado
  const servers = db
    .select()
    .from(schema.monitoredServers)
    .where(eq(schema.monitoredServers.active, true))
    .all();
  const compById = new Map(comps.map((c) => [c.id, c]));
  const releasesByCompChannel = new Map<string, string>();
  for (const c of comps) {
    for (const ch of channelsByComp.get(c.id) ?? []) {
      const r = db
        .select()
        .from(schema.releases)
        .where(and(eq(schema.releases.componentId, c.id), eq(schema.releases.channel, ch.name)))
        .orderBy(desc(schema.releases.publishedAt))
        .limit(1)
        .all()[0];
      if (r) releasesByCompChannel.set(`${c.id}:${ch.name}`, r.tagName);
    }
  }

  const allRuntime = db.select().from(schema.instanceRuntime).all();
  const runtimeByServer = new Map(
    allRuntime.filter((r) => r.serverId != null).map((r) => [r.serverId!, r]),
  );

  const allClusters = db.select().from(schema.pgClusterStatus).all();
  const clusterByServer = new Map(
    allClusters.filter((c) => c.serverId != null).map((c) => [c.serverId!, c]),
  );

  const expected = db.select().from(schema.expectedReplication).all();
  const checks = db.select().from(schema.replicationCheckResults).all();
  const checkByExp = new Map(checks.map((c) => [c.expectedId, c]));

  const serverSummary: ServerSummary[] = servers.map((s) => {
    const lastHealth = db
      .select()
      .from(schema.healthChecks)
      .where(eq(schema.healthChecks.serverId, s.id))
      .orderBy(desc(schema.healthChecks.checkedAt))
      .limit(1)
      .all()[0];

    const runtime = runtimeByServer.get(s.id);
    const cluster = clusterByServer.get(s.id);

    const compSlug = s.kind === "central" ? "central" : s.kind === "filial" ? "filial" : null;
    const matchedComp = compSlug ? comps.find((cc) => cc.slug === compSlug) : null;
    const compRel = matchedComp && s.channel
      ? releasesByCompChannel.get(`${matchedComp.id}:${s.channel}`) ?? null
      : null;

    const drift = !!(runtime?.version && compRel && !runtime.version.includes(compRel.replace(/^v/, "")));

    const ownExpected = expected.filter((e) => e.serverId === s.id);
    let ok = 0, warn = 0, err = 0;
    for (const e of ownExpected) {
      const c = checkByExp.get(e.id);
      if (!c) { warn += 1; continue; }
      if (c.status === "missing") err += 1;
      else if (c.status === "found" && c.active) ok += 1;
      else err += 1;
    }

    return {
      id: s.id,
      kind: s.kind,
      empresa: s.empresa,
      nombre: s.nombre,
      channel: s.channel,
      appHealth: (lastHealth?.status as "up" | "down" | undefined) ?? "unknown",
      appHealthAt: lastHealth?.checkedAt ?? null,
      appHealthLatency: lastHealth?.latencyMs ?? null,
      pgStatus: cluster?.status ?? "unknown",
      pgCheckedAt: cluster?.checkedAt ?? null,
      runtimeVersion: runtime?.version ?? null,
      expectedTag: compRel,
      versionDrift: drift,
      uptimeSec: runtime?.uptimeSec ?? null,
      replicationOk: ok,
      replicationWarn: warn,
      replicationErr: err,
      ip: s.ip,
      appPort: s.appPort,
    };
  });

  const summary = {
    serversTotal: servers.length,
    serversUp: serverSummary.filter((s) => s.appHealth === "up").length,
    serversDown: serverSummary.filter((s) => s.appHealth === "down").length,
    pgClustersUp: serverSummary.filter((s) => s.pgStatus === "up").length,
    pgClustersDown: serverSummary.filter((s) => s.pgStatus !== "up" && s.pgStatus !== "unknown").length,
    replicationOk: serverSummary.reduce((a, s) => a + s.replicationOk, 0),
    replicationProblems: serverSummary.reduce((a, s) => a + s.replicationErr + s.replicationWarn, 0),
    versionDriftCount: serverSummary.filter((s) => s.versionDrift).length,
    criticalAlerts: activeAlerts.filter((a) => a.severity === "critical").length,
    warnAlerts: activeAlerts.filter((a) => a.severity === "warn").length,
    totalAlerts: activeAlerts.length,
  };

  return NextResponse.json({
    components,
    alerts: {
      total: activeAlerts.length,
      critical: summary.criticalAlerts,
      warn: summary.warnAlerts,
    },
    summary,
    serverSummary,
    lastSync,
  });
}
