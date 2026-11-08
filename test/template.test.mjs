// The template of the control repository: what a repository takes from it, the
// pull request that brings it, and the report to the pager, against a simulated
// GitHub that records each call.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { Refusal } from "../pager/core.mjs";
import { GitHub, GitHubError } from "../pager/github.mjs";
import { main } from "../pager/job.mjs";
import {
  BRANCH,
  changesOf,
  filesOf,
  isOwn,
  pullBody,
  reportOf,
  SETTINGS,
  settingsOf,
  summaryOf,
  takeTemplate,
} from "../pager/template.mjs";
import { json, Net } from "./fake.mjs";

const TEMPLATE = "Dennis-Otto/repo-pager-control-template";
const HOME = "monalisa/repo-pager-control";
const sha = (letter) => letter.repeat(40);
const HEAD = sha("a");
const OLD = sha("b");
const LATEST = sha("c");

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
    .on("POST", "/graphql", () =>
      json({ data: { createCommitOnBranch: { commit: { oid: "d" } } } }),
    )
    .on("POST", `/repos/${HOME}/pulls`, () =>
      json({ html_url: `https://github.com/${HOME}/pull/8` }, 201),
    )
    .on("PATCH", `/repos/${HOME}/pulls/7`, () => json({}));
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
    assert.match(body, new RegExp(`<!-- template ${LATEST} onto ${HEAD} -->$`));
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
      template: TEMPLATE,
      commit: LATEST,
      changes: CHANGES,
    });
    assert.deepEqual(net.to(`/repos/${HOME}/git/refs`)[0].body, {
      ref: `refs/heads/${BRANCH}`,
      sha: HEAD,
    });
    const { input } = net.to("/graphql")[0].body.variables;
    assert.deepEqual(input.branch, {
      repositoryNameWithOwner: HOME,
      branchName: BRANCH,
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
      new RegExp(`<!-- template ${LATEST} onto ${HEAD} -->`),
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
    const result = await take(net);
    assert.equal(result.state, "updated");
    assert.equal(result.url, `https://github.com/${HOME}/pull/7`);
    assert.deepEqual(net.to(`/git/refs/heads/${BRANCH}`)[0].body, {
      sha: HEAD,
      force: true,
    });
    assert.equal(
      net.to(`/repos/${HOME}/pulls/7`)[0].body.title,
      "chore: take the template up to cccccccccccc",
    );
    assert.equal(net.to(`/repos/${HOME}/pulls`).length, 0);
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
      changes: { write: [], remove: [] },
    });
  });

  it("takes nothing in the template itself", async () => {
    const net = github({ here: settings({ template: HOME }) });
    assert.deepEqual(await take(net), { state: "template", template: HOME });
  });

  it("deletes nothing before the first take, or when the template lost the commit", async () => {
    const first = await take(github({ here: settings({ commit: "" }) }));
    assert.deepEqual(first.changes.remove, []);
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
