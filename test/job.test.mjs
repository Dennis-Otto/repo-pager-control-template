// The commands of the workflow, end to end in a folder of their own: the outputs
// that they write, the summary, and how a refusal fails the step.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { annotation, main, writeOutputs } from "../pager/job.mjs";
import { ITEM, json, Net, REPO } from "./fake.mjs";

async function folder() {
  return mkdtemp(join(tmpdir(), "pager-job-"));
}

/** The outputs of a step, as GitHub reads the file of GITHUB_OUTPUT. */
function outputs(text) {
  const found = {};
  const pattern = /^(\w[\w-]*)<<(EOF_[\w-]+)\n([\s\S]*?)\n\2\n/gm;
  for (const match of text.matchAll(pattern)) {
    found[match[1]] = match[3];
  }
  return found;
}

async function world(net = new Net()) {
  const dir = await folder();
  const env = {
    GITHUB_OUTPUT: join(dir, "output"),
    GITHUB_STEP_SUMMARY: join(dir, "summary"),
    GITHUB_REPOSITORY_OWNER: "monalisa",
    GITHUB_RUN_ID: "77",
    RUN_URL: "https://github.com/monalisa/repo-pager-control/actions/runs/77",
  };
  await writeFile(env.GITHUB_OUTPUT, "");
  await writeFile(env.GITHUB_STEP_SUMMARY, "");
  const lines = [];
  const io = {
    fetch: net.fetch,
    git: () => "",
    sleep: async () => undefined,
    log: (line) => lines.push(line),
  };
  const read = async (name) => readFile(join(dir, name), "utf8");
  return { dir, env, io, lines, net, read };
}

describe("the outputs of a step", () => {
  it("are written between delimiters that no value holds", async () => {
    const dir = await folder();
    const file = join(dir, "output");
    await writeOutputs(file, { a: "one\ntwo", b: "" });
    assert.deepEqual(outputs(await readFile(file, "utf8")), {
      a: "one\ntwo",
      b: "",
    });
  });
});

