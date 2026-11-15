// The actions that the Actions policy of README.md allows besides GitHub's own, and
// the check that they still are all that the jobs need. GitHub checks every action
// of a job against the policy, also one that an allowed action runs itself, as a
// composite action does with its `uses:`: anthropics/claude-code-action runs
// oven-sh/setup-bun, so the list names both, or GitHub refuses the job of Claude in
// its Set up job. A new release of an allowed action may run another action, so the
// workflow Tests reads the action.yml of each allowed action at the commit that a
// workflow pins, and of each action that it runs in turn, and fails on one that the
// list misses, before a pull request of Dependabot brings that release to a copy.
import { Refusal } from "./core.mjs";
import { GitHubError } from "./github.mjs";

/**
 * The actions that the policy allows besides GitHub's own, each as `owner/repo`,
 * which README.md allows as `owner/repo@*`, in both pairs of its commands.
 */
export const ALLOWED = ["anthropics/claude-code-action", "oven-sh/setup-bun"];

/** The owners whose actions are GitHub's own, which the policy allows as well. */
const GITHUB_OWNED = ["actions", "github"];

/**
 * Each `uses:` of a workflow or an action.yml that runs an action of a repository:
 * neither one of the checkout (`./`) nor an image (`docker://`).
 */
export function usesOf(text) {
  return [...text.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)]
    .map(([, target]) => target.replace(/^(["'])(.*)\1$/, "$2"))
    .filter(
      (target) => !target.startsWith("./") && !target.startsWith("docker://"),
    );
}

/** An action as `owner/repo`, its path inside the repository and its ref. */
export function parse(target) {
  const [action, ref = ""] = target.split("@");
  const [owner = "", repo = "", ...path] = action.split("/");
  return { owner, repository: `${owner}/${repo}`, path: path.join("/"), ref };
}

/** Whether the policy allows an action: GitHub's own, or one of the list. */
export function allowed(target, list = ALLOWED) {
  const { owner, repository } = parse(target);
  return GITHUB_OWNED.includes(owner) || list.includes(repository);
}

/** Whether an action is pinned to a commit, as the policy requires. */
export function pinned(target) {
  return /^[0-9a-f]{40}$/.test(parse(target).ref);
}

/** The text of the action.yml, or action.yaml, of an action at its ref. */
async function metadata(api, target) {
  const { repository, path, ref } = parse(target);
  const folder = path === "" ? "" : `${path}/`;
  for (const name of ["action.yml", "action.yaml"]) {
    try {
      const file = await api.get(
        `/repos/${repository}/contents/${folder}${name}?ref=${ref}`,
      );
      return Buffer.from(file.content, "base64").toString("utf8");
    } catch (error) {
      if (!(error instanceof GitHubError)) {
        throw error;
      }
      if (error.status !== 404) {
        throw new Refusal(`${error.message}, for the action.yml of ${target}`);
      }
    }
  }
  throw new Refusal(`${target} has no action.yml at its ref`);
}

/**
 * Read what each allowed action of the workflows runs itself, at the commit that
 * they pin, and in turn what each allowed action among those runs. GitHub's own
 * actions are allowed with all they run; an action that the list doesn't name is
 * the business of the workflow that uses it, which test/workflows.test.mjs checks in
 * the template, and of the policy of a copy that adds it. Says what the allowed
 * actions run, or refuses with each action that the policy would refuse: one that
 * the list misses, or one that isn't pinned to a commit.
 */
export async function checkActions({ api, workflows, list = ALLOWED }) {
  const queue = [
    ...new Set(
      workflows.flatMap((text) =>
        usesOf(text).filter(
          (target) => pinned(target) && list.includes(parse(target).repository),
        ),
      ),
    ),
  ].sort();
  if (queue.length === 0) {
    throw new Refusal(
      `No workflow runs an action of ${list.join(" or ")} pinned to a commit: correct ALLOWED in pager/actions.mjs`,
    );
  }
  const seen = new Set(queue);
  const runs = [];
  const refused = [];
  while (queue.length > 0) {
    const parent = queue.shift();
    for (const child of usesOf(await metadata(api, parent))) {
      runs.push(`${parent} runs ${child}`);
      if (!allowed(child, list)) {
        refused.push(
          `${parent} runs ${child}, which the Actions policy doesn't allow, so GitHub refuses every job that uses ${parse(parent).repository}: add ${parse(child).repository}@* to ALLOWED in pager/actions.mjs, to both pairs of commands of README.md and to the Actions policy of the template and of each copy`,
        );
      } else if (!pinned(child)) {
        refused.push(
          `${parent} runs ${child}, which isn't pinned to a commit, so the required SHA pinning of the Actions policy refuses every job that uses ${parse(parent).repository}`,
        );
      } else if (list.includes(parse(child).repository) && !seen.has(child)) {
        seen.add(child);
        queue.push(child);
      }
    }
  }
  if (refused.length > 0) {
    throw new Refusal(refused.join(". "));
  }
  const checked = [
    ...new Set([...seen].map((target) => parse(target).repository)),
  ].join(" and ");
  return runs.length === 0
    ? `${checked} run no other action.`
    : `The Actions policy allows all that ${checked} run: ${runs.join(", ")}.`;
}
