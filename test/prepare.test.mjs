// What the first job collects for Claude, with the read-only token, on a simulated
// GitHub: the state of the repositories, a thread, and the logs of what fails.
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { GitHub, GitHubError } from "../pager/github.mjs";
import {
  BY_ITSELF,
  byItself,
  excerpt,
  failures,
  healthRun,
  held,
  prepare,
  READ,
  snapshot,
  thread,
} from "../pager/prepare.mjs";
import { ITEM, json, Net, OWNER, REPO } from "./fake.mjs";

const api = (net) => new GitHub("ghs_test", net.fetch);
const read = async (name) => `the file ${name}`;

async function run(net, eventName, event) {
  const out = await mkdtemp(join(tmpdir(), "pager-"));
  const result = await prepare({
    eventName,
    event,
    owner: OWNER,
    api: api(net),
    out,
    read,
  });
  const names = (await readdir(out, { recursive: true })).sort();
  const file = (name) => readFile(join(out, name), "utf8");
  return { ...result, names, file };
}

const SNAPSHOT = {
  repositoryOwner: {
    repositories: {
      nodes: [
        {
          nameWithOwner: REPO,
          latestRelease: { tagName: "v1.2.3" },
          defaultBranchRef: {
            name: "main",
            target: {
              statusCheckRollup: {
                state: "FAILURE",
                contexts: {
                  nodes: [
                    {
                      __typename: "CheckRun",
                      name: "lint",
                      conclusion: "FAILURE",
                    },
                    {
                      __typename: "CheckRun",
                      name: "test",
                      conclusion: "SUCCESS",
                    },
                    {
                      __typename: "StatusContext",
                      context: "dco",
                      state: "ERROR",
                    },
                  ],
                },
              },
            },
          },
        },
        {
          nameWithOwner: "monalisa/empty",
          latestRelease: null,
          defaultBranchRef: null,
        },
      ],
    },
  },
  pulls: {
    nodes: [
      {
        number: 30,
        title: "chore: release 1.2.4",
        url: `https://github.com/${REPO}/pull/30`,
        isDraft: false,
        headRefName: "release-please--branches--main",
        author: { login: "monalisa-release[bot]" },
        repository: { nameWithOwner: REPO },
        commits: {
          nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }],
        },
      },
      {
        number: 31,
        title: "x",
        url: "u",
        isDraft: true,
        headRefName: "b",
        author: null,
        repository: { nameWithOwner: REPO },
        commits: { nodes: [] },
      },
      {},
    ],
  },
  issues: {
    nodes: [
      {
        number: 12,
        title: "It breaks",
        url: `https://github.com/${REPO}/issues/12`,
        author: { login: "octocat" },
        repository: { nameWithOwner: REPO },
        labels: { nodes: [{ name: "bug" }] },
      },
      {
        number: 13,
        title: "Gone",
        url: "u",
        author: null,
        repository: { nameWithOwner: REPO },
        labels: null,
      },
      null,
    ],
  },
};

describe("a free text", () => {
  it("gets the state of the owner's repositories, pull requests and issues", async () => {
    const net = new Net().on("POST", "/graphql", () =>
      json({ data: SNAPSHOT }),
    );
    const event = {
      action: "pager-text",
      client_payload: { text: "Merge it", message: 5, reply: "📦 Release" },
    };
    const { job, outputs, names, file } = await run(
      net,
      "repository_dispatch",
      event,
    );
    assert.equal(job.kind, "text");
    assert.deepEqual(names, [
      "github.json",
      "logs",
      "reply.txt",
      "rules.md",
      "task.md",
      "text.txt",
    ]);
    assert.equal(await file("text.txt"), "Merge it");
    assert.equal(await file("reply.txt"), "📦 Release");
    assert.equal(await file("rules.md"), "the file rules.md");
    assert.match(await file("task.md"), /`data\/reply.txt`/);
    const github = JSON.parse(await file("github.json"));
    assert.deepEqual(github.repositories, [
      {
        repo: REPO,
        branch: "main",
        checks: "FAILURE",
        failing: ["lint", "dco"],
        release: "v1.2.3",
      },
      {
        repo: "monalisa/empty",
        branch: null,
        checks: null,
        failing: [],
        release: null,
      },
    ]);
    assert.equal(github.pulls.length, 2);
    assert.deepEqual(github.pulls[0], {
      repo: REPO,
      number: 30,
      title: "chore: release 1.2.4",
      url: `https://github.com/${REPO}/pull/30`,
      author: "monalisa-release[bot]",
      draft: false,
      branch: "release-please--branches--main",
      checks: "SUCCESS",
    });
    assert.equal(github.pulls[1].checks, null);
    assert.deepEqual(github.issues[1].labels, []);
    assert.deepEqual(github.issues[0].labels, ["bug"]);
    const query = net.to("/graphql")[0].body.variables;
    assert.deepEqual(query, {
      owner: OWNER,
      pulls: "user:monalisa is:open archived:false sort:updated-desc is:pr",
      issues: "user:monalisa is:open archived:false sort:updated-desc is:issue",
    });
    // The text of the maintainer stays out of the outputs, which the next jobs read.
    assert.deepEqual(JSON.parse(outputs.job), {
      kind: "text",
      message: 5,
      language: "en",
    });
    assert.equal(outputs.repo, "");
    assert.equal(outputs.tools, "Read,Grep,Glob");
    assert.equal(JSON.parse(outputs.schema).required[0], "answer");
    // A job with tools reads its task from data/, as its prompt says.
    assert.match(outputs.prompt, /^Read data\/task\.md and do the task/);
  });

  it("hands Claude the thing whose topic the text came from, and keeps it out of the outputs", async () => {
    const net = new Net().on("POST", "/graphql", () => json({ data: {} }));
    const item = {
      id: ITEM,
      kind: "release",
      repo: REPO,
      state: "ready",
      number: 30,
      version: "1.2.3",
      links: [`https://github.com/${REPO}/pull/30`],
      text: "📦 Release 1.2.3 of monalisa/demo: #30",
    };
    const { job, outputs, names, file } = await run(
      net,
      "repository_dispatch",
      {
        action: "pager-text",
        client_payload: { text: "Why not?", message: 5, thing: item },
      },
    );
    assert.deepEqual(job.item, item);
    assert.ok(names.includes("item.json"));
    assert.deepEqual(JSON.parse(await file("item.json")), item);
    assert.match(await file("task.md"), /`data\/item.json` holds/);
    assert.deepEqual(JSON.parse(outputs.job), {
      kind: "text",
      message: 5,
      language: "en",
    });
  });

  it("does without a message it answers, and with an empty answer of GitHub", async () => {
    const net = new Net().on("POST", "/graphql", () => json({ data: {} }));
    const { names, file } = await run(net, "workflow_dispatch", {
      inputs: { text: "Hi" },
    });
    assert.ok(!names.includes("reply.txt"));
    assert.ok(!names.includes("item.json"));
    assert.deepEqual(JSON.parse(await file("github.json")), {
      repositories: [],
      pulls: [],
      issues: [],
    });
    assert.deepEqual(
      await snapshot(
        api(new Net().on("POST", "/graphql", () => json({}))),
        OWNER,
      ),
      {
        repositories: [],
        pulls: [],
        issues: [],
      },
    );
  });
});

