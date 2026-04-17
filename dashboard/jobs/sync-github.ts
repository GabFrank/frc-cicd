import { eq } from "drizzle-orm";
import { db, schema } from "../lib/db";
import { COMPONENTS, channelFromRefOrTag } from "../lib/config";
import {
  latestDeploymentStatus,
  listDeployments,
  listPulls,
  listReleases,
  listWorkflowRuns,
} from "../lib/github";

interface JobResult {
  job: string;
  ok: boolean;
  itemsIngested: number;
  error?: string;
}

function recordStart(name: string): number {
  const res = db
    .insert(schema.syncRuns)
    .values({ jobName: name, ok: false, itemsIngested: 0 })
    .run();
  return Number(res.lastInsertRowid);
}

function recordFinish(id: number, result: JobResult) {
  db.update(schema.syncRuns)
    .set({
      finishedAt: new Date().toISOString(),
      ok: result.ok,
      itemsIngested: result.itemsIngested,
      errorMessage: result.error ?? null,
    })
    .where(eq(schema.syncRuns.id, id))
    .run();
}

async function syncOneRepo(slug: string, repoFullName: string, componentId: number) {
  let ingested = 0;

  const releases = await listReleases(repoFullName, 20);
  for (const r of releases) {
    db.insert(schema.releases)
      .values({
        id: r.id,
        componentId,
        tagName: r.tag_name,
        name: r.name ?? null,
        channel: channelFromRefOrTag(r.tag_name) ?? (r.prerelease ? "alpha" : "stable"),
        draft: !!r.draft,
        prerelease: !!r.prerelease,
        publishedAt: r.published_at ?? r.created_at ?? null,
        htmlUrl: r.html_url ?? null,
        payloadJson: JSON.stringify({
          author: r.author?.login,
          target: r.target_commitish,
          assets: r.assets?.map((a) => ({ name: a.name, size: a.size, url: a.browser_download_url })),
        }),
      })
      .onConflictDoUpdate({
        target: schema.releases.id,
        set: {
          tagName: r.tag_name,
          name: r.name ?? null,
          draft: !!r.draft,
          prerelease: !!r.prerelease,
          publishedAt: r.published_at ?? r.created_at ?? null,
          htmlUrl: r.html_url ?? null,
        },
      })
      .run();
    ingested += 1;
  }

  const runs = await listWorkflowRuns(repoFullName, 20);
  for (const w of runs) {
    db.insert(schema.workflowRuns)
      .values({
        id: w.id,
        componentId,
        name: w.name ?? null,
        status: w.status ?? null,
        conclusion: w.conclusion ?? null,
        headBranch: w.head_branch ?? null,
        runNumber: w.run_number ?? null,
        event: w.event ?? null,
        runStartedAt: w.run_started_at ?? null,
        updatedAt: w.updated_at ?? null,
        htmlUrl: w.html_url ?? null,
      })
      .onConflictDoUpdate({
        target: schema.workflowRuns.id,
        set: {
          status: w.status ?? null,
          conclusion: w.conclusion ?? null,
          updatedAt: w.updated_at ?? null,
        },
      })
      .run();
    ingested += 1;
  }

  const pulls = await listPulls(repoFullName, 30);
  for (const p of pulls) {
    db.insert(schema.pullRequests)
      .values({
        id: p.id,
        componentId,
        number: p.number,
        title: p.title,
        state: p.state,
        draft: !!p.draft,
        author: p.user?.login ?? null,
        headRef: p.head?.ref ?? null,
        baseRef: p.base?.ref ?? null,
        createdAt: p.created_at ?? null,
        updatedAt: p.updated_at ?? null,
        htmlUrl: p.html_url ?? null,
      })
      .onConflictDoUpdate({
        target: schema.pullRequests.id,
        set: {
          title: p.title,
          state: p.state,
          draft: !!p.draft,
          updatedAt: p.updated_at ?? null,
        },
      })
      .run();
    ingested += 1;
  }

  const deps = await listDeployments(repoFullName, 100);
  for (const d of deps) {
    let statusLatest: Awaited<ReturnType<typeof latestDeploymentStatus>> = null;
    try {
      statusLatest = await latestDeploymentStatus(repoFullName, d.id);
    } catch (err) {
      console.warn(`[sync-github] deployment ${d.id} status fetch failed`, err);
    }
    db.insert(schema.deployments)
      .values({
        id: d.id,
        componentId,
        environment: d.environment ?? "unknown",
        ref: d.ref ?? null,
        sha: d.sha ?? null,
        createdAt: d.created_at ?? null,
        latestStatus: statusLatest?.state ?? null,
        latestStatusDescription: statusLatest?.description ?? null,
        latestStatusAt: statusLatest?.updated_at ?? statusLatest?.created_at ?? null,
        logUrl: statusLatest?.log_url ?? null,
        payloadJson: JSON.stringify({ payload: d.payload, creator: d.creator?.login }),
      })
      .onConflictDoUpdate({
        target: schema.deployments.id,
        set: {
          latestStatus: statusLatest?.state ?? null,
          latestStatusDescription: statusLatest?.description ?? null,
          latestStatusAt: statusLatest?.updated_at ?? statusLatest?.created_at ?? null,
          logUrl: statusLatest?.log_url ?? null,
        },
      })
      .run();
    ingested += 1;
  }

  return ingested;
}

export async function syncGithub(): Promise<JobResult> {
  const runId = recordStart("sync-github");
  let total = 0;
  try {
    const comps = db.select().from(schema.components).all();
    for (const c of comps) {
      try {
        const n = await syncOneRepo(c.slug, c.repoFullName, c.id);
        total += n;
        console.log(`[sync-github] ${c.slug}: ${n} items`);
      } catch (err) {
        console.error(`[sync-github] ${c.slug} FAILED`, err);
      }
    }
    const result: JobResult = { job: "sync-github", ok: true, itemsIngested: total };
    recordFinish(runId, result);
    return result;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const result: JobResult = { job: "sync-github", ok: false, itemsIngested: total, error: msg };
    recordFinish(runId, result);
    throw err;
  }
}
