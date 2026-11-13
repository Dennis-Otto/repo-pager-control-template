// The steps of the workflow pager.yml, one command each:
//
//   node pager/job.mjs prepare        check the event, collect what Claude reads
//   node pager/job.mjs pull-request   open the pull request of a fix
//   node pager/job.mjs answer         send the answer to the pager, signed, or a
//                                     translation that keeps its notes
//   node pager/job.mjs forward        send a question or a report of an agent to
//                                     the pager, signed (agents.yml)
//   node pager/job.mjs health         ask the pager for its health, signed, and
//                                     fail on what is wrong (health.yml)
//   node pager/job.mjs health-issue   open or comment on the issue of a failed
//                                     check, or close it after one that passed
//   node pager/job.mjs template       bring the changes of the template as a pull
//                                     request, merge it once its checks pass when
//                                     the settings ask, and tell the pager
//                                     (template.yml)
//   node pager/job.mjs access         check that the token of the workflow reads
//                                     the log of a job and the discussions of a
//                                     public repository (smoke.yml)
//   node pager/job.mjs smoke-fix      collect the task of the smoke test of a fix
//   node pager/job.mjs smoke-fix-check
//                                     check that it changed a workflow and a
//                                     file of its checkout (smoke-fix.yml)
//
// Each reads what it needs from the environment of its step and writes its outputs
// with the workflow commands of GitHub Actions. None of them runs on the machine on
// which Claude ran, so nothing that Claude wrote runs here.
import { randomUUID } from "node:crypto";
import { appendFile, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkAccess, SMOKE_REPOSITORY } from "./access.mjs";
import { relay } from "./agents.mjs";
import {
  answerBody,
  Refusal,
  readPlan,
  translationBody,
  usageOf,
} from "./core.mjs";
import { deliver } from "./deliver.mjs";
import { GitHub } from "./github.mjs";
import { check, keepIssue, pagerReport, problemsOf } from "./health.mjs";
import { prepare } from "./prepare.mjs";
import { gitIn, openPull, workflowsAllowed } from "./pull.mjs";
import { checkSmokeFix, denialsOf, prepareSmokeFix } from "./smoke.mjs";
import {
  reportOf,
  settle,
  short,
  summaryOf,
  takeTemplate,
} from "./template.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * A workflow command that annotates the run, its message escaped as @actions/core
 * escapes it: a line break or a % in data, such as a path that Claude chose, then
 * stays one annotation and can never start a command of its own.
 */
export function annotation(level, message) {
  const escaped = String(message)
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
  return `::${level}::${escaped}`;
}

/** Write the outputs of a step, each between delimiters that no value holds. */
export async function writeOutputs(file, outputs) {
  const lines = Object.entries(outputs).map(([name, value]) => {
    const delimiter = `EOF_${randomUUID()}`;
    return `${name}<<${delimiter}\n${value}\n${delimiter}\n`;
  });
  await appendFile(file, lines.join(""));
}

/** The JSON of the transcript of Claude's run, which the answer job downloads. */
async function transcript(folder) {
  try {
    const names = (await readdir(folder)).filter((name) =>
      name.endsWith(".json"),
    );
    return names.length === 0
      ? ""
      : await readFile(join(folder, names[0]), "utf8");
  } catch {
    return "";
  }
}

function owner(env) {
  return env.PAGER_OWNER || env.GITHUB_REPOSITORY_OWNER;
}

/** The address of the run of the workflow, from GitHub's own variables. */
function runOf(env) {
  return `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
}

/**
 * Show a body in the summary of the run under its heading, and send it to the
 * pager, signed: what the pager answered, or a refusal that fails the step.
 */
async function send(env, io, heading, body) {
  await appendFile(
    env.GITHUB_STEP_SUMMARY,
    `### ${heading}\n\n\`\`\`json\n${JSON.stringify(body, null, 2)}\n\`\`\`\n`,
  );
  const result = await deliver({
    url: env.PAGER_URL ?? "",
    secret: env.PAGER_CONTROL_SECRET ?? "",
    body,
    fetcher: io.fetch,
    sleep: io.sleep,
  });
  if (result.fatal) {
    throw new Refusal(result.note);
  }
  return result.note;
}

