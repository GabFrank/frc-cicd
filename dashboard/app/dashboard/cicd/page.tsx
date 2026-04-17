"use client";

import { usePollJson } from "@/components/PollQuery";
import { statusToPill, timeAgo } from "@/lib/utils";

interface CicdData {
  id: number;
  slug: string;
  displayName: string;
  repoFullName: string;
  workflowRuns: Array<{
    id: number;
    name: string | null;
    status: string | null;
    conclusion: string | null;
    headBranch: string | null;
    runNumber: number | null;
    event: string | null;
    runStartedAt: string | null;
    htmlUrl: string | null;
  }>;
  releases: Array<{
    id: number;
    tagName: string;
    channel: string | null;
    publishedAt: string | null;
    htmlUrl: string | null;
  }>;
  pullRequests: Array<{
    id: number;
    number: number;
    title: string;
    state: string;
    draft: boolean;
    author: string | null;
    headRef: string | null;
    baseRef: string | null;
    updatedAt: string | null;
    htmlUrl: string | null;
  }>;
}

export default function CicdPage() {
  const { data, isLoading, error } = usePollJson<CicdData[]>("/api/data/cicd", ["cicd"]);

  if (isLoading) return <div className="text-text-secondary">Cargando…</div>;
  if (error) return <div className="text-status-err">Error: {(error as Error).message}</div>;
  if (!data) return null;

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold">CI/CD</h1>
      {data.map((c) => (
        <section key={c.id} className="space-y-3">
          <div className="flex items-baseline justify-between">
            <h2 className="font-semibold text-lg">{c.displayName}</h2>
            <a
              href={`https://github.com/${c.repoFullName}`}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-text-muted hover:text-text-secondary"
            >
              {c.repoFullName} ↗
            </a>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="card">
              <h3 className="text-sm font-semibold mb-2">Últimos workflow runs</h3>
              <ul className="space-y-1 text-sm">
                {c.workflowRuns.length === 0 && <li className="text-text-muted">—</li>}
                {c.workflowRuns.map((r) => (
                  <li key={r.id} className="flex items-center gap-2">
                    <span className={statusToPill(r.conclusion ?? r.status)}>{r.conclusion ?? r.status}</span>
                    <a href={r.htmlUrl ?? "#"} target="_blank" rel="noreferrer" className="truncate hover:underline">
                      #{r.runNumber} {r.name}
                    </a>
                    <span className="text-xs text-text-muted ml-auto shrink-0">{timeAgo(r.runStartedAt)}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="card">
              <h3 className="text-sm font-semibold mb-2">Últimos releases</h3>
              <ul className="space-y-1 text-sm">
                {c.releases.length === 0 && <li className="text-text-muted">—</li>}
                {c.releases.map((r) => (
                  <li key={r.id} className="flex items-center gap-2">
                    <span className={`pill ${r.channel === "stable" ? "pill-ok" : r.channel === "beta" ? "pill-info" : "pill-warn"}`}>
                      {r.channel ?? "?"}
                    </span>
                    <a href={r.htmlUrl ?? "#"} target="_blank" rel="noreferrer" className="font-mono hover:underline">
                      {r.tagName}
                    </a>
                    <span className="text-xs text-text-muted ml-auto shrink-0">{timeAgo(r.publishedAt)}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="card">
              <h3 className="text-sm font-semibold mb-2">PRs abiertos</h3>
              <ul className="space-y-1 text-sm">
                {c.pullRequests.length === 0 && <li className="text-text-muted">—</li>}
                {c.pullRequests.map((p) => (
                  <li key={p.id} className="flex items-center gap-2">
                    <span className={`pill ${p.draft ? "pill-neutral" : "pill-info"}`}>
                      {p.draft ? "draft" : "open"}
                    </span>
                    <a href={p.htmlUrl ?? "#"} target="_blank" rel="noreferrer" className="truncate hover:underline">
                      #{p.number} {p.title}
                    </a>
                    <span className="text-xs text-text-muted ml-auto shrink-0">{timeAgo(p.updatedAt)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}
