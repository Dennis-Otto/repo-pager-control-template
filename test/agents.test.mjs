// The questions and reports of the maintainer's own agents: what the workflow agents.yml
// takes and forwards to the pager, and the command line scripts/ask.mjs, with a gh
// of its own that records each call.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  LIMITS,
  question,
  relay,
  report,
  withdrawal,
} from "../pager/agents.mjs";
import { LEEWAY, repositoryOf, run, USAGE, WAIT } from "../pager/ask.mjs";
import { Refusal } from "../pager/core.mjs";

const OWNER = "monalisa";
const MAINTAINER = { login: "monalisa", type: "User" };

const ASKED = {
  id: "merge-order",
  question: "Which release goes first?",
  options: ["The blueprint", "The pager"],
};

describe("an event of an agent", () => {
  it("becomes the body of a question or a report, trimmed", () => {
    assert.deepEqual(
      relay(
        "repository_dispatch",
        {
          action: "pager-ask",
          sender: MAINTAINER,
          client_payload: {
            ...ASKED,
            question: " Which release goes first? ",
            options: [" The blueprint", "The pager "],
          },
        },
        OWNER,
      ),
      { type: "ask", ...ASKED },
    );
    assert.deepEqual(
      relay(
        "repository_dispatch",
        {
          action: "pager-report",
          sender: MAINTAINER,
          client_payload: { text: " Done. ", title: " Night \n run " },
        },
        OWNER,
      ),
      { type: "report", text: "Done.", title: "Night run" },
    );
    assert.deepEqual(
      relay(
        "repository_dispatch",
        {
          action: "pager-withdraw",
          sender: MAINTAINER,
          client_payload: { id: "merge-order", reason: " No answer. " },
        },
        OWNER,
      ),
      { type: "withdraw", id: "merge-order", reason: "No answer." },
    );
    assert.deepEqual(withdrawal({ id: "merge-order" }), {
      type: "withdraw",
      id: "merge-order",
    });
    assert.deepEqual(report({ text: "x".repeat(5000) }).text.length, 5000);
  });

  it("goes on only when the owner sent it", () => {
    const event = { action: "pager-ask", client_payload: ASKED };
    for (const sender of [
      undefined,
      { login: "pager[bot]", type: "Bot" },
      { login: "someone", type: "User" },
      { login: "monalisa", type: "Bot" },
    ]) {
      assert.throws(
        () => relay("repository_dispatch", { ...event, sender }, OWNER),
        /only monalisa asks and reports through the pager/,
      );
    }
    for (const [name, action] of [
      ["repository_dispatch", "pager-text"],
      ["repository_dispatch", "constructor"],
      ["repository_dispatch", undefined],
      ["workflow_dispatch", "pager-ask"],
    ]) {
      assert.throws(
        () =>
          relay(
            name,
            { action, sender: MAINTAINER, client_payload: ASKED },
            OWNER,
          ),
        /isn't a question, the end of one or a report of an agent/,
      );
    }
    assert.throws(() => relay("repository_dispatch", null, OWNER), Refusal);
  });

  it("takes the limits of the pager, and refuses what the pager would", () => {
    const wrong = [
      [{ ...ASKED, id: "../answers" }, /the id has 1 to 64/],
      [{ ...ASKED, id: "a".repeat(65) }, /the id has 1 to 64/],
      [{ ...ASKED, id: 7 }, /the id has 1 to 64/],
      [{ ...ASKED, question: " " }, /the question is missing/],
      [
        { ...ASKED, question: "?".repeat(LIMITS.question + 1) },
        /the question has more than 1000 characters/,
      ],
      [{ ...ASKED, options: "A or B" }, /a question has 2 to 4 options/],
      [{ ...ASKED, options: ["A"] }, /a question has 2 to 4 options/],
      [
        { ...ASKED, options: ["A", "B", "C", "D", "E"] },
        /a question has 2 to 4 options/,
      ],
      [{ ...ASKED, options: ["A", 2] }, /option 2 is missing/],
      [
        { ...ASKED, options: ["A", "B".repeat(LIMITS.option + 1)] },
        /option 2 has more than 64 characters/,
      ],
      [{ ...ASKED, options: ["A", " A "] }, /two options are the same/],
    ];
    for (const [payload, why] of wrong) {
      assert.throws(() => question(payload), why);
    }
    assert.throws(() => question(undefined), /the id has 1 to 64/);
    assert.throws(() => report(undefined), /the text is missing/);
    assert.throws(
      () => report({ text: "Done.", title: "t".repeat(LIMITS.title + 1) }),
      /the title has more than 100 characters/,
    );
    assert.throws(() => withdrawal(undefined), /the id has 1 to 64/);
    assert.throws(
      () => withdrawal({ id: "merge-order", reason: " " }),
      /the reason is missing/,
    );
    assert.throws(
      () =>
        withdrawal({
          id: "merge-order",
          reason: "r".repeat(LIMITS.reason + 1),
        }),
      /the reason has more than 500 characters/,
    );
    assert.equal(
      withdrawal({ id: "merge-order", reason: "r".repeat(LIMITS.reason) })
        .reason.length,
      500,
    );
    assert.deepEqual(
      question({
        ...ASKED,
        id: `A${"b".repeat(63)}`,
        options: ["A", "B", "C", "D"],
      }).options,
      ["A", "B", "C", "D"],
    );
  });
});

