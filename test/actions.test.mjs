// The check of the actions that an allowed action runs itself, as GitHub checks them
// against the Actions policy: what it reads, what it lets pass and how it fails,
// against a simulated GitHub.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ALLOWED,
  allowed,
  checkActions,
  parse,
  pinned,
  usesOf,
} from "../pager/actions.mjs";
import { Refusal } from "../pager/core.mjs";
import { GitHub } from "../pager/github.mjs";
import { main } from "../pager/job.mjs";
import { json, Net } from "./fake.mjs";

const CLAUDE = "anthropics/claude-code-action";
const CLAUDE_SHA = "61a9c274fa7110a66dfafc1bbbced03833eb25fe";
const BUN = "oven-sh/setup-bun";
const BUN_SHA = "0c5077e51419868618aeaa5fe8019c62421857d6";
const SHA = "1111111111111111111111111111111111111111";

const WORKFLOW = `jobs:
  ask:
    steps:
      - uses: actions/checkout@${SHA} # v7
      - name: Run Claude
        uses: ${CLAUDE}@${CLAUDE_SHA} # v1.0.269
`;

/** The action.yml of a composite action that runs each of uses. */
function composite(...uses) {
  return `runs:
  using: "composite"
  steps:
${uses.map((target) => `    - name: A step\n      uses: ${target}\n`).join("")}`;
}

const NODE = `runs:\n  using: "node24"\n  main: dist/index.js\n`;

/** The contents API of GitHub for a file. */
function file(text) {
  return json({
    type: "file",
    encoding: "base64",
    content: Buffer.from(text).toString("base64"),
  });
}

/** A GitHub whose actions have these action.yml files, by `owner/repo[/path]@ref`. */
function github(files) {
  const net = new Net();
  for (const [target, text] of Object.entries(files)) {
    const { repository, path, ref } = parse(target);
    const folder = path === "" ? "" : `${path}/`;
    net.on(
      "GET",
      `/repos/${repository}/contents/${folder}action.yml?ref=${ref}`,
      () => file(text),
    );
  }
  return net;
}

/** The action.yml of the claude-code-action that ask.yml pins today. */
function today() {
  return github({
    [`${CLAUDE}@${CLAUDE_SHA}`]: composite(
      `${BUN}@${BUN_SHA} # https://github.com/oven-sh/setup-bun/releases/tag/v2.2.0`,
      `actions/cache@${SHA}`,
      "./local-step",
    ),
    [`${BUN}@${BUN_SHA}`]: NODE,
  });
}

function check(net, workflows = [WORKFLOW], list = ALLOWED) {
  return checkActions({
    api: new GitHub("ghs_test", net.fetch),
    workflows,
    list,
  });
}

async function refusal(promise, pattern) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof Refusal);
    assert.match(error.message, pattern);
    return true;
  });
}

describe("the actions of the Actions policy", () => {
  it("allow claude-code-action and the setup-bun that it runs, besides GitHub's own", () => {
    assert.deepEqual(ALLOWED, [CLAUDE, BUN]);
    assert.ok(allowed(`actions/checkout@${SHA}`));
    assert.ok(allowed(`github/codeql-action/init@${SHA}`));
    assert.ok(allowed(`${CLAUDE}@${CLAUDE_SHA}`));
    assert.ok(allowed(`${CLAUDE}/base-action@${CLAUDE_SHA}`));
    assert.ok(allowed(`${BUN}@${BUN_SHA}`));
    assert.ok(!allowed(`oven-sh/setup-node@${SHA}`));
    assert.ok(!allowed(`anthropics/other@${SHA}`));
  });

  it("read an action, its path and its ref from a uses", () => {
    assert.deepEqual(parse(`${CLAUDE}/base-action/sub@v1`), {
      owner: "anthropics",
      repository: CLAUDE,
      path: "base-action/sub",
      ref: "v1",
    });
    assert.deepEqual(parse("nothing"), {
      owner: "nothing",
      repository: "nothing/",
      path: "",
      ref: "",
    });
    assert.ok(pinned(`${BUN}@${BUN_SHA}`));
    assert.ok(!pinned(`${BUN}@v2`));
    assert.ok(!pinned(BUN));
  });

  it("take each uses of another repository, without its comment or its quotes", () => {
    assert.deepEqual(
      usesOf(`steps:
  - uses: actions/checkout@${SHA} # v7
    with: {}
  - name: x
    uses: "${BUN}@${BUN_SHA}"
  - uses: './local'
  - uses: docker://alpine:3
  - uses: ./.github/workflows/check-token.yml
`),
      [`actions/checkout@${SHA}`, `${BUN}@${BUN_SHA}`],
    );
  });
});

