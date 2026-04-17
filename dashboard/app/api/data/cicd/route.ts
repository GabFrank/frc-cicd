import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const comps = db.select().from(schema.components).all();

  const result = comps.map((c) => {
    const runs = db
      .select()
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.componentId, c.id))
      .orderBy(desc(schema.workflowRuns.runStartedAt))
      .limit(10)
      .all();
    const releases = db
      .select()
      .from(schema.releases)
      .where(eq(schema.releases.componentId, c.id))
      .orderBy(desc(schema.releases.publishedAt))
      .limit(5)
      .all();
    const pulls = db
      .select()
      .from(schema.pullRequests)
      .where(eq(schema.pullRequests.componentId, c.id))
      .orderBy(desc(schema.pullRequests.updatedAt))
      .limit(10)
      .all();

    return {
      id: c.id,
      slug: c.slug,
      displayName: c.displayName,
      repoFullName: c.repoFullName,
      workflowRuns: runs,
      releases,
      pullRequests: pulls,
    };
  });

  return NextResponse.json(result);
}
