// The command line of the maintainer's agents, with the gh of their machine signed
// in as the maintainer, so that they need no secret of their own:
//
//   node scripts/ask.mjs ask <id> <question> <option> <option> [<option> <option>]
//   node scripts/ask.mjs withdraw <id> [--reason <reason>] [--since <time>]
//   node scripts/ask.mjs report [--title <title>] <text | ->
//   node scripts/ask.mjs answer <id> [--since <time>]
//   node scripts/ask.mjs wait <id> [--since <time>] [--timeout <seconds>] [--every <seconds>]
//
// ask, withdraw and report send a repository dispatch to this repository, whose
// workflow agents.yml forwards it to the pager; a report of - reads its text from
// the standard input. answer prints the answer as JSON once the maintainer pressed
// one of its buttons or wrote their own in its topic, and wait asks for it until it comes.
// ask prints the time of its question, and --since with that time ignores an
// answer that is older, that of an earlier question with the same id. withdraw
// takes back a question that the agent no longer needs, unless it has an answer.
// An id is used once: ask refuses one that has an answer already. The exit code is
// 0 for the answer, 3 while there is none, 1 when gh or a check refuses, and 2 for
// a wrong command. wait takes a failure of gh that may pass, such as a network
// error, an error of GitHub's servers or a rate limit, for no answer yet and asks
// again; one that a retry gets again, such as one of the sign-in, ends it with 1.
import { ANSWERS, idOf, question, report, withdrawal } from "./agents.mjs";
import { Refusal } from "./core.mjs";

/**
 * The control repository of a checkout, where the questions go and the answers are:
 * owner/name, from the address of its remote origin on GitHub, or empty for another.
 */
export function repositoryOf(origin) {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(
      origin.trim(),
    );
  return match === null ? "" : match[1];
}

/** How long wait asks for an answer, and how often, in seconds. */
export const WAIT = { timeout: 3600, every: 30 };

/**
 * How many seconds the clock of this machine may run ahead of that of the pager:
 * an answer this much older than --since still counts, so that a quick press
 * isn't taken for the answer to an earlier question.
 */
export const LEEWAY = 60;

export const USAGE = [
  "Usage:",
  "  node scripts/ask.mjs ask <id> <question> <option> <option> [<option> <option>]",
  "  node scripts/ask.mjs withdraw <id> [--reason <reason>] [--since <time>]",
  "  node scripts/ask.mjs report [--title <title>] <text | ->",
  "  node scripts/ask.mjs answer <id> [--since <time>]",
  "  node scripts/ask.mjs wait <id> [--since <time>] [--timeout <seconds>] [--every <seconds>]",
].join("\n");

/** A wrong command line, which the usage answers. */
class Usage extends Error {}

/** The flags of a command, such as --title, and the words without one. */
function flags(args, names) {
  const found = {};
  const rest = [];
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index].startsWith("--") ? args[index].slice(2) : null;
    if (name === null) {
      rest.push(args[index]);
    } else if (names.includes(name) && index + 1 < args.length) {
      found[name] = args[index + 1];
      index += 1;
    } else {
      throw new Usage(
        `--${name} isn't a flag of this command, or has no value`,
      );
    }
  }
  return { found, rest };
}

/** A number of seconds of a flag, or its default. */
function seconds(value, fallback, name) {
  if (value === undefined) {
    return fallback;
  }
  if (!/^\d+$/.test(value) || Number(value) === 0) {
    throw new Usage(`--${name} takes a number of seconds`);
  }
  return Number(value);
}

/** A time of ISO 8601 with its zone, such as ask prints. */
const TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/** The time of --since, in milliseconds since 1970, or null without the flag. */
function since(value) {
  if (value === undefined) {
    return null;
  }
  const time = TIME.test(value) ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(time)) {
    throw new Usage(
      "--since takes the time of the question, such as 2026-11-08T07:12:03.000Z, as ask prints it",
    );
  }
  return time;
}

