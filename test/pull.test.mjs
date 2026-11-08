// The pull request of a fix: the patch on a fresh checkout, one signed commit
// through the API, and the pull request; or the reason why there is none.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GitHub, GitHubError } from "../pager/github.mjs";
import {
  changesOf,
  commitMessage,
  LIMIT,
  openPull,
  pullBody,
} from "../pager/pull.mjs";
import { ITEM, json, Net, REPO } from "./fake.mjs";

const job = {
  kind: "fix",
  item: ITEM,
  repo: REPO,
  thing: "alarm",
  entries: [
    { label: "lint [main] (fails)", url: `https://github.com/${REPO}/runs/5` },
  ],
};
const plan = {
  answer: "A pin.",
  changed: true,
  title: "fix(ci): pin the linter",
  body: "The linter moved.",
};

const raw = (...changes) =>
  changes
    .map(
      ([status, mode, path]) => `:100644 ${mode} aaa bbb ${status}\0${path}\0`,
    )
    .join("");

function world({
  changes = raw(["M", "100644", "a.txt"], ["D", "000000", "old.txt"]),
  apply,
} = {}) {
  const net = new Net()
    .on("GET", "/user", () => json({ login: "monalisa", id: 42 }))
    .on("GET", `/repos/${REPO}`, () => json({ default_branch: "main" }))
    .on("POST", "/git/refs", () => json({}, 201))
    .on("POST", "/graphql", () =>
      json({ data: { createCommitOnBranch: { commit: { oid: "c1" } } } }),
    )
    .on("POST", "/pulls", () =>
      json({ html_url: `https://github.com/${REPO}/pull/40` }, 201),
    )
    .on(
      "DELETE",
      /\/git\/refs\/heads\//,
      () => new Response(null, { status: 204 }),
    );
  const commands = [];
  const git = (args) => {
    commands.push(args);
    if (args[0] === "apply") {
      apply?.();
      return "";
    }
    return changes;
  };
  const files = { "a.txt": Buffer.from("new") };
  const open = (fields = {}) =>
    openPull({
      job,
      plan,
      base: "b".repeat(40),
      token: "github_pat_test",
      runId: "77",
      patch: "/tmp/fix/fix.patch",
      api: new GitHub("github_pat_test", net.fetch),
      git,
      read: async (path) => files[path] ?? Buffer.alloc(0),
      ...fields,
    });
  return { net, commands, files, open };
}