/** A machine with a gh whose answers the test gives, and what it said. */
/** The control repository of the checkout in these tests. */
const REPOSITORY = "monalisa/repo-pager-control";

function machine(answers = [], env = {}) {
  const calls = [];
  const out = [];
  const err = [];
  const slept = [];
  const clock = { now: 0 };
  const io = {
    gh(args, input) {
      calls.push({
        args,
        input: input === undefined ? undefined : JSON.parse(input),
      });
      return answers.shift() ?? { status: 0, stdout: "", stderr: "" };
    },
    origin: () => `https://github.com/${REPOSITORY}.git
`,
    env,
    stdin: () => "From the standard input.\n",
    now: () => clock.now,
    async sleep(milliseconds) {
      slept.push(milliseconds);
      clock.now += milliseconds;
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  return { io, calls, out, err, slept, clock };
}

const NONE = { status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)\n" };
const ANSWER = { status: 0, stdout: '{"answer":"The pager"}\n', stderr: "" };

/** A failure of gh as it says it on its standard error, with its exit code. */
function failure(stderr, status = 1) {
  return { status, stdout: "", stderr: `${stderr}\n` };
}

// Failures that pass: of the network, of GitHub's servers, of a rate limit.
const OFFLINE = failure("error connecting to api.github.com");
const BAD_GATEWAY = failure("gh: Bad Gateway (HTTP 502)");
const TOO_MANY = failure("gh: Too Many Requests (HTTP 429)");
const TIMED_OUT = failure("gh: Request Timeout (HTTP 408)");
const RATE_LIMITED = failure(
  "gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)",
);

// Failures that a retry gets again: of the sign-in, of the rights, of gh itself.
const BAD_CREDENTIALS = failure("gh: Bad credentials (HTTP 401)");
const FORBIDDEN = failure(
  "gh: Resource not accessible by integration (HTTP 403)",
);
const SIGNED_OUT = failure(
  "To get started with GitHub CLI, please run:  gh auth login",
  4,
);
const NO_GH = failure("spawnSync gh ENOENT");
const UNPROCESSABLE = failure(
  "gh: No commit found for the ref pager-answers (HTTP 422)",
);

/** The time of a question, as ask prints it. */
const ASKED_AT = "2026-11-08T07:00:00.000Z";

/** The file of an answer that the pager saved at a time. */
function answeredAt(time, fields = {}) {
  return {
    status: 0,
    stdout: `${JSON.stringify({ id: "merge-order", choice: null, answer: "Neither.", answered: time, ...fields })}\n`,
    stderr: "",
  };
}

/** An answer to an earlier question with the same id, a day before. */
const YESTERDAY = answeredAt("2026-11-07T07:00:00.000Z");

describe("the command line of an agent", () => {
  it("asks in the control repository of its checkout, by the address of its remote origin", () => {
    for (const origin of [
      "https://github.com/monalisa/repo-pager-control.git\n",
      "https://github.com/monalisa/repo-pager-control",
      "https://github.com/monalisa/repo-pager-control/",
      "git@github.com:monalisa/repo-pager-control.git",
      "ssh://git@github.com/monalisa/repo-pager-control.git",
    ]) {
      assert.equal(repositoryOf(origin), REPOSITORY, origin);
    }
    for (const origin of [
      "",
      "https://gitlab.com/monalisa/repo-pager-control.git",
      "https://github.com/monalisa",
      "/home/monalisa/repo-pager-control",
    ]) {
      assert.equal(repositoryOf(origin), "", origin);
    }
  });

  it("refuses to guess the control repository of a checkout without a remote origin on GitHub", async () => {
    const m = machine();
    m.io.origin = () => "";
    assert.equal(await run(["report", "Merged: 3."], m.io), 1);
    assert.deepEqual(m.calls, []);
    assert.deepEqual(m.err, [
      "Refused: this checkout has no remote origin on GitHub; name the control repository with PAGER_CONTROL_REPOSITORY, such as octocat/repo-pager-control.",
    ]);
  });

  it("asks a question with a dispatch of gh, and prints its time", async () => {
    const m = machine([NONE]);
    m.clock.now = Date.parse(ASKED_AT);
    const code = await run(
      [
        "ask",
        "merge-order",
        "Which release goes first?",
        "The blueprint",
        "The pager",
      ],
      m.io,
    );
    assert.equal(code, 0);
    assert.deepEqual(m.calls, [
      {
        args: [
          "api",
          "-H",
          "Accept: application/vnd.github.raw+json",
          `repos/${REPOSITORY}/contents/answers/merge-order.json?ref=pager-answers`,
        ],
        input: undefined,
      },
      {
        args: ["api", `repos/${REPOSITORY}/dispatches`, "--input", "-"],
        input: { event_type: "pager-ask", client_payload: ASKED },
      },
    ]);
    assert.deepEqual(m.out, [
      `Asked merge-order at ${ASKED_AT}. Its answer: node scripts/ask.mjs wait merge-order --since ${ASKED_AT}`,
    ]);
  });

  it("refuses to ask an id again that has an answer already", async () => {
    const m = machine([ANSWER]);
    assert.equal(
      await run(["ask", "merge-order", "Which?", "A", "B"], m.io),
      1,
    );
    assert.equal(m.calls.length, 1);
    assert.deepEqual(m.out, []);
    assert.deepEqual(m.err, [
      "Refused: merge-order has an answer already; ask with a new id, such as one with the date in it.",
    ]);
  });

  it("sends the report of a run, with a title or without, from the standard input too", async () => {
    const m = machine([], { PAGER_CONTROL_REPOSITORY: "monalisa/control" });
    assert.equal(
      await run(["report", "--title", "Night run", "Merged: 3."], m.io),
      0,
    );
    assert.equal(await run(["report", "-"], m.io), 0);
    assert.deepEqual(
      m.calls.map((call) => [call.args[1], call.input]),
      [
        [
          "repos/monalisa/control/dispatches",
          {
            event_type: "pager-report",
            client_payload: { text: "Merged: 3.", title: "Night run" },
          },
        ],
        [
          "repos/monalisa/control/dispatches",
          {
            event_type: "pager-report",
            client_payload: { text: "From the standard input." },
          },
        ],
      ],
    );
    assert.deepEqual(m.out, ["Reported.", "Reported."]);
  });

  it("reads an answer from the branch of the answers, and says when there is none yet", async () => {
    const m = machine([ANSWER, NONE]);
    assert.equal(await run(["answer", "merge-order"], m.io), 0);
    assert.equal(await run(["answer", "merge-order"], m.io), 3);
    assert.deepEqual(m.calls[0].args, [
      "api",
      "-H",
      "Accept: application/vnd.github.raw+json",
      `repos/${REPOSITORY}/contents/answers/merge-order.json?ref=pager-answers`,
    ]);
    assert.deepEqual(m.out, ['{"answer":"The pager"}']);
    assert.deepEqual(m.err, ["No answer to merge-order yet."]);
  });

  it("waits for an answer, and gives up after its time", async () => {
    const waited = machine([NONE, NONE, ANSWER]);
    assert.equal(
      await run(["wait", "merge-order", "--every", "5"], waited.io),
      0,
    );
    assert.deepEqual(waited.slept, [5000, 5000]);
    assert.deepEqual(waited.out, ['{"answer":"The pager"}']);
    const late = machine([NONE, NONE, NONE]);
    assert.equal(
      await run(
        ["wait", "merge-order", "--timeout", "60", "--every", "30"],
        late.io,
      ),
      3,
    );
    assert.deepEqual(late.slept, [30000, 30000]);
    assert.deepEqual(late.err, ["No answer to merge-order within 60 s."]);
    const fallback = machine([ANSWER]);
    assert.equal(await run(["wait", "merge-order"], fallback.io), 0);
    assert.deepEqual(WAIT, { timeout: 3600, every: 30 });
  });

  it("keeps waiting through a failure of gh that passes, and says so once", async () => {
    const m = machine([
      NONE,
      BAD_GATEWAY,
      RATE_LIMITED,
      TIMED_OUT,
      NONE,
      ANSWER,
    ]);
    assert.equal(await run(["wait", "merge-order", "--every", "5"], m.io), 0);
    assert.deepEqual(m.slept, [5000, 5000, 5000, 5000, 5000]);
    assert.deepEqual(m.out, ['{"answer":"The pager"}']);
    assert.deepEqual(m.err, [
      "Couldn't read the answer to merge-order this time: gh: Bad Gateway (HTTP 502). Trying again every 5 s.",
    ]);
  });

  it("gives up after its time with 3, and names the last failure when no read came through", async () => {
    const failing = machine([OFFLINE, BAD_GATEWAY, TOO_MANY]);
    assert.equal(
      await run(
        ["wait", "merge-order", "--timeout", "60", "--every", "30"],
        failing.io,
      ),
      3,
    );
    assert.deepEqual(failing.slept, [30000, 30000]);
    assert.deepEqual(failing.err, [
      "Couldn't read the answer to merge-order this time: error connecting to api.github.com. Trying again every 30 s.",
      "No answer to merge-order within 60 s, and no read of it came through; the last failed with: gh: Too Many Requests (HTTP 429).",
    ]);
    const once = machine([BAD_GATEWAY, NONE]);
    assert.equal(
      await run(
        ["wait", "merge-order", "--timeout", "30", "--every", "30"],
        once.io,
      ),
      3,
    );
    assert.equal(once.err.at(-1), "No answer to merge-order within 30 s.");
  });

  it("stops waiting at a failure that a retry would get again, such as one of the sign-in", async () => {
    for (const [failed, message] of [
      [BAD_CREDENTIALS, "gh: Bad credentials (HTTP 401)"],
      [FORBIDDEN, "gh: Resource not accessible by integration (HTTP 403)"],
      [
        SIGNED_OUT,
        "To get started with GitHub CLI, please run:  gh auth login",
      ],
      [NO_GH, "spawnSync gh ENOENT"],
      [
        UNPROCESSABLE,
        "gh: No commit found for the ref pager-answers (HTTP 422)",
      ],
    ]) {
      const m = machine([NONE, failed, ANSWER]);
      assert.equal(await run(["wait", "merge-order", "--every", "5"], m.io), 1);
      assert.equal(m.calls.length, 2);
      assert.deepEqual(m.out, []);
      assert.deepEqual(m.err, [
        `Refused: gh couldn't read the answer: ${message}.`,
      ]);
    }
  });

  it("refuses a single read that fails, even one that would pass", async () => {
    const m = machine([BAD_GATEWAY]);
    assert.equal(await run(["answer", "merge-order"], m.io), 1);
    assert.deepEqual(m.err, [
      "Refused: gh couldn't read the answer: gh: Bad Gateway (HTTP 502).",
    ]);
  });

  it("waits for an answer newer than the question with --since, and says once that it ignores an older one", async () => {
    const quick = answeredAt("2026-11-08T06:59:30.000Z", { choice: 1 });
    const m = machine([YESTERDAY, YESTERDAY, quick]);
    m.clock.now = Date.parse(ASKED_AT);
    assert.equal(
      await run(
        ["wait", "merge-order", "--since", ASKED_AT, "--every", "5"],
        m.io,
      ),
      0,
    );
    assert.deepEqual(m.slept, [5000, 5000]);
    assert.deepEqual(m.err, [
      "The answer to merge-order from 2026-11-07T07:00:00.000Z is older than the question: waiting for a new one.",
    ]);
    // Half a minute before the question: within the leeway of the clocks.
    assert.deepEqual(m.out, [quick.stdout.trim()]);
    assert.equal(LEEWAY, 60);
    const late = machine([YESTERDAY, YESTERDAY]);
    assert.equal(
      await run(
        [
          "wait",
          "merge-order",
          "--since",
          "2026-11-08T08:00:00+01:00",
          "--timeout",
          "30",
          "--every",
          "30",
        ],
        late.io,
      ),
      3,
    );
    assert.deepEqual(late.err, [
      "The answer to merge-order from 2026-11-07T07:00:00.000Z is older than the question: waiting for a new one.",
      "No answer to merge-order within 30 s.",
    ]);
  });

  it("reads an answer newer than the question with --since, and none older", async () => {
    const newer = answeredAt("2026-11-08T07:02:00.000Z");
    const m = machine([newer, YESTERDAY, NONE]);
    for (const expected of [0, 3, 3]) {
      assert.equal(
        await run(["answer", "merge-order", "--since", ASKED_AT], m.io),
        expected,
      );
    }
    assert.deepEqual(m.out, [newer.stdout.trim()]);
    assert.deepEqual(m.err, [
      "No answer to merge-order yet: the one from 2026-11-07T07:00:00.000Z is older than the question.",
      "No answer to merge-order yet.",
    ]);
  });

  it("refuses --since for an answer without its time, and a time that isn't one", async () => {
    const m = machine([
      ANSWER,
      { status: 0, stdout: "The pager\n", stderr: "" },
      answeredAt("soon"),
    ]);
    for (let read = 0; read < 3; read += 1) {
      assert.equal(
        await run(["answer", "merge-order", "--since", ASKED_AT], m.io),
        1,
      );
    }
    assert.deepEqual(m.err, [
      "Refused: the answer to merge-order has no time of its answer, so --since can't tell whether it is newer.",
      "Refused: the answer to merge-order has no time of its answer, so --since can't tell whether it is newer.",
      "Refused: the answer to merge-order has no time of its answer, so --since can't tell whether it is newer.",
    ]);
    const wrong = machine();
    for (const time of [
      "yesterday",
      "2026-11-08",
      "2026-11-08T07:00:00",
      "2026-13-08T07:00:00Z",
    ]) {
      assert.equal(
        await run(["wait", "merge-order", "--since", time], wrong.io),
        2,
        time,
      );
    }
    assert.equal(wrong.calls.length, 0);
    assert.equal(
      wrong.err[0].split("\n")[0],
      "--since takes the time of the question, such as 2026-11-08T07:12:03.000Z, as ask prints it.",
    );
  });

  it("takes a question back with a dispatch of gh, with its reason or without", async () => {
    const sent = { status: 0, stdout: "", stderr: "" };
    const m = machine([NONE, sent, NONE, sent, YESTERDAY], {
      PAGER_CONTROL_REPOSITORY: "monalisa/control",
    });
    assert.equal(
      await run(
        ["withdraw", "merge-order", "--reason", " No answer within the hour. "],
        m.io,
      ),
      0,
    );
    assert.equal(await run(["withdraw", "merge-order"], m.io), 0);
    assert.equal(
      await run(["withdraw", "merge-order", "--since", ASKED_AT], m.io),
      0,
    );
    assert.deepEqual(m.calls[0].args, [
      "api",
      "-H",
      "Accept: application/vnd.github.raw+json",
      "repos/monalisa/control/contents/answers/merge-order.json?ref=pager-answers",
    ]);
    assert.deepEqual(
      m.calls
        .filter((call) => call.input !== undefined)
        .map((call) => [call.args[1], call.input]),
      [
        [
          "repos/monalisa/control/dispatches",
          {
            event_type: "pager-withdraw",
            client_payload: {
              id: "merge-order",
              reason: "No answer within the hour.",
            },
          },
        ],
        [
          "repos/monalisa/control/dispatches",
          {
            event_type: "pager-withdraw",
            client_payload: { id: "merge-order" },
          },
        ],
        [
          "repos/monalisa/control/dispatches",
          {
            event_type: "pager-withdraw",
            client_payload: { id: "merge-order" },
          },
        ],
      ],
    );
    assert.deepEqual(m.out, [
      "Took merge-order back.",
      "Took merge-order back.",
      "Took merge-order back.",
    ]);
  });

  it("keeps a question that has an answer, which the agent reads instead", async () => {
    const m = machine([ANSWER, answeredAt("2026-11-08T07:02:00.000Z")]);
    assert.equal(await run(["withdraw", "merge-order"], m.io), 1);
    assert.equal(
      await run(["withdraw", "merge-order", "--since", ASKED_AT], m.io),
      1,
    );
    assert.equal(m.calls.length, 2);
    assert.deepEqual(m.err, [
      "Refused: merge-order has an answer already, which stands: node scripts/ask.mjs answer merge-order.",
      "Refused: merge-order has an answer already, which stands: node scripts/ask.mjs answer merge-order.",
    ]);
    const wrong = machine();
    assert.equal(await run(["withdraw"], wrong.io), 2);
    assert.equal(await run(["withdraw", "a", "b"], wrong.io), 2);
    assert.equal(
      await run(["withdraw", "merge-order", "--reason", " "], wrong.io),
      1,
    );
    assert.equal(wrong.calls.length, 0);
    assert.deepEqual(
      wrong.err.map((line) => line.split("\n")[0]),
      [
        "withdraw takes one id.",
        "withdraw takes one id.",
        "Refused: the reason is missing.",
      ],
    );
  });

  it("fails when gh or a check refuses, and names the commands for a wrong one", async () => {
    const m = machine([
      NONE,
      { status: 1, stdout: "", stderr: "HTTP 403: Resource not accessible\n" },
      { status: 1, stdout: "", stderr: "HTTP 500: Server Error\n" },
    ]);
    assert.equal(
      await run(["ask", "merge-order", "Which?", "A", "B"], m.io),
      1,
    );
    assert.equal(await run(["answer", "merge-order"], m.io), 1);
    assert.equal(await run(["ask", "merge-order", "Which?", "A"], m.io), 1);
    assert.equal(await run(["answer", "../x"], m.io), 1);
    assert.deepEqual(m.err, [
      "Refused: gh couldn't send the event: HTTP 403: Resource not accessible.",
      "Refused: gh couldn't read the answer: HTTP 500: Server Error.",
      "Refused: a question has 2 to 4 options.",
      "Refused: the id has 1 to 64 letters, digits, dots, dashes and underscores, and starts with a letter or a digit.",
    ]);
    const wrong = machine();
    for (const args of [
      [],
      ["deploy"],
      ["toString"],
      ["report"],
      ["report", "a", "b"],
      ["report", "--title"],
      ["report", "--color", "red", "Done."],
      ["wait", "merge-order", "--every", "0"],
      ["wait", "merge-order", "--timeout", "soon"],
    ]) {
      assert.equal(await run(args, wrong.io), 2, JSON.stringify(args));
    }
    assert.equal(wrong.calls.length, 0);
    assert.equal(wrong.err[0], USAGE);
    assert.deepEqual(
      wrong.err.slice(3).map((line) => line.split("\n")[0]),
      [
        "a report takes one text, or - for the standard input.",
        "a report takes one text, or - for the standard input.",
        "--title isn't a flag of this command, or has no value.",
        "--color isn't a flag of this command, or has no value.",
        "--every takes a number of seconds.",
        "--timeout takes a number of seconds.",
      ],
    );
  });

  it("lets a bug through", async () => {
    const m = machine();
    m.io.gh = () => {
      throw new TypeError("gh is broken");
    };
    await assert.rejects(run(["answer", "merge-order"], m.io), TypeError);
  });
});
