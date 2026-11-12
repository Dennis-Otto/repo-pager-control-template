// The promises of the README about the workflows, which the settings of the template
// enforce on GitHub as well: only GitHub's own actions and anthropics/claude-code-action
// run, each pinned to a commit (the Actions policy of selected actions with required SHA
// pinning), every job gets contents: read at most, and the three exceptions: the
// workflow Dependabot merges only a pull request of Dependabot, in the template alone,
// the workflow Health keeps one issue of a failed check, and the job prepare of the
// workflow Pager reads today's runs of its own workflow for PAGER_DAILY_RUNS.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { BY_ITSELF } from "../pager/prepare.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS = ".github/workflows";
// The one workflow whose job writes, and what it may write.
const MERGE = "dependabot.yml";
const MERGE_PERMISSIONS = ["contents: write", "pull-requests: write"];
// The workflow whose jobs keep the issue of a failed check, and what they may write.
const HEALTH = "health.yml";
const HEALTH_PERMISSIONS = ["contents: read", "issues: write"];
// The workflow whose job prepare counts its runs of today, and what it may read.
const PAGER = "pager.yml";
const PAGER_PERMISSIONS = ["contents: read", "actions: read"];
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
      const allowed = {
        [MERGE]: MERGE_PERMISSIONS,
        [HEALTH]: HEALTH_PERMISSIONS,
        [PAGER]: PAGER_PERMISSIONS,
      }[name] ?? ["contents: read"];
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

describe("the workflow Health", () => {
  const text = read(`${WORKFLOWS}/${HEALTH}`);
  const check = text.slice(text.indexOf("  health:"), text.indexOf("  issue:"));
  const issue = text.slice(text.indexOf("  issue:"));

  it("hands the problems of the check to the job issue, also of a run that failed", () => {
    assert.match(
      check,
      /^ {6}problems: \$\{\{ steps\.check\.outputs\.problems \}\}$/m,
    );
    assert.match(check, /^ {8}id: check$/m);
    assert.match(issue, /^ {4}needs: health$/m);
    assert.match(issue, /^ {4}if: failure\(\)$/m);
    assert.match(
      issue,
      /^ {10}HEALTH_RESULT: failure\n {10}HEALTH_PROBLEMS: \$\{\{ needs\.health\.outputs\.problems \}\}\n {8}run: node pager\/job\.mjs health-issue$/m,
    );
  });

  it("closes the issue only after the check passed, and gives the step of the secrets no token of GitHub", () => {
    assert.match(
      check,
      /^ {6}- name: Close the issue of a failed check\n {8}env:\n {10}GH_TOKEN: \$\{\{ github\.token \}\}\n {10}HEALTH_RESULT: success\n {8}run: node pager\/job\.mjs health-issue$/m,
    );
    const secrets = check.slice(
      check.indexOf("id: check"),
      check.indexOf("- name: Close the issue"),
    );
    assert.match(secrets, /PAGER_CONTROL_SECRET/);
    assert.doesNotMatch(secrets, /GH_TOKEN|github\.token|if:/);
  });
});

describe("the workflow Pager", () => {
  const text = read(`${WORKFLOWS}/${PAGER}`);
  const prepare = text.slice(
    text.indexOf("  prepare:"),
    text.indexOf("  ask:"),
  );

  it("gives actions: read to the job prepare alone, which counts the runs", () => {
    assert.equal(text.match(/^\s+actions: read$/gm).length, 1);
    assert.match(prepare, /^ {6}actions: read$/m);
  });

  it("titles a run that starts by itself as byItself of pager/prepare.mjs says", () => {
    // Change both together: PAGER_DAILY_RUNS counts the runs by this title.
    assert.equal(
      text.match(/^run-name: (.*)$/m)[1],
      `\${{ github.event.action || 'Pager' }}\${{ (github.event.action == 'pager-translate' || (github.event.action == 'pager-draft' && github.event.client_payload.discussion == true)) && '${BY_ITSELF}' || '' }}`,
    );
  });

  it("hands PAGER_PAUSED and PAGER_DAILY_RUNS to the job prepare", () => {
    assert.match(
      prepare,
      /^ {10}PAGER_PAUSED: \$\{\{ vars\.PAGER_PAUSED \}\}$/m,
    );
    assert.match(
      prepare,
      /^ {10}PAGER_DAILY_RUNS: \$\{\{ vars\.PAGER_DAILY_RUNS \}\}$/m,
    );
  });
});