describe("the check of what the allowed actions run", () => {
  it("passes with the list of the README for the action that ask.yml pins today", async () => {
    const net = today();
    assert.equal(
      await check(net),
      `The Actions policy allows all that ${CLAUDE} and ${BUN} run: ${CLAUDE}@${CLAUDE_SHA} runs ${BUN}@${BUN_SHA}, ${CLAUDE}@${CLAUDE_SHA} runs actions/cache@${SHA}.`,
    );
    // GitHub's own actions are allowed with all they run, so it reads none of them.
    assert.deepEqual(
      net.calls.map((call) => new URL(call.url).pathname),
      [
        `/repos/${CLAUDE}/contents/action.yml`,
        `/repos/${BUN}/contents/action.yml`,
      ],
    );
    assert.equal(net.calls[0].headers.authorization, "Bearer ghs_test");
  });

  it("fails as GitHub fails the job, without setup-bun on the list", async () => {
    await refusal(
      check(today(), [WORKFLOW], [CLAUDE]),
      new RegExp(
        `^${CLAUDE}@${CLAUDE_SHA} runs ${BUN}@${BUN_SHA}, which the Actions policy doesn't allow, so GitHub refuses every job that uses ${CLAUDE}: add ${BUN}@\\* to ALLOWED in pager/actions\\.mjs, to both pairs of commands of README\\.md and to the Actions policy of the template and of each copy$`,
      ),
    );
  });

  it("follows an allowed action that an allowed action runs, once, and names each that the policy refuses", async () => {
    const net = github({
      [`${CLAUDE}@${CLAUDE_SHA}`]: composite(
        `${BUN}@${BUN_SHA}`,
        `${CLAUDE}/base-action@${CLAUDE_SHA}`,
      ),
      [`${CLAUDE}/base-action@${CLAUDE_SHA}`]: composite(
        `${BUN}@${BUN_SHA}`,
        `${BUN}@v2`,
        `somebody/new-action@${SHA}`,
      ),
      [`${BUN}@${BUN_SHA}`]: NODE,
    });
    await refusal(
      check(net),
      new RegExp(
        [
          `^${CLAUDE}/base-action@${CLAUDE_SHA} runs ${BUN}@v2, which isn't pinned to a commit, so the required SHA pinning of the Actions policy refuses every job that uses ${CLAUDE}`,
          ` ${CLAUDE}/base-action@${CLAUDE_SHA} runs somebody/new-action@${SHA}, which the Actions policy doesn't allow, .* add somebody/new-action@\\* to ALLOWED`,
        ].join("\\."),
      ),
    );
    // setup-bun, which two of them run, is read once.
    assert.equal(
      net.to(`/repos/${BUN}/contents/action.yml?ref=${BUN_SHA}`).length,
      1,
    );
  });

  it("reads an action.yaml where there is no action.yml", async () => {
    const net = new Net().on(
      "GET",
      `/repos/${CLAUDE}/contents/action.yaml?ref=${CLAUDE_SHA}`,
      () => file(NODE),
    );
    assert.equal(await check(net), `${CLAUDE} run no other action.`);
    assert.equal(net.calls.length, 2);
  });

  it("fails on an allowed action that has no action.yml at its commit", async () => {
    await refusal(
      check(new Net()),
      new RegExp(`^${CLAUDE}@${CLAUDE_SHA} has no action\\.yml at its ref$`),
    );
  });

  it("names GitHub's refusal, and what it read", async () => {
    const net = new Net().on("GET", /action\.yml/, () =>
      json({ message: "API rate limit exceeded" }, 403),
    );
    await refusal(
      check(net),
      new RegExp(
        `^GitHub answered 403: API rate limit exceeded, for the action\\.yml of ${CLAUDE}@${CLAUDE_SHA}$`,
      ),
    );
  });

  it("lets an error of the network through, which is no answer of GitHub", async () => {
    const net = new Net().on("GET", /action\.yml/, () => {
      throw new TypeError("fetch failed");
    });
    await assert.rejects(check(net), { name: "TypeError" });
  });

  it("fails when no workflow runs an allowed action pinned to a commit, so the check would check nothing", async () => {
    for (const workflow of [
      `steps:\n  - uses: actions/checkout@${SHA}\n`,
      `steps:\n  - uses: ${CLAUDE}@v1\n`,
    ]) {
      const net = new Net();
      await refusal(
        check(net, [workflow]),
        /^No workflow runs an action of anthropics\/claude-code-action or oven-sh\/setup-bun pinned to a commit: correct ALLOWED/,
      );
      assert.equal(net.calls.length, 0);
    }
  });
});

describe("the command actions", () => {
  it("reads the workflows of this repository and checks the action that ask.yml pins", async () => {
    // Whatever ask.yml pins: each action.yml of an allowed action runs nothing.
    const net = new Net().on("GET", /\/contents\/action\.yml\?ref=/, () =>
      file(NODE),
    );
    const lines = [];
    const io = { fetch: net.fetch, log: (line) => lines.push(line) };
    assert.equal(await main("actions", { GH_TOKEN: "ghs_test" }, io), 0);
    assert.match(
      lines[0],
      /^anthropics\/claude-code-action run no other action\.$/,
    );
    assert.match(
      net.calls[0].url,
      /\/repos\/anthropics\/claude-code-action\/contents\/action\.yml\?ref=[0-9a-f]{40}$/,
    );
  });

  it("fails the step with the reason as an error", async () => {
    const lines = [];
    const io = { fetch: new Net().fetch, log: (line) => lines.push(line) };
    assert.equal(await main("actions", { GH_TOKEN: "ghs_test" }, io), 1);
    assert.match(
      lines[0],
      /^::error::anthropics\/claude-code-action@[0-9a-f]{40} has no action\.yml at its ref$/,
    );
  });
});