const commands = {
  async prepare(env, io) {
    // The smoke test names an event of its own: GitHub keeps GITHUB_* as they are.
    const path = env.PAGER_EVENT_PATH || env.GITHUB_EVENT_PATH;
    const event = JSON.parse(await readFile(path, "utf8"));
    const { outputs } = await prepare({
      eventName: env.PAGER_EVENT_NAME || env.GITHUB_EVENT_NAME,
      event,
      owner: owner(env),
      api: new GitHub(env.GH_TOKEN, io.fetch),
      out: env.PAGER_INPUT,
      read: (name) => readFile(join(HERE, name), "utf8"),
      workflows: workflowsAllowed(env.PAGER_FIX_WORKFLOWS),
      hold: {
        paused: (env.PAGER_PAUSED ?? "").trim() !== "",
        daily: (env.PAGER_DAILY_RUNS ?? "").trim(),
        repository: env.GITHUB_REPOSITORY,
        run: env.GITHUB_RUN_ID,
        now: Date.now,
      },
    });
    await writeOutputs(env.GITHUB_OUTPUT, outputs);
    return outputs.error === ""
      ? `A job of the kind ${outputs.kind}.`
      : `A job of the kind ${outputs.kind}, which Claude doesn't run: ${outputs.error}.`;
  },

  access(env, io) {
    return checkAccess({
      api: new GitHub(env.GH_TOKEN, io.fetch),
      repo: env.PAGER_SMOKE_REPOSITORY || SMOKE_REPOSITORY,
    });
  },

  async "smoke-fix"(env) {
    const outputs = await prepareSmokeFix({
      out: env.PAGER_INPUT,
      read: (name) => readFile(join(HERE, name), "utf8"),
    });
    await writeOutputs(env.GITHUB_OUTPUT, outputs);
    return "The smoke test of a fix, with the tools and the mode of a fix.";
  },

  async "smoke-fix-check"(env) {
    let patch = "";
    try {
      patch = await readFile(env.PAGER_PATCH, "utf8");
    } catch {
      // No change, no patch: the check says so.
    }
    return checkSmokeFix({
      plan: env.PLAN ?? "",
      changed: env.CHANGED === "true",
      patch,
      execution: await transcript(env.PAGER_TRANSCRIPT),
      owner: owner(env),
    });
  },

  async "pull-request"(env, io) {
    const job = JSON.parse(env.JOB);
    const plan = readPlan(job.kind, env.PLAN, owner(env));
    const result = await openPull({
      job,
      plan,
      base: env.BASE,
      token: env.PAGER_FIX_TOKEN ?? "",
      runId: env.GITHUB_RUN_ID,
      patch: env.PAGER_PATCH,
      api: new GitHub(env.PAGER_FIX_TOKEN, io.fetch),
      git: io.git,
      workflows: workflowsAllowed(env.PAGER_FIX_WORKFLOWS),
    });
    await writeOutputs(env.GITHUB_OUTPUT, result);
    return result.url === "" ? `No pull request: ${result.error}.` : result.url;
  },

  async answer(env, io) {
    const job = JSON.parse(env.JOB);
    const execution = await transcript(env.PAGER_TRANSCRIPT);
    const { usage, error } = usageOf(execution);
    // A write that Claude Code refused is a fix that Claude couldn't make: the run
    // says which, where the maintainer looks for why nothing changed.
    const denials = denialsOf(execution);
    if (denials.length > 0) {
      io.log(
        annotation("warning", `Claude Code refused ${denials.join(", ")}.`),
      );
    }
    const outcome = {
      ask: env.ASK_RESULT,
      plan: env.PLAN ?? "",
      usage,
      error,
      changed: env.CHANGED === "true",
      pull: env.PULL_URL ?? "",
      pullError: env.PULL_ERROR ?? "",
      run: env.RUN_URL,
      prepared: env.PREPARE_ERROR ?? "",
    };
    if (job.kind !== "translate") {
      const body = answerBody(job, outcome, owner(env));
      return send(env, io, "The answer for the pager", body);
    }
    // Without a translation, the message keeps its English: a warning, no failure.
    const { body, why } = translationBody(job, outcome);
    if (body === null) {
      await appendFile(
        env.GITHUB_STEP_SUMMARY,
        `### No translation for the pager\n\nThe message of the release keeps its notes in English: ${why}.\n`,
      );
      io.log(annotation("warning", `No translation for the pager: ${why}.`));
      return "Nothing sent: the message of the release keeps its notes in English.";
    }
    return send(env, io, "The translation for the pager", body);
  },

  async forward(env, io) {
    const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8"));
    const body = relay(env.GITHUB_EVENT_NAME, event, owner(env));
    return send(env, io, "What goes to the pager", body);
  },

  async health(env, io) {
    let result;
    try {
      result = await check({
        url: env.PAGER_URL ?? "",
        secret: env.PAGER_CONTROL_SECRET ?? "",
        token: env.PAGER_FIX_TOKEN ?? "",
        fetcher: io.fetch,
        now: Date.now,
        sleep: io.sleep,
      });
    } catch (error) {
      if (error instanceof Refusal) {
        // The job issue names the problem; the pager didn't answer, so it can't.
        await writeOutputs(env.GITHUB_OUTPUT, {
          problems: JSON.stringify([error.message]),
        });
      }
      throw error;
    }
    const { summary, problems, speaks } = result;
    await appendFile(env.GITHUB_STEP_SUMMARY, summary);
    await writeOutputs(env.GITHUB_OUTPUT, {
      problems: JSON.stringify(problems),
    });
    if (problems.length === 0) {
      return "The pager is well.";
    }
    if (speaks) {
      // The pager answered, so it says the problems in the chat too; the issue of
      // the job issue stays the record, also when this doesn't arrive.
      const sent = await deliver({
        url: env.PAGER_URL,
        secret: env.PAGER_CONTROL_SECRET,
        body: pagerReport(problems, runOf(env)),
        fetcher: io.fetch,
        sleep: io.sleep,
      });
      if (!sent.sent) {
        io.log(annotation("warning", sent.note));
      }
    }
    // One annotation per problem; the last one fails the step.
    for (const problem of problems.slice(0, -1)) {
      io.log(annotation("error", problem));
    }
    throw new Refusal(problems.at(-1));
  },

  async "health-issue"(env, io) {
    const failed = { failure: true, success: false }[env.HEALTH_RESULT];
    if (failed === undefined) {
      throw new Refusal(
        `HEALTH_RESULT is ${env.HEALTH_RESULT}, not failure or success.`,
      );
    }
    let kept;
    try {
      kept = await keepIssue({
        api: new GitHub(env.GH_TOKEN, io.fetch),
        repo: env.GITHUB_REPOSITORY,
        failed,
        problems: problemsOf(env.HEALTH_PROBLEMS),
        run: runOf(env),
        owner: owner(env),
      });
    } catch (error) {
      if (failed && error?.status === undefined) {
        throw error;
      }
      const why =
        error?.status === undefined
          ? String(error)
          : `${error.message}. The job needs the issues of this repository turned on and issues: write`;
      if (failed) {
        throw new Refusal(why);
      }
      // A check that passed stays green, whatever went wrong with GitHub,
      // even its network; the issue waits for the next run.
      io.log(
        annotation("warning", `The issue of the check stays open: ${why}.`),
      );
      return "The pager is well; its issue stays open until the next run.";
    }
    return {
      opened: `The failure is in the issue ${kept.url}.`,
      commented: `The failure is a comment on the issue ${kept.url}.`,
      closed: `The issue ${kept.url} is closed: the pager is well again.`,
      none: "No issue of a failed check is open.",
    }[kept.state];
  },

  async template(env, io) {
    const write = (env.PAGER_FIX_TOKEN ?? "") !== "";
    const api = new GitHub(
      write ? env.PAGER_FIX_TOKEN : env.GITHUB_TOKEN,
      io.fetch,
    );
    let result;
    try {
      result = await takeTemplate({ api, repo: env.GITHUB_REPOSITORY, write });
    } catch (error) {
      if (error?.status === undefined) {
        throw error;
      }
      throw new Refusal(
        `${error.message}. PAGER_FIX_TOKEN needs this repository, with Contents, Pull requests and Workflows read and write, and reads the template while it is public`,
      );
    }
    await appendFile(env.GITHUB_STEP_SUMMARY, summaryOf(result));
    let outcome;
    if (result.merge && result.number !== undefined) {
      try {
        outcome = await settle({
          api: new GitHub(env.GITHUB_TOKEN, io.fetch),
          merger: api,
          repo: env.GITHUB_REPOSITORY,
          number: result.number,
          made: result.made,
          sleep: io.sleep,
        });
      } catch (error) {
        if (error?.status === undefined) {
          throw error;
        }
        throw new Refusal(
          `${error.message}. The job reads the checks of the pull request ${result.url} with the token of the workflow, which needs actions: read, checks: read and pull-requests: read, and merges it with PAGER_FIX_TOKEN`,
        );
      }
    }
    if (result.state === "template") {
      return "This is the template itself: it takes nothing.";
    }
    const where = `${result.template} at ${short(result.commit)}`;
    if (result.state === "current") {
      return `Up to date with ${where}.`;
    }
    if (result.state === "waiting") {
      throw new Refusal(
        `${where} has changes for this repository, which the summary lists: give PAGER_FIX_TOKEN this repository, with Contents, Pull requests and Workflows read and write, and they come as a pull request`,
      );
    }
    const settled =
      outcome === undefined ? "" : ` ${SETTLED[outcome.state](outcome)}`;
    // A pull request that waits from an earlier run told the pager then; only its
    // merge is news. One that closed while its checks ran needs no one either.
    if (
      (result.state === "open" && outcome?.state !== "merged") ||
      outcome?.state === "closed"
    ) {
      const already = result.state === "open" ? " already" : "";
      return `The pull request ${result.url} takes ${where}${already}.${settled}`;
    }
    const sent = await deliver({
      url: env.PAGER_URL ?? "",
      secret: env.PAGER_CONTROL_SECRET ?? "",
      body: reportOf(result, env.PAGER_LANGUAGE, outcome),
      fetcher: io.fetch,
      sleep: io.sleep,
    });
    if (!sent.sent) {
      // The pull request is there all the same; the report only points to it.
      io.log(annotation("warning", sent.note));
    }
    return `The pull request ${result.url} takes ${where}.${settled} ${sent.note}`;
  },
};