/** Send an event to this repository with gh; a refusal of gh fails the command. */
function dispatch(io, repo, eventType, payload) {
  const sent = io.gh(
    ["api", `repos/${repo}/dispatches`, "--input", "-"],
    JSON.stringify({ event_type: eventType, client_payload: payload }),
  );
  if (sent.status !== 0) {
    throw new Refusal(`gh couldn't send the event: ${sent.stderr.trim()}`);
  }
}

/**
 * A failure of gh that may pass by itself, such as a network error, an error of
 * GitHub's servers or a rate limit: wait tries again, a single read refuses.
 */
class Passing extends Refusal {
  constructor(said) {
    super(`gh couldn't read the answer: ${said}`);
    this.said = said;
  }
}

/**
 * Whether a failure of gh may pass by itself. One that a retry gets again ends a
 * wait at once: gh missing (ENOENT) or signed out (its exit code 4), and a refusal
 * of GitHub, 4xx, such as 401 or 403, other than a rate limit (403 or 429) or a
 * timeout (408). Anything else, a network error or a 5xx, passes.
 */
function passes(read) {
  if (read.status === 4 || /\bENOENT\b/.test(read.stderr)) {
    return false;
  }
  const code = Number(/\(HTTP (\d{3})\)/.exec(read.stderr)?.[1] ?? 0);
  if (code < 400 || code >= 500 || code === 408 || code === 429) {
    return true;
  }
  return code === 403 && /rate limit/i.test(read.stderr);
}

/** The answer to a question, as its file holds it, or null while there is none. */
function readAnswer(io, repo, id) {
  const read = io.gh([
    "api",
    "-H",
    "Accept: application/vnd.github.raw+json",
    `repos/${repo}/contents/answers/${id}.json?ref=${ANSWERS}`,
  ]);
  if (read.status === 0) {
    return read.stdout.trim();
  }
  // No branch yet, or no file on it: no answer, not yet.
  if (/\b404\b|Not Found/.test(read.stderr)) {
    return null;
  }
  const said = read.stderr.trim();
  if (passes(read)) {
    throw new Passing(said);
  }
  throw new Refusal(`gh couldn't read the answer: ${said}`);
}

/**
 * One read of wait: that of answerSince, or, for a failure of gh that may pass,
 * no answer yet and what gh said.
 */
function poll(io, repo, id, time) {
  try {
    return { ...answerSince(io, repo, id, time), failed: null };
  } catch (error) {
    if (!(error instanceof Passing)) {
      throw error;
    }
    return { answer: null, older: null, failed: error.said };
  }
}

/**
 * The answer to the question asked at the time of --since: its file, or null while
 * there is none, and the time of an older answer that it ignores, that of an
 * earlier question with the same id. Without --since, every answer counts.
 */
function answerSince(io, repo, id, time) {
  const answer = readAnswer(io, repo, id);
  if (answer === null || time === null) {
    return { answer, older: null };
  }
  let answered = Number.NaN;
  try {
    answered = Date.parse(JSON.parse(answer).answered);
  } catch {
    // Not JSON: it has no time, which the refusal below says.
  }
  if (Number.isNaN(answered)) {
    throw new Refusal(
      `the answer to ${id} has no time of its answer, so --since can't tell whether it is newer`,
    );
  }
  return answered < time - LEEWAY * 1000
    ? { answer: null, older: new Date(answered).toISOString() }
    : { answer, older: null };
}

