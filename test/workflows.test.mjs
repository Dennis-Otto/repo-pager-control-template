// The promises of the README about the workflows, which the settings of the template
// enforce on GitHub as well: only GitHub's own actions and anthropics/claude-code-action
// run, each pinned to a commit (the Actions policy of selected actions with required SHA
// pinning), every job gets contents: read at most, and the one exception, the workflow
// Dependabot, merges only a pull request of Dependabot, in the template alone.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS = ".github/workflows";
// The one workflow whose job writes, and what it may write.
const MERGE = "dependabot.yml";
const MERGE_PERMISSIONS = ["contents: write", "pull-requests: write"];
// The actions that the Actions policy of the template allows besides GitHub's own.
const ALLOWED = ["anthropics/claude-code-action"];

function read(path) {
  return readFileSync(join(ROOT, path), "utf8");
}

const workflows = readdirSync(join(ROOT, WORKFLOWS))
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => ({ name, text: read(`${WORKFLOWS}/${name}`) }));

// As in test/pins.test.mjs: the template, not a control repository, which may add
// workflows of its own and sets its own policy.
const template =
  JSON.parse(read(".github/template.json")).commit === "" &&
  existsSync(join(ROOT, ".github/dependabot.yml"));

/** Each `uses:` of a text that runs an action or a workflow of another repository. */
function usesOf(text) {
  return [...text.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)]
    .map(([, target]) => target)
    .filter((target) => !target.startsWith("./"));
}

describe("the workflows of the template", {
  skip: !template && "a control repository sets its own policy",
}, () => {
  it("run only GitHub's own actions and those that the policy allows, each pinned to a commit", () => {
    const refused = workflows.flatMap(({ name, text }) =>
      usesOf(text)
        .filter((target) => {
          const [action, ref = ""] = target.split("@");
          const owner = action.split("/")[0];
          const allowed =
            ["actions", "github"].includes(owner) ||
            ALLOWED.some(
              (entry) => action === entry || action.startsWith(`${entry}/`),
            );
          return !allowed || !/^[0-9a-f]{40}$/.test(ref);
        })
        .map((target) => `${name}: ${target}`),
    );
    assert.deepEqual(
      refused,
      [],
      "pin the action to a commit, or add it to ALLOWED here, to the README and to the Actions policy of the template",
    );
  });

  it("start with no permissions and give a job contents: read at most", () => {
    for (const { name, text } of workflows) {
      assert.match(text, /^permissions: \{\}$/m, `${name} starts elsewhere`);
      const granted = [
        ...text.matchAll(/^\s+([a-z-]+: (?:read|write))\s*$/gm),
      ].map(([, line]) => line);
      const allowed = name === MERGE ? MERGE_PERMISSIONS : ["contents: read"];
      assert.deepEqual(
        granted.filter((line) => !allowed.includes(line)),
        [],
        `${name} grants more than ${allowed.join(" and ")}`,
      );
      assert.doesNotMatch(text, /permissions: (?:read|write)-all/, name);
    }
  });

  it("has the comment of dependabot.yml name the workflow that merges", () => {
    assert.match(
      read(".github/dependabot.yml"),
      /merges by itself once they pass, through the workflow Dependabot/,
    );
  });
});

describe("the workflow Dependabot", () => {
  const text = read(`${WORKFLOWS}/${MERGE}`);

  it("runs only for a pull request that Dependabot opened, in the template", () => {
    assert.match(text, /^ {2}pull_request:\n {4}types: \[opened, reopened\]$/m);
    assert.match(
      text,
      /^ {4}if: \$\{\{ github\.event\.pull_request\.user\.login == 'dependabot\[bot\]' && github\.event\.repository\.is_template \}\}$/m,
    );
    assert.doesNotMatch(text, /pull_request_target|github\.actor/);
  });

  it("turns on auto-merge with a squash, which waits for the required check", () => {
    assert.match(text, /^ {10}gh pr merge --auto --squash "\$PULL_REQUEST"$/m);
    assert.doesNotMatch(text, /--admin/);
  });

  it("warns instead of failing while the setting Allow auto-merge is off", () => {
    assert.match(
      text,
      /if \[ "\$\(gh api "repos\/\$REPOSITORY" --jq \.allow_auto_merge\)" != true \]; then\n\s+echo "::warning::[^"]+"\n\s+exit 0\n/,
    );
  });
});