describe("what GitHub doesn't give", () => {
  it("leaves an answer to free text without the state of the repositories", async () => {
    const net = new Net().on("POST", "/graphql", () =>
      json({ message: "Resource not accessible" }, 403),
    );
    const { file, outputs } = await run(net, "workflow_dispatch", {
      inputs: { text: "Hi" },
    });
    assert.deepEqual(JSON.parse(await file("github.json")), {
      unread: "GitHub answered 403: Resource not accessible",
    });
    assert.equal(outputs.error, "");
  });

  it("names why a draft has no thread, so that the answer says it", async () => {
    const event = {
      action: "pager-draft",
      client_payload: { item: ITEM, repo: REPO, number: 12, pull: false },
    };
    const { names, outputs } = await run(
      new Net(),
      "repository_dispatch",
      event,
    );
    assert.equal(
      outputs.error,
      "the thread didn't come from GitHub: GitHub answered 404: Not Found",
    );
    assert.ok(!names.includes("thread.json"));
  });

  it("lets a broken network through", async () => {
    const broken = async () => {
      throw new TypeError("network");
    };
    const out = await mkdtemp(join(tmpdir(), "pager-"));
    for (const event of [
      { inputs: { text: "Hi" } },
      {
        action: "pager-draft",
        client_payload: { item: ITEM, repo: REPO, number: 1, pull: false },
      },
    ]) {
      const eventName = event.inputs
        ? "workflow_dispatch"
        : "repository_dispatch";
      await assert.rejects(
        prepare({
          eventName,
          event,
          owner: OWNER,
          api: new GitHub("t", broken),
          out,
          read,
        }),
        TypeError,
      );
    }
  });
});

describe("a draft", () => {
  const issue = {
    html_url: `https://github.com/${REPO}/issues/12`,
    title: "It breaks",
    state: "open",
    user: { login: "octocat" },
    author_association: "NONE",
    labels: [{ name: "bug" }, "question"],
    created_at: "2026-11-01T00:00:00Z",
    body: "x".repeat(READ.body + 10),
  };
  const comments = Array.from({ length: 60 }, (_, index) => ({
    user: index === 59 ? null : { login: "octocat" },
    author_association: "NONE",
    created_at: "2026-11-02T00:00:00Z",
    body: `comment ${index}`,
  }));

  it("gets the issue with its last comments, and the voice of the maintainer", async () => {
    const net = new Net()
      .on("GET", "/issues/12", () => json(issue))
      .on("GET", "/issues/12/comments?per_page=100", () => json(comments));
    const event = {
      action: "pager-draft",
      client_payload: { item: ITEM, repo: REPO, number: 12, pull: false },
    };
    const { names, file, outputs } = await run(
      net,
      "repository_dispatch",
      event,
    );
    assert.deepEqual(names, [
      "logs",
      "rules.md",
      "task.md",
      "thread.json",
      "voice.md",
    ]);
    const got = JSON.parse(await file("thread.json"));
    assert.equal(got.kind, "issue");
    assert.equal(got.body.length, READ.body + 1);
    assert.deepEqual(got.labels, ["bug", "question"]);
    assert.equal(got.comments.length, READ.comments);
    assert.equal(got.comments[0].body, "comment 10");
    assert.equal(got.comments.at(-1).author, null);
    assert.equal(got.pull, undefined);
    assert.equal(outputs.repo, REPO);
    assert.equal(await file("voice.md"), "the file voice.md");
    // The answer job reads the job from the outputs: without the item, the draft
    // would reach no thing of the pager.
    assert.equal(JSON.parse(outputs.job).item, ITEM);
  });

  it("gets the comment that the reply answers, and goes on without it once it is gone", async () => {
    const answered = {
      html_url: `https://github.com/${REPO}/issues/12#issuecomment-99`,
      user: { login: "hubot" },
      author_association: "NONE",
      created_at: "2026-11-01T00:00:00Z",
      body: "c".repeat(READ.comment + 1),
    };
    const net = new Net()
      .on("GET", "/issues/12", () => json(issue))
      .on("GET", "/issues/12/comments?per_page=100", () =>
        json([answered, { ...answered, user: null }]),
      )
      .on("GET", "/issues/comments/99", () => json(answered));
    const job = { repo: REPO, number: 12, pull: false, issueComment: 99 };
    const got = await thread(api(net), job);
    assert.deepEqual(got.answering, {
      url: answered.html_url,
      author: "hubot",
      association: "NONE",
      created: "2026-11-01T00:00:00Z",
      body: `${"c".repeat(READ.comment)}…`,
    });
    assert.equal(got.comments[0].url, answered.html_url);
    // A comment that was deleted meanwhile: the reply goes below the issue all the same.
    net.on("GET", "/issues/comments/99", () =>
      json({ message: "Not Found" }, 404),
    );
    const gone = await thread(api(net), job);
    assert.equal(gone.answering, undefined);
    assert.equal(gone.comments.length, 2);
    // Any other answer of GitHub is no thread.
    net.on("GET", "/issues/comments/99", () =>
      json({ message: "Server Error" }, 502),
    );
    await assert.rejects(thread(api(net), job), /GitHub answered 502/);
    net.on("GET", "/issues/comments/99", () => {
      throw new TypeError("network");
    });
    await assert.rejects(thread(api(net), job), TypeError);
  });

  it("gets a pull request with its changes, as far as they fit", async () => {
    const files = Array.from({ length: 20 }, (_, index) => ({
      filename: `f${index}`,
      status: "modified",
      additions: 1,
      deletions: 0,
      patch: "p".repeat(READ.patch + 1),
    }));
    files.push({
      filename: "image.png",
      status: "added",
      additions: 0,
      deletions: 0,
    });
    const net = new Net()
      .on("GET", "/issues/12", () =>
        json({ ...issue, user: null, labels: undefined, body: null }),
      )
      .on("GET", "/issues/12/comments?per_page=100", () => json([]))
      .on("GET", "/pulls/12", () =>
        json({
          head: { label: "octocat:fix" },
          base: { ref: "main" },
          additions: 20,
          deletions: 0,
        }),
      )
      .on("GET", "/pulls/12/files?per_page=100", () => json(files));
    const got = await thread(api(net), { repo: REPO, number: 12, pull: true });
    assert.equal(got.author, null);
    assert.equal(got.body, "");
    assert.deepEqual(got.labels, []);
    assert.equal(got.pull.head, "octocat:fix");
    const sizes = got.pull.files.map((file) => file.patch.length);
    assert.equal(sizes[0], READ.patch + 1);
    assert.ok(sizes.reduce((sum, size) => sum + size, 0) <= READ.patches + 20);
    assert.equal(sizes.at(-1), 0);
    const bare = new Net()
      .on("GET", "/issues/12", () => json(issue))
      .on("GET", "/issues/12/comments?per_page=100", () => json([]))
      .on("GET", "/pulls/12", () => json({}))
      .on("GET", "/pulls/12/files?per_page=100", () => json([]));
    const empty = await thread(api(bare), {
      repo: REPO,
      number: 12,
      pull: true,
    });
    assert.deepEqual(empty.pull, {
      head: null,
      base: null,
      additions: undefined,
      deletions: undefined,
      files: [],
    });
  });
});