/** What became of the pull request of the template after its checks, for the log. */
const SETTLED = {
  merged: () => "It passed every check and is merged.",
  failed: ({ failed }) => `It waits for a person: ${failed.join(", ")} failed.`,
  moved: () =>
    "It waits for a person: its head is a commit that this workflow didn't make.",
  late: () => "It waits for a person: its checks still ran after half an hour.",
  refused: ({ why }) =>
    `It waits for a person: GitHub didn't merge it: ${why}.`,
  closed: () => "It was closed or merged while its checks ran.",
};

/** Run a command; a refusal fails the step with its reason as an annotation. */
export async function main(command, env, io) {
  const run = commands[command];
  if (run === undefined) {
    io.log(
      annotation(
        "error",
        `Unknown command ${command}: prepare, access, smoke-fix, smoke-fix-check, pull-request, answer, forward, health, health-issue or template.`,
      ),
    );
    return 2;
  }
  try {
    io.log(await run(env, io));
    return 0;
  } catch (error) {
    if (!(error instanceof Refusal)) {
      throw error;
    }
    io.log(annotation("error", error.message));
    return 1;
  }
}

// The entry of the command line, which the tests replace with their own world.
/* node:coverage disable */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv[2], process.env, {
    fetch,
    git: gitIn(process.env.PAGER_REPO),
    sleep: (milliseconds) =>
      new Promise((done) => setTimeout(done, milliseconds)),
    log: (line) => console.log(line),
  });
}
/* node:coverage enable */
