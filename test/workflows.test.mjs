// The promises of the README about the workflows, which the settings of the template
// enforce on GitHub as well: only GitHub's own actions and anthropics/claude-code-action
// run, each pinned to a commit (the Actions policy of selected actions with required SHA
// pinning), every job gets contents: read at most, and the three exceptions: the
// workflow Dependabot merges only a pull request of Dependabot, in the template alone,
// the workflow Health keeps one issue of a failed check, the job prepare of the
// workflow Pager reads today's runs of its own workflow for PAGER_DAILY_RUNS, and the
// workflow Template reads the checks of its pull request for `merge`.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { PACK } from "../pager/pack.mjs";
import { BY_ITSELF } from "../pager/prepare.mjs";
import { WAIT } from "../pager/template.mjs";
import { IN_TEMPLATE, ROOT } from "./where.mjs";

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
// The workflow whose pull request merges by itself, and what it may read for that.
const TEMPLATE = "template.yml";
const TEMPLATE_PERMISSIONS = [
  "contents: read",
  "actions: read",
  "checks: read",
  "pull-requests: read",
];
// The actions that the Actions policy of the template allows besides GitHub's own.
const ALLOWED = ["anthropics/claude-code-action"];

function read(path) {
  return readFileSync(join(ROOT, path), "utf8");
}

const workflows = readdirSync(join(ROOT, WORKFLOWS))
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => ({ name, text: read(`${WORKFLOWS}/${name}`) }));

/** Each `uses:` of a text that runs an action or a workflow of another repository. */
function usesOf(text) {
  return [...text.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)]
    .map(([, target]) => target)
    .filter((target) => !target.startsWith("./"));
}

