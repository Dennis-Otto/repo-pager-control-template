// The template of the control repository: what a repository takes from it, the
// pull request that brings it, and the report to the pager, against a simulated
// GitHub that records each call.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { Refusal } from "../pager/core.mjs";
import { GitHub, GitHubError } from "../pager/github.mjs";
import { main } from "../pager/job.mjs";
import {
  BRANCH,
  changesOf,
  checksOf,
  filesOf,
  isOwn,
  lastPage,
  pullBody,
  reportOf,
  SETTINGS,
  settingsOf,
  settle,
  summaryOf,
  takeTemplate,
  WAIT,
  WORK,
} from "../pager/template.mjs";
import { json, Net } from "./fake.mjs";

const TEMPLATE = "Dennis-Otto/repo-pager-control-template";
const HOME = "monalisa/repo-pager-control";
const sha = (letter) => letter.repeat(40);
const HEAD = sha("a");
const OLD = sha("b");
const LATEST = sha("c");
const MADE = sha("d");

const base64 = (text) => Buffer.from(text).toString("base64");
const settings = (fields = {}) =>
  `${JSON.stringify({ template: TEMPLATE, commit: OLD, own: ["README.md"], ...fields }, null, 2)}\n`;
const tree = (files) => ({
  truncated: false,
  tree: Object.entries(files).map(([path, id]) => ({
    path,
    mode: "100644",
    type: "blob",
    sha: id,
  })),
});

/** The files of the template now, at the commit taken last, and here. */
const LATEST_FILES = {
  "pager/core.mjs": "core2",
  "pager/new.mjs": "new1",
  "README.md": "readme-template",
  "pager/voice.md": "voice-template",
  [SETTINGS]: "settings-template",
};
const OLD_FILES = {
  "pager/core.mjs": "core1",
  "pager/gone.mjs": "gone1",
  "pager/kept.mjs": "kept1",
  "README.md": "readme-template",
};
const HERE_FILES = {
  "pager/core.mjs": "core1",
  "pager/gone.mjs": "gone1",
  "README.md": "readme-mine",
  "pager/voice.md": "voice-mine",
  "pager/mine.mjs": "mine1",
  [SETTINGS]: "settings-mine",
};

function github({
  here = settings(),
  theirs = settings({ commit: "", own: ["pager/voice.md"] }),
  latestFiles = LATEST_FILES,
  oldTree = () => json(tree(OLD_FILES)),
  open = [],
  ref = () => json({}, 201),
} = {}) {
  const net = new Net()
    .on("GET", `/repos/${HOME}`, () => json({ default_branch: "main" }))
    .on("GET", `/repos/${HOME}/git/ref/heads/main`, () =>
      json({ object: { sha: HEAD } }),
    )
    .on("GET", `/repos/${TEMPLATE}`, () => json({ default_branch: "main" }))
    .on("GET", `/repos/${TEMPLATE}/git/ref/heads/main`, () =>
      json({ object: { sha: LATEST } }),
    )
    .on("GET", `/repos/${HOME}/git/trees/${HEAD}?recursive=1`, () =>
      json(tree(HERE_FILES)),
    )
    .on("GET", `/repos/${TEMPLATE}/git/trees/${LATEST}?recursive=1`, () =>
      json(tree(latestFiles)),
    )
    .on("GET", `/repos/${TEMPLATE}/git/trees/${OLD}?recursive=1`, oldTree)
    .on("GET", /\/git\/blobs\//, (call) => {
      const id = call.url.split("/").at(-1);
      return json({ content: `${base64(`<${id}>`)}\n`, size: id.length + 2 });
    })
    .on("GET", `/repos/${HOME}/pulls?head=monalisa:${BRANCH}&state=open`, () =>
      json(open),
    )
    .on("POST", `/repos/${HOME}/git/refs`, ref)
    .on("PATCH", `/repos/${HOME}/git/refs/heads/${BRANCH}`, () => json({}))
    .on("PATCH", `/repos/${HOME}/git/refs/heads/${WORK}`, () => json({}))
    .on("DELETE", `/repos/${HOME}/git/refs/heads/${WORK}`, () =>
      Response.json(null, { status: 204 }),
    )
    .on("POST", "/graphql", () =>
      json({ data: { createCommitOnBranch: { commit: { oid: MADE } } } }),
    )
    .on("POST", `/repos/${HOME}/pulls`, () =>
      json({ number: 8, html_url: `https://github.com/${HOME}/pull/8` }, 201),
    )
    .on("PATCH", `/repos/${HOME}/pulls/7`, () =>
      json({
        number: 7,
        state: "open",
        html_url: `https://github.com/${HOME}/pull/7`,
      }),
    );
  if (here !== null) {
    net.on("GET", `/repos/${HOME}/contents/${SETTINGS}?ref=${HEAD}`, () =>
      json({ content: base64(here) }),
    );
  }
  if (theirs !== null) {
    net.on("GET", `/repos/${TEMPLATE}/contents/${SETTINGS}?ref=${LATEST}`, () =>
      json({ content: base64(theirs) }),
    );
  }
  return net;
}

/**
 * GitHub as it treats the open pull request 7 of BRANCH: a head moved to a commit
 * that the base has already, the tip of the default branch, closes it, and it
 * won't open again while its head has no commit of its own.
 */
