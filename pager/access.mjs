// What the smoke test (smoke.yml) checks of the token of the workflow before it asks
// Claude: that it still reads what prepare reads with it in public repositories, the
// log of a job and the discussions. Any public repository with a successful run and
// discussions shows that, so the check reads the pager's own, which every copy of
// the template reaches, and not one that the owner of a copy need not have.
// PAGER_SMOKE_REPOSITORY names another.
import { Refusal } from "./core.mjs";
import { GitHubError } from "./github.mjs";

/** The public repository that the check reads without PAGER_SMOKE_REPOSITORY. */
export const SMOKE_REPOSITORY = "Dennis-Otto/repo-pager";

const DISCUSSIONS = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) { discussions { totalCount } }
}`;

/** The answer of a request, or a refusal that says what it was for. */
async function read(what, request) {
  try {
    return await request();
  } catch (error) {
    if (!(error instanceof GitHubError)) {
      throw error;
    }
    throw new Refusal(`${error.message}, for ${what}`);
  }
}

/** A repository that lacks what the check reads: another one does. */
function unfit(repo, lack) {
  return new Refusal(
    `${repo} has no ${lack}, which the smoke test reads: set the variable PAGER_SMOKE_REPOSITORY to a public repository that has one`,
  );
}

/**
 * Read the log of a successful job of the newest successful run of a public
 * repository, and the number of its discussions, with the token of the workflow.
 * Says what it read, or refuses with the reason: a repository without such a run or
 * job, or a token that GitHub refuses.
 */
export async function checkAccess({ api, repo }) {
  const [owner, name] = repo.split("/");
  const runs = await read(`the runs of ${repo}`, () =>
    api.get(`/repos/${repo}/actions/runs?status=success&per_page=1`),
  );
  const run = runs?.workflow_runs?.[0]?.id;
  if (run === undefined) {
    throw unfit(repo, "successful run of Actions");
  }
  // A job that ran: a skipped one has no log.
  const jobs = await read(`the jobs of run ${run} of ${repo}`, () =>
    api.get(`/repos/${repo}/actions/runs/${run}/jobs?per_page=100`),
  );
  const job = jobs?.jobs?.find((each) => each.conclusion === "success")?.id;
  if (job === undefined) {
    throw unfit(repo, `successful job in its run ${run}`);
  }
  // As prepare reads it: the API redirects to the log, and fetch sends the token
  // to the API alone, not to the host of the redirect.
  await read(
    `the log of job ${job} of ${repo}, so a fix reads no log: prepare needs a token that can`,
    () => api.text(`/repos/${repo}/actions/jobs/${job}/logs`),
  );
  const data = await read(
    `the discussions of ${repo}, so a draft of a discussion has no thread: prepare needs a token that can`,
    () => api.graphql(DISCUSSIONS, { owner, name }),
  );
  const count = data?.repository?.discussions?.totalCount;
  if (!Number.isInteger(count)) {
    throw new Refusal(
      `The token of the workflow reads no discussions of ${repo}, so a draft of a discussion has no thread: prepare needs a token that can`,
    );
  }
  return `The token of the workflow reads the log of job ${job} and the ${count} discussion(s) of ${repo}.`;
}