describe("the pull request of a fix", () => {
  it("is one signed commit on a new branch, and a pull request to the default branch", async () => {
    const w = world();
    assert.deepEqual(await w.open(), {
      url: `https://github.com/${REPO}/pull/40`,
      error: "",
    });
    assert.deepEqual(w.commands[0], [
      "apply",
      "--index",
      "--binary",
      "--whitespace=nowarn",
      "/tmp/fix/fix.patch",
    ]);
    assert.deepEqual(w.net.to("/git/refs")[0].body, {
      ref: "refs/heads/fix/pager-fix-77",
      sha: "b".repeat(40),
    });
    const input = w.net.to("/graphql")[0].body.variables.input;
    assert.deepEqual(input.branch, {
      repositoryNameWithOwner: REPO,
      branchName: "fix/pager-fix-77",
    });
    assert.equal(input.expectedHeadOid, "b".repeat(40));
    assert.deepEqual(input.fileChanges, {
      additions: [
        { path: "a.txt", contents: Buffer.from("new").toString("base64") },
      ],
      deletions: [{ path: "old.txt" }],
    });
    assert.equal(input.message.headline, "fix(ci): pin the linter");
    assert.match(
      input.message.body,
      /Signed-off-by: monalisa <42\+monalisa@users.noreply.github.com>/,
    );
    const pull = w.net.to("/pulls")[0].body;
    assert.equal(pull.base, "main");
    assert.equal(pull.head, "fix/pager-fix-77");
    assert.match(
      pull.body,
      /- \[lint main fails\]\(https:\/\/github.com\/monalisa\/demo\/runs\/5\)/,
    );
    assert.match(pull.body, /🤖 Generated with \[Claude Code\]/);
    assert.equal(w.net.to("/git/refs/heads/fix/pager-fix-77").length, 0);
  });

  it("needs PAGER_FIX_TOKEN", async () => {
    const w = world();
    assert.deepEqual(await w.open({ token: "" }), {
      url: "",
      error: "PAGER_FIX_TOKEN isn't set in the control repository",
    });
    assert.equal(w.commands.length, 0);
  });

  it("refuses a patch that doesn't apply, is empty, too large or holds a link", async () => {
    const broken = world({
      apply: () => {
        throw new Error("patch does not apply");
      },
    });
    assert.match(
      (await broken.open()).error,
      /^the change doesn't apply: patch does not apply/,
    );
    assert.equal(
      (await world({ changes: "" }).open()).error,
      "the change is empty",
    );
    const many = Array.from({ length: LIMIT.files + 1 }, (_, index) => [
      "A",
      "100644",
      `f${index}`,
    ]);
    assert.match(
      (await world({ changes: raw(...many) }).open()).error,
      /more than 100 files/,
    );
    assert.match(
      (await world({ changes: raw(["A", "120000", "link"]) }).open()).error,
      /symbolic link/,
    );
    assert.match(
      (await world({ changes: raw(["A", "160000", "sub"]) }).open()).error,
      /submodule/,
    );
    const large = world();
    large.files["a.txt"] = Buffer.alloc(LIMIT.bytes + 1);
    assert.equal((await large.open()).error, "the change is larger than 5 MB");
    assert.equal(large.net.calls.length, 0);
  });

  it("takes its branch back when GitHub refuses the commit or the pull request", async () => {
    const w = world();
    w.net.on("POST", "/pulls", () =>
      json({ message: "Validation Failed" }, 422),
    );
    assert.deepEqual(await w.open(), {
      url: "",
      error: "GitHub answered 422: Validation Failed",
    });
    assert.equal(
      w.net.to("/git/refs/heads/fix/pager-fix-77")[0].method,
      "DELETE",
    );
    const stuck = world();
    stuck.net
      .on("POST", "/graphql", () =>
        json({ errors: [{ message: "expectedHeadOid" }] }),
      )
      .on("DELETE", /\/git\/refs\/heads\//, () => json({ message: "no" }, 500));
    assert.equal(
      (await stuck.open()).error,
      "GitHub answered 200: expectedHeadOid",
    );
    const early = world();
    early.net.on("GET", "/user", () =>
      json({ message: "Bad credentials" }, 401),
    );
    assert.equal(
      (await early.open()).error,
      "GitHub answered 401: Bad credentials",
    );
    assert.equal(
      early.net.calls.filter((call) => call.method === "DELETE").length,
      0,
    );
  });

  it("lets an error that isn't GitHub's through", async () => {
    const w = world();
    const api = new GitHub("t", async () => {
      throw new TypeError("network");
    });
    await assert.rejects(w.open({ api }), TypeError);
    assert.ok(new GitHubError(1, "x").status === 1);
  });

  it("reads the raw diff of git, and writes the trailers", () => {
    assert.deepEqual(changesOf(raw(["M", "100755", "run.sh"])), [
      { status: "M", mode: "100755", path: "run.sh" },
    ]);
    assert.deepEqual(changesOf(""), []);
    assert.deepEqual(commitMessage(plan, { login: "a", id: 1 }), {
      headline: plan.title,
      body: "The linter moved.\n\nSigned-off-by: a <1+a@users.noreply.github.com>\nCo-Authored-By: Claude <noreply@anthropic.com>",
    });
    assert.match(pullBody(job, plan), /^The linter moved\.\n\n---/);
  });
});