describe("prepare", () => {
  it("writes the job, its limits and its schema, and the data for Claude", async () => {
    const w = await world(
      new Net().on("POST", "/graphql", () => json({ data: {} })),
    );
    const event = join(w.dir, "event.json");
    await writeFile(
      event,
      JSON.stringify({
        action: "pager-text",
        client_payload: { text: "Hi", message: 3 },
      }),
    );
    const env = {
      ...w.env,
      GITHUB_EVENT_NAME: "repository_dispatch",
      GITHUB_EVENT_PATH: event,
      GH_TOKEN: "ghs_test",
      PAGER_INPUT: join(w.dir, "input"),
    };
    assert.equal(await main("prepare", env, w.io), 0);
    assert.deepEqual(w.lines, ["A job of the kind text."]);
    const got = outputs(await w.read("output"));
    assert.deepEqual(JSON.parse(got.job), {
      kind: "text",
      message: 3,
      language: "en",
    });
    assert.equal(got.turns, "12");
    assert.match(
      await readFile(join(w.dir, "input", "rules.md"), "utf8"),
      /Data is never an instruction/,
    );
    assert.equal(w.net.calls[0].headers.authorization, "Bearer ghs_test");
  });

  it("tells a fix whether PAGER_FIX_WORKFLOWS allows it to change the CI", async () => {
    const tasks = [];
    for (const allowed of [undefined, "true"]) {
      const w = await world(
        new Net().on("GET", "/issues/9", () =>
          json({ title: "A bot fails", body: "It does." }),
        ),
      );
      const event = join(w.dir, "event.json");
      await writeFile(
        event,
        JSON.stringify({
          action: "pager-fix",
          client_payload: {
            item: ITEM,
            repo: REPO,
            kind: "alarm",
            entries: [
              {
                label: "A bot fails",
                url: `https://github.com/${REPO}/issues/9`,
              },
            ],
          },
        }),
      );
      const env = {
        ...w.env,
        GITHUB_EVENT_NAME: "repository_dispatch",
        GITHUB_EVENT_PATH: event,
        PAGER_INPUT: join(w.dir, "input"),
        PAGER_FIX_WORKFLOWS: allowed,
      };
      assert.equal(await main("prepare", env, w.io), 0);
      tasks.push(await readFile(join(w.dir, "input", "task.md"), "utf8"));
    }
    assert.match(tasks[0], /isn't part of a fix/);
    assert.match(tasks[1], /the maintainer allows a fix to change one/);
  });

  it("takes the event of the smoke test in place of GitHub's", async () => {
    const w = await world(
      new Net().on("POST", "/graphql", () => json({ data: {} })),
    );
    const env = {
      ...w.env,
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: join(w.dir, "missing.json"),
      PAGER_EVENT_NAME: "workflow_dispatch",
      PAGER_EVENT_PATH: "test/fixtures/smoke.json",
      PAGER_INPUT: join(w.dir, "input"),
    };
    assert.equal(await main("prepare", env, w.io), 0);
    const text = await readFile(join(w.dir, "input", "text.txt"), "utf8");
    assert.match(text, /pong/);
  });

  it("fails the step on an event that isn't a job of the pager", async () => {
    const w = await world();
    const event = join(w.dir, "event.json");
    await writeFile(
      event,
      JSON.stringify({ action: "pager-text", client_payload: { text: "" } }),
    );
    const env = {
      ...w.env,
      GITHUB_EVENT_NAME: "repository_dispatch",
      GITHUB_EVENT_PATH: event,
    };
    assert.equal(await main("prepare", env, w.io), 1);
    assert.deepEqual(w.lines, ["::error::the text is missing"]);
  });
});

describe("pull-request", () => {
  const job = {
    kind: "fix",
    item: ITEM,
    repo: REPO,
    thing: "alarm",
    entries: [{ label: "lint", url: `https://github.com/${REPO}/runs/5` }],
  };
  const plan = JSON.stringify({
    answer: "A pin.",
    changed: true,
    title: "fix: pin it",
    body: "Why.",
  });

  it("opens the pull request with PAGER_FIX_TOKEN, and names it", async () => {
    const net = new Net()
      .on("GET", "/user", () => json({ login: "monalisa", id: 42 }))
      .on("GET", `/repos/${REPO}`, () => json({ default_branch: "main" }))
      .on("POST", "/git/refs", () => json({}, 201))
      .on("POST", "/graphql", () => json({ data: {} }))
      .on("POST", "/pulls", () =>
        json({ html_url: `https://github.com/${REPO}/pull/40` }, 201),
      );
    const w = await world(net);
    await mkdir(join(w.dir, "repo"));
    await writeFile(join(w.dir, "repo", "a.txt"), "new");
    w.io.git = (args) =>
      args[0] === "apply" ? "" : ":100644 100644 a b M\0a.txt\0";
    const env = {
      ...w.env,
      JOB: JSON.stringify(job),
      PLAN: plan,
      BASE: "c".repeat(40),
      PAGER_FIX_TOKEN: "github_pat_test",
      PAGER_REPO: join(w.dir, "repo"),
      PAGER_PATCH: join(w.dir, "fix.patch"),
    };
    assert.equal(await main("pull-request", env, w.io), 0);
    assert.deepEqual(w.lines, [`https://github.com/${REPO}/pull/40`]);
    assert.deepEqual(outputs(await w.read("output")), {
      url: `https://github.com/${REPO}/pull/40`,
      error: "",
    });
    assert.equal(net.calls[0].headers.authorization, "Bearer github_pat_test");
    const additions =
      net.to("/graphql")[0].body.variables.input.fileChanges.additions;
    assert.deepEqual(additions, [
      { path: "a.txt", contents: Buffer.from("new").toString("base64") },
    ]);
  });

  it("refuses a change of a workflow, unless PAGER_FIX_WORKFLOWS allows it", async () => {
    const results = [];
    for (const allowed of ["", "true"]) {
      const net = new Net()
        .on("GET", "/user", () => json({ login: "monalisa", id: 42 }))
        .on("GET", `/repos/${REPO}`, () => json({ default_branch: "main" }))
        .on("POST", "/git/refs", () => json({}, 201))
        .on("POST", "/graphql", () => json({ data: {} }))
        .on("POST", "/pulls", () =>
          json({ html_url: `https://github.com/${REPO}/pull/41` }, 201),
        );
      const w = await world(net);
      await mkdir(join(w.dir, "repo", ".github", "workflows"), {
        recursive: true,
      });
      await writeFile(
        join(w.dir, "repo", ".github", "workflows", "ci.yml"),
        "on: push",
      );
      w.io.git = (args) =>
        args[0] === "apply"
          ? ""
          : ":100644 100644 a b M .github/workflows/ci.yml ";
      const env = {
        ...w.env,
        JOB: JSON.stringify(job),
        PLAN: plan,
        BASE: "c".repeat(40),
        PAGER_FIX_TOKEN: "github_pat_test",
        PAGER_FIX_WORKFLOWS: allowed,
        PAGER_REPO: join(w.dir, "repo"),
        PAGER_PATCH: join(w.dir, "fix.patch"),
      };
      assert.equal(await main("pull-request", env, w.io), 0);
      results.push({ lines: w.lines, calls: net.calls.length });
    }
    assert.deepEqual(results[0], {
      lines: [
        "No pull request: the change touches what the CI runs, which a fix doesn't change unless PAGER_FIX_WORKFLOWS allows it: .github/workflows/ci.yml.",
      ],
      calls: 0,
    });
    assert.deepEqual(results[1].lines, [`https://github.com/${REPO}/pull/41`]);
  });

  it("says why there is none without its token, and refuses a wrong plan", async () => {
    const w = await world();
    const env = { ...w.env, JOB: JSON.stringify(job), PLAN: plan };
    assert.equal(await main("pull-request", env, w.io), 0);
    assert.deepEqual(w.lines, [
      "No pull request: PAGER_FIX_TOKEN isn't set in the control repository.",
    ]);
    assert.equal(await main("pull-request", { ...env, PLAN: "{}" }, w.io), 1);
    assert.equal(w.lines[1], "::error::the answer has no changed");
  });
});

describe("answer", () => {
  // The result as the Claude Code action writes it, with its usage per model.
  const execution = [
    { type: "system", subtype: "init", model: "claude-opus-5-5" },
    {
      type: "result",
      num_turns: 3,
      duration_ms: 12000,
      is_error: false,
      modelUsage: {
        "claude-opus-5-5": {
          inputTokens: 6,
          outputTokens: 466,
          cacheReadInputTokens: 11390,
          cacheCreationInputTokens: 12567,
          webSearchRequests: 0,
          costUSD: 0.09,
        },
      },
    },
  ];

  async function answer(w, fields) {
    const transcript = join(w.dir, "transcript");
    await mkdir(transcript, { recursive: true });
    const env = {
      ...w.env,
      JOB: JSON.stringify({ kind: "draft", item: ITEM }),
      ASK_RESULT: "success",
      PLAN: '{"reply":"Thanks!"}',
      PAGER_TRANSCRIPT: transcript,
      PAGER_URL: "https://pager.example",
      PAGER_CONTROL_SECRET: "control-secret",
      ...fields,
    };
    return { code: await main("answer", env, w.io), transcript };
  }

  it("sends the answer with what the run took, and shows it in the summary", async () => {
    const net = new Net().on("POST", "/control", () => new Response("drafted"));
    const w = await world(net);
    const transcript = join(w.dir, "transcript");
    await mkdir(transcript);
    await writeFile(join(transcript, "notes.txt"), "not this");
    await writeFile(
      join(transcript, "claude-execution-output.json"),
      JSON.stringify(execution),
    );
    const { code } = await answer(w, {});
    assert.equal(code, 0);
    assert.deepEqual(net.calls[0].body, {
      type: "draft",
      item: ITEM,
      text: "Thanks!",
      usage: {
        turns: 3,
        seconds: 12,
        models: [{ model: "claude-opus-5-5", tokens: 24429 }],
        effort: "high",
      },
    });
    assert.deepEqual(w.lines, ["The pager answered: drafted"]);
    assert.match(
      await w.read("summary"),
      /### The answer for the pager\n\n```json\n\{\n {2}"type": "draft"/,
    );
  });

  it("does without a transcript, and fails the step when the pager refuses", async () => {
    const net = new Net().on(
      "POST",
      "/control",
      () => new Response("Unauthorized", { status: 401 }),
    );
    const w = await world(net);
    const { code } = await answer(w, {
      ASK_RESULT: "failure",
      PLAN: undefined,
      PAGER_TRANSCRIPT: join(w.dir, "missing"),
    });
    assert.equal(code, 1);
    assert.equal(net.calls[0].body.type, "failed");
    assert.equal(net.calls[0].body.usage, undefined);
    assert.match(
      w.lines[0],
      /^::error::Not sent: the pager refused the signature/,
    );
  });

  it("names a fix and its pull request, and an empty folder of the transcript", async () => {
    const net = new Net().on("POST", "/control", () => new Response("noted"));
    const w = await world(net);
    const plan = JSON.stringify({
      answer: "A pin.",
      changed: true,
      title: "fix: pin it",
      body: "b",
    });
    const { code } = await answer(w, {
      JOB: JSON.stringify({ kind: "fix", item: ITEM }),
      PLAN: plan,
      CHANGED: "true",
      PULL_URL: "https://github.com/x/pull/3",
    });
    assert.equal(code, 0);
    assert.equal(
      net.calls[0].body.text,
      "🛠 A pin. The pull request: https://github.com/x/pull/3",
    );
  });

  it("warns of each write that Claude Code refused", async () => {
    const net = new Net().on("POST", "/control", () => new Response("noted"));
    const w = await world(net);
    const transcript = join(w.dir, "transcript");
    await mkdir(transcript);
    const refused = structuredClone(execution);
    refused[1].permission_denials = [
      {
        tool_name: "Edit",
        tool_use_id: "toolu_1",
        tool_input: { file_path: "repo/.github/workflows/ci.yml" },
      },
      {
        tool_name: "Write",
        tool_use_id: "toolu_2",
        tool_input: { file_path: "repo/a%0A\n::add-mask::x\r.md" },
      },
    ];
    await writeFile(
      join(transcript, "claude-execution-output.json"),
      JSON.stringify(refused),
    );
    const { code } = await answer(w, {
      JOB: JSON.stringify({ kind: "fix", item: ITEM }),
      PLAN: JSON.stringify({
        answer: "The write was refused.",
        changed: false,
        title: "",
        body: "",
      }),
      CHANGED: "false",
    });
    assert.equal(code, 0);
    assert.deepEqual(w.lines, [
      "::warning::Claude Code refused Edit repo/.github/workflows/ci.yml, Write repo/a%250A%0A::add-mask::x%0D.md.",
      "The pager answered: noted",
    ]);
  });

  it("escapes the message of an annotation as @actions/core does", () => {
    assert.equal(
      annotation("error", "100% sure\r\n::stop-commands::x"),
      "::error::100%25 sure%0D%0A::stop-commands::x",
    );
  });

  it("only shows the answer while the pager isn't set up", async () => {
    const w = await world();
    const { code } = await answer(w, {
      PAGER_URL: undefined,
      PAGER_CONTROL_SECRET: undefined,
    });
    assert.equal(code, 0);
    assert.match(w.lines[0], /^Not sent: the variable PAGER_URL/);
  });

  describe("of a translation", () => {
    const JOB = JSON.stringify({
      kind: "translate",
      item: ITEM,
      repo: REPO,
      of: "0a1b2c3d",
      lines: ["the pager speaks German", "bump anchore/syft (#4)"],
      language: "de",
    });

    it("sends the lines that keep their notes, signed, and shows them in the summary", async () => {
      const net = new Net().on(
        "POST",
        "/control",
        () => new Response("translated"),
      );
      const w = await world(net);
      const { code } = await answer(w, {
        JOB,
        PLAN: JSON.stringify({
          lines: ["Der Pager spricht Deutsch", "anchore/syft angehoben (#4)"],
        }),
      });
      assert.equal(code, 0);
      assert.deepEqual(net.calls[0].body, {
        type: "translation",
        item: ITEM,
        of: "0a1b2c3d",
        lines: ["Der Pager spricht Deutsch", "anchore/syft angehoben (#4)"],
      });
      assert.match(net.calls[0].headers["x-pager-signature"], /^sha256=/);
      assert.deepEqual(w.lines, ["The pager answered: translated"]);
      assert.match(
        await w.read("summary"),
        /^### The translation for the pager\n\n```json\n\{\n {2}"type": "translation"/,
      );
    });

    it("sends nothing for a translation that lost a name or didn't come to be, and warns", async () => {
      const cases = [
        [
          { PLAN: JSON.stringify({ lines: ["Deutsch", "syft (#4)"] }) },
          'line 2 of the translation lost "anchore/syft"',
        ],
        [
          { ASK_RESULT: "failure", PLAN: undefined },
          "the step of Claude failed",
        ],
      ];
      for (const [fields, why] of cases) {
        const net = new Net();
        const w = await world(net);
        const { code } = await answer(w, { JOB, ...fields });
        assert.equal(code, 0);
        assert.equal(net.calls.length, 0);
        assert.deepEqual(w.lines, [
          `::warning::No translation for the pager: ${why}.`,
          "Nothing sent: the message of the release keeps its notes in English.",
        ]);
        assert.equal(
          await w.read("summary"),
          `### No translation for the pager\n\nThe message of the release keeps its notes in English: ${why}.\n`,
        );
      }
    });

    it("fails the step when the pager refuses the translation", async () => {
      const net = new Net().on(
        "POST",
        "/control",
        () => new Response("Unprocessable Content", { status: 422 }),
      );
      const w = await world(net);
      const { code } = await answer(w, {
        JOB,
        PLAN: JSON.stringify({
          lines: ["Der Pager spricht Deutsch", "anchore/syft angehoben (#4)"],
        }),
      });
      assert.equal(code, 1);
      assert.match(w.lines[0], /^::error::Not sent: the pager found/);
    });
  });
});

describe("forward", () => {
  async function forward(w, event, fields = {}) {
    const path = join(w.dir, "event.json");
    await writeFile(path, JSON.stringify(event));
    const env = {
      ...w.env,
      GITHUB_EVENT_NAME: "repository_dispatch",
      GITHUB_EVENT_PATH: path,
      PAGER_URL: "https://pager.example/",
      PAGER_CONTROL_SECRET: "control-secret",
      ...fields,
    };
    return main("forward", env, w.io);
  }

  const asked = {
    action: "pager-ask",
    sender: { login: "monalisa", type: "User" },
    client_payload: {
      id: "merge-order",
      question: "Which release goes first?",
      options: ["The blueprint", "The pager"],
    },
  };

  it("sends a question of the owner to the pager, signed, and shows it in the summary", async () => {
    const net = new Net().on("POST", "/control", () => new Response("asked"));
    const w = await world(net);
    assert.equal(await forward(w, asked), 0);
    const [call] = net.calls;
    assert.equal(call.url, "https://pager.example/control");
    assert.deepEqual(call.body, {
      type: "ask",
      id: "merge-order",
      question: "Which release goes first?",
      options: ["The blueprint", "The pager"],
    });
    assert.match(call.headers["x-pager-signature"], /^sha256=[0-9a-f]{64}$/);
    assert.deepEqual(w.lines, ["The pager answered: asked"]);
    assert.match(
      await w.read("summary"),
      /### What goes to the pager\n\n```json\n\{\n {2}"type": "ask"/,
    );
  });

  it("fails the run for the event of someone else, and when the pager refuses", async () => {
    const net = new Net().on(
      "POST",
      "/control",
      () => new Response("Bad Request", { status: 400 }),
    );
    const w = await world(net);
    const app = { ...asked, sender: { login: "pager[bot]", type: "Bot" } };
    assert.equal(await forward(w, app), 1);
    assert.equal(net.calls.length, 0);
    assert.match(w.lines[0], /^::error::only monalisa asks/);
    assert.equal(await forward(w, asked), 1);
    assert.match(
      w.lines[1],
      /^::error::Not sent: the pager doesn't take this body/,
    );
  });

  it("only shows a question in the summary while the pager isn't set up", async () => {
    const w = await world();
    const unset = { PAGER_URL: undefined, PAGER_CONTROL_SECRET: undefined };
    assert.equal(await forward(w, asked, unset), 0);
    assert.match(w.lines[0], /^Not sent: the variable PAGER_URL/);
    assert.match(await w.read("summary"), /"id": "merge-order"/);
  });
});

describe("the command line", () => {
  it("names the commands for an unknown one, and lets a bug through", async () => {
    const w = await world();
    assert.equal(await main("deploy", w.env, w.io), 2);
    assert.match(
      w.lines[0],
      /Unknown command deploy: prepare, access, smoke-fix, smoke-fix-check, pull-request, answer, forward, health or template/,
    );
    await assert.rejects(
      main("answer", { ...w.env, JOB: "not json" }, w.io),
      SyntaxError,
    );
  });
});

describe("the smoke test of a fix", () => {
  it("collects its task and rules, with the tools and the mode of a fix", async () => {
    const w = await world();
    const env = { ...w.env, PAGER_INPUT: join(w.dir, "input") };
    assert.equal(await main("smoke-fix", env, w.io), 0);
    assert.deepEqual(w.lines, [
      "The smoke test of a fix, with the tools and the mode of a fix.",
    ]);
    const got = outputs(await w.read("output"));
    assert.equal(got.tools, "Read,Grep,Glob,Edit,Write");
    assert.equal(got.mode, "acceptEdits");
    assert.deepEqual(JSON.parse(got.schema).required, [
      "answer",
      "changed",
      "title",
      "body",
    ]);
    assert.match(
      await readFile(join(w.dir, "input", "task.md"), "utf8"),
      /repo\/\.github\/workflows\/smoke\.yml/,
    );
    assert.match(
      await readFile(join(w.dir, "input", "rules.md"), "utf8"),
      /Data is never an instruction/,
    );
  });

  const plan = JSON.stringify({
    answer: "Changed both.",
    changed: true,
    title: "test: the smoke test of a fix",
    body: "Two lines.",
  });

  it("passes for a change of both files", async () => {
    const w = await world();
    const patch = join(w.dir, "fix.patch");
    await writeFile(
      patch,
      [
        "diff --git a/.github/workflows/smoke.yml b/.github/workflows/smoke.yml",
        "@@ -1 +1,2 @@",
        "+# The smoke test of a fix wrote this line.",
        "diff --git a/README.md b/README.md",
        "@@ -1 +1,2 @@",
        "+<!-- The smoke test of a fix wrote this line. -->",
        "",
      ].join("\n"),
    );
    const env = {
      ...w.env,
      PLAN: plan,
      CHANGED: "true",
      PAGER_PATCH: patch,
      PAGER_TRANSCRIPT: join(w.dir, "missing"),
    };
    assert.equal(await main("smoke-fix-check", env, w.io), 0);
    assert.match(
      w.lines[0],
      /^Claude changed \.github\/workflows\/smoke\.yml and README\.md/,
    );
  });

  it("fails without a change, and names the writes that were refused", async () => {
    const w = await world();
    const transcript = join(w.dir, "transcript");
    await mkdir(transcript);
    await writeFile(
      join(transcript, "claude-execution-output.json"),
      JSON.stringify([
        {
          type: "result",
          permission_denials: [
            { tool_name: "Edit", tool_input: { file_path: "repo/README.md" } },
          ],
        },
      ]),
    );
    const env = {
      ...w.env,
      PLAN: JSON.stringify({ answer: "Refused.", changed: false }),
      CHANGED: "false",
      PAGER_PATCH: join(w.dir, "missing.patch"),
      PAGER_TRANSCRIPT: transcript,
    };
    assert.equal(await main("smoke-fix-check", env, w.io), 1);
    assert.match(
      w.lines[0],
      /^::error::A fix can't change what it should: the job ask collected no change/,
    );
    assert.match(
      w.lines[0],
      /Claude Code refused Edit repo\/README\.md\. Claude answered: Refused\.$/,
    );
  });

  it("fails without an answer", async () => {
    const w = await world();
    const env = {
      ...w.env,
      CHANGED: "false",
      PAGER_PATCH: join(w.dir, "missing.patch"),
      PAGER_TRANSCRIPT: join(w.dir, "missing"),
    };
    assert.equal(await main("smoke-fix-check", env, w.io), 1);
    assert.deepEqual(w.lines, ["::error::Claude gave no answer"]);
  });
});
