// The check of the set-up, against a simulated GitHub and a simulated pager: one
// line per item, and what is wrong with each, also through the command of the job.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { DEPENDABOT, doctor, NEEDED, summaryOf } from "../pager/doctor.mjs";
import { annotation, main } from "../pager/job.mjs";
import { json, Net } from "./fake.mjs";

const NOW = Date.parse("2026-11-08T07:00:00Z");
const HEADER = "github-authentication-token-expiration";
const CONTROL = "monalisa/repo-pager-control";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const SETTINGS = JSON.stringify({
  template: "Dennis-Otto/repo-pager-control-template",
  commit: COMMIT,
  own: ["README.md"],
});

/** The health of a pager that is well, as of NOW. */
function well(extra = {}) {
  return {
    schedule: "2026-11-08T06:45:00.000Z",
    telegram: { ok: true, webhook: true, pending: 0 },
    github: { ok: true },
    tokens: { claude: { expires: "2027-10-07" } },
    ...extra,
  };
}

/** GitHub's answer to GET /repos of this repository with PAGER_FIX_TOKEN. */
function repository(push, expires = "2027-01-31 10:00:00 UTC") {
  return () =>
    new Response(JSON.stringify({ permissions: { push } }), {
      headers: expires === null ? {} : { [HEADER]: expires },
    });
}

/** A copy that is set up, on a GitHub and a pager that answer as they should. */
function network() {
  return new Net()
    .on("GET", "/apps/repo-pager-of-monalisa", () =>
      json({ name: "Repo Pager of monalisa" }),
    )
    .on("GET", `/repos/${CONTROL}`, repository(true))
    .on("POST", "/control", () => json(well()));
}

const SET = Object.fromEntries(NEEDED.map(({ name }) => [name, true]));

function check(net, extra = {}) {
  return doctor({
    set: SET,
    url: "https://pager.example",
    secret: "control-secret",
    app: "repo-pager-of-monalisa",
    token: "github_pat_test",
    workflowToken: "ghs_test",
    repo: CONTROL,
    model: "",
    limits: "",
    dependabot: false,
    settings: SETTINGS,
    fetcher: net.fetch,
    now: () => NOW,
    sleep: async () => undefined,
    ...extra,
  });
}

const stateOf = (lines, what) =>
  lines.filter((line) => line.what === what).map(({ state }) => state);

