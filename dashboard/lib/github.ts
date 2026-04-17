import { Octokit } from "@octokit/rest";

let _octokit: Octokit | null = null;

export function getOctokit(): Octokit {
  if (_octokit) return _octokit;
  const token = process.env.GITHUB_PAT;
  if (!token) {
    throw new Error("GITHUB_PAT is not set");
  }
  _octokit = new Octokit({
    auth: token,
    userAgent: "frc-dashboard/0.1",
    request: { timeout: 15_000 },
  });
  return _octokit;
}

export function splitRepo(fullName: string): { owner: string; repo: string } {
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) throw new Error(`Invalid repo: ${fullName}`);
  return { owner, repo };
}

export async function listReleases(fullName: string, perPage = 20) {
  const { owner, repo } = splitRepo(fullName);
  const { data } = await getOctokit().repos.listReleases({
    owner,
    repo,
    per_page: perPage,
  });
  return data;
}

export async function listWorkflowRuns(fullName: string, perPage = 20) {
  const { owner, repo } = splitRepo(fullName);
  const { data } = await getOctokit().actions.listWorkflowRunsForRepo({
    owner,
    repo,
    per_page: perPage,
  });
  return data.workflow_runs;
}

export async function listPulls(fullName: string, perPage = 30) {
  const { owner, repo } = splitRepo(fullName);
  const { data } = await getOctokit().pulls.list({
    owner,
    repo,
    state: "open",
    per_page: perPage,
    sort: "updated",
    direction: "desc",
  });
  return data;
}

export async function listDeployments(fullName: string, perPage = 100) {
  const { owner, repo } = splitRepo(fullName);
  const { data } = await getOctokit().repos.listDeployments({
    owner,
    repo,
    per_page: perPage,
  });
  return data;
}

export type DeploymentStatus = Awaited<
  ReturnType<Octokit["repos"]["listDeploymentStatuses"]>
>["data"][number];

export async function latestDeploymentStatus(
  fullName: string,
  deploymentId: number,
): Promise<DeploymentStatus | null> {
  const { owner, repo } = splitRepo(fullName);
  const { data } = await getOctokit().repos.listDeploymentStatuses({
    owner,
    repo,
    deployment_id: deploymentId,
    per_page: 1,
  });
  return data[0] ?? null;
}
