// The template of the control repository is the one source of its code: every
// control repository, that of the template's maintainer included, is made from it
// with "Use this template", and the workflow template.yml brings what changed there
// as one pull request of this repository, with PAGER_FIX_TOKEN, and tells the pager.
// The files of a repository's own, its README and the voice of its drafts, stay as
// they are, and so does every file that the template never had. A file of the
// template that a repository changed goes back to the template's: what all control
// repositories need belongs in the template, and a file kept apart in `own`. With
// `merge` on, the same run waits for the checks of its commit and merges the pull
// request once every one of them passed.
import { Refusal } from "./core.mjs";
import { LIMIT } from "./pull.mjs";

/** The settings of the template in each repository, a file of its own. */
export const SETTINGS = ".github/template.json";

/** The branch of the pull request that brings the template's changes. */
export const BRANCH = "template-sync";

/**
 * The branch on which the commit of a change comes to be, for the moments before
 * BRANCH moves to it, and which goes again right after.
 */
export const WORK = `${BRANCH}-next`;

/**
 * The mark in the description that names what the pull request takes, onto which
 * commit of the default branch, and the commit that the workflow made of it; the
 * mark of an older run names no commit of its own.
 */
const MARK =
  /<!-- template ([0-9a-f]{40}) onto ([0-9a-f]{40})(?: as ([0-9a-f]{40}))? -->/;

/**
 * How long a run with `merge` on waits for the checks of its commit: a look a
 * minute, for half an hour, which the smoke tests with Claude fit in.
 */
export const WAIT = { every: 60_000, looks: 30 };

/** The ends of a check that let a pull request merge. */
const PASSED = new Set(["success", "neutral", "skipped"]);

const COMMIT = `mutation($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) { commit { oid } }
}`;

/** The words of the report to the pager, in its languages. */
export const WORDS = {
  en: {
    title: (short) => `Template ${short}`,
    text: (template, url, count) =>
      `The template ${template} changed: the pull request ${url} takes ${count === 1 ? "one file" : `${count} files`} of it into this control repository. Merge it once its checks pass.`,
    merged: (template, url) =>
      `The template ${template} changed, and its pull request ${url} passed every check: it is merged into this control repository.`,
    failed: (template, url, names) =>
      `The pull request ${url} of the template ${template} waits for you: ${names.join(", ")} failed. Fix it, or run the checks again and then the workflow Template, which merges it once they pass.`,
    moved: (template, url) =>
      `The pull request ${url} of the template ${template} holds a commit that the workflow Template didn't make, so it doesn't merge by itself: merge it yourself once its checks pass.`,
    late: (template, url) =>
      `The checks of the pull request ${url} of the template ${template} still run after half an hour: merge it yourself once they pass, or run the workflow Template again.`,
    refused: (template, url, why) =>
      `GitHub didn't merge the pull request ${url} of the template ${template}: ${why}. Merge it yourself once its checks pass.`,
  },
  de: {
    title: (short) => `Vorlage ${short}`,
    text: (template, url, count) =>
      `Die Vorlage ${template} hat sich geändert: Der Pull Request ${url} übernimmt ${count === 1 ? "eine Datei" : `${count} Dateien`} daraus in dieses Steuer-Repository. Merge ihn, sobald seine Checks grün sind.`,
    merged: (template, url) =>
      `Die Vorlage ${template} hat sich geändert, und ihr Pull Request ${url} hat jeden Check bestanden: Er ist in dieses Steuer-Repository gemergt.`,
    failed: (template, url, names) =>
      `Der Pull Request ${url} der Vorlage ${template} wartet auf dich: ${names.join(", ")} ${names.length === 1 ? "ist" : "sind"} fehlgeschlagen. Behebe es, oder starte die Checks neu und danach den Workflow Template, der ihn merget, sobald sie grün sind.`,
    moved: (template, url) =>
      `Der Pull Request ${url} der Vorlage ${template} enthält einen Commit, den der Workflow Template nicht gemacht hat, darum merget er ihn nicht selbst: Merge ihn, sobald seine Checks grün sind.`,
    late: (template, url) =>
      `Die Checks des Pull Requests ${url} der Vorlage ${template} laufen nach einer halben Stunde noch: Merge ihn, sobald sie grün sind, oder starte den Workflow Template noch einmal.`,
    refused: (template, url, why) =>
      `GitHub hat den Pull Request ${url} der Vorlage ${template} nicht gemergt: ${why}. Merge ihn selbst, sobald seine Checks grün sind.`,
  },
};