function closing(net) {
  const pull = { head: sha("e"), state: "open" };
  const answer = () =>
    json({
      number: 7,
      state: pull.state,
      html_url: `https://github.com/${HOME}/pull/7`,
    });
  net
    .on("PATCH", `/repos/${HOME}/git/refs/heads/${BRANCH}`, (call) => {
      pull.head = call.body.sha;
      if (pull.head === HEAD) {
        pull.state = "closed";
      }
      return json({});
    })
    .on("PATCH", `/repos/${HOME}/pulls/7`, (call) => {
      if (call.body.state === "open" && pull.state === "closed") {
        if (pull.head === HEAD) {
          return json({ message: "Validation Failed" }, 422);
        }
        pull.state = "open";
      }
      return answer();
    });
  return pull;
}

const take = (net, write = true) =>
  takeTemplate({ api: new GitHub("t", net.fetch), repo: HOME, write });

/** What the repository takes from the world of github() by default. */
const CHANGES = {
  write: ["pager/core.mjs", "pager/new.mjs"],
  remove: ["pager/gone.mjs"],
};

describe("the settings of the template", () => {
  it("names the template, the commit taken last and the files of its own", () => {
    assert.deepEqual(settingsOf(settings()), {
      template: TEMPLATE,
      commit: OLD,
      own: ["README.md"],
    });
    assert.equal(settingsOf(settings({ commit: "" })).commit, "");
    assert.equal(settingsOf(settings({ merge: true })).merge, true);
  });

  it("refuses what isn't settings", () => {
    for (const [text, why] of [
      ["{", /isn't JSON/],
      ["null", /names no template/],
      [settings({ template: "repo-pager-control-template" }), /no template/],
      [settings({ commit: "main" }), /isn't empty or a commit/],
      [settings({ commit: 5 }), /isn't empty or a commit/],
      [settings({ own: "README.md" }), /aren't a list of paths/],
      [settings({ own: [""] }), /aren't a list of paths/],
      [settings({ merge: "yes" }), /merge of .* isn't true or false/],
    ]) {
      assert.throws(
        () => settingsOf(text),
        (error) => error instanceof Refusal && why.test(error.message),
      );
    }
  });

  it("keeps the files of its own, by path or by folder, and the settings themselves", () => {
    const own = ["README.md", "notes/"];
    assert.equal(isOwn("README.md", own), true);
    assert.equal(isOwn("notes/a.md", own), true);
    assert.equal(isOwn(SETTINGS, []), true);
    assert.equal(isOwn("pager/core.mjs", own), false);
    assert.equal(isOwn("README.md.bak", own), false);
  });

  it("keeps the files for the template's contributors out of every copy", async () => {
    // A copy needs neither the guide of contributing nor the issue forms nor the
    // template of a pull request: `own` of the template lists each that is here.
    const root = new URL("../", import.meta.url);
    const { own } = settingsOf(await readFile(new URL(SETTINGS, root), "utf8"));
    const paths = [
      "CONTRIBUTING.md",
      ".github/pull_request_template.md",
      ...(
        await readdir(new URL(".github/ISSUE_TEMPLATE/", root)).catch(() => [])
      ).map((name) => `.github/ISSUE_TEMPLATE/${name}`),
    ];
    for (const path of paths) {
      if (existsSync(new URL(path, root))) {
        assert.ok(isOwn(path, own), `${path} isn't in own of ${SETTINGS}`);
      }
    }
  });
});

describe("what a repository takes", () => {
  it("reads the files of a tree, without folders and links", () => {
    const files = filesOf({
      truncated: false,
      tree: [
        { path: "pager", mode: "040000", type: "tree", sha: "t" },
        { path: "pager/a.mjs", mode: "100644", type: "blob", sha: "1" },
        { path: "run.sh", mode: "100755", type: "blob", sha: "2" },
        { path: "link", mode: "120000", type: "blob", sha: "3" },
      ],
    });
    assert.deepEqual(
      [...files],
      [
        ["pager/a.mjs", "1"],
        ["run.sh", "2"],
      ],
    );
    assert.throws(
      () => filesOf({ truncated: true, tree: [] }),
      /too large for the API/,
    );
  });

  it("takes the changed and new files and deletes the gone ones, never its own", () => {
    assert.deepEqual(
      changesOf({
        latest: new Map(Object.entries(LATEST_FILES)),
        before: new Map(Object.entries(OLD_FILES)),
        here: new Map(Object.entries(HERE_FILES)),
        own: ["README.md", "pager/voice.md"],
      }),
      CHANGES,
    );
    // Without its own files, the template's README and voice come as well, and a
    // file that the template deleted goes only when the repository has it.
    assert.deepEqual(
      changesOf({
        latest: new Map(Object.entries(LATEST_FILES)),
        before: new Map(Object.entries(OLD_FILES)),
        here: new Map(Object.entries(HERE_FILES)),
        own: [],
      }),
      {
        write: [
          "README.md",
          "pager/core.mjs",
          "pager/new.mjs",
          "pager/voice.md",
        ],
        remove: ["pager/gone.mjs"],
      },
    );
    assert.deepEqual(
      changesOf({
        latest: new Map(),
        before: new Map([["pager/gone.mjs", "1"]]),
        here: new Map([["pager/gone.mjs", "1"]]),
        own: ["pager/"],
      }),
      { write: [], remove: [] },
    );
  });

  it("describes the pull request with what it takes, and its mark", () => {
    const body = pullBody({
      template: TEMPLATE,
      commit: OLD,
      latest: LATEST,
      head: HEAD,
      made: MADE,
      merge: false,
      changes: CHANGES,
    });
    assert.match(
      body,
      new RegExp(
        `\\[bbbbbbbbbbbb\\.\\.\\.cccccccccccc\\]\\(https://github.com/${TEMPLATE}/compare/${OLD}\\.\\.\\.${LATEST}\\)`,
      ),
    );
    assert.match(body, /- `pager\/core.mjs`\n- `pager\/new.mjs`\n/);
    assert.match(body, /- `pager\/gone.mjs` \(deleted\)/);
    assert.match(body, /list it in `own` to keep it apart/);
    assert.match(
      body,
      new RegExp(`<!-- template ${LATEST} onto ${HEAD} as ${MADE} -->$`),
    );
    assert.match(body, /Merge it once its checks pass/);
    assert.match(
      pullBody({
        template: TEMPLATE,
        commit: OLD,
        latest: LATEST,
        head: HEAD,
        made: MADE,
        merge: true,
        changes: CHANGES,
      }),
      /merges this pull request once every check of its commit passed/,
    );
    assert.match(
      pullBody({
        template: TEMPLATE,
        commit: "",
        latest: LATEST,
        head: HEAD,
        changes: CHANGES,
      }),
      new RegExp(
        `\\[cccccccccccc\\]\\(https://github.com/${TEMPLATE}/commit/${LATEST}\\)`,
      ),
    );
  });
});

describe("the pull request of the template", () => {
  it("opens one with a signed commit of the changes and the commit it took", async () => {
    const net = github();
    const result = await take(net);
    assert.deepEqual(result, {
      state: "opened",
      url: `https://github.com/${HOME}/pull/8`,
      number: 8,
      made: MADE,
      template: TEMPLATE,
      commit: LATEST,
      merge: false,
      changes: CHANGES,
    });
    assert.deepEqual(
      net.to(`/repos/${HOME}/git/refs`).map((call) => call.body),
      [
        { ref: `refs/heads/${WORK}`, sha: HEAD },
        { ref: `refs/heads/${BRANCH}`, sha: MADE },
      ],
    );
    assert.deepEqual(
      net.to(`/git/refs/heads/${WORK}`).map((call) => call.method),
      ["DELETE"],
    );
    const { input } = net.to("/graphql")[0].body.variables;
    assert.deepEqual(input.branch, {
      repositoryNameWithOwner: HOME,
      branchName: WORK,
    });
    assert.equal(input.expectedHeadOid, HEAD);
    assert.equal(
      input.message.headline,
      "chore: take the template up to cccccccccccc",
    );
    assert.deepEqual(input.fileChanges.additions.slice(0, 2), [
      { path: "pager/core.mjs", contents: base64("<core2>") },
      { path: "pager/new.mjs", contents: base64("<new1>") },
    ]);
    const written = input.fileChanges.additions[2];
    assert.equal(written.path, SETTINGS);
    assert.deepEqual(
      JSON.parse(Buffer.from(written.contents, "base64").toString()),
      { template: TEMPLATE, commit: LATEST, own: ["README.md"] },
    );
    assert.deepEqual(input.fileChanges.deletions, [{ path: "pager/gone.mjs" }]);
    const pull = net.to(`/repos/${HOME}/pulls`)[0].body;
    assert.equal(pull.head, BRANCH);
    assert.equal(pull.base, "main");
    assert.match(
      pull.body,
      new RegExp(`<!-- template ${LATEST} onto ${HEAD} as ${MADE} -->`),
    );
    assert.match(
      pull.body,
      /Merge it once its checks pass, or turn on `merge`/,
    );
  });

  it("brings a newer change onto the branch and the pull request that are open", async () => {
    const net = github({
      open: [
        {
          number: 7,
          html_url: `https://github.com/${HOME}/pull/7`,
          body: `<!-- template ${OLD} onto ${HEAD} -->`,
        },
      ],
      ref: () => json({ message: "Reference already exists" }, 422),
    });
    const pull = closing(net);
    const result = await take(net);
    assert.equal(result.state, "updated");
    assert.equal(result.url, `https://github.com/${HOME}/pull/7`);
    assert.equal(result.number, 7);
    assert.equal(result.made, MADE);
    assert.deepEqual(pull, { head: MADE, state: "open" });
    assert.deepEqual(
      net.to(`/git/refs/heads/${BRANCH}`).map((call) => call.body),
      [{ sha: MADE, force: true }],
    );
    assert.deepEqual(
      net.to(`/git/refs/heads/${WORK}`).map((call) => [call.method, call.body]),
      [
        ["PATCH", { sha: HEAD, force: true }],
        ["DELETE", undefined],
      ],
    );
    const patched = net.to(`/repos/${HOME}/pulls/7`)[0].body;
    assert.equal(patched.title, "chore: take the template up to cccccccccccc");
    assert.equal(patched.state, "open");
    assert.equal(net.to(`/repos/${HOME}/pulls`).length, 0);
  });

  it("opens the pull request again that someone closed meanwhile", async () => {
    const net = github({
      open: [{ number: 7, body: `<!-- template ${OLD} onto ${HEAD} -->` }],
      ref: () => json({ message: "Reference already exists" }, 422),
    });
    const pull = closing(net);
    pull.state = "closed";
    const result = await take(net);
    assert.equal(result.state, "updated");
    assert.equal(result.url, `https://github.com/${HOME}/pull/7`);
    assert.equal(pull.state, "open");
  });

  it("opens a new pull request when GitHub won't open the old one again", async () => {
    const open = [{ number: 7, body: `<!-- template ${OLD} onto ${HEAD} -->` }];
    const merged = github({ open }).on("PATCH", `/repos/${HOME}/pulls/7`, () =>
      json({ message: "Validation Failed" }, 422),
    );
    const result = await take(merged);
    assert.equal(result.state, "opened");
    assert.equal(result.url, `https://github.com/${HOME}/pull/8`);
    assert.equal(merged.to(`/repos/${HOME}/pulls`)[0].body.head, BRANCH);
    const closed = github({ open }).on("PATCH", `/repos/${HOME}/pulls/7`, () =>
      json({ number: 7, state: "closed" }),
    );
    assert.equal((await take(closed)).state, "opened");
    const refused = github({ open }).on("PATCH", `/repos/${HOME}/pulls/7`, () =>
      json({ message: "Resource not accessible" }, 403),
    );
    await assert.rejects(take(refused), { status: 403 });
  });

  it("deletes the branch of its commit also when the commit fails", async () => {
    const net = github().on("POST", "/graphql", () =>
      json({ errors: [{ message: "Expected head is outdated" }] }),
    );
    await assert.rejects(take(net), { message: /Expected head is outdated/ });
    assert.deepEqual(
      net.to(`/git/refs/heads/${WORK}`).map((call) => call.method),
      ["DELETE"],
    );
    assert.equal(net.to(`/repos/${HOME}/git/refs`).length, 1);
    const kept = github().on(
      "DELETE",
      `/repos/${HOME}/git/refs/heads/${WORK}`,
      () => json({ message: "Reference does not exist" }, 422),
    );
    assert.equal((await take(kept)).state, "opened");
  });

  it("brings the same change again when the default branch moved on", async () => {
    const net = github({
      open: [
        {
          number: 7,
          html_url: `https://github.com/${HOME}/pull/7`,
          body: `<!-- template ${LATEST} onto ${OLD} -->`,
        },
      ],
      ref: () => json({ message: "Reference already exists" }, 422),
    });
    assert.equal((await take(net)).state, "updated");
  });

  it("leaves a pull request alone that takes the change already", async () => {
    const net = github({
      open: [
        {
          number: 7,
          html_url: `https://github.com/${HOME}/pull/7`,
          body: `Takes it.\n\n<!-- template ${LATEST} onto ${HEAD} -->`,
        },
      ],
    });
    const result = await take(net);
    assert.equal(result.state, "open");
    assert.equal(result.url, `https://github.com/${HOME}/pull/7`);
    // The mark of an older run names no commit of its own.
    assert.equal(result.made, null);
    assert.equal(net.to("/graphql").length, 0);
    assert.equal(net.to(`/repos/${HOME}/git/refs`).length, 0);
  });

  it("finds the changes without writing them when it has no right to", async () => {
    const net = github();
    const result = await take(net, false);
    assert.deepEqual(result, {
      state: "waiting",
      template: TEMPLATE,
      commit: LATEST,
      merge: false,
      changes: CHANGES,
    });
    assert.ok(net.calls.every((call) => call.method === "GET"));
  });

  it("is current when it has every file of the template", async () => {
    const latestFiles = {
      "pager/core.mjs": "core1",
      "README.md": "readme-template",
    };
    const net = github({ latestFiles, oldTree: () => json(tree(latestFiles)) });
    assert.deepEqual(await take(net), {
      state: "current",
      template: TEMPLATE,
      commit: LATEST,
      merge: false,
      changes: { write: [], remove: [] },
    });
  });

  it("takes nothing in the template itself", async () => {
    const net = github({ here: settings({ template: HOME }) });
    assert.deepEqual(await take(net), { state: "template", template: HOME });
  });

  it("deletes before the first take what the template lost since the copy", async () => {
    const ROOT = sha("e");
    const DATE = "2026-11-01T10:00:00Z";
    const commit = (id, tree) => ({
      sha: id,
      commit: { tree: { sha: tree }, committer: { date: DATE } },
    });
    const world = ({ link, templateCommits }) => {
      const net = github({ here: settings({ commit: "" }) });
      net
        .on("GET", `/repos/${HOME}/commits?sha=main&per_page=1`, () => {
          const headers = link === undefined ? {} : { link };
          return Response.json([commit(HEAD, "tree-head")], { headers });
        })
        .on("GET", `/repos/${HOME}/commits?sha=main&per_page=1&page=3`, () =>
          json([commit(ROOT, "tree-old")]),
        )
        .on(
          "GET",
          `/repos/${TEMPLATE}/commits?sha=main&until=${encodeURIComponent(DATE)}&per_page=100`,
          () => json(templateCommits),
        );
      return net;
    };
    const copied = await take(
      world({
        link: `<https://api.github.com/repositories/1/commits?sha=main&per_page=1&page=2>; rel="next", <https://api.github.com/repositories/1/commits?sha=main&per_page=1&page=3>; rel="last"`,
        templateCommits: [
          commit(sha("f"), "tree-new"),
          commit(OLD, "tree-old"),
        ],
      }),
    );
    assert.deepEqual(copied.changes, CHANGES);
    const unknown = await take(
      world({ templateCommits: [commit(OLD, "tree-old")] }),
    );
    assert.deepEqual(unknown.changes.remove, []);
  });

  it("reads the last page of a header Link", () => {
    assert.equal(lastPage('<https://x/y?per_page=1&page=7>; rel="last"'), "7");
    assert.equal(lastPage('<https://x/y?page=2>; rel="next"'), null);
    assert.equal(lastPage(null), null);
  });

  it("deletes nothing when the template lost the commit", async () => {
    for (const status of [404, 422]) {
      const result = await take(
        github({ oldTree: () => json({ message: "No commit" }, status) }),
      );
      assert.deepEqual(result.changes.remove, [], String(status));
    }
    await assert.rejects(
      take(github({ oldTree: () => json({ message: "Down" }, 502) })),
      GitHubError,
    );
  });

  it("keeps only the files of its own when the template names none", async () => {
    const result = await take(github({ theirs: null }), false);
    assert.deepEqual(result.changes.write, [
      "pager/core.mjs",
      "pager/new.mjs",
      "pager/voice.md",
    ]);
  });

  it("refuses a repository without settings, and passes on what GitHub refuses", async () => {
    await assert.rejects(take(github({ here: null })), {
      message: `${HOME} has no ${SETTINGS}, which names its template`,
    });
    const net = github().on(
      "GET",
      `/repos/${HOME}/contents/${SETTINGS}?ref=${HEAD}`,
      () => json({ message: "Bad credentials" }, 401),
    );
    await assert.rejects(take(net), { status: 401 });
    await assert.rejects(
      take(github({ ref: () => json({ message: "No workflows" }, 403) })),
      { status: 403 },
    );
  });

  it("refuses a change too large for one commit", async () => {
    const many = Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [`f${index}.txt`, `x${index}`]),
    );
    await assert.rejects(take(github({ latestFiles: many })), {
      message: "the template changed more than 100 files",
    });
    const net = github().on("GET", /\/git\/blobs\//, () =>
      json({ content: base64("x"), size: 6 * 1024 * 1024 }),
    );
    await assert.rejects(take(net), {
      message: "the template changed more than 5 MB",
    });
  });
});

/**
 * GitHub as it shows the checks of the pull request 8 of the template: its state,
 * its head, and the workflow runs and the check runs of its commit, each look a
 * value of the lists, the last one staying; and the merge that it answers.
 */
function checking(
  net,
  {
    pull = { state: "open", head: { sha: MADE } },
    runs = [[{ name: "Tests", status: "completed", conclusion: "success" }]],
    checks = [
      [
        {
          name: "Tests, lint and workflows",
          status: "completed",
          conclusion: "success",
        },
      ],
    ],
    merge = () => json({ merged: true }),
  } = {},
) {
  let look = 0;
  const at = (list) => list[Math.min(look, list.length - 1)];
  return net
    .on("GET", `/repos/${HOME}/pulls/8`, () =>
      json({ number: 8, title: "chore: take the template up to x", ...pull }),
    )
    .on(
      "GET",
      `/repos/${HOME}/actions/runs?head_sha=${MADE}&per_page=100`,
      () => json({ workflow_runs: at(runs) }),
    )
    .on("GET", `/repos/${HOME}/commits/${MADE}/check-runs?per_page=100`, () => {
      const answer = json({ check_runs: at(checks) });
      look += 1;
      return answer;
    })
    .on("PUT", `/repos/${HOME}/pulls/8/merge`, merge);
}

describe("the merge of the pull request of the template", () => {
  const ask = (net, made = MADE) => {
    const sleeps = [];
    const settled = settle({
      api: new GitHub("read-only", net.fetch),
      merger: new GitHub("fix", net.fetch),
      repo: HOME,
      number: 8,
      made,
      sleep: async (milliseconds) => sleeps.push(milliseconds),
    });
    return settled.then((outcome) => ({ outcome, sleeps }));
  };
  const running = {
    name: "Smoke test",
    status: "in_progress",
    conclusion: null,
  };

  it("merges with a squash and PAGER_FIX_TOKEN once every check passed, only at the commit it made", async () => {
    const net = checking(new Net(), {
      runs: [
        [
          { name: "Tests", status: "completed", conclusion: "success" },
          { name: "Dependabot", status: "completed", conclusion: "skipped" },
        ],
      ],
    });
    const { outcome, sleeps } = await ask(net);
    assert.deepEqual(outcome, { state: "merged" });
    assert.deepEqual(sleeps, []);
    const [merge] = net.to("/pulls/8/merge");
    assert.equal(merge.method, "PUT");
    assert.equal(merge.headers.authorization, "Bearer fix");
    assert.deepEqual(merge.body, {
      sha: MADE,
      merge_method: "squash",
      commit_title: "chore: take the template up to x (#8)",
    });
    assert.ok(
      net.calls
        .filter((call) => call.method === "GET")
        .every((call) => call.headers.authorization === "Bearer read-only"),
    );
  });

  it("waits a minute a look while a check runs or none has started yet", async () => {
    const net = checking(new Net(), {
      runs: [
        [],
        [running],
        [{ name: "Smoke test", status: "completed", conclusion: "success" }],
      ],
      checks: [
        [],
        [],
        [{ name: "ask", status: "queued", conclusion: null }],
        [],
      ],
    });
    const { outcome, sleeps } = await ask(net);
    assert.deepEqual(outcome, { state: "merged" });
    assert.deepEqual(sleeps, [WAIT.every, WAIT.every, WAIT.every]);
  });

  it("gives up after half an hour of checks that still run", async () => {
    const net = checking(new Net(), { runs: [[running]] });
    const { outcome, sleeps } = await ask(net);
    assert.deepEqual(outcome, { state: "late" });
    assert.equal(sleeps.length, WAIT.looks - 1);
    assert.equal(WAIT.every * WAIT.looks, 30 * 60_000);
    assert.equal(net.to("/pulls/8/merge").length, 0);
  });

  it("merges nothing red and names each check that failed once", async () => {
    const net = checking(new Net(), {
      runs: [
        [
          { name: "Tests", status: "completed", conclusion: "failure" },
          { name: "Smoke test", status: "completed", conclusion: "cancelled" },
        ],
      ],
      checks: [
        [
          { name: "Tests", status: "completed", conclusion: "failure" },
          { name: "ask", status: "completed", conclusion: "neutral" },
        ],
      ],
    });
    const { outcome } = await ask(net);
    assert.deepEqual(outcome, {
      state: "failed",
      failed: ["Tests", "Smoke test"],
    });
    assert.equal(net.to("/pulls/8/merge").length, 0);
  });

  it("merges nothing whose head moved to a commit that it didn't make", async () => {
    const net = checking(new Net(), {
      pull: { state: "open", head: { sha: sha("f") } },
    });
    assert.deepEqual((await ask(net)).outcome, { state: "moved" });
    assert.deepEqual((await ask(checking(new Net()), null)).outcome, {
      state: "moved",
    });
    assert.equal(
      net.calls.filter((call) => call.url.includes("/actions/runs")).length,
      0,
    );
    assert.equal(net.to("/pulls/8/merge").length, 0);
  });

  it("stops when someone merged or closed it meanwhile", async () => {
    const net = checking(new Net(), {
      pull: { state: "closed", head: { sha: MADE } },
    });
    assert.deepEqual(
      await checksOf({
        api: new GitHub("t", net.fetch),
        repo: HOME,
        number: 8,
        made: MADE,
      }),
      { state: "closed" },
    );
  });

  it("names GitHub's reason when it won't merge, and passes on any other refusal", async () => {
    for (const status of [405, 409, 422]) {
      const net = checking(new Net(), {
        merge: () => json({ message: "Head branch was modified" }, status),
      });
      assert.deepEqual((await ask(net)).outcome, {
        state: "refused",
        why: "Head branch was modified",
      });
    }
    const net = checking(new Net(), {
      merge: () => json({ message: "Resource not accessible" }, 403),
    });
    await assert.rejects(ask(net), { status: 403 });
  });
});

describe("the summary and the report", () => {
  const result = {
    state: "opened",
    url: `https://github.com/${HOME}/pull/8`,
    template: TEMPLATE,
    commit: LATEST,
    changes: CHANGES,
  };

  it("lists what the template brings, with its pull request", () => {
    assert.equal(
      summaryOf(result),
      `### The template\n\nWhat ${TEMPLATE} at cccccccccccc brings:\n\nThe pull request: https://github.com/${HOME}/pull/8\n\n| File | Change |\n| --- | --- |\n| \`pager/core.mjs\` | changed |\n| \`pager/new.mjs\` | changed |\n| \`pager/gone.mjs\` | deleted |\n`,
    );
    assert.doesNotMatch(
      summaryOf({ ...result, state: "waiting", url: undefined }),
      /The pull request/,
    );
    assert.equal(
      summaryOf({ ...result, changes: { write: [], remove: [] } }),
      `### The template\n\nThis repository has every file of ${TEMPLATE} at cccccccccccc.\n`,
    );
    assert.match(summaryOf({ state: "template" }), /the template itself/);
  });

  it("tells the pager in its language, English unless it names German", () => {
    assert.deepEqual(reportOf(result, "en"), {
      type: "report",
      title: "Template cccccccccccc",
      text: `The template ${TEMPLATE} changed: the pull request https://github.com/${HOME}/pull/8 takes 3 files of it into this control repository. Merge it once its checks pass.`,
    });
    assert.deepEqual(reportOf(result, undefined), reportOf(result, "en"));
    const one = { ...result, changes: { write: ["a"], remove: [] } };
    assert.match(reportOf(one, "fr").text, /takes one file of it/);
    assert.deepEqual(reportOf(result, "de"), {
      type: "report",
      title: "Vorlage cccccccccccc",
      text: `Die Vorlage ${TEMPLATE} hat sich geändert: Der Pull Request https://github.com/${HOME}/pull/8 übernimmt 3 Dateien daraus in dieses Steuer-Repository. Merge ihn, sobald seine Checks grün sind.`,
    });
    assert.match(reportOf(one, "de").text, /übernimmt eine Datei daraus/);
  });

  it("tells the pager what became of a pull request that merges by itself", () => {
    const pull = `https://github.com/${HOME}/pull/8`;
    const outcomes = {
      merged: [{ state: "merged" }, /passed every check: it is merged/],
      failed: [
        { state: "failed", failed: ["Tests", "Smoke test"] },
        /waits for you: Tests, Smoke test failed\. Fix it, or run the checks again/,
      ],
      moved: [
        { state: "moved" },
        /a commit that the workflow Template didn't make/,
      ],
      late: [{ state: "late" }, /still run after half an hour/],
      refused: [
        { state: "refused", why: "Merge conflict" },
        /GitHub didn't merge the pull request .*: Merge conflict\. Merge it yourself/,
      ],
    };
    for (const [outcome, text] of Object.values(outcomes)) {
      const report = reportOf(result, "en", outcome);
      assert.equal(report.title, "Template cccccccccccc");
      assert.match(report.text, text);
      assert.ok(report.text.includes(pull));
      assert.ok(report.text.includes(TEMPLATE));
      assert.notEqual(
        reportOf(result, "de", outcome).text,
        report.text,
        outcome.state,
      );
    }
    assert.match(
      reportOf(result, "de", { state: "failed", failed: ["Tests"] }).text,
      /wartet auf dich: Tests ist fehlgeschlagen/,
    );
    assert.match(
      reportOf(result, "de", { state: "failed", failed: ["Tests", "ask"] })
        .text,
      /Tests, ask sind fehlgeschlagen/,
    );
  });
});

describe("the workflow Template", () => {
  async function run(net, fields = {}) {
    const dir = await mkdtemp(join(tmpdir(), "template-"));
    const env = {
      GITHUB_STEP_SUMMARY: join(dir, "summary"),
      GITHUB_REPOSITORY: HOME,
      GITHUB_TOKEN: "read-only",
      PAGER_FIX_TOKEN: "fix",
      PAGER_URL: "https://pager.example",
      PAGER_CONTROL_SECRET: "secret",
      PAGER_LANGUAGE: "de",
      ...fields,
    };
    await writeFile(env.GITHUB_STEP_SUMMARY, "");
    const lines = [];
    const code = await main("template", env, {
      fetch: net.fetch,
      sleep: async () => undefined,
      log: (line) => lines.push(line),
    });
    const summary = await readFile(env.GITHUB_STEP_SUMMARY, "utf8");
    return { code, lines, summary };
  }

  it("opens the pull request with PAGER_FIX_TOKEN and tells the pager, signed", async () => {
    const net = github().on("POST", "https://pager.example/control", () =>
      json({ ok: true }),
    );
    const { code, lines, summary } = await run(net);
    assert.equal(code, 0);
    assert.equal(
      lines[0],
      `The pull request https://github.com/${HOME}/pull/8 takes ${TEMPLATE} at cccccccccccc. The pager answered: {"ok":true}`,
    );
    assert.match(summary, /\| `pager\/gone.mjs` \| deleted \|/);
    assert.equal(
      net.to(`/repos/${HOME}`)[0].headers.authorization,
      "Bearer fix",
    );
    const sent = net.to("/control")[0];
    assert.equal(sent.body.type, "report");
    assert.equal(sent.body.title, "Vorlage cccccccccccc");
    assert.match(sent.headers["x-pager-signature"], /^sha256=[0-9a-f]{64}$/);
  });

  it("warns when the pager isn't set up, and keeps the pull request", async () => {
    const { code, lines } = await run(github(), {
      PAGER_URL: undefined,
      PAGER_CONTROL_SECRET: undefined,
    });
    assert.equal(code, 0);
    assert.match(lines[0], /^::warning::Not sent: the variable PAGER_URL/);
    assert.match(lines[1], /^The pull request .*\/pull\/8 takes/);
  });

  it("fails, so that GitHub tells the owner, when it may not write the changes", async () => {
    for (const fix of [undefined, ""]) {
      const net = github();
      const { code, lines, summary } = await run(net, { PAGER_FIX_TOKEN: fix });
      assert.equal(code, 1);
      assert.match(
        lines[0],
        /^::error::Dennis-Otto\/repo-pager-control-template at cccccccccccc has changes for this repository, which the summary lists: give PAGER_FIX_TOKEN this repository/,
      );
      assert.match(summary, /\| `pager\/new.mjs` \| changed \|/);
      assert.equal(
        net.to(`/repos/${HOME}`)[0].headers.authorization,
        "Bearer read-only",
      );
    }
  });

  it("says when there is nothing to take, in the template too", async () => {
    const latestFiles = { "pager/core.mjs": "core1" };
    const current = await run(
      github({ latestFiles, oldTree: () => json(tree(latestFiles)) }),
    );
    assert.equal(current.code, 0);
    assert.deepEqual(current.lines, [
      `Up to date with ${TEMPLATE} at cccccccccccc.`,
    ]);
    const itself = await run(github({ here: settings({ template: HOME }) }));
    assert.deepEqual(itself.lines, [
      "This is the template itself: it takes nothing.",
    ]);
    const open = await run(
      github({
        open: [
          {
            number: 7,
            html_url: `https://github.com/${HOME}/pull/7`,
            body: `<!-- template ${LATEST} onto ${HEAD} -->`,
          },
        ],
      }),
    );
    assert.deepEqual(open.lines, [
      `The pull request https://github.com/${HOME}/pull/7 takes ${TEMPLATE} at cccccccccccc already.`,
    ]);
  });

  // The world of github() with `merge` on, whose pull request 8 checking() shows.
  const merging = (fields = {}, checks = {}) =>
    checking(github({ here: settings({ merge: true }), ...fields }), checks).on(
      "POST",
      "https://pager.example/control",
      () => json({ ok: true }),
    );

  it("merges the pull request once its checks pass and tells the pager that alone", async () => {
    const net = merging();
    const { code, lines } = await run(net);
    assert.equal(code, 0);
    assert.equal(
      lines[0],
      `The pull request https://github.com/${HOME}/pull/8 takes ${TEMPLATE} at cccccccccccc. It passed every check and is merged. The pager answered: {"ok":true}`,
    );
    assert.match(
      net.to(`/repos/${HOME}/pulls`)[0].body.body,
      /merges this pull request once every check of its commit passed/,
    );
    assert.equal(
      net.to(`/actions/runs?head_sha=${MADE}&per_page=100`)[0].headers
        .authorization,
      "Bearer read-only",
    );
    assert.equal(
      net.to("/pulls/8/merge")[0].headers.authorization,
      "Bearer fix",
    );
    const sent = net.to("/control");
    assert.equal(sent.length, 1);
    assert.match(sent[0].body.text, /hat jeden Check bestanden/);
  });

  it("tells the pager which check failed, and leaves the pull request open", async () => {
    const net = merging(
      {},
      {
        runs: [[{ name: "Tests", status: "completed", conclusion: "failure" }]],
      },
    );
    const { code, lines } = await run(net, { PAGER_LANGUAGE: undefined });
    assert.equal(code, 0);
    assert.match(lines[0], /It waits for a person: Tests failed\./);
    assert.equal(net.to("/pulls/8/merge").length, 0);
    assert.match(
      net.to("/control")[0].body.text,
      /waits for you: Tests failed/,
    );
  });

  it("merges a pull request of an earlier run that turned green, and is quiet while it isn't", async () => {
    const open = [
      {
        number: 8,
        html_url: `https://github.com/${HOME}/pull/8`,
        body: `<!-- template ${LATEST} onto ${HEAD} as ${MADE} -->`,
      },
    ];
    const green = merging({ open });
    const merged = await run(green);
    assert.match(
      merged.lines[0],
      /takes .* at cccccccccccc\. It passed every check and is merged\. The pager answered/,
    );
    assert.equal(green.to("/graphql").length, 0);
    for (const [checks, said] of [
      [
        {
          runs: [
            [{ name: "Tests", status: "completed", conclusion: "failure" }],
          ],
        },
        "It waits for a person: Tests failed.",
      ],
      [
        { pull: { state: "closed" } },
        "It was closed or merged while its checks ran.",
      ],
      [
        { pull: { state: "open", head: { sha: sha("f") } } },
        "It waits for a person: its head is a commit that this workflow didn't make.",
      ],
      [
        {
          runs: [[{ name: "Tests", status: "queued", conclusion: null }]],
        },
        "It waits for a person: its checks still ran after half an hour.",
      ],
      [
        { merge: () => json({ message: "Merge conflict" }, 405) },
        "It waits for a person: GitHub didn't merge it: Merge conflict.",
      ],
    ]) {
      const net = merging({ open }, checks);
      const { code, lines } = await run(net);
      assert.equal(code, 0);
      assert.deepEqual(lines, [
        `The pull request https://github.com/${HOME}/pull/8 takes ${TEMPLATE} at cccccccccccc already. ${said}`,
      ]);
      assert.equal(net.to("/control").length, 0);
    }
  });

  it("is quiet about a pull request that closed while its checks ran", async () => {
    const net = merging({}, { pull: { state: "closed" } });
    const { code, lines } = await run(net);
    assert.equal(code, 0);
    assert.deepEqual(lines, [
      `The pull request https://github.com/${HOME}/pull/8 takes ${TEMPLATE} at cccccccccccc. It was closed or merged while its checks ran.`,
    ]);
    assert.equal(net.to("/control").length, 0);
  });

  it("names the permissions of the job when GitHub refuses it the checks", async () => {
    const net = merging().on(
      "GET",
      `/repos/${HOME}/actions/runs?head_sha=${MADE}&per_page=100`,
      () => json({ message: "Resource not accessible by integration" }, 403),
    );
    const { code, lines } = await run(net);
    assert.equal(code, 1);
    assert.equal(
      lines[0],
      `::error::GitHub answered 403: Resource not accessible by integration. The job reads the checks of the pull request https://github.com/${HOME}/pull/8 with the token of the workflow, which needs actions: read, checks: read and pull-requests: read, and merges it with PAGER_FIX_TOKEN`,
    );
    const broken = merging().on("GET", `/repos/${HOME}/pulls/8`, () => {
      throw new TypeError("fetch failed");
    });
    await assert.rejects(run(broken), TypeError);
  });

  it("names the token when GitHub refuses, and the reason of a refusal of its own", async () => {
    const refused = await run(
      github({ ref: () => json({ message: "No workflows" }, 403) }),
    );
    assert.equal(refused.code, 1);
    assert.equal(
      refused.lines[0],
      "::error::GitHub answered 403: No workflows. PAGER_FIX_TOKEN needs this repository, with Contents, Pull requests and Workflows read and write, and reads the template while it is public",
    );
    const broken = await run(github({ here: "{" }));
    assert.equal(broken.code, 1);
    assert.equal(broken.lines[0], `::error::${SETTINGS} isn't JSON`);
  });
});
