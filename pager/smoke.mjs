// The smoke test of a fix (smoke-fix.yml): the task of a fix that changes two
// files of a checkout of this repository, a workflow among them, and the check of
// the change that came of it. A new version of Claude Code or of its action that
// refuses such a write, as the fix of 2026-11-06 was refused, fails the test.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { LIMITS, modelOf, PROMPT, Refusal, readPlan, schema } from "./core.mjs";

/**
 * The files that the smoke test changes in its checkout, each with the line that
 * it adds at the end: a workflow, which a fix of the CI changes, and a file that
 * every fix may change. Every copy of the control repository has both.
 */
export const SMOKE_FIX = [
  {
    path: ".github/workflows/smoke.yml",
    line: "# The smoke test of a fix wrote this line.",
  },
  {
    path: "README.md",
    line: "<!-- The smoke test of a fix wrote this line. -->",
  },
];

/**
 * Its limits: the tools and the mode of a fix, which are what it tests, with a
 * smaller model, effort and budget, since two lines are all that it writes.
 */
export const SMOKE_LIMITS = {
  ...LIMITS.fix,
  budget: "0.50",
  model: "claude-sonnet-5-5",
  effort: "low",
};

function task() {
  return [
    "# The task",
    "",
    "This is the smoke test of a fix of the pager: it proves that your tools may change the files of `repo/`, a workflow among them, as a fix changes them. The maintainer allows this change of a workflow for the test: nothing of it is committed, and no workflow runs it.",
    "",
    "Make these changes with your tools, and no other:",
    "",
    ...SMOKE_FIX.map(
      ({ path, line }) =>
        `- Add the line \`${line}\` at the end of \`repo/${path}\`, after its last line.`,
    ),
    "",
    "Try each of them, even if another one is refused. Then answer: `answer` says which files you changed, and for a change that was refused, the file and the message of the refusal, word for word; `changed` is true when you changed a file; `title` is `test: the smoke test of a fix`; `body` is one sentence on what you changed.",
  ].join("\n");
}

/**
 * Collect the data of the smoke test into out, as the job prepare does for a fix:
 * its task and the rules of every job. The outputs name its limits and the schema
 * and prompt of a fix, with the model of PAGER_MODEL, when set, as every job has it.
 */
export async function prepareSmokeFix({ out, read, model = "" }) {
  const every = modelOf(model);
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "task.md"), task());
  await writeFile(join(out, "rules.md"), await read("rules.md"));
  return {
    ...SMOKE_LIMITS,
    ...(every === "" ? {} : { model: every }),
    schema: JSON.stringify(schema("fix")),
    prompt: PROMPT,
  };
}

/**
 * The lines that a patch of git adds, by the file that it adds them to: the lines
 * with a plus in its hunks, after the header of each file, whose +++ names it.
 */
export function addedLines(patch) {
  const files = new Map();
  let lines;
  let hunk = false;
  for (const line of patch.split("\n")) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header !== null) {
      lines = [];
      hunk = false;
      files.set(header[2], lines);
    } else if (lines !== undefined && line.startsWith("@@ ")) {
      hunk = true;
    } else if (hunk && line.startsWith("+")) {
      lines.push(line.slice(1));
    }
  }
  return files;
}

/**
 * The writes that Claude Code refused in a run, from the result in its transcript:
 * each as its tool and the file that it would have written, such as
 * `Edit repo/README.md`.
 */
export function denialsOf(execution) {
  let messages;
  try {
    messages = JSON.parse(execution);
  } catch {
    return [];
  }
  const result = Array.isArray(messages)
    ? messages.findLast((message) => message?.type === "result")
    : undefined;
  const denials = Array.isArray(result?.permission_denials)
    ? result.permission_denials
    : [];
  return denials.map((denial) => {
    const tool = String(denial?.tool_name ?? "a tool");
    const file = denial?.tool_input?.file_path;
    return typeof file === "string" ? `${tool} ${file}` : tool;
  });
}

/**
 * Check what came of the smoke test: Claude's answer in the schema of a fix, and a
 * change that adds its line to each file of SMOKE_FIX and touches no other. A
 * Refusal names what is missing, with the writes that Claude Code refused.
 */
export function checkSmokeFix({ plan, changed, patch, execution, owner }) {
  const fix = readPlan("fix", plan, owner);
  const added = addedLines(patch);
  const problems = [];
  if (!changed) {
    problems.push("the job ask collected no change of the checkout");
  }
  for (const { path, line } of SMOKE_FIX) {
    if (!(added.get(path) ?? []).includes(line)) {
      problems.push(`the change doesn't add its line to ${path}`);
    }
  }
  const others = [...added.keys()].filter(
    (path) => !SMOKE_FIX.some((file) => file.path === path),
  );
  if (others.length > 0) {
    problems.push(`the change touches other files: ${others.join(", ")}`);
  }
  if (problems.length > 0) {
    const denials = denialsOf(execution);
    const refused =
      denials.length > 0
        ? ` Claude Code refused ${denials.join(", ")}.`
        : " Claude Code refused no write.";
    throw new Refusal(
      `A fix can't change what it should: ${problems.join("; ")}.${refused} Claude answered: ${fix.answer}`,
    );
  }
  return `Claude changed ${SMOKE_FIX.map((file) => file.path).join(" and ")} as a fix does: ${fix.answer}`;
}