function refuse(why) {
  throw new Refusal(why);
}

/** The first twelve characters of a commit, as GitHub shows it. */
export function short(sha) {
  return sha.slice(0, 12);
}

/**
 * The settings of a repository's template: the template as owner/name, the commit
 * of it that the repository took last, empty before the first, the files of the
 * repository's own, a path each, or a folder with a slash at its end, and `merge`,
 * true when the pull request merges by itself once its checks pass, off without it.
 */
export function settingsOf(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    refuse(`${SETTINGS} isn't JSON`);
  }
  if (
    typeof value?.template !== "string" ||
    !/^[\w.-]+\/[\w.-]+$/.test(value.template)
  ) {
    refuse(`${SETTINGS} names no template as owner/name`);
  }
  if (
    typeof value.commit !== "string" ||
    !/^(?:[0-9a-f]{40})?$/.test(value.commit)
  ) {
    refuse(`the commit of ${SETTINGS} isn't empty or a commit of git`);
  }
  if (
    !Array.isArray(value.own) ||
    !value.own.every((entry) => typeof entry === "string" && entry !== "")
  ) {
    refuse(`the own files of ${SETTINGS} aren't a list of paths`);
  }
  if (value.merge !== undefined && typeof value.merge !== "boolean") {
    refuse(`merge of ${SETTINGS} isn't true or false`);
  }
  return value;
}

/** Whether a path is a file of the repository's own, which the template leaves. */
export function isOwn(path, own) {
  return (
    path === SETTINGS ||
    own.some((entry) =>
      entry.endsWith("/") ? path.startsWith(entry) : path === entry,
    )
  );
}

/** The files of a tree of git, each path with the id of its content. */
export function filesOf(tree) {
  if (tree.truncated) {
    refuse("the tree is too large for the API of GitHub");
  }
  return new Map(
    tree.tree
      .filter((entry) => entry.type === "blob" && entry.mode !== "120000")
      .map((entry) => [entry.path, entry.sha]),
  );
}

/**
 * What a repository takes from its template: the files of the template that it
 * lacks or holds otherwise, and those that the template had at the commit taken
 * last and no longer has. The files of its own stay out of both.
 */
export function changesOf({ latest, before, here, own }) {
  const write = [...latest]
    .filter(([path, sha]) => !isOwn(path, own) && here.get(path) !== sha)
    .map(([path]) => path)
    .sort();
  const remove = [...before.keys()]
    .filter((path) => !latest.has(path) && here.has(path) && !isOwn(path, own))
    .sort();
  return { write, remove };
}

/** The description of the pull request, with the mark of what it takes. */
export function pullBody({
  template,
  commit,
  latest,
  head,
  made,
  merge,
  changes,
}) {
  const since =
    commit === ""
      ? `[${short(latest)}](https://github.com/${template}/commit/${latest})`
      : `[${short(commit)}...${short(latest)}](https://github.com/${template}/compare/${commit}...${latest})`;
  const list = [
    ...changes.write.map((path) => `- \`${path}\``),
    ...changes.remove.map((path) => `- \`${path}\` (deleted)`),
  ].join("\n");
  return [
    `The template [${template}](https://github.com/${template}) changed, ${since}, and this pull request takes its files into this control repository:`,
    "",
    list,
    "",
    `The files of this repository's own, which \`own\` of \`${SETTINGS}\` lists, stay as they are. A file of the template that this repository changed goes back to the template's here: change it in the template, or list it in \`own\` to keep it apart.`,
    "",
    merge
      ? `Made by the workflow *Template*, which brings the next change of the template onto this branch as well, and merges this pull request once every check of its commit passed, since \`merge\` of \`${SETTINGS}\` is on. A commit of someone else on this branch stops that: merge it yourself then.`
      : `Made by the workflow *Template*, which brings the next change of the template onto this branch as well. Merge it once its checks pass, or turn on \`merge\` of \`${SETTINGS}\` to have the workflow merge it.`,
    "",
    `<!-- template ${latest} onto ${head} as ${made} -->`,
  ].join("\n");
}

