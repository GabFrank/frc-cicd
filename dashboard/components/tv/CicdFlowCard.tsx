"use client";

import { statusToPill, timeAgo } from "@/lib/utils";

interface RunRow {
  id: number;
  component: string;
  name: string | null;
  status: string | null;
  conclusion: string | null;
  headBranch: string | null;
  runStartedAt: string | null;
  htmlUrl: string | null;
}

interface ReleaseRow {
  id: number;
  component: string;
  tagName: string;
  channel: string | null;
  publishedAt: string | null;
  htmlUrl: string | null;
}

function channelPill(ch: string | null): string {
  if (ch === "stable") return "pill pill-ok";
  if (ch === "beta") return "pill pill-info";
  if (ch === "alpha") return "pill pill-warn";
  return "pill pill-neutral";
}

export function CicdFlowCard({
  runs,
  releases,
  interactive = false,
}: {
  runs: RunRow[];
  releases: ReleaseRow[];
  interactive?: boolean;
}) {
  const LinkOrSpan = ({ href, children }: { href: string | null; children: React.ReactNode }) =>
    interactive && href ? (
      <a href={href} target="_blank" rel="noreferrer" className="hover:underline">{children}</a>
    ) : (
      <span>{children}</span>
    );

  return (
    <div className="grid grid-cols-2 gap-3 h-full">
      <section className="flex flex-col min-h-0">
        <h3 className="text-xs uppercase text-text-muted mb-1.5">Workflow runs</h3>
        <ul className="space-y-1 text-sm overflow-hidden">
          {runs.length === 0 && <li className="text-text-muted">—</li>}
          {runs.slice(0, 10).map((r) => (
            <li key={r.id} className="flex items-center gap-1.5 min-w-0">
              <span className={statusToPill(r.conclusion ?? r.status)}>
                {(r.conclusion ?? r.status ?? "?").slice(0, 8)}
              </span>
              <span className="text-[10px] uppercase text-text-muted shrink-0">
                {r.component}
              </span>
              <span className="truncate text-xs">
                <LinkOrSpan href={r.htmlUrl}>{r.name ?? "—"}</LinkOrSpan>
              </span>
              <span className="text-[10px] text-text-muted shrink-0 ml-auto">
                {r.headBranch?.slice(0, 10) ?? ""}
              </span>
              <span className="text-[10px] text-text-muted shrink-0 tabular-nums">
                {timeAgo(r.runStartedAt)}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col min-h-0 border-l border-border-subtle pl-3">
        <h3 className="text-xs uppercase text-text-muted mb-1.5">Releases recientes</h3>
        <ul className="space-y-1 text-sm overflow-hidden">
          {releases.length === 0 && <li className="text-text-muted">—</li>}
          {releases.slice(0, 8).map((r) => (
            <li key={r.id} className="flex items-center gap-1.5">
              <span className={channelPill(r.channel)}>{r.channel ?? "?"}</span>
              <span className="text-[10px] uppercase text-text-muted shrink-0">
                {r.component}
              </span>
              <span className="font-mono text-xs truncate">
                <LinkOrSpan href={r.htmlUrl}>{r.tagName}</LinkOrSpan>
              </span>
              <span className="text-[10px] text-text-muted ml-auto tabular-nums">
                {timeAgo(r.publishedAt)}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