const commands = {
  ask(args, io, repo) {
    const [id, asked, ...options] = args;
    const body = question({ id, question: asked, options });
    // An answered id keeps its file for good: asked again, its old answer would
    // read as the choice for the new question. Each question takes a new id.
    if (readAnswer(io, repo, body.id) !== null) {
      throw new Refusal(
        `${body.id} has an answer already; ask with a new id, such as one with the date in it`,
      );
    }
    // Before the event goes, so that no answer to this question can be older.
    const time = new Date(io.now()).toISOString();
    dispatch(io, repo, "pager-ask", {
      id: body.id,
      question: body.question,
      options: body.options,
    });
    io.out(
      `Asked ${body.id} at ${time}. Its answer: node scripts/ask.mjs wait ${body.id} --since ${time}`,
    );
    return 0;
  },

  withdraw(args, io, repo) {
    const { found, rest } = flags(args, ["reason", "since"]);
    if (rest.length !== 1) {
      throw new Usage("withdraw takes one id");
    }
    const body = withdrawal({ id: rest[0], reason: found.reason });
    const time = since(found.since);
    // An answer that came in between stands: the agent reads it instead.
    if (answerSince(io, repo, body.id, time).answer !== null) {
      throw new Refusal(
        `${body.id} has an answer already, which stands: node scripts/ask.mjs answer ${body.id}`,
      );
    }
    // JSON leaves out a reason that there isn't.
    dispatch(io, repo, "pager-withdraw", { id: body.id, reason: body.reason });
    io.out(`Took ${body.id} back.`);
    return 0;
  },

  report(args, io, repo) {
    const { found, rest } = flags(args, ["title"]);
    if (rest.length !== 1) {
      throw new Usage("a report takes one text, or - for the standard input");
    }
    const text = rest[0] === "-" ? io.stdin() : rest[0];
    const body = report({ text, title: found.title });
    // JSON leaves out a title that there isn't.
    dispatch(io, repo, "pager-report", { text: body.text, title: body.title });
    io.out("Reported.");
    return 0;
  },

  answer(args, io, repo) {
    const { found, rest } = flags(args, ["since"]);
    const id = idOf(rest[0]);
    const { answer, older } = answerSince(io, repo, id, since(found.since));
    if (answer === null) {
      io.err(
        older === null
          ? `No answer to ${id} yet.`
          : `No answer to ${id} yet: the one from ${older} is older than the question.`,
      );
      return 3;
    }
    io.out(answer);
    return 0;
  },

  async wait(args, io, repo) {
    const { found, rest } = flags(args, ["since", "timeout", "every"]);
    const id = idOf(rest[0]);
    const time = since(found.since);
    const timeout = seconds(found.timeout, WAIT.timeout, "timeout");
    const every = seconds(found.every, WAIT.every, "every");
    const until = io.now() + timeout * 1000;
    let told = false;
    // A failure of gh that passes is no answer yet; it is said once.
    let warned = false;
    // Whether a read came through, and what gh said the last time one didn't.
    let read = false;
    let last = "";
    for (;;) {
      const { answer, older, failed } = poll(io, repo, id, time);
      if (answer !== null) {
        io.out(answer);
        return 0;
      }
      if (older !== null && !told) {
        io.err(
          `The answer to ${id} from ${older} is older than the question: waiting for a new one.`,
        );
        told = true;
      }
      if (failed === null) {
        read = true;
      } else {
        last = failed;
        if (!warned) {
          io.err(
            `Couldn't read the answer to ${id} this time: ${failed}. Trying again every ${every} s.`,
          );
          warned = true;
        }
      }
      if (io.now() + every * 1000 > until) {
        io.err(
          read
            ? `No answer to ${id} within ${timeout} s.`
            : `No answer to ${id} within ${timeout} s, and no read of it came through; the last failed with: ${last}.`,
        );
        return 3;
      }
      await io.sleep(every * 1000);
    }
  },
};

/** Run the command line; returns its exit code. */
export async function run(args, io) {
  const [command, ...rest] = args;
  if (!Object.hasOwn(commands, command)) {
    io.err(USAGE);
    return 2;
  }
  const repo = io.env.PAGER_CONTROL_REPOSITORY || repositoryOf(io.origin());
  if (repo === "") {
    io.err(
      "Refused: this checkout has no remote origin on GitHub; name the control repository with PAGER_CONTROL_REPOSITORY, such as octocat/repo-pager-control.",
    );
    return 1;
  }
  try {
    return await commands[command](rest, io, repo);
  } catch (error) {
    if (error instanceof Usage) {
      io.err(`${error.message}.\n${USAGE}`);
      return 2;
    }
    if (error instanceof Refusal) {
      io.err(`Refused: ${error.message}.`);
      return 1;
    }
    throw error;
  }
}
