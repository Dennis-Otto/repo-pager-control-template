// The smoke test of a fix: its task, its limits, and the check of the change that
// came of it, against a patch of git and the transcript of Claude Code.
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { LIMITS, PROMPT, Refusal } from "../pager/core.mjs";
import {
  addedLines,
  checkSmokeFix,
  denialsOf,
  prepareSmokeFix,
  SMOKE_FIX,
  SMOKE_LIMITS,
} from "../pager/smoke.mjs";

/** A patch of git that adds each line to its file, as git diff writes it. */
function patchOf(changes) {
  return changes
    .flatMap(([path, line]) => [
      `diff --git a/${path} b/${path}`,
      "index 1111111..2222222 100644",
      `--- a/${path}`,
      `+++ b/${path}`,
      "@@ -1,1 +1,2 @@",
      " name: x",
      `+${line}`,
    ])
    .join("\n");
}

const BOTH = patchOf(SMOKE_FIX.map(({ path, line }) => [path, line]));

const PLAN = JSON.stringify({
  answer: "Changed both.",
  changed: true,
  title: "test: the smoke test of a fix",
  body: "Two lines.",
});

function refusal(fields) {
  try {
    checkSmokeFix({
      plan: PLAN,
      changed: true,
      patch: BOTH,
      execution: "",
      owner: "monalisa",
      ...fields,
    });
  } catch (error) {
    assert.ok(error instanceof Refusal);
    return error.message;
  }
  assert.fail("the check passed");
}

describe("the smoke test of a fix", () => {
  it("runs with the tools and the mode of a fix, and changes a workflow", () => {
    assert.equal(SMOKE_LIMITS.tools, LIMITS.fix.tools);
    assert.equal(SMOKE_LIMITS.mode, LIMITS.fix.mode);
    assert.equal(SMOKE_LIMITS.turns, "");
    assert.ok(Number(SMOKE_LIMITS.budget) < Number(LIMITS.fix.budget));
    assert.ok(
      SMOKE_FIX.some(({ path }) => path.startsWith(".github/workflows/")),
    );
  });

  it("writes its task and the rules, and names the prompt of a fix", async () => {
    const out = join(await mkdtemp(join(tmpdir(), "pager-smoke-")), "input");
    const outputs = await prepareSmokeFix({
      out,
      read: async (name) => `the ${name}`,
    });
    assert.equal(outputs.prompt, PROMPT);
    assert.equal(outputs.model, "claude-sonnet-5-5");
    assert.equal(JSON.parse(outputs.schema).properties.changed.type, "boolean");
    assert.equal(await readFile(join(out, "rules.md"), "utf8"), "the rules.md");
    const task = await readFile(join(out, "task.md"), "utf8");
    for (const { path, line } of SMOKE_FIX) {
      assert.ok(task.includes(`\`${line}\` at the end of \`repo/${path}\``));
    }
  });

  it("reads the lines that a patch adds, by their file", () => {
    const added = addedLines(
      [
        "+not in a file",
        "@@ -1 +1 @@",
        "+nor this",
        "diff --git a/a.txt b/a.txt",
        "--- a/a.txt",
        "+++ b/a.txt",
        "@@ -1,2 +1,2 @@",
        "-gone",
        "+++ kept, a line that starts with two pluses",
        "+new",
        "diff --git a/old.txt b/new.txt",
        "rename from old.txt",
      ].join("\n"),
    );
    assert.deepEqual(
      [...added],
      [
        ["a.txt", ["++ kept, a line that starts with two pluses", "new"]],
        ["new.txt", []],
      ],
    );
  });

  it("names the writes that Claude Code refused", () => {
    const result = (denials) =>
      JSON.stringify([{ type: "system" }, { type: "result", ...denials }]);
    assert.deepEqual(
      denialsOf(
        result({
          permission_denials: [
            { tool_name: "Write", tool_input: { file_path: "repo/a.yml" } },
            { tool_name: "Edit", tool_input: {} },
            {},
          ],
        }),
      ),
      ["Write repo/a.yml", "Edit", "a tool"],
    );
    assert.deepEqual(denialsOf(result({})), []);
    assert.deepEqual(denialsOf('{"type":"result"}'), []);
    assert.deepEqual(denialsOf("not json"), []);
  });

  it("passes for a change that adds its line to each file", () => {
    assert.equal(
      checkSmokeFix({
        plan: PLAN,
        changed: true,
        patch: BOTH,
        execution: "",
        owner: "monalisa",
      }),
      "Claude changed .github/workflows/smoke.yml and README.md as a fix does: Changed both.",
    );
  });

  it("fails for a change that leaves out the workflow, with what was refused", () => {
    const [workflow, readme] = SMOKE_FIX;
    const message = refusal({
      patch: patchOf([[readme.path, readme.line]]),
      execution: JSON.stringify([
        {
          type: "result",
          permission_denials: [
            {
              tool_name: "Edit",
              tool_input: { file_path: `repo/${workflow.path}` },
            },
          ],
        },
      ]),
    });
    assert.equal(
      message,
      `A fix can't change what it should: the change doesn't add its line to ${workflow.path}. Claude Code refused Edit repo/${workflow.path}. Claude answered: Changed both.`,
    );
  });

  it("fails for no change, and for a change of other files", () => {
    assert.match(
      refusal({ changed: false, patch: "" }),
      /^A fix can't change what it should: the job ask collected no change of the checkout; the change doesn't add its line to \.github\/workflows\/smoke\.yml; the change doesn't add its line to README\.md\. Claude Code refused no write\./,
    );
    assert.match(
      refusal({ patch: `${BOTH}\n${patchOf([["pager/core.mjs", "x"]])}` }),
      /the change touches other files: pager\/core\.mjs\./,
    );
  });

  it("fails for an answer outside the schema of a fix", () => {
    assert.throws(
      () =>
        checkSmokeFix({
          plan: '{"answer":"Done."}',
          changed: true,
          patch: BOTH,
          execution: "",
          owner: "monalisa",
        }),
      /the answer has no changed/,
    );
  });
});

describe("the workflows of a fix", () => {
  const workflow = (name) =>
    readFile(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");

  it("give Claude Code the mode of its kind", async () => {
    assert.match(
      await workflow("ask.yml"),
      /--permission-prompts none\n {12}\$\{\{ inputs\.mode != '' && format\('--permission-mode \{0\}', inputs\.mode\) \|\| '' \}\}\n/,
    );
    for (const name of [
      "pager.yml",
      "smoke.yml",
      "smoke-translate.yml",
      "smoke-fix.yml",
    ]) {
      const text = await workflow(name);
      assert.match(text, /mode: \$\{\{ steps\.prepare\.outputs\.mode \}\}/);
      assert.match(text, /mode: \$\{\{ needs\.prepare\.outputs\.mode \}\}/);
    }
  });

  it("run the smoke test of a fix on a checkout of this repository", async () => {
    const smoke = await workflow("smoke-fix.yml");
    assert.match(smoke, /kind: fix\n/);
    assert.match(smoke, /repo: \$\{\{ github\.repository \}\}\n/);
    assert.match(smoke, /run: node pager\/job\.mjs smoke-fix\n/);
    assert.match(smoke, /run: node pager\/job\.mjs smoke-fix-check\n/);
    assert.doesNotMatch(smoke, /repo-pager\b(?!-control)/);
  });
});
