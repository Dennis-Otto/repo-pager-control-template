// The template of the control repository is the one source of its code: every
// control repository, that of the template's maintainer included, is made from it
// with "Use this template", and the workflow template.yml brings what changed there
// as one pull request of this repository, with PAGER_FIX_TOKEN, and tells the pager.
// The files of a repository's own, its README and the voice of its drafts, stay as
// they are, and so does every file that the template never had. A file of the
// template that a repository changed goes back to the template's: what all control
// repositories need belongs in the template, and a file kept apart in `own`.
import { Refusal } from "./core.mjs";
import { LIMIT } from "./pull.mjs";

/** The settings of the template in each repository, a file of its own. */
export const SETTINGS = ".github/template.json";

/** The branch of the pull request that brings the template's changes. */
export const BRANCH = "template-sync";

/** The mark in the description that names what the pull request takes. */
const MARK = /<!-- template ([0-9a-f]{40}) onto ([0-9a-f]{40}) -->/;

const COMMIT = `mutation($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) { commit { oid } }
}`;

/** The words of the report to the pager, in its languages. */
export const WORDS = {
  en: {
    title: (short) => `Template ${short}`,
    text: (template, url, count) =>
      `The template ${template} changed: the pull request ${url} takes ${count === 1 ? "one file" : `${count} files`} of it into this control repository. Merge it once its checks pass.`,
  },
  de: {
    title: (short) => `Vorlage ${short}`,
    text: (template, url, count) =>
      `Die Vorlage ${template} hat sich geändert: Der Pull Request ${url} übernimmt ${count === 1 ? "eine Datei" : `${count} Dateien`} daraus in dieses Steuer-Repository. Merge ihn, sobald seine Checks grün sind.`,
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
 * of it that the repository took last, empty before the first, and the files of
 * the repository's own, a path each, or a folder with a slash at its end.
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
export function pullBody({ template, commit, latest, head, changes }) {
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
    `Made by the workflow *Template*, which brings the next change of the template onto this branch as well.`,
    "",
    `<!-- template ${latest} onto ${head} -->`,
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

/** The files of a repository at a commit. */
async function treeOf(api, repo, sha) {
  return filesOf(await api.get(`/repos/${repo}/git/trees/${sha}?recursive=1`));
}

/**
 * Find what the template of a repository changed, and bring it as one pull request
 * when `write` is true. Returns the state, `current`, `waiting` (changes and no
 * right to write them), `open` (its pull request takes them already), `opened` or
 * `updated`, with the changes, the commit of the template and the pull request.
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
  if (commit !== "") {
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
  const found = { template, commit: source.sha, changes };
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
    return { state: "open", url: open.html_url, ...found };
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
  try {
    await api.post(`/repos/${repo}/git/refs`, {
      ref: `refs/heads/${BRANCH}`,
      sha: here.sha,
    });
  } catch (error) {
    if (error?.status !== 422) {
      throw error;
    }
    // The branch of an earlier change: it starts again from the default branch.
    await api.json("PATCH", `/repos/${repo}/git/refs/heads/${BRANCH}`, {
      sha: here.sha,
      force: true,
    });
  }
  const title = `chore: take the template up to ${short(source.sha)}`;
  await api.graphql(COMMIT, {
    input: {
      branch: { repositoryNameWithOwner: repo, branchName: BRANCH },
      expectedHeadOid: here.sha,
      message: { headline: title, body: `From ${template}.` },
      fileChanges: {
        additions,
        deletions: changes.remove.map((path) => ({ path })),
      },
    },
  });
  const body = pullBody({
    template,
    commit,
    latest: source.sha,
    head: here.sha,
    changes,
  });
  if (open !== undefined) {
    await api.json("PATCH", `/repos/${repo}/pulls/${open.number}`, {
      title,
      body,
    });
    return { state: "updated", url: open.html_url, ...found };
  }
  const pull = await api.post(`/repos/${repo}/pulls`, {
    title,
    head: BRANCH,
    base: here.branch,
    body,
  });
  return { state: "opened", url: pull.html_url, ...found };
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

/** The report of a new or changed pull request of the template, for the pager. */
export function reportOf(result, language) {
  const words = WORDS[language] ?? WORDS.en;
  const count = result.changes.write.length + result.changes.remove.length;
  return {
    type: "report",
    title: words.title(short(result.commit)),
    text: words.text(result.template, result.url, count),
  };
}
