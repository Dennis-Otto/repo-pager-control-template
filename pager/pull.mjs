// The pull request of a fix, in a job of its own: Claude's job hands over only its
// change as a patch, and the token that writes, PAGER_FIX_TOKEN, never reaches the
// machine on which Claude ran. The patch goes onto a fresh checkout at the commit
// that Claude saw, and becomes one commit through the API, which GitHub signs, on a
// new branch, and a pull request that runs the checks and the review of the
// repository as any other.

/** The most files and bytes that a fix may change. */
export const LIMIT = { files: 100, bytes: 5 * 1024 * 1024 };

const COMMIT = `mutation($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) { commit { oid } }
}`;

/**
 * The changes of `git diff --cached --raw -z --no-renames`: the status, the new
 * mode and the path of each file.
 */
export function changesOf(raw) {
  const parts = raw.split("\0");
  const changes = [];
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const [, mode, , , status] = parts[index].slice(1).split(" ");
    changes.push({ status, mode, path: parts[index + 1] });
  }
  return changes;
}

/** A text of GitHub without the brackets of a link of its own. */
function plain(text) {
  return text.replace(/[[\]()]/g, "");
}

/** The description of the pull request: Claude's, and what the fix was for. */
export function pullBody(job, plan) {
  const entries = job.entries
    .map((entry) => `- [${plain(entry.label)}](${entry.url})`)
    .join("\n");
  return [
    plan.body,
    "",
    "---",
    "",
    `Started with 🛠 **Start fix** of the pager, for what fails on the default branch:`,
    "",
    entries,
    "",
    "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
  ].join("\n");
}

/** The commit message: the title, the description and the trailers. */
export function commitMessage(plan, user) {
  return {
    headline: plan.title,
    body: [
      plan.body,
      "",
      `Signed-off-by: ${user.login} <${user.id}+${user.login}@users.noreply.github.com>`,
      "Co-Authored-By: Claude <noreply@anthropic.com>",
    ].join("\n"),
  };
}

function refused(error) {
  return { url: "", error };
}

/**
 * Open the pull request of a fix. Returns its address, or the reason why there is
 * none; it throws only on what isn't a refusal of git or GitHub.
 */
export async function openPull({
  job,
  plan,
  base,
  token,
  runId,
  patch,
  api,
  git,
  read,
}) {
  if (token === "") {
    return refused("PAGER_FIX_TOKEN isn't set in the control repository");
  }
  try {
    git(["apply", "--index", "--binary", "--whitespace=nowarn", patch]);
  } catch (error) {
    return refused(
      `the change doesn't apply: ${String(error.message).slice(0, 150)}`,
    );
  }
  const changes = changesOf(
    git(["diff", "--cached", "--raw", "-z", "--no-renames"]),
  );
  if (changes.length === 0) {
    return refused("the change is empty");
  }
  if (changes.length > LIMIT.files) {
    return refused(`the change has more than ${LIMIT.files} files`);
  }
  if (changes.some((change) => ["120000", "160000"].includes(change.mode))) {
    return refused(
      "the change has a symbolic link or a submodule, which a commit through the API can't hold",
    );
  }
  const additions = [];
  const deletions = [];
  let bytes = 0;
  for (const change of changes) {
    if (change.status === "D") {
      deletions.push({ path: change.path });
      continue;
    }
    const content = await read(change.path);
    bytes += content.length;
    additions.push({ path: change.path, contents: content.toString("base64") });
  }
  if (bytes > LIMIT.bytes) {
    return refused("the change is larger than 5 MB");
  }
  const type = /^[a-z]+/.exec(plan.title)[0];
  const branch = `${type}/pager-fix-${runId}`;
  let created = false;
  try {
    const user = await api.get("/user");
    const repository = await api.get(`/repos/${job.repo}`);
    await api.post(`/repos/${job.repo}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: base,
    });
    created = true;
    await api.graphql(COMMIT, {
      input: {
        branch: { repositoryNameWithOwner: job.repo, branchName: branch },
        expectedHeadOid: base,
        message: commitMessage(plan, user),
        fileChanges: { additions, deletions },
      },
    });
    const pull = await api.post(`/repos/${job.repo}/pulls`, {
      title: plan.title,
      head: branch,
      base: repository.default_branch,
      body: pullBody(job, plan),
      maintainer_can_modify: true,
    });
    return { url: pull.html_url, error: "" };
  } catch (error) {
    if (error?.status === undefined) {
      throw error;
    }
    if (created) {
      // A branch without its pull request helps nobody; one that can't go stays.
      await api
        .request("DELETE", `/repos/${job.repo}/git/refs/heads/${branch}`)
        .catch(() => undefined);
    }
    return refused(error.message);
  }
}
