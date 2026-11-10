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
//   node pager/job.mjs template       bring the changes of the template as a pull
//                                     request, and tell the pager (template.yml)
//
// Each reads what it needs from the environment of its step and writes its outputs
// with the workflow commands of GitHub Actions. None of them runs on the machine on
// which Claude ran, so nothing that Claude wrote runs here.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
import { check } from "./health.mjs";
import { prepare } from "./prepare.mjs";
import { openPull } from "./pull.mjs";
import { reportOf, short, summaryOf, takeTemplate } from "./template.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

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
    });
    await writeOutputs(env.GITHUB_OUTPUT, outputs);
    return `A job of the kind ${outputs.kind}.`;
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
      read: (path) => readFile(join(env.PAGER_REPO, path)),
    });
    await writeOutputs(env.GITHUB_OUTPUT, result);
    return result.url === "" ? `No pull request: ${result.error}.` : result.url;
  },

  async answer(env, io) {
    const job = JSON.parse(env.JOB);
    const { usage, error } = usageOf(await transcript(env.PAGER_TRANSCRIPT));
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
      io.log(`::warning::No translation for the pager: ${why}.`);
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
    const { summary, problems } = await check({
      url: env.PAGER_URL ?? "",
      secret: env.PAGER_CONTROL_SECRET ?? "",
      token: env.PAGER_FIX_TOKEN ?? "",
      fetcher: io.fetch,
      now: Date.now,
      sleep: io.sleep,
    });
    await appendFile(env.GITHUB_STEP_SUMMARY, summary);
    if (problems.length > 0) {
      // One annotation per problem; the last one fails the step.
      for (const problem of problems.slice(0, -1)) {
        io.log(`::error::${problem}`);
      }
      throw new Refusal(problems.at(-1));
    }
    return "The pager is well.";
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
    if (result.state === "open") {
      return `The pull request ${result.url} takes ${where} already.`;
    }
    const sent = await deliver({
      url: env.PAGER_URL ?? "",
      secret: env.PAGER_CONTROL_SECRET ?? "",
      body: reportOf(result, env.PAGER_LANGUAGE),
      fetcher: io.fetch,
      sleep: io.sleep,
    });
    if (!sent.sent) {
      // The pull request is there all the same; the report only points to it.
      io.log(`::warning::${sent.note}`);
    }
    return `The pull request ${result.url} takes ${where}. ${sent.note}`;
  },
};

/** Run a command; a refusal fails the step with its reason as an annotation. */
export async function main(command, env, io) {
  const run = commands[command];
  if (run === undefined) {
    io.log(
      `::error::Unknown command ${command}: prepare, pull-request, answer, forward, health or template.`,
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
    io.log(`::error::${error.message}`);
    return 1;
  }
}

// The entry of the command line, which the tests replace with their own world.
/* node:coverage disable */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv[2], process.env, {
    fetch,
    git: (args) =>
      execFileSync("git", ["-C", process.env.PAGER_REPO, ...args], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      }),
    sleep: (milliseconds) =>
      new Promise((done) => setTimeout(done, milliseconds)),
    log: (line) => console.log(line),
  });
}
/* node:coverage enable */