/** A file of a repository at a commit, as text, or null when it has none. */
async function fileAt(api, repo, path, ref) {
  try {
    const file = await api.get(`/repos/${repo}/contents/${path}?ref=${ref}`);
    return Buffer.from(file.content, "base64").toString("utf8");
  } catch (error) {
    if (error?.status === 404) {
      return null;
    }
    throw error;
  }
}

/** The latest commit of the default branch of a repository, with its branch. */
async function tipOf(api, repo) {
  const { default_branch: branch } = await api.get(`/repos/${repo}`);
  const ref = await api.get(`/repos/${repo}/git/ref/heads/${branch}`);
  return { branch, sha: ref.object.sha };
}

/** Point a branch at a commit: make it, or move the one that is there. */
async function point(api, repo, branch, sha) {
  try {
    await api.post(`/repos/${repo}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha,
    });
  } catch (error) {
    if (error?.status !== 422) {
      throw error;
    }
    await api.json("PATCH", `/repos/${repo}/git/refs/heads/${branch}`, {
      sha,
      force: true,
    });
  }
}

/** The files of a repository at a commit. */
async function treeOf(api, repo, sha) {
  return filesOf(await api.get(`/repos/${repo}/git/trees/${sha}?recursive=1`));
}

/** The address of the last page in a header Link of GitHub, or null. */
export function lastPage(link) {
  return (
    /<[^>]*[?&]page=(\d+)[^>]*>;\s*rel="last"/.exec(link ?? "")?.[1] ?? null
  );
}

/**
 * The files of the template at the commit that a repository was made from, before
 * its first take: "Use this template" copies the tree of the template's latest
 * commit into the repository's first commit, so the template's newest commit up
 * to that date with the same tree is it. An empty map when none has that tree.
 */
async function originOf(api, repo, here, template, source) {
  const path = `/repos/${repo}/commits?sha=${here.branch}&per_page=1`;
  const response = await api.request("GET", path);
  const last = lastPage(response.headers.get("link"));
  const [root] =
    last === null
      ? await response.json()
      : await api.get(`${path}&page=${last}`);
  const until = encodeURIComponent(root.commit.committer.date);
  const commits = await api.get(
    `/repos/${template}/commits?sha=${source.branch}&until=${until}&per_page=100`,
  );
  const match = commits.find(
    (entry) => entry.commit.tree.sha === root.commit.tree.sha,
  );
  return match === undefined ? new Map() : treeOf(api, template, match.sha);
}

/**
 * Find what the template of a repository changed, and bring it as one pull request
 * when `write` is true. Returns the state, `current`, `waiting` (changes and no
 * right to write them), `open` (its pull request takes them already), `opened` or
 * `updated`, with the changes, the commit of the template, `merge` of the settings,
 * and the pull request: its address, its number and the commit that the workflow
 * made of it, null for a pull request of an older run, whose mark names none.
 */
export async function takeTemplate({ api, repo, write }) {
  const here = await tipOf(api, repo);
  const text = await fileAt(api, repo, SETTINGS, here.sha);
  if (text === null) {
    refuse(`${repo} has no ${SETTINGS}, which names its template`);
  }
  const settings = settingsOf(text);
  const { template, commit } = settings;
  if (template.toLowerCase() === repo.toLowerCase()) {
    return { state: "template", template };
  }
  const source = await tipOf(api, template);
  const latest = await treeOf(api, template, source.sha);
  let before = new Map();
  if (commit === "") {
    before = await originOf(api, repo, here, template, source);
  } else {
    before = await treeOf(api, template, commit).catch((error) => {
      // A commit that the template no longer has: only its deletions are lost.
      if (error?.status === 404 || error?.status === 422) {
        return new Map();
      }
      throw error;
    });
  }
  const theirs = await fileAt(api, template, SETTINGS, source.sha);
  const own = [
    ...settings.own,
    ...(theirs === null ? [] : settingsOf(theirs).own),
  ];
  const changes = changesOf({
    latest,
    before,
    here: await treeOf(api, repo, here.sha),
    own,
  });
  const found = {
    template,
    commit: source.sha,
    merge: settings.merge === true,
    changes,
  };
  if (changes.write.length + changes.remove.length === 0) {
    return { state: "current", ...found };
  }
  if (!write) {
    return { state: "waiting", ...found };
  }
  const owner = repo.split("/")[0];
  const [open] = await api.get(
    `/repos/${repo}/pulls?head=${owner}:${BRANCH}&state=open`,
  );
  const marked = MARK.exec(open?.body ?? "");
  if (marked?.[1] === source.sha && marked[2] === here.sha) {
    return {
      state: "open",
      url: open.html_url,
      number: open.number,
      made: marked[3] ?? null,
      ...found,
    };
  }
  if (changes.write.length + changes.remove.length > LIMIT.files) {
    refuse(`the template changed more than ${LIMIT.files} files`);
  }
  const additions = [];
  let bytes = 0;
  for (const path of changes.write) {
    const blob = await api.get(
      `/repos/${template}/git/blobs/${latest.get(path)}`,
    );
    bytes += blob.size;
    additions.push({ path, contents: blob.content.replace(/\s/g, "") });
  }
  if (bytes > LIMIT.bytes) {
    refuse("the template changed more than 5 MB");
  }
  const settled = `${JSON.stringify({ ...settings, commit: source.sha }, null, 2)}\n`;
  additions.push({
    path: SETTINGS,
    contents: Buffer.from(settled).toString("base64"),
  });
  // The commit comes to be on a branch of its own, on the default branch, and the
  // branch of the pull request moves to it in one step. Moved back to the default
  // branch first, even for a moment, the head of an open pull request would have
  // no commit of its own, and GitHub would close the pull request for good.
  const title = `chore: take the template up to ${short(source.sha)}`;
  let made;
  await point(api, repo, WORK, here.sha);
  try {
    const commit = await api.graphql(COMMIT, {
      input: {
        branch: { repositoryNameWithOwner: repo, branchName: WORK },
        expectedHeadOid: here.sha,
        message: { headline: title, body: `From ${template}.` },
        fileChanges: {
          additions,
          deletions: changes.remove.map((path) => ({ path })),
        },
      },
    });
    made = commit.createCommitOnBranch.commit.oid;
    await point(api, repo, BRANCH, made);
  } finally {
    // A branch left over, should GitHub refuse to delete it, starts the next run
    // again from the default branch, so it fails no run.
    await api
      .request("DELETE", `/repos/${repo}/git/refs/heads/${WORK}`)
      .catch(() => null);
  }
  const body = pullBody({
    template,
    commit,
    latest: source.sha,
    head: here.sha,
    made,
    merge: found.merge,
    changes,
  });
  if (open !== undefined) {
    // Open again, should someone have closed it since: a pull request that GitHub
    // won't open again, merged meanwhile, gives way to a new one.
    const again = await api
      .json("PATCH", `/repos/${repo}/pulls/${open.number}`, {
        title,
        body,
        state: "open",
      })
      .catch((error) => {
        if (error?.status !== 422) {
          throw error;
        }
        return null;
      });
    if (again?.state === "open") {
      const url = again.html_url;
      return { state: "updated", url, number: open.number, made, ...found };
    }
  }
  const pull = await api.post(`/repos/${repo}/pulls`, {
    title,
    head: BRANCH,
    base: here.branch,
    body,
  });
  const { html_url: url, number } = pull;
  return { state: "opened", url, number, made, ...found };
}

/**
 * Where the checks of a pull request of the template stand, at one look: `closed`
 * (merged or closed meanwhile), `moved` (its head isn't the commit that the
 * workflow made), `pending` (no run yet, or one that hasn't ended), `failed` with
 * the names of what failed, or `passed`. Every workflow run and every check run of
 * the commit counts, those of a workflow of the repository's own too.
 */
export async function checksOf({ api, repo, number, made }) {
  const pull = await api.get(`/repos/${repo}/pulls/${number}`);
  if (pull.state !== "open") {
    return { state: "closed" };
  }
  if (made === null || pull.head.sha !== made) {
    return { state: "moved" };
  }
  const { workflow_runs: runs } = await api.get(
    `/repos/${repo}/actions/runs?head_sha=${made}&per_page=100`,
  );
  const { check_runs: checks } = await api.get(
    `/repos/${repo}/commits/${made}/check-runs?per_page=100`,
  );
  const all = [...runs, ...checks];
  if (runs.length === 0 || all.some((entry) => entry.status !== "completed")) {
    return { state: "pending" };
  }
  const failed = [
    ...new Set(
      all
        .filter((entry) => !PASSED.has(entry.conclusion))
        .map((entry) => entry.name),
    ),
  ];
  if (failed.length > 0) {
    return { state: "failed", failed };
  }
  return { state: "passed", title: pull.title };
}

/**
 * Wait for the checks of the pull request that takeTemplate brought, and merge it
 * with a squash once every one passed: with `merger`, PAGER_FIX_TOKEN, since only a
 * token with Workflows may merge a change of a workflow, and only while its head is
 * still the commit that the workflow made, which GitHub checks once more as it
 * merges. A private repository on GitHub Free has no ruleset that would hold a red
 * pull request, so this is what holds it. Returns the state of checksOf, `late`
 * when its checks still run at the end of the wait, `merged`, or `refused` with
 * GitHub's reason.
 */
export async function settle({ api, merger, repo, number, made, sleep }) {
  let checks;
  for (let look = 1; look <= WAIT.looks; look += 1) {
    // Wait before the first look as well: GitHub registers the runs of a new head
    // one by one, and a look right away could find only a run that ended at once
    // (all its jobs skipped) and take the commit for passed before Tests exists.
    await sleep(WAIT.every);
    checks = await checksOf({ api, repo, number, made });
    if (checks.state !== "pending") {
      break;
    }
  }
  if (checks.state === "pending") {
    return { state: "late" };
  }
  if (checks.state !== "passed") {
    return checks;
  }
  try {
    await merger.json("PUT", `/repos/${repo}/pulls/${number}/merge`, {
      sha: made,
      merge_method: "squash",
      commit_title: `${checks.title} (#${number})`,
    });
  } catch (error) {
    if (![405, 409, 422].includes(error?.status)) {
      throw error;
    }
    return { state: "refused", why: error.detail };
  }
  return { state: "merged" };
}