describe("a draft of a discussion", () => {
  const author = { login: "octocat" };
  const node = (body, extra = {}) => ({
    url: `https://github.com/${REPO}/discussions/31#${body}`,
    body,
    createdAt: "2026-11-07T00:00:00Z",
    authorAssociation: "NONE",
    author,
    ...extra,
  });
  const DISCUSSION = {
    repository: {
      discussion: {
        ...node("How do I start?", {
          url: `https://github.com/${REPO}/discussions/31`,
        }),
        title: "Getting started",
        closed: false,
        category: { name: "Q&A" },
        comments: {
          nodes: [
            node("Me too", {
              replies: { nodes: [node("Same", { author: null })] },
            }),
            node("Any news?", { replies: null }),
          ],
        },
      },
    },
  };
  /** GitHub's GraphQL API: the discussion, and the comment that the reply answers. */
  const graphql = (discussion, answering) =>
    new Net().on("POST", "/graphql", (call) =>
      json({
        data: call.body.query.includes("node(id: $id)")
          ? { node: answering }
          : discussion,
      }),
    );
  const event = (payload) => ({
    action: "pager-draft",
    client_payload: {
      item: ITEM,
      repo: REPO,
      number: 31,
      pull: false,
      discussion: true,
      ...payload,
    },
  });

  it("gets the discussion with its comments and their replies, and the comment that the reply answers", async () => {
    const net = graphql(DISCUSSION, node("Any news?"));
    const { names, file, outputs } = await run(
      net,
      "repository_dispatch",
      event({ comment: "DC_kwDOB" }),
    );
    assert.ok(names.includes("thread.json"));
    const got = JSON.parse(await file("thread.json"));
    assert.equal(got.kind, "discussion");
    assert.equal(got.url, `https://github.com/${REPO}/discussions/31`);
    assert.equal(got.title, "Getting started");
    assert.equal(got.category, "Q&A");
    assert.equal(got.state, "open");
    assert.equal(got.author, "octocat");
    assert.equal(got.body, "How do I start?");
    assert.equal(got.comments.length, 2);
    assert.equal(got.comments[0].replies[0].author, null);
    assert.deepEqual(got.comments[1].replies, []);
    assert.equal(got.answering.body, "Any news?");
    const [query, comment] = net.to("/graphql");
    assert.deepEqual(query.body.variables, {
      owner: "monalisa",
      name: "demo",
      number: 31,
    });
    assert.match(query.body.query, /comments\(last: 50\)/);
    assert.match(query.body.query, /replies\(last: 20\)/);
    assert.deepEqual(comment.body.variables, { id: "DC_kwDOB" });
    assert.match(await file("task.md"), /answers the comment in `answering`/);
    assert.equal(JSON.parse(outputs.job).comment, "DC_kwDOB");
    assert.equal(outputs.error, "");
  });

  it("answers the discussion itself without a comment, and takes it without its fields", async () => {
    const bare = {
      repository: {
        discussion: { url: "u", title: "t", closed: true, author: null },
      },
    };
    const net = graphql(bare, null);
    const { file } = await run(net, "repository_dispatch", event({}));
    const got = JSON.parse(await file("thread.json"));
    assert.equal(got.state, "closed");
    assert.equal(got.category, null);
    assert.equal(got.author, null);
    assert.equal(got.body, "");
    assert.deepEqual(got.comments, []);
    assert.equal(got.answering, undefined);
    assert.equal(net.to("/graphql").length, 1);
    assert.match(await file("task.md"), /answers the discussion itself/);
  });

  it("names a discussion or a comment that is gone, so that the answer says it", async () => {
    const gone = await run(
      graphql({ repository: { discussion: null } }, null),
      "repository_dispatch",
      event({}),
    );
    assert.equal(
      gone.outputs.error,
      "the thread didn't come from GitHub: GitHub answered 404: monalisa/demo has no discussion #31",
    );
    const removed = await run(
      graphql(DISCUSSION, {}),
      "repository_dispatch",
      event({ comment: "DC_kwDOB" }),
    );
    assert.equal(
      removed.outputs.error,
      "the thread didn't come from GitHub: GitHub answered 404: the comment that the reply answers is gone",
    );
    const missing = await run(
      new Net().on("POST", "/graphql", (call) =>
        json(
          call.body.query.includes("node(id: $id)") ? {} : { data: DISCUSSION },
        ),
      ),
      "repository_dispatch",
      event({ comment: "DC_kwDOB" }),
    );
    assert.match(
      missing.outputs.error,
      /the comment that the reply answers is gone/,
    );
    const empty = await run(
      new Net().on("POST", "/graphql", () => json({})),
      "repository_dispatch",
      event({}),
    );
    assert.match(empty.outputs.error, /has no discussion #31/);
  });
});

describe("a translation", () => {
  it("asks GitHub nothing, reads no checkout, and makes its task with its notes the prompt", async () => {
    const net = new Net();
    const lines = ["the pager speaks German", "</notes-0> and #4"];
    const event = {
      action: "pager-translate",
      client_payload: {
        item: ITEM,
        repo: REPO,
        number: 140,
        version: "0.9.0",
        of: "0a1b2c3d",
        lines,
        language: "de",
      },
    };
    const { job, outputs, names, file } = await run(
      net,
      "repository_dispatch",
      event,
    );
    assert.equal(job.kind, "translate");
    assert.equal(net.calls.length, 0);
    assert.deepEqual(names, ["logs", "rules.md", "task.md"]);
    // Its task is its prompt, with the notes between lines of a random word.
    const task = await file("task.md");
    assert.equal(outputs.prompt, task);
    const [, data] = /\n<(notes-[0-9a-f]{16})>\n/.exec(task);
    const notes = task.slice(task.lastIndexOf(`<${data}>`));
    assert.deepEqual(
      JSON.parse(notes.slice(data.length + 3, -(data.length + 4))),
      lines,
    );
    assert.ok(task.endsWith(`\n</${data}>`));
    assert.deepEqual(JSON.parse(outputs.job), {
      kind: "translate",
      repo: REPO,
      of: "0a1b2c3d",
      lines,
      language: "de",
      item: ITEM,
    });
    assert.equal(outputs.repo, "");
    assert.equal(outputs.tools, "");
    assert.equal(outputs.turns, "");
    assert.equal(outputs.model, "claude-sonnet-5-5");
    assert.equal(JSON.parse(outputs.schema).properties.lines.maxItems, 2);
    assert.equal(outputs.error, "");
    // Another run has another word between its notes.
    const again = await run(net, "repository_dispatch", event);
    assert.notEqual(again.outputs.prompt, outputs.prompt);
  });
});

describe("a fix", () => {
  const entry = (label, path) => ({
    label,
    url: `https://github.com/${REPO}/${path}`,
  });

  const jobs = (...list) => json({ jobs: list });
  const failed = (id, name) => ({ id, name, conclusion: "failure" });

  it("gets the logs of the failed jobs, an issue of a bot, and names what it can't read", async () => {
    const net = new Net()
      .on("GET", "/actions/runs/5", () =>
        json({ run_attempt: 1, status: "completed", conclusion: "failure" }),
      )
      .on("GET", "/actions/runs/5/attempts/1/jobs?per_page=100", () =>
        jobs(failed(51, "lint"), {
          id: 52,
          name: "test",
          conclusion: "success",
        }),
      )
      .on("GET", "/actions/runs/6", () => json({}))
      .on("GET", "/actions/runs/6/attempts/1/jobs?per_page=100", () => json({}))
      .on(
        "GET",
        /\/actions\/jobs\/\d+\/logs$/,
        () => new Response("﻿2026-11-04T01:02:03.4567890Z one\r\ntwo"),
      )
      .on("GET", "/actions/jobs/91/logs", () =>
        json({ message: "Must have admin rights to Repository." }, 403),
      )
      .on("GET", "/issues/9", () =>
        json({ title: "A bot fails", body: "It does." }),
      )
      .on("GET", "/actions/runs/7", () => json({ message: "Forbidden" }, 403));
    const event = {
      action: "pager-fix",
      client_payload: {
        item: ITEM,
        repo: REPO,
        kind: "alarm",
        entries: [
          entry("The release fails", "actions/runs/5"),
          entry("A job", "actions/runs/8/job/81"),
          entry("A check", "runs/91"),
          entry("A bot fails", "issues/9"),
          entry("Nothing failed", "actions/runs/6"),
          entry("Hidden", "actions/runs/7"),
          entry("high: x", "security/code-scanning/3"),
        ],
      },
    };
    const { names, file, outputs } = await run(
      net,
      "repository_dispatch",
      event,
    );
    // The answer of the fix goes to its thing, and so into the thing's topic.
    assert.equal(JSON.parse(outputs.job).item, ITEM);
    assert.deepEqual(names, [
      "failures.json",
      "logs",
      join("logs", "1-51.txt"),
      join("logs", "2-81.txt"),
      "rules.md",
      "task.md",
    ]);
    assert.equal(await file(join("logs", "1-51.txt")), "one\ntwo");
    const found = JSON.parse(await file("failures.json"));
    assert.deepEqual(found[0].run, {
      id: 5,
      attempt: 1,
      latest: { attempt: 1, status: "completed", conclusion: "failure" },
    });
    assert.deepEqual(found[0].jobs, [
      { id: 51, name: "lint", log: "logs/1-51.txt" },
    ]);
    assert.deepEqual(found[1].jobs, [
      { id: 81, name: null, log: "logs/2-81.txt" },
    ]);
    // A log that GitHub refuses says why, with its status.
    assert.deepEqual(found[2].jobs, [
      {
        id: 91,
        name: null,
        unread: "GitHub answered 403: Must have admin rights to Repository.",
      },
    ]);
    assert.deepEqual(found[3], {
      label: "A bot fails",
      url: `https://github.com/${REPO}/issues/9`,
      issue: { title: "A bot fails", body: "It does." },
    });
    assert.deepEqual(found[4].run, {
      id: 6,
      attempt: null,
      latest: { attempt: 1, status: null, conclusion: null },
    });
    assert.deepEqual(found[4].jobs, []);
    assert.equal(found[5].unread, "GitHub answered 403: Forbidden");
    assert.deepEqual(found[6].jobs, []);
    assert.match(await file("task.md"), /`data\/logs\/1-51.txt`/);
  });

  it("reads the attempt that failed, and names a newer one that runs or passed", async () => {
    const net = new Net()
      .on("GET", "/actions/runs/41810972406", () =>
        json({ run_attempt: 2, status: "in_progress", conclusion: null }),
      )
      .on("GET", "/actions/runs/41810972406/attempts/2/jobs?per_page=100", () =>
        jobs({ id: 20, name: "release pull request", conclusion: null }),
      )
      .on("GET", "/actions/runs/41810972406/attempts/1/jobs?per_page=100", () =>
        jobs(failed(10, "release pull request")),
      )
      .on("GET", /\/logs$/, () => new Response("log"));
    const found = await failures(api(net), {
      repo: REPO,
      entries: [entry("Release", "actions/runs/41810972406")],
    });
    // The jobs of the run without an attempt are those of the rerun, which still runs.
    assert.deepEqual(found.entries[0].run, {
      id: 41810972406,
      attempt: 1,
      latest: { attempt: 2, status: "in_progress", conclusion: null },
    });
    assert.deepEqual(found.entries[0].jobs, [
      { id: 10, name: "release pull request", log: "logs/1-10.txt" },
    ]);
    // An address with its attempt reads that attempt alone.
    const named = new Net()
      .on("GET", "/actions/runs/3", () =>
        json({ run_attempt: 3, status: "completed", conclusion: "success" }),
      )
      .on("GET", "/actions/runs/3/attempts/2/jobs?per_page=100", () =>
        jobs(failed(32, "test"), { id: 33, conclusion: "timed_out" }),
      )
      .on("GET", /\/logs$/, () => new Response("log"));
    const passed = await failures(api(named), {
      repo: REPO,
      entries: [entry("Release", "actions/runs/3/attempts/2")],
    });
    assert.deepEqual(passed.entries[0].run, {
      id: 3,
      attempt: 2,
      latest: { attempt: 3, status: "completed", conclusion: "success" },
    });
    assert.deepEqual(passed.entries[0].jobs, [
      { id: 32, name: "test", log: "logs/1-32.txt" },
      { id: 33, name: null, log: "logs/2-33.txt" },
    ]);
    assert.equal(named.to("/attempts/3/jobs?per_page=100").length, 0);
    // A run without a failed job in its last attempts names none.
    const none = new Net()
      .on("GET", "/actions/runs/4", () => json({ run_attempt: 9 }))
      .on("GET", /\/attempts\/\d+\/jobs\?per_page=100$/, () => json({}));
    const nothing = await failures(api(none), {
      repo: REPO,
      entries: [entry("Release", "actions/runs/4")],
    });
    assert.equal(nothing.entries[0].run.attempt, null);
    assert.equal(
      none.calls.filter((call) => call.url.includes("/attempts/")).length,
      READ.attempts,
    );
  });

  it("reads the failed jobs of the run that an issue of the bot-health bot names", async () => {
    const log = await readFile(
      new URL("fixtures/mutation-job.log", import.meta.url),
      "utf8",
    );
    const body = [
      '<!-- bot-health {"attempt": 2, "failed": 2, "key": ".github/workflows/mutation.yml", "run": 41995567564, "since": "2026-11-05", "where": "789b2212e01f"} -->',
      "The workflow **Mutation** fails on `main` since 2026-11-05.",
    ].join("\n");
    const net = new Net()
      .on("GET", "/issues/367", () =>
        json({ title: "Mutation fails on main", body }),
      )
      .on("GET", "/actions/runs/41995567564", () =>
        json({ run_attempt: 2, status: "completed", conclusion: "failure" }),
      )
      .on("GET", "/actions/runs/41995567564/attempts/2/jobs?per_page=100", () =>
        jobs(failed(127150025992, "mutation 1/1")),
      )
      .on("GET", "/actions/jobs/127150025992/logs", () => new Response(log));
    const found = await failures(api(net), {
      repo: REPO,
      entries: [entry("A bot fails: Mutation fails on main", "issues/367")],
    });
    assert.equal(found.entries[0].issue.title, "Mutation fails on main");
    assert.deepEqual(found.entries[0].run, {
      id: 41995567564,
      attempt: 2,
      latest: { attempt: 2, status: "completed", conclusion: "failure" },
    });
    const read = found.logs["logs/1-127150025992.txt"];
    // The cause, which the end of the log no longer showed: GitHub's 504, six times.
    assert.equal(read.match(/curl: \(22\) .* error: 504/g)?.length, 6);
  });

  it("reads the logs of five jobs at most, and says so of the others", async () => {
    const net = new Net().on("GET", /\/logs$/, () => new Response("log"));
    const entries = Array.from({ length: 7 }, (_, index) =>
      entry(`job ${index}`, `runs/${index + 1}`),
    );
    const found = await failures(api(net), { repo: REPO, entries });
    assert.equal(Object.keys(found.logs).length, READ.jobs);
    assert.deepEqual(found.entries[6].jobs, [
      { id: 7, name: null, unread: "the job reads the logs of 5 jobs at most" },
    ]);
  });

  it("lets a broken network through", async () => {
    const broken = new GitHub("t", async () => {
      throw new TypeError("network");
    });
    await assert.rejects(
      failures(broken, { repo: REPO, entries: [entry("x", "runs/1")] }),
      TypeError,
    );
    await assert.rejects(
      failures(broken, { repo: REPO, entries: [entry("x", "actions/runs/1")] }),
      TypeError,
    );
    assert.ok(new GitHubError(500, "x") instanceof Error);
  });
});

describe("the marker of the bot-health bot", () => {
  it("names the run and the attempt of the latest failure", () => {
    assert.deepEqual(
      healthRun('<!-- bot-health {"attempt": 2, "run": 7} -->\nText'),
      { run: 7, attempt: 2 },
    );
    assert.deepEqual(healthRun('<!-- bot-health {"run": 7} -->'), { run: 7 });
    assert.deepEqual(
      healthRun('<!-- bot-health {"attempt": 0, "run": 7} -->'),
      { run: 7 },
    );
  });

  it("is null for another issue and for a broken marker", () => {
    assert.equal(healthRun("It breaks."), null);
    assert.equal(healthRun(null), null);
    assert.equal(healthRun("<!-- bot-health {run: 7} -->"), null);
    assert.equal(healthRun('<!-- bot-health {"run": "7"} -->'), null);
    assert.equal(healthRun('<!-- bot-health {"key": "x"} -->'), null);
  });
});

describe("the part of a log that Claude reads", () => {
  it("keeps the failed step of a real log, not the report of Harden-Runner at its end", async () => {
    const log = await readFile(
      new URL("fixtures/mutation-job.log", import.meta.url),
      "utf8",
    );
    // The shape of the problem: the last 400 lines are Harden-Runner's report and
    // the steps after the failure, not the error.
    const end = log.split("\n").slice(-READ.log).join("\n");
    assert.doesNotMatch(end, /error: 504/);
    const read = excerpt(log);
    const lines = read.split("\n");
    assert.ok(lines.length <= READ.log);
    // The command of the failed step, without its colors.
    assert.ok(
      lines.includes(
        "##[group]Run composer install --no-interaction --prefer-dist --no-progress",
      ),
    );
    assert.ok(
      lines.includes(
        '  "https://github.com/infection/infection/releases/download/$INFECTION_VERSION/infection.phar"',
      ),
    );
    assert.equal(
      read.match(/curl: \(22\) The requested URL returned error: 504/g)?.length,
      6,
    );
    assert.ok(lines.includes("##[error]Process completed with exit code 22."));
    assert.ok(lines.includes("##[error]Process completed with exit code 1."));
    assert.doesNotMatch(
      read,
      /domain resolved|endpoint called|\[harden-runner\]/,
    );
    assert.doesNotMatch(read, /^\d{4}-\d\d-\d\dT/m);
    assert.ok(!read.includes("\u001b"), "the colors are gone");
  });

  it("keeps the end of a log without an error", () => {
    assert.equal(excerpt("a\nb\n2026-11-04T01:02:03Z c", 2), "b\nc");
  });

  it("shares its lines between the errors, the nearest first, and marks what it leaves out", () => {
    const log = [
      "set up",
      "##[group]Run make test",
      "make test",
      "shell: /usr/bin/bash -e {0}",
      "##[endgroup]",
      ...Array.from({ length: 20 }, (_, index) => `test ${index}`),
      "##[error]test 19 failed",
      "after 1",
      "##[group]Run make lint",
      "make lint",
      "##[endgroup]",
      "lint 1",
      "##[error]lint failed",
    ].join("\n");
    assert.equal(
      excerpt(log, 16),
      [
        "…",
        "##[group]Run make test",
        "make test",
        "shell: /usr/bin/bash -e {0}",
        "##[endgroup]",
        "…",
        "test 17",
        "test 18",
        "test 19",
        "##[error]test 19 failed",
        "after 1",
        "##[group]Run make lint",
        "make lint",
        "##[endgroup]",
        "lint 1",
        "##[error]lint failed",
      ].join("\n"),
    );
  });

  it("does without the command of a step that it doesn't find", () => {
    assert.equal(
      excerpt("a\nb\nc\nd\n##[error]e\nf", 4),
      "…\nd\n##[error]e\nf",
    );
    // A step whose command has no end before the error, or none at all.
    const open = "##[group]Run x\nx\n##[error]broken\n##[endgroup]";
    assert.equal(excerpt(open, 10), open);
    const bare = "##[group]Run x\n##[error]y";
    assert.equal(excerpt(bare, 10), bare);
    // Two errors of one step share its command.
    const twice = "##[group]Run x\n##[endgroup]\na\n##[error]b\nc\n##[error]d";
    assert.equal(excerpt(twice, 10), twice);
  });

  it("gives each step with an error its share, so that hundreds of annotations leave room for the step that failed after them", () => {
    const exit = "##[error]Process completed with exit code 1.";
    // A lint step with continue-on-error and its annotations, then the tests.
    const log = [
      "##[group]Run npm run lint",
      "npm run lint",
      "shell: /usr/bin/bash -e {0}",
      "##[endgroup]",
      ...Array.from(
        { length: 450 },
        (_, index) => `##[error]src/a.mjs:${index + 1}:1 lint/style/useConst`,
      ),
      exit,
      "##[group]Run npm test",
      "npm test",
      "shell: /usr/bin/bash -e {0}",
      "##[endgroup]",
      ...Array.from({ length: 100 }, (_, index) => `ok ${index + 1} - passes`),
      "not ok 101 - adds",
      "  expected: 3",
      "  actual: 4",
      ...Array.from({ length: 8 }, (_, index) => `# summary ${index}`),
      exit,
    ].join("\n");
    const lines = excerpt(log).split("\n");
    assert.ok(lines.length <= READ.log);
    assert.ok(lines.includes("##[group]Run npm run lint"));
    assert.ok(lines.includes("##[group]Run npm test"));
    assert.ok(lines.includes("not ok 101 - adds"));
    assert.equal(lines.filter((line) => line === exit).length, 2);
    // The first annotations and those before the end of the lint step.
    assert.ok(lines.includes("##[error]src/a.mjs:1:1 lint/style/useConst"));
    assert.ok(lines.includes("##[error]src/a.mjs:450:1 lint/style/useConst"));
  });

  it("reads a long step of thousands of errors in little time and memory", () => {
    const lines = [
      "##[group]Run npm run lint",
      "npm run lint",
      "##[endgroup]",
      ...Array.from({ length: 60000 }, (_, index) =>
        index % 5 === 4
          ? `##[error]src/a.mjs:${index}:1 lint`
          : `line ${index}`,
      ),
      "##[error]Process completed with exit code 1.",
    ];
    const rss = process.resourceUsage().maxRSS;
    const started = performance.now();
    const read = excerpt(lines.join("\n")).split("\n");
    // Each line of the log once, not each line once for each error: 12,000 errors
    // in 60,000 lines took more than ten seconds and 2 GB, and then threw.
    assert.ok(performance.now() - started < 2000);
    assert.ok(process.resourceUsage().maxRSS - rss < 256 * 1024);
    assert.ok(read.length <= READ.log);
    assert.ok(read.includes("##[group]Run npm run lint"));
    assert.ok(read.includes("##[error]src/a.mjs:4:1 lint"));
    assert.ok(read.includes("##[error]Process completed with exit code 1."));
  });

  it("cuts a long line, and leaves out a line of Harden-Runner's report anywhere", () => {
    assert.equal(
      excerpt(`${"x".repeat(READ.line + 5)}\ndomain resolved: github.com.`),
      `${"x".repeat(READ.line)}…`,
    );
  });
});

describe("a job that the owner holds", () => {
  const CONTROL = "monalisa/repo-pager-control";
  // 2026-11-12 at 18:00 UTC.
  const now = () => Date.UTC(2026, 10, 12, 18);
  const hold = (extra) => ({
    paused: false,
    daily: "",
    repository: CONTROL,
    run: "7700",
    now,
    ...extra,
  });
  const payload = { item: ITEM, repo: REPO, number: 31 };
  const EVENTS = {
    text: { action: "pager-text", client_payload: { text: "Hi", message: 3 } },
    draft: {
      action: "pager-draft",
      client_payload: { ...payload, pull: false },
    },
    discussion: {
      action: "pager-draft",
      client_payload: { ...payload, pull: false, discussion: true },
    },
    fix: {
      action: "pager-fix",
      client_payload: {
        item: ITEM,
        repo: REPO,
        kind: "alarm",
        entries: [
          { label: "A bot fails", url: `https://github.com/${REPO}/issues/9` },
        ],
      },
    },
    translate: {
      action: "pager-translate",
      client_payload: {
        ...payload,
        of: "0a1b2c3d",
        lines: ["the pager speaks German"],
        language: "de",
      },
    },
  };
  const RUNS = /\/actions\/workflows\/pager\.yml\/runs\?/;
  /**
   * Today's runs of the workflow on GitHub, by their titles; the first is this
   * run, 7700, and the others started before it, or after it from `newer` on.
   */
  const runsOf = (titles, newer = titles.length) =>
    new Net().on("GET", RUNS, (call) => {
      const page = Number(new URL(call.url).searchParams.get("page"));
      const runs = titles.map((title, index) => ({
        id: index === 0 ? 7700 : index + (index >= newer ? 7700 : 0),
        display_title: title,
      }));
      return json({
        total_count: runs.length,
        workflow_runs: runs.slice((page - 1) * 100, page * 100),
      });
    });
  async function prepareHeld(net, event, extra) {
    const out = await mkdtemp(join(tmpdir(), "pager-"));
    const result = await prepare({
      eventName: "repository_dispatch",
      event,
      owner: OWNER,
      api: api(net),
      out,
      read,
      hold: hold(extra),
    });
    const names = (await readdir(out, { recursive: true })).sort();
    return { ...result, names };
  }

  it("counts a translation and the draft of a discussion as jobs that start by themselves", () => {
    assert.equal(byItself({ kind: "translate" }), true);
    assert.equal(byItself({ kind: "draft", discussion: true }), true);
    assert.equal(byItself({ kind: "draft", pull: false }), false);
    assert.equal(byItself({ kind: "draft", pull: true }), false);
    assert.equal(byItself({ kind: "fix" }), false);
    assert.equal(byItself({ kind: "text" }), false);
  });

  it("holds every kind of job with PAGER_PAUSED, collects nothing and says why", async () => {
    for (const event of Object.values(EVENTS)) {
      const net = new Net();
      const { outputs, names } = await prepareHeld(net, event, {
        paused: true,
        daily: "5",
      });
      assert.equal(
        outputs.error,
        "the jobs of the pager are paused by PAGER_PAUSED; delete the variable to start them again",
      );
      assert.equal(net.calls.length, 0, event.action);
      assert.deepEqual(names, ["logs", "rules.md", "task.md"]);
    }
  });

  it("runs a job that starts by itself while today's runs are below PAGER_DAILY_RUNS", async () => {
    const net = runsOf([
      `pager-draft${BY_ITSELF}`,
      `pager-translate${BY_ITSELF}`,
      "pager-draft",
      "pager-text",
    ]);
    // This run and the presses don't count: one of two.
    const { outputs, names } = await prepareHeld(net, EVENTS.translate, {
      daily: "2",
    });
    assert.equal(outputs.error, "");
    assert.equal(outputs.model, "claude-sonnet-5-5");
    assert.deepEqual(names, ["logs", "rules.md", "task.md"]);
    assert.equal(net.calls.length, 1);
    const url = new URL(net.calls[0].url);
    assert.equal(
      url.pathname,
      `/repos/${CONTROL}/actions/workflows/pager.yml/runs`,
    );
    assert.equal(url.searchParams.get("event"), "repository_dispatch");
    assert.equal(url.searchParams.get("created"), ">=2026-11-12T00:00:00Z");
    assert.equal(url.searchParams.get("per_page"), "100");
    assert.equal(url.searchParams.get("page"), "1");
    // The draft of a discussion below the limit reads its thread.
    const thread = runsOf(["pager-draft (by itself)"]);
    const draft = await prepareHeld(thread, EVENTS.discussion, { daily: "1" });
    assert.match(draft.outputs.error, /the thread didn't come from GitHub/);
    assert.equal(thread.calls.at(-1).url, "https://api.github.com/graphql");
  });

  it("holds a job that starts by itself once today's runs reach PAGER_DAILY_RUNS", async () => {
    for (const event of [EVENTS.discussion, EVENTS.translate]) {
      const net = runsOf([
        `pager-translate${BY_ITSELF}`,
        `pager-draft${BY_ITSELF}`,
        `pager-translate${BY_ITSELF}`,
      ]);
      const { outputs, names } = await prepareHeld(net, event, { daily: "2" });
      assert.equal(
        outputs.error,
        "today's runs that start by themselves, drafts of discussions and translations, reached PAGER_DAILY_RUNS, 2; the count starts again at 00:00 UTC",
      );
      assert.equal(net.calls.length, 1);
      assert.deepEqual(names, ["logs", "rules.md", "task.md"]);
    }
    const first = runsOf([`pager-translate${BY_ITSELF}`]);
    const zero = await prepareHeld(first, EVENTS.translate, { daily: "0" });
    assert.match(zero.outputs.error, /reached PAGER_DAILY_RUNS, 0;/);
  });

  it("counts only the runs that started before this one", async () => {
    // Five drafts start together with PAGER_DAILY_RUNS 3: the newer ones don't hold this one.
    const titles = Array.from({ length: 5 }, () => `pager-draft${BY_ITSELF}`);
    const third = runsOf(titles, 3);
    const runs = await prepareHeld(third, EVENTS.discussion, { daily: "3" });
    assert.doesNotMatch(runs.outputs.error, /PAGER_DAILY_RUNS/);
    const fourth = runsOf(titles, 4);
    const held = await prepareHeld(fourth, EVENTS.discussion, { daily: "3" });
    assert.match(held.outputs.error, /reached PAGER_DAILY_RUNS, 3;/);
  });

  it("reads the next page of runs only while the count stays below PAGER_DAILY_RUNS", async () => {
    const titles = [
      `pager-translate${BY_ITSELF}`,
      ...Array.from({ length: 150 }, (_, index) =>
        index % 2 === 0 ? `pager-draft${BY_ITSELF}` : "pager-draft",
      ),
    ];
    const reached = runsOf(titles);
    const full = await prepareHeld(reached, EVENTS.translate, { daily: "75" });
    assert.match(full.outputs.error, /reached PAGER_DAILY_RUNS, 75;/);
    assert.equal(reached.calls.length, 2);
    const below = runsOf(titles);
    const next = await prepareHeld(below, EVENTS.translate, { daily: "76" });
    assert.equal(next.outputs.error, "");
    assert.equal(below.calls.length, 2);
    const early = runsOf(titles);
    await prepareHeld(early, EVENTS.translate, { daily: "10" });
    assert.equal(early.calls.length, 1);
  });

  it("never counts a press of the owner, nor without PAGER_DAILY_RUNS", async () => {
    const net = new Net();
    for (const job of [
      { kind: "draft", pull: false },
      { kind: "draft", pull: true },
      { kind: "fix" },
      { kind: "text" },
    ]) {
      assert.equal(await held(job, api(net), hold({ daily: "0" })), "");
    }
    assert.equal(
      await held({ kind: "translate" }, api(net), hold({ daily: "" })),
      "",
    );
    assert.equal(net.calls.length, 0);
    const text = await prepareHeld(
      new Net().on("POST", "/graphql", () => json({ data: {} })),
      EVENTS.text,
      { daily: "0" },
    );
    assert.equal(text.outputs.error, "");
  });

  it("holds a job that starts by itself when PAGER_DAILY_RUNS isn't a whole number", async () => {
    for (const daily of ["ten", "-1", "1.5", "x".repeat(60)]) {
      const net = new Net();
      assert.equal(
        await held({ kind: "translate" }, api(net), hold({ daily })),
        `PAGER_DAILY_RUNS isn't a whole number from 0 but ${daily.slice(0, 40)}, so no job that starts by itself runs`,
      );
      assert.equal(net.calls.length, 0);
    }
  });

  it("holds a job that starts by itself when GitHub doesn't give today's runs", async () => {
    const refused = new Net().on("GET", RUNS, () =>
      json({ message: "Resource not accessible by integration" }, 403),
    );
    assert.equal(
      await held({ kind: "translate" }, api(refused), hold({ daily: "3" })),
      "today's runs of the pager didn't come from GitHub, so PAGER_DAILY_RUNS can't be kept: GitHub answered 403: Resource not accessible by integration",
    );
    // An answer without runs, or a run without a title, counts none.
    const empty = new Net().on("GET", RUNS, () => json({}));
    assert.equal(
      await held({ kind: "translate" }, api(empty), hold({ daily: "3" })),
      "",
    );
    const untitled = new Net().on("GET", RUNS, () =>
      json({ workflow_runs: [{ id: 5 }] }),
    );
    assert.equal(
      await held({ kind: "translate" }, api(untitled), hold({ daily: "1" })),
      "",
    );
    const broken = new Net().on("GET", RUNS, () => {
      throw new TypeError("a bug");
    });
    await assert.rejects(
      held({ kind: "translate" }, api(broken), hold({ daily: "3" })),
      TypeError,
    );
  });
});
