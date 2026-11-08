// The questions and reports of the maintainer's own agents, such as an orchestrator
// that works through the night on their PC with gh signed in as them: what scripts/ask.mjs
// sends as a repository dispatch, and what the workflow agents.yml forwards from it
// to the pager, signed. The pager saves the answer to a question, a button or a
// text of the maintainer in its topic, on the branch pager-answers of this repository,
// where the agent reads it with gh, and an agent takes back a question that it no
// longer needs. Both sides check the limits of the pager, so a question that it
// would refuse never goes.
import { Refusal } from "./core.mjs";

/** The events of an agent, and the type of the body that the pager gets for each. */
export const AGENT_EVENTS = {
  "pager-ask": "ask",
  "pager-withdraw": "withdraw",
  "pager-report": "report",
};

/** The branch of this repository on which the pager saves each answer. */
export const ANSWERS = "pager-answers";

/** The limits of the pager, in characters, and the number of options of a question. */
export const LIMITS = {
  question: 1000,
  option: 64,
  options: { least: 2, most: 4 },
  title: 100,
  reason: 500,
};

/** The id of a question, which names its answer: a file name of 1 to 64 characters. */
export const ID = /^[A-Za-z0-9][\w.-]{0,63}$/;

function refuse(text) {
  throw new Refusal(text);
}

/** A text that is there, trimmed, of at most max characters. */
function words(value, max, what) {
  if (typeof value !== "string" || value.trim() === "") {
    refuse(`${what} is missing`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    refuse(`${what} has more than ${max} characters`);
  }
  return trimmed;
}

/** The id of a question, or a refusal that says what an id is. */
export function idOf(value) {
  if (typeof value !== "string" || !ID.test(value)) {
    refuse(
      "the id has 1 to 64 letters, digits, dots, dashes and underscores, and starts with a letter or a digit",
    );
  }
  return value;
}

/** A question for the pager: its id, the question and two to four different options. */
export function question(payload) {
  const id = idOf(payload?.id);
  const asked = words(payload.question, LIMITS.question, "the question");
  const { options } = payload;
  const { least, most } = LIMITS.options;
  if (
    !Array.isArray(options) ||
    options.length < least ||
    options.length > most
  ) {
    refuse(`a question has ${least} to ${most} options`);
  }
  const named = options.map((option, place) =>
    words(option, LIMITS.option, `option ${place + 1}`),
  );
  if (new Set(named).size !== named.length) {
    refuse("two options are the same");
  }
  return { type: "ask", id, question: asked, options: named };
}

/** The end of a question that the agent no longer needs: its id and, if any, why. */
export function withdrawal(payload) {
  const id = idOf(payload?.id);
  const { reason } = payload;
  if (reason === undefined) {
    return { type: "withdraw", id };
  }
  return {
    type: "withdraw",
    id,
    reason: words(reason, LIMITS.reason, "the reason"),
  };
}

/** The report of a run for the pager: its text and, if any, a short title. */
export function report(payload) {
  // The pager shows the first 3000 characters; it cuts a longer one.
  const text = words(payload?.text, Number.POSITIVE_INFINITY, "the text");
  const { title } = payload;
  if (title === undefined) {
    return { type: "report", text };
  }
  return {
    type: "report",
    text,
    title: words(title, LIMITS.title, "the title").replace(/\s+/g, " "),
  };
}

/**
 * The body for the pager of an event of an agent. Only an event that the owner of
 * this repository sent goes on: the pager's GitHub App, which sends the jobs here,
 * and anyone else who may write here, get a refusal.
 */
export function relay(eventName, event, owner) {
  const type = Object.hasOwn(AGENT_EVENTS, event?.action)
    ? AGENT_EVENTS[event.action]
    : undefined;
  if (eventName !== "repository_dispatch" || type === undefined) {
    refuse(
      `${event?.action} isn't a question, the end of one or a report of an agent`,
    );
  }
  const sender = event.sender ?? {};
  if (
    sender.type !== "User" ||
    String(sender.login).toLowerCase() !== owner.toLowerCase()
  ) {
    refuse(
      `only ${owner} asks and reports through the pager, not ${sender.login}`,
    );
  }
  const bodies = { ask: question, withdraw: withdrawal, report };
  return bodies[type](event.client_payload);
}