describe("the check of the set-up", () => {
  it("passes a copy that is set up, with one line per item", async () => {
    const net = network();
    const { lines, problems } = await check(net);
    assert.deepEqual(problems, []);
    assert.deepEqual(
      lines.map(({ what }) => what),
      [
        "CLAUDE_CODE_OAUTH_TOKEN",
        "PAGER_CONTROL_SECRET",
        "PAGER_URL",
        "PAGER_APP",
        "PAGER_FIX_TOKEN",
        "PAGER_MODEL and PAGER_LIMITS",
        "The app of PAGER_APP",
        "PAGER_FIX_TOKEN on this repository",
        "The pager",
        DEPENDABOT,
        ".github/template.json",
      ],
    );
    assert.deepEqual(stateOf(lines, "The app of PAGER_APP"), [
      "GitHub knows repo-pager-of-monalisa, Repo Pager of monalisa: its events start the jobs of Claude",
    ]);
    assert.match(
      stateOf(lines, "PAGER_FIX_TOKEN on this repository")[0],
      /^writes to monalisa\/repo-pager-control and expires on 2027-01-31\. GitHub shows no other permission/,
    );
    assert.deepEqual(stateOf(lines, ".github/template.json"), [
      "takes Dennis-Otto/repo-pager-control-template, last at 0123456789ab",
    ]);
    assert.match(
      stateOf(lines, "PAGER_MODEL and PAGER_LIMITS")[0],
      /^not set: every kind of job runs with the limits of the template$/,
    );
    // The app is asked with PAGER_FIX_TOKEN, which sees a private app of its owner.
    assert.equal(
      net.to("/apps/repo-pager-of-monalisa")[0].headers.authorization,
      "Bearer github_pat_test",
    );
    // The pager gets the day of PAGER_FIX_TOKEN, as Health sends it.
    assert.deepEqual(net.to("/control")[0].body, {
      type: "health",
      tokens: { fix: "2027-01-31" },
    });
  });

  it("names each secret and variable that isn't set, and how to set it", async () => {
    const net = new Net();
    const { lines, problems } = await check(net, {
      set: { ...SET, PAGER_URL: false, PAGER_FIX_TOKEN: false },
      url: "",
      token: "",
      app: "",
      settings: JSON.stringify({ ...JSON.parse(SETTINGS), commit: "" }),
    });
    assert.deepEqual(problems, [
      'The variable PAGER_URL isn\'t set: set the address of your Worker with gh variable set PAGER_URL -R "$CONTROL" --body "$WORKER".',
      `The secret PAGER_FIX_TOKEN isn't set: ${NEEDED[4].how}.`,
      "Not asked: it needs PAGER_URL and PAGER_CONTROL_SECRET, which the lines above name.",
    ]);
    // Without its value, nothing that needs it is asked.
    assert.equal(net.calls.length, 0);
    assert.deepEqual(stateOf(lines, "PAGER_FIX_TOKEN on this repository"), []);
    assert.deepEqual(stateOf(lines, ".github/template.json"), [
      "takes Dennis-Otto/repo-pager-control-template, not yet: the first run of the workflow Template brings it",
    ]);
    const secret = await check(network(), { secret: "" });
    assert.equal(secret.problems.length, 1);
  });

  it("reads PAGER_MODEL and PAGER_LIMITS as the job prepare does", async () => {
    const tuned = await check(network(), {
      model: "claude-sonnet-5-5",
      limits: '{"fix": {"budget": "1.50", "model": "claude-opus-5-5"}}',
    });
    assert.deepEqual(tuned.problems, []);
    assert.equal(
      stateOf(tuned.lines, "PAGER_MODEL and PAGER_LIMITS")[0],
      "text claude-sonnet-5-5 at high, 0.50 dollars, 12 turns; draft claude-sonnet-5-5 at high, 1.00 dollars, 16 turns; fix claude-opus-5-5 at xhigh, 1.50 dollars, no limit of turns; translate claude-sonnet-5-5 at medium, 0.30 dollars, no limit of turns",
    );
    const wrong = await check(network(), {
      limits: '{"fix": {"tools": "Bash"}}',
    });
    assert.match(
      wrong.problems[0],
      /^PAGER_LIMITS can't set tools of fix: .+\. Every job is held until it is fixed: correct the variable, or delete it for the limits of the template\.$/,
    );
    await assert.rejects(check(network(), { limits: 5 }), TypeError);
  });

  it("names a PAGER_APP that is no app on GitHub", async () => {
    const malformed = await check(network(), { app: "Repo Pager" });
    assert.match(
      malformed.problems[0],
      /^"Repo Pager" isn't the slug of an app, the lower-case name in its address github\.com\/apps\/NAME/,
    );
    const net = network().on("GET", "/apps/repo-pager-of-monalisa", () =>
      json({ message: "Not Found" }, 404),
    );
    assert.deepEqual((await check(net)).problems, [
      "GitHub knows no app repo-pager-of-monalisa: set PAGER_APP to the name in the address of your app, github.com/apps/NAME.",
    ]);
    // Without PAGER_FIX_TOKEN, the token of the workflow asks, which sees no private app.
    const unowned = await check(net, {
      token: "",
      set: { ...SET, PAGER_FIX_TOKEN: false },
    });
    assert.match(
      unowned.problems[1],
      /github\.com\/apps\/NAME\. A private app shows only to a token of its owner: set PAGER_FIX_TOKEN and run this again\.$/,
    );
    assert.equal(
      net.to("/apps/repo-pager-of-monalisa").at(-1).headers.authorization,
      "Bearer ghs_test",
    );
    const broken = network().on("GET", "/apps/repo-pager-of-monalisa", () =>
      json({ message: "Server Error" }, 502),
    );
    assert.deepEqual((await check(broken)).problems, [
      "GitHub didn't say whether the app repo-pager-of-monalisa exists: GitHub answered 502: Server Error.",
    ]);
    const offline = network().on("GET", "/apps/repo-pager-of-monalisa", () => {
      throw new TypeError("fetch failed");
    });
    await assert.rejects(check(offline), TypeError);
  });

  it("names what PAGER_FIX_TOKEN may not do here, and a day that comes soon", async () => {
    const answer = async (rule) => {
      const net = network().on("GET", `/repos/${CONTROL}`, rule);
      return (await check(net)).problems;
    };
    assert.deepEqual(
      await answer(() => json({ message: "Bad credentials" }, 401)),
      [
        "GitHub refuses it: it expired or was revoked. Make a new one and set it with gh secret set PAGER_FIX_TOKEN.",
      ],
    );
    assert.match(
      (await answer(() => json({ message: "Forbidden" }, 403)))[0],
      /^GitHub refuses it for monalisa\/repo-pager-control: GitHub answered 403: Forbidden\. Give it this repository/,
    );
    assert.match(
      (await answer(() => json({ message: "Not Found" }, 404)))[0],
      /^it doesn't reach monalisa\/repo-pager-control: add this repository to the token/,
    );
    assert.deepEqual(await answer(() => json({ message: "Oops" }, 500)), [
      "GitHub didn't answer for monalisa/repo-pager-control: GitHub answered 500: Oops.",
    ]);
    assert.deepEqual(await answer(repository(false, null)), [
      "It reads monalisa/repo-pager-control but may not write to it: give it Contents, Pull requests and Workflows read and write; it has no day of expiry.",
    ]);
    assert.deepEqual(
      await answer(repository(true, "2026-11-12 10:00:00 UTC")),
      [
        "It expires on 2026-11-12: make a new one and set it with gh secret set PAGER_FIX_TOKEN.",
      ],
    );
    const lasting = network().on(
      "GET",
      `/repos/${CONTROL}`,
      repository(true, null),
    );
    const { lines } = await check(lasting);
    assert.match(
      stateOf(lines, "PAGER_FIX_TOKEN on this repository")[0],
      /and has no day of expiry\./,
    );
    assert.deepEqual(lasting.to("/control")[0].body, {
      type: "health",
      tokens: { fix: null },
    });
    // Without an answer of GitHub, the pager gets no day of the token.
    const refused = network().on("GET", `/repos/${CONTROL}`, () =>
      json({ message: "Bad credentials" }, 401),
    );
    await check(refused);
    assert.deepEqual(refused.to("/control")[0].body, { type: "health" });
    const offline = network().on("GET", `/repos/${CONTROL}`, () => {
      throw new TypeError("fetch failed");
    });
    await assert.rejects(check(offline), TypeError);
  });

  it("names what is wrong with the pager, as Health does", async () => {
    const sick = network().on("POST", "/control", () =>
      json(well({ schedule: null, github: { ok: false, error: "401" } })),
    );
    const { problems } = await check(sick);
    assert.equal(problems.length, 2);
    assert.match(
      problems[0],
      /^The schedule of the pager never ran to its end/,
    );
    assert.match(problems[1], /^GitHub refuses the app of the pager: 401/);
    const refusing = network().on(
      "POST",
      "/control",
      () => new Response("Unauthorized", { status: 401 }),
    );
    assert.match(
      (await check(refusing)).problems[0],
      /PAGER_CONTROL_SECRET must equal CONTROL_SECRET of the Worker/,
    );
    const down = network().on(
      "POST",
      "/control",
      () => new Response("down", { status: 503 }),
    );
    await assert.rejects(
      check(down, {
        sleep: async () => {
          throw new TypeError("no timer");
        },
      }),
      TypeError,
    );
  });

  it("names a .github/dependabot.yml that is still here, and settings that don't read", async () => {
    const { problems } = await check(network(), {
      dependabot: true,
      settings: '{"template": "Dennis-Otto/repo-pager-control-template"}',
    });
    assert.deepEqual(problems, [
      "It is still here, and its bumps would fight the pull request of the workflow Template: delete it, as Set it up of the README says.",
      "the commit of .github/template.json isn't empty or a commit of git: correct it, or take it from the template again.",
    ]);
    assert.deepEqual((await check(network(), { settings: null })).problems, [
      "It is missing, and the workflow Template can't run without it: take it from the template again.",
    ]);
  });

  it("writes the lines as a table, with a pipe of a state kept", () => {
    const summary = summaryOf([
      { what: "PAGER_URL", ok: true, state: "set" },
      { what: "The pager", ok: false, state: "a | b" },
    ]);
    assert.match(summary, /^### The set-up of this control repository\n/);
    assert.match(summary, /^\| ✅ \| PAGER_URL \| set \|$/m);
    assert.match(summary, /^\| ❌ \| The pager \| a \\\| b \|$/m);
    assert.match(summary, /set PAGER_AI_RUNNER/);
  });
});

describe("the command doctor", () => {
  async function world(net, files = {}) {
    const dir = await mkdtemp(join(tmpdir(), "pager-doctor-"));
    await mkdir(join(dir, ".github"));
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(dir, name), content);
    }
    const env = {
      GITHUB_WORKSPACE: dir,
      GITHUB_STEP_SUMMARY: join(dir, "summary"),
      GITHUB_REPOSITORY: CONTROL,
      CLAUDE_TOKEN_SET: "true",
      PAGER_CONTROL_SECRET: "control-secret",
      PAGER_URL: " https://pager.example ",
      PAGER_APP: "repo-pager-of-monalisa",
      PAGER_FIX_TOKEN: "github_pat_test",
      GH_TOKEN: "ghs_test",
    };
    await writeFile(env.GITHUB_STEP_SUMMARY, "");
    const lines = [];
    const io = {
      fetch: net.fetch,
      sleep: async () => undefined,
      log: (line) => lines.push(line),
    };
    return { dir, env, io, lines };
  }

  /** A pager that is well right now, since the command reads the real clock. */
  const live = () =>
    network().on("POST", "/control", () =>
      json(well({ schedule: new Date().toISOString() })),
    );

  it("passes a copy that is set up and writes its summary", async () => {
    const w = await world(live(), { ".github/template.json": SETTINGS });
    assert.equal(await main("doctor", w.env, w.io), 0);
    assert.deepEqual(w.lines, ["The set-up is complete: 11 items checked."]);
    const summary = await readFile(w.env.GITHUB_STEP_SUMMARY, "utf8");
    assert.match(summary, /^\| ✅ \| PAGER_URL \| set \|$/m);
    assert.doesNotMatch(summary, /control-secret|github_pat_test/);
  });

  it("fails with one error per problem, the last one failing the step", async () => {
    const w = await world(live());
    await writeFile(join(w.dir, DEPENDABOT), "version: 2\n");
    const env = { ...w.env, CLAUDE_TOKEN_SET: "false", PAGER_LIMITS: "[]" };
    delete env.PAGER_MODEL;
    assert.equal(await main("doctor", env, w.io), 1);
    assert.equal(w.lines.length, 4);
    assert.match(
      w.lines[0],
      /^::error::The secret CLAUDE_CODE_OAUTH_TOKEN isn't set/,
    );
    assert.match(w.lines[1], /^::error::PAGER_LIMITS isn't a JSON object/);
    assert.match(w.lines[2], /^::error::It is still here/);
    assert.equal(
      w.lines[3],
      annotation(
        "error",
        "It is missing, and the workflow Template can't run without it: take it from the template again.",
      ),
    );
  });

  it("reads the settings with what it may, and lets another failure through", async () => {
    const w = await world(live());
    // A folder where the file belongs can't be read as text.
    await mkdir(join(w.dir, ".github/template.json"));
    await assert.rejects(main("doctor", w.env, w.io), { code: "EISDIR" });
    const empty = await world(live(), { ".github/template.json": SETTINGS });
    const env = { ...empty.env };
    for (const name of [
      "PAGER_CONTROL_SECRET",
      "PAGER_URL",
      "PAGER_APP",
      "PAGER_FIX_TOKEN",
      "GH_TOKEN",
    ]) {
      delete env[name];
    }
    assert.equal(await main("doctor", env, empty.io), 1);
    assert.equal(empty.lines.length, 5);
  });
});