/** The summary of a run, as Markdown. */
export function summaryOf(result) {
  if (result.state === "template") {
    return "### The template\n\nThis is the template itself: it takes nothing.\n";
  }
  const { template, commit, changes } = result;
  const rows = [
    ...changes.write.map((path) => `| \`${path}\` | changed |`),
    ...changes.remove.map((path) => `| \`${path}\` | deleted |`),
  ];
  const where = `${template} at ${short(commit)}`;
  if (rows.length === 0) {
    return `### The template\n\nThis repository has every file of ${where}.\n`;
  }
  const pull =
    result.url === undefined ? "" : `\n\nThe pull request: ${result.url}`;
  return `### The template\n\nWhat ${where} brings:${pull}\n\n| File | Change |\n| --- | --- |\n${rows.join("\n")}\n`;
}

/**
 * The report of a new or changed pull request of the template, for the pager, or,
 * with `outcome`, the end of the wait of settle for its checks.
 */
export function reportOf(result, language, outcome) {
  const words = WORDS[language] ?? WORDS.en;
  const count = result.changes.write.length + result.changes.remove.length;
  const { template, url } = result;
  const text = {
    none: () => words.text(template, url, count),
    merged: () => words.merged(template, url),
    failed: () => words.failed(template, url, outcome.failed),
    moved: () => words.moved(template, url),
    late: () => words.late(template, url),
    refused: () => words.refused(template, url, outcome.why),
  }[outcome?.state ?? "none"]();
  return { type: "report", title: words.title(short(result.commit)), text };
}