// As in test/pins.test.mjs: the template, not a control repository, which may add
// workflows of its own and sets its own policy.
describe("the workflows of the template", {
  skip: !IN_TEMPLATE && "a control repository sets its own policy",
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
        [TEMPLATE]: TEMPLATE_PERMISSIONS,
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

describe("the workflow Tests", () => {
  const text = read(`${WORKFLOWS}/test.yml`);

  it("checks the diagrams without Docker, as npm run diagrams does", () => {
    assert.equal(
      JSON.parse(read("package.json")).scripts.diagrams,
      "bash scripts/diagrams.sh --check",
    );
    assert.match(
      text,
      /^ {6}- name: Check the diagrams\n {8}if: \$\{\{ !cancelled\(\) \}\}\n {8}run: npm run diagrams$/m,
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

  it("checks PAGER_MODEL and PAGER_LIMITS in the job prepare, whose limits alone reach Claude", () => {
    for (const name of [PAGER, "smoke.yml", "smoke-translate.yml"]) {
      const workflow = read(`${WORKFLOWS}/${name}`);
      for (const variable of ["PAGER_MODEL", "PAGER_LIMITS"]) {
        assert.match(
          workflow,
          new RegExp(
            `^ {10}${variable}: \\$\\{\\{ vars\\.${variable} \\}\\}$`,
            "m",
          ),
          `${name} ${variable}`,
        );
      }
    }
    assert.match(
      read(`${WORKFLOWS}/smoke-fix.yml`),
      /^ {10}PAGER_MODEL: \$\{\{ vars\.PAGER_MODEL \}\}$/m,
    );
    // ask.yml takes the model that prepare checked, never the variable itself.
    const ask = read(`${WORKFLOWS}/ask.yml`);
    assert.match(ask, /^ {12}--model \$\{\{ inputs\.model \}\}$/m);
    assert.doesNotMatch(ask, /PAGER_MODEL \|\||vars\.PAGER_LIMITS/);
    // The footer names the effort that the run had.
    assert.match(
      text,
      /^ {10}EFFORT: \$\{\{ needs\.prepare\.outputs\.effort \}\}$/m,
    );
  });

  // The second try of the job of Claude: once, on a new machine, and only when the
  // first one missed its data or its checkout, so that Claude runs once in all.
  const jobOf = (name) => {
    const start = text.indexOf(`\n  ${name}:\n`);
    assert.notEqual(start, -1, name);
    const rest = text.slice(start + 1);
    const end = rest.slice(1).search(/\n {2}(?:# .*\n {2})*[a-z-]+:\n/);
    return end === -1 ? rest : rest.slice(0, end + 1);
  };
  const withOf = (job) =>
    job
      .slice(job.indexOf("    with:\n"), job.indexOf("    secrets:\n"))
      .split("\n")
      .filter((line) => !/^ {6}(?:# .*|retry: true)$/.test(line));

  it("tries the job of Claude once more, with the same inputs, only after a miss of its data", () => {
    const ask = jobOf("ask");
    const again = jobOf("ask-again");
    assert.equal(
      text.match(/^ {4}uses: \.\/\.github\/workflows\/ask\.yml /gm).length,
      2,
    );
    assert.match(ask, /^ {6}retry: true$/m);
    assert.doesNotMatch(again, /retry:/, "the second try is the last one");
    assert.deepEqual(withOf(again), withOf(ask));
    assert.match(again, /^ {4}needs: \[prepare, ask\]$/m);
    assert.match(again, /^ {4}if: needs\.ask\.outputs\.missing == 'true'$/m);
    assert.match(again, /^ {6}CLAUDE_CODE_OAUTH_TOKEN: /m);
  });

  it("opens the pull request and answers with the outputs of the try that ran Claude, once", () => {
    const pull = jobOf("pull-request");
    const answer = jobOf("answer");
    assert.match(pull, /^ {4}needs: \[prepare, ask, ask-again\]$/m);
    assert.match(
      pull,
      /^ {4}if: \$\{\{ !cancelled\(\) && \(needs\.ask\.outputs\.missing == 'true' && needs\.ask-again\.result \|\| needs\.ask\.result\) == 'success' && \(needs\.ask-again\.outputs\.changed \|\| needs\.ask\.outputs\.changed\) == 'true' \}\}$/m,
      "a failed try opens no pull request, even with a change",
    );
    for (const output of ["plan", "base"]) {
      assert.match(
        pull,
        new RegExp(
          `: \\$\\{\\{ needs\\.ask-again\\.outputs\\.${output} \\|\\| needs\\.ask\\.outputs\\.${output} \\}\\}$`,
          "m",
        ),
      );
    }
    assert.doesNotMatch(pull, /\{\{ needs\.ask\.outputs\.(?:plan|base) \}\}/);
    assert.match(
      answer,
      /^ {4}needs: \[prepare, ask, ask-again, pull-request\]$/m,
    );
    // A miss whose second try didn't run, such as for a cancel, is no success.
    assert.match(
      answer,
      /^ {10}ASK_RESULT: \$\{\{ needs\.ask\.outputs\.missing == 'true' && needs\.ask-again\.result \|\| needs\.ask\.result \}\}$/m,
    );
    for (const [name, output] of [
      ["PLAN", "plan"],
      ["CHANGED", "changed"],
    ]) {
      assert.match(
        answer,
        new RegExp(
          `^ {10}${name}: \\$\\{\\{ needs\\.ask-again\\.outputs\\.${output} \\|\\| needs\\.ask\\.outputs\\.${output} \\}\\}$`,
          "m",
        ),
      );
    }
    // One job sends the answer, so that the pager gets one for the job.
    assert.equal(text.match(/run: node pager\/job\.mjs answer$/gm).length, 1);
  });
});

describe("the workflow Ask Claude", () => {
  const text = read(`${WORKFLOWS}/ask.yml`);
  const stepOf = (name) => {
    const start = text.indexOf(`      - name: ${name}\n`);
    assert.notEqual(start, -1, name);
    const next = text.indexOf("\n      - name: ", start + 1);
    return next === -1 ? text.slice(start) : text.slice(start, next);
  };

  it("gives the data of the job and its checkout a short limit, and leaves a miss to the second try", () => {
    assert.match(
      text,
      /^ {6}retry:\n {8}description: .+\n {8}type: boolean\n {8}default: false$/m,
    );
    const data = stepOf("Get the data of the job");
    assert.match(data, /^ {8}id: data$/m);
    assert.match(data, /^ {8}timeout-minutes: 1$/m);
    const checkout = stepOf("Check out the repository of the job");
    assert.match(checkout, /^ {8}id: checkout$/m);
    assert.match(checkout, /^ {8}timeout-minutes: 5$/m);
    assert.match(
      checkout,
      /^ {8}if: steps\.data\.outcome == 'success' && inputs\.repo != ''$/m,
    );
    for (const step of [data, checkout]) {
      assert.match(step, /^ {8}continue-on-error: \$\{\{ inputs\.retry \}\}$/m);
    }
    assert.match(
      text,
      /^ {6}missing: \$\{\{ steps\.data\.outcome == 'failure' \|\| steps\.checkout\.outcome == 'failure' \}\}$/m,
    );
    assert.match(
      text,
      /^ {6}missing:\n {8}description: .+\n {8}value: \$\{\{ jobs\.ask\.outputs\.missing \}\}$/m,
    );
  });

  it("runs Claude only once its data and its checkout arrived", () => {
    assert.match(
      stepOf("Keep the history of git out of Claude's reach"),
      /^ {8}if: steps\.checkout\.outcome == 'success'$/m,
    );
    assert.match(
      stepOf("Ask Claude"),
      /^ {8}if: steps\.data\.outcome == 'success' && \(inputs\.repo == '' \|\| steps\.target\.outcome == 'success'\)$/m,
    );
  });

  it("keeps a miss fatal in the smoke tests, which have no second try", () => {
    for (const name of ["smoke.yml", "smoke-translate.yml", "smoke-fix.yml"]) {
      assert.doesNotMatch(read(`${WORKFLOWS}/${name}`), /retry:/, name);
    }
  });
});

describe("the workflow Template", () => {
  const text = read(`${WORKFLOWS}/${TEMPLATE}`);

  it("waits for the checks within its own run, on no trigger that a pull request starts", () => {
    assert.doesNotMatch(text, /workflow_run|pull_request/);
    const minutes = Number(text.match(/^ {4}timeout-minutes: (\d+)$/m)[1]);
    assert.ok(
      minutes * 60_000 > WAIT.every * WAIT.looks + 5 * 60_000,
      "the job ends before its wait for the checks",
    );
  });

  it("reads the checks with the token of the workflow and merges with PAGER_FIX_TOKEN", () => {
    assert.match(text, /^ {10}GITHUB_TOKEN: \$\{\{ github\.token \}\}$/m);
    assert.match(
      text,
      /^ {10}PAGER_FIX_TOKEN: \$\{\{ secrets\.PAGER_FIX_TOKEN \}\}$/m,
    );
    assert.doesNotMatch(text, /: write$/m);
  });
});

describe("the workflow Check the set-up", () => {
  const text = read(`${WORKFLOWS}/setup.yml`);
  const setup = text.slice(text.indexOf("  setup:"), text.indexOf("  claude:"));
  const claude = text.slice(text.indexOf("  claude:"));

  it("gives the check no token of Claude, only whether it is set", () => {
    assert.match(
      setup,
      /^ {10}CLAUDE_TOKEN_SET: \$\{\{ secrets\.CLAUDE_CODE_OAUTH_TOKEN != '' \}\}$/m,
    );
    assert.equal(setup.match(/CLAUDE_CODE_OAUTH_TOKEN/g).length, 1);
    assert.match(setup, /^ {8}run: node pager\/job\.mjs doctor$/m);
  });

  it("asks Claude for two words on the runner of the jobs of Claude, after the check", () => {
    assert.match(claude, /^ {4}needs: setup$/m);
    assert.match(
      claude,
      /^ {4}uses: \.\/\.github\/workflows\/check-token\.yml /m,
    );
    const runner = read(`${WORKFLOWS}/ask.yml`).match(
      /^ {4}runs-on: \$\{\{ (.+) \}\}$/m,
    )[1];
    assert.match(
      claude,
      new RegExp(
        `^ {6}runner: $\{{ ${runner.replace(/[.|()]/g, "$&")} }}$`,
        "m",
      ),
    );
    // By hand, Check the Claude token keeps its runner of every day.
    assert.match(
      read(`${WORKFLOWS}/check-token.yml`),
      /^ {4}runs-on: \$\{\{ inputs\.runner \|\| 'ubuntu-24\.04' \}\}$/m,
    );
  });

  it("skips the template, which has no set-up", () => {
    for (const job of [setup, claude]) {
      assert.match(
        job,
        /github\.repository != 'Dennis-Otto\/repo-pager-control-template'/,
      );
    }
  });
});

// The job of Claude runs on the egress-firewall runner, which now and then doesn't
// reach the storage of the artifacts: its data comes in its inputs, its change goes
// back in its outputs, packed as pager/pack.mjs says, and nothing that it needs or
// hands on goes through that storage.
describe("the hand-over of the data and the change", () => {
  const ask = read(`${WORKFLOWS}/ask.yml`);
  const numbered = (name, count) =>
    Array.from({ length: count }, (_, index) => `${name}${index + 1}`);
  const packs = numbered("pack", PACK.data);
  const patches = numbered("patch", PACK.patch);

  /** The steps of a workflow, each the text from its `- ` to the next one. */
  const stepsOf = (text) =>
    text
      .split(/\n(?= {6}- )/)
      .slice(1)
      .map((step) => step.split(/\n(?! {7,}| *$)/)[0]);

  it("gives the job of Claude no download of an artifact, and lets no upload fail a job", () => {
    assert.doesNotMatch(ask, /download-artifact/);
    for (const { name, text } of workflows) {
      for (const step of stepsOf(text)) {
        if (step.includes("actions/upload-artifact@")) {
          assert.match(step, /^ {8}continue-on-error: true$/m, name);
          assert.match(step, /^ {8}timeout-minutes: \d$/m, name);
        }
        if (step.includes("actions/download-artifact@")) {
          // Only the transcript, for the usage of the answer and the checks of
          // the smoke tests, on an ordinary runner after Claude's job.
          assert.match(step, /^ {10}name: pager-transcript$/m, name);
        }
      }
    }
  });

  it("takes the pack of the data in as many inputs as PACK.data, and hands back the change in PACK.patch outputs", () => {
    for (const name of packs) {
      assert.match(
        ask,
        new RegExp(
          `^ {6}${name}:\\n {8}description: .+\\n {8}type: string\\n {8}default: ""$`,
          "m",
        ),
      );
    }
    assert.doesNotMatch(ask, new RegExp(`^ {6}pack${PACK.data + 1}:`, "m"));
    assert.match(
      ask,
      /^ {6}pack_sha256:\n {8}description: .+\n {8}type: string\n {8}required: true$/m,
    );
    for (const name of [...patches, "patch_sha256", "patch_size"]) {
      assert.match(
        ask,
        new RegExp(
          `^ {6}${name}: \\$\\{\\{ steps\\.patch\\.outputs\\.${name} \\}\\}$`,
          "m",
        ),
      );
      assert.match(
        ask,
        new RegExp(
          `^ {8}value: \\$\\{\\{ jobs\\.ask\\.outputs\\.${name} \\}\\}$`,
          "m",
        ),
      );
    }
    assert.doesNotMatch(ask, new RegExp(`patch${PACK.patch + 1}`));
    // The script packs in the chunks of PACK.
    assert.match(ask, new RegExp(`^ {10}chunk=${PACK.chunk}$`, "m"));
    assert.match(ask, new RegExp(`^ {10}chunks=${PACK.patch}$`, "m"));
  });

  it("lets the pack reach a step of the job of Claude through env: alone, and no expression into a script", () => {
    const lines = ask
      .split("\n")
      .filter((line) => line.includes("inputs.pack"));
    assert.deepEqual(lines, [
      ...packs.map(
        (name) => `          ${name.toUpperCase()}: \${{ inputs.${name} }}`,
      ),
      `          PACK_SHA256: \${{ inputs.pack_sha256 }}`,
    ]);
    for (const { name, text } of workflows) {
      for (const script of text.split(/^ +run: \|\n/m).slice(1)) {
        const body = script.split(/\n(?! {10,}| *$)/)[0];
        assert.doesNotMatch(body, /outputs\.(?:pack|patch)|inputs\.pack/, name);
      }
    }
  });

  it("hands the pack of the job prepare to every call of the job of Claude", () => {
    for (const name of [
      PAGER,
      "smoke.yml",
      "smoke-translate.yml",
      "smoke-fix.yml",
    ]) {
      const text = read(`${WORKFLOWS}/${name}`);
      const calls = text.match(
        /^ {4}uses: \.\/\.github\/workflows\/ask\.yml /gm,
      );
      for (const pack of [...packs, "pack_sha256"]) {
        assert.match(
          text,
          new RegExp(
            `^ {6}${pack}: \\$\\{\\{ steps\\.prepare\\.outputs\\.${pack} \\}\\}$`,
            "m",
          ),
          `${name} ${pack}`,
        );
        assert.equal(
          text.match(
            new RegExp(
              `^ {6}${pack}: \\$\\{\\{ needs\\.prepare\\.outputs\\.${pack} \\}\\}$`,
              "gm",
            ),
          ).length,
          calls.length,
          `${name} ${pack}`,
        );
      }
    }
  });

  it("opens the pull request with the change of the try that ran Claude, unpacked where git applies it", () => {
    const pager = read(`${WORKFLOWS}/${PAGER}`);
    for (const [variable, output] of [
      ...patches.map((name) => [name.toUpperCase(), name]),
      ["PATCH_SHA256", "patch_sha256"],
      ["PATCH_SIZE", "patch_size"],
    ]) {
      assert.match(
        pager,
        new RegExp(
          `^ {10}${variable}: \\$\\{\\{ needs\\.ask-again\\.outputs\\.${output} \\|\\| needs\\.ask\\.outputs\\.${output} \\}\\}$`,
          "m",
        ),
      );
      assert.match(
        read(`${WORKFLOWS}/smoke-fix.yml`),
        new RegExp(
          `^ {10}${variable}: \\$\\{\\{ needs\\.ask\\.outputs\\.${output} \\}\\}$`,
          "m",
        ),
      );
    }
    assert.match(
      pager,
      /^ {10}PAGER_PATCH: \$\{\{ runner\.temp \}\}\/fix\.patch$/m,
    );
  });
});
