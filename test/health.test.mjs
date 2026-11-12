// The daily check of the pager (health.yml): the day of PAGER_FIX_TOKEN from
// GitHub, the signed question for the health of the pager, and each problem that
// fails the run, with its summary.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  askPager,
  check,
  expiryOf,
  fixToken,
  problems,
  summary,
} from "../pager/health.mjs";
import { main } from "../pager/job.mjs";
import { json, Net } from "./fake.mjs";

const NOW = Date.parse("2026-11-08T07:00:00Z");
const HEADER = "github-authentication-token-expiration";

/** The health of a pager that is well, as of NOW. */
function well(extra = {}) {
  return {
    schedule: "2026-11-08T06:45:00.000Z",
    telegram: { ok: true, webhook: true, pending: 0 },
    github: { ok: true },
    tokens: {
      claude: { expires: "2027-10-07" },
      user: { expires: "2026-12-03" },
      fix: { expires: null },
    },
    ...extra,
  };
}

/** GitHub's answer to GET /rate_limit, with the day of the token, if any. */
function limits(expires) {
  return () =>
    new Response("{}", {
      headers: expires === undefined ? {} : { [HEADER]: expires },
    });
}

const ask = (net, body = { type: "health" }, fields = {}) =>
  askPager({
    url: "https://pager.example/",
    secret: "control-secret",
    body,
    fetcher: net.fetch,
    now: () => NOW,
    sleep: async () => undefined,
    ...fields,
  });

describe("the day of a token", () => {
  it("is the day in UTC of GitHub's header, in each form, and none without it", () => {
    assert.equal(expiryOf("2026-12-03 10:00:00 UTC"), "2026-12-03");
    assert.equal(expiryOf("2026-12-03T10:00:00Z"), "2026-12-03");
    assert.equal(expiryOf("2026-12-03 20:00:00 -0800"), "2026-12-04");
    assert.equal(expiryOf("2026-12-03 01:00:00 +02:00"), "2026-12-02");
    assert.equal(expiryOf("2026-12-03 10:00:00"), "2026-12-03");
    assert.equal(expiryOf(null), null);
    assert.equal(expiryOf("soon"), null);
    assert.equal(expiryOf("2026-13-45 10:00:00 UTC"), null);
  });

  it("of PAGER_FIX_TOKEN comes from GET /rate_limit, with the token", async () => {
    const net = new Net().on(
      "GET",
      "/rate_limit",
      limits("2026-12-04 09:00:00 UTC"),
    );
    assert.deepEqual(await fixToken("fix-token", net.fetch), {
      expires: "2026-12-04",
    });
    assert.equal(net.calls[0].headers.authorization, "Bearer fix-token");
    const none = new Net().on("GET", "/rate_limit", limits());
    assert.deepEqual(await fixToken("fix-token", none.fetch), {
      expires: null,
    });
  });

  it("says that GitHub refuses PAGER_FIX_TOKEN, that it isn't set, or that GitHub didn't answer", async () => {
    const refused = new Net().on("GET", "/rate_limit", () =>
      json({ message: "Bad credentials" }, 401),
    );
    assert.deepEqual(await fixToken("fix-token", refused.fetch), {
      refused: true,
    });
    assert.match((await fixToken("", refused.fetch)).note, /isn't set/);
    assert.equal(refused.calls.length, 1);
    const down = new Net().on("GET", "/rate_limit", () =>
      json({ message: "Unicorn" }, 503),
    );
    assert.deepEqual(await fixToken("fix-token", down.fetch), {
      note: "GitHub didn't say when PAGER_FIX_TOKEN expires: GitHub answered 503: Unicorn.",
    });
  });
});

describe("the question for the health", () => {
  it("is signed over the time and the body, and returns the answer", async () => {
    const net = new Net().on("POST", "/control", () => json(well()));
    assert.deepEqual(await ask(net), well());
    const [call] = net.calls;
    assert.equal(call.url, "https://pager.example/control");
    assert.deepEqual(call.body, { type: "health" });
    const stamp = String(NOW / 1000);
    assert.equal(call.headers["x-pager-timestamp"], stamp);
    assert.equal(
      call.headers["x-pager-signature"],
      `sha256=${createHmac("sha256", "control-secret").update(`${stamp}.{"type":"health"}`).digest("hex")}`,
    );
  });

  it("tries three times after a failure of the network or the Worker", async () => {
    let calls = 0;
    const net = new Net().on("POST", "/control", () => {
      calls += 1;
      if (calls === 1) {
        throw new TypeError("fetch failed");
      }
      return calls === 2 ? new Response("down", { status: 502 }) : json(well());
    });
    const waits = [];
    const answer = await ask(net, undefined, {
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });
    assert.deepEqual(answer, well());
    assert.deepEqual(waits, [2000, 4000]);
    const dead = new Net().on(
      "POST",
      "/control",
      () => new Response("down", { status: 503 }),
    );
    await assert.rejects(ask(dead), {
      message: "The pager didn't answer after 3 tries: it answered 503: down.",
    });
  });

  it("tries again after a limit of Cloudflare, for as long as its Retry-After asks", async () => {
    const answers = [
      new Response("<!DOCTYPE html>", {
        status: 429,
        headers: { "retry-after": "5" },
      }),
      new Response("<!DOCTYPE html>", { status: 408 }),
      json(well()),
    ];
    const net = new Net().on("POST", "/control", () => answers.shift());
    const waits = [];
    const answer = await ask(net, undefined, {
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });
    assert.deepEqual(answer, well());
    assert.deepEqual(waits, [5000, 4000]);
  });

  it("names the limit of Cloudflare, not the secret, when every try meets it", async () => {
    const limited = new Net().on(
      "POST",
      "/control",
      () => new Response("<!DOCTYPE html>", { status: 429 }),
    );
    const error = await ask(limited).catch((caught) => caught);
    assert.equal(
      error.message,
      "The pager didn't answer after 3 tries: it answered 429, the rate limit of Cloudflare in front of the Worker.",
    );
    assert.doesNotMatch(error.message, /SECRET/);
    assert.equal(limited.calls.length, 3);
  });

  it("fails on a refusal, an older Worker, an answer that isn't its health and a missing setting", async () => {
    const refused = new Net().on(
      "POST",
      "/control",
      () => new Response("Unauthorized", { status: 401 }),
    );
    await assert.rejects(
      ask(refused),
      /refused the check with 401: Unauthorized\. PAGER_CONTROL_SECRET must equal CONTROL_SECRET of the Worker/,
    );
    assert.equal(refused.calls.length, 1);
    const forbidden = new Net().on(
      "POST",
      "/control",
      () => new Response("Forbidden", { status: 403 }),
    );
    const error = await ask(forbidden).catch((caught) => caught);
    assert.equal(
      error.message,
      "The pager refused the check with 403: Forbidden.",
    );
    assert.equal(forbidden.calls.length, 1);
    const older = new Net().on(
      "POST",
      "/control",
      () => new Response("Bad Request", { status: 400 }),
    );
    await assert.rejects(ask(older), /doesn't take the body health/);
    for (const answer of [
      new Response("ok"),
      json({ telegram: null }),
      json(null),
    ]) {
      const odd = new Net().on("POST", "/control", () => answer);
      await assert.rejects(ask(odd), /something other than its health/);
    }
    await assert.rejects(
      ask(new Net(), undefined, { url: "" }),
      /PAGER_URL or the secret PAGER_CONTROL_SECRET isn't set/,
    );
  });
});

describe("the problems of the pager", () => {
  it("are none when all is well", () => {
    assert.deepEqual(problems(well(), NOW), []);
    // An error of the webhook more than a day ago, and a token in eight days.
    const older = well({
      telegram: {
        ok: true,
        webhook: true,
        pending: 0,
        lastError: { at: "2026-11-07T06:59:00.000Z", message: "old" },
      },
      tokens: { user: { expires: "2026-11-16" } },
    });
    assert.deepEqual(problems(older, NOW), []);
    assert.deepEqual(problems(well({ tokens: undefined }), NOW), []);
  });

  it("name a schedule that stopped or never ran", () => {
    assert.match(
      problems(well({ schedule: "2026-11-08T05:59:00.000Z" }), NOW)[0],
      /last ran to its end at 2026-11-08T05:59:00.000Z, more than an hour ago/,
    );
    assert.match(
      problems(well({ schedule: null }), NOW)[0],
      /never ran to its end/,
    );
  });

  it("name what Telegram and GitHub refuse, and a webhook that fails", () => {
    assert.deepEqual(
      problems(
        well({
          telegram: { ok: false, error: "Telegram getMe: Unauthorized" },
          github: { ok: false, error: "GitHub answered 401: Bad JWT" },
        }),
        NOW,
      ),
      [
        "Telegram refuses the bot: Telegram getMe: Unauthorized. Is TELEGRAM_BOT_TOKEN of the Worker still valid?",
        "GitHub refuses the app of the pager: GitHub answered 401: Bad JWT. Are GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY of the Worker still right?",
      ],
    );
    const webhook = problems(
      well({
        telegram: {
          ok: true,
          webhook: false,
          pending: 3,
          lastError: { at: "2026-11-08T06:00:00.000Z", message: "Timeout" },
        },
      }),
      NOW,
    );
    assert.equal(webhook.length, 2);
    assert.match(webhook[0], /No webhook of Telegram is set/);
    assert.equal(
      webhook[1],
      "The webhook of Telegram failed at 2026-11-08T06:00:00.000Z: Timeout. 3 update(s) wait.",
    );
  });

  it("name a token that expires within a week, or that GitHub refuses", () => {
    const found = problems(
      well({
        tokens: {
          claude: { expires: "2026-11-15" },
          user: { expires: "2026-12-03", refused: "2026-11-07" },
          fix: { expires: "2026-11-01" },
        },
      }),
      NOW,
    );
    assert.deepEqual(found, [
      "CLAUDE_CODE_OAUTH_TOKEN expires on 2026-11-15: renew it with claude setup-token and gh secret set CLAUDE_CODE_OAUTH_TOKEN, then change CLAUDE_TOKEN_EXPIRES in wrangler.jsonc of the pager.",
      "GitHub refuses GITHUB_USER_TOKEN since 2026-11-07: it expired or was revoked; renew it on GitHub and set it with npx wrangler secret put GITHUB_USER_TOKEN.",
      "PAGER_FIX_TOKEN expires on 2026-11-01: renew it on GitHub and set it with gh secret set PAGER_FIX_TOKEN.",
    ]);
  });
});

describe("the summary", () => {
  it("shows the health as a table, with the notes below it", () => {
    const text = summary(
      well({
        telegram: {
          ok: true,
          webhook: false,
          pending: 1,
          lastError: { at: "2026-11-08T06:00:00.000Z", message: "x" },
        },
        tokens: { user: { expires: null, refused: "2026-11-07" } },
      }),
      ["PAGER_FIX_TOKEN isn't set."],
    );
    assert.equal(
      text,
      [
        "### The health of the pager",
        "",
        "| What | State |",
        "| --- | --- |",
        "| Last run of the schedule | 2026-11-08T06:45:00.000Z |",
        "| Telegram | takes the bot; webhook not set, 1 update(s) waiting, last error at 2026-11-08T06:00:00.000Z |",
        "| GitHub | takes the app |",
        "| CLAUDE_CODE_OAUTH_TOKEN | unknown |",
        "| GITHUB_USER_TOKEN | refused since 2026-11-07 |",
        "| PAGER_FIX_TOKEN | unknown |",
        "",
        "- PAGER_FIX_TOKEN isn't set.",
        "",
      ].join("\n"),
    );
    const refusing = summary(
      well({
        schedule: null,
        telegram: { ok: false, error: "Telegram getMe: Unauthorized" },
        github: { ok: false, error: "GitHub answered 401: Bad JWT" },
      }),
      [],
    );
    assert.match(refusing, /\| Last run of the schedule \| never \|/);
    assert.match(
      refusing,
      /\| Telegram \| refuses: Telegram getMe: Unauthorized \|/,
    );
    assert.match(
      refusing,
      /\| GitHub \| refuses: GitHub answered 401: Bad JWT \|/,
    );
    assert.match(
      refusing,
      /\| CLAUDE_CODE_OAUTH_TOKEN \| expires on 2027-10-07 \|/,
    );
    assert.match(refusing, /\| PAGER_FIX_TOKEN \| no day \|/);
    assert.match(refusing, /\| Telegram \| refuses[^\n]*\n/);
    assert.ok(refusing.endsWith("| PAGER_FIX_TOKEN | no day |\n"));
    const plain = summary(well(), []);
    assert.match(plain, /webhook set, 0 update\(s\) waiting \|/);
  });
});

describe("the check", () => {
  it("sends the day of PAGER_FIX_TOKEN with the question, and finds no problem when all is well", async () => {
    const net = new Net()
      .on("GET", "/rate_limit", limits("2026-12-04 09:00:00 UTC"))
      .on("POST", "/control", () => json(well()));
    const result = await check({
      url: "https://pager.example",
      secret: "control-secret",
      token: "fix-token",
      fetcher: net.fetch,
      now: () => NOW,
      sleep: async () => undefined,
    });
    assert.deepEqual(result.problems, []);
    assert.deepEqual(net.to("/control")[0].body, {
      type: "health",
      tokens: { fix: "2026-12-04" },
    });
    assert.doesNotMatch(result.summary, /fix-token|control-secret/);
  });

  it("names a refused PAGER_FIX_TOKEN first, and sends no day without one", async () => {
    const net = new Net()
      .on("GET", "/rate_limit", () => json({ message: "Bad credentials" }, 401))
      .on("POST", "/control", () => json(well({ schedule: null })));
    const result = await check({
      url: "https://pager.example",
      secret: "control-secret",
      token: "fix-token",
      fetcher: net.fetch,
      now: () => NOW,
      sleep: async () => undefined,
    });
    assert.equal(result.problems.length, 2);
    assert.match(result.problems[0], /GitHub refuses PAGER_FIX_TOKEN/);
    assert.match(result.problems[1], /never ran/);
    assert.deepEqual(net.to("/control")[0].body, { type: "health" });
  });
});

describe("the command health", () => {
  async function run(net, fields = {}) {
    const dir = await mkdtemp(join(tmpdir(), "pager-health-"));
    const env = {
      GITHUB_STEP_SUMMARY: join(dir, "summary"),
      PAGER_URL: "https://pager.example",
      PAGER_CONTROL_SECRET: "control-secret",
      PAGER_FIX_TOKEN: "fix-token",
      ...fields,
    };
    await writeFile(env.GITHUB_STEP_SUMMARY, "");
    const lines = [];
    const code = await main("health", env, {
      fetch: net.fetch,
      sleep: async () => undefined,
      log: (line) => lines.push(line),
    });
    return {
      code,
      lines,
      summary: await readFile(env.GITHUB_STEP_SUMMARY, "utf8"),
    };
  }

  /** The health of a pager that is well now, by the clock of the test. */
  function now(extra = {}) {
    return well({ schedule: new Date().toISOString(), ...extra });
  }

  it("passes when the pager is well, with its health in the summary", async () => {
    const net = new Net()
      .on("GET", "/rate_limit", limits())
      .on("POST", "/control", () => json(now()));
    const result = await run(net);
    assert.equal(result.code, 0);
    assert.deepEqual(result.lines, ["The pager is well."]);
    assert.match(result.summary, /### The health of the pager/);
  });

  it("fails with one error per problem", async () => {
    const net = new Net().on("POST", "/control", () =>
      json(
        now({
          telegram: { ok: false, error: "Telegram getMe: Unauthorized" },
          github: { ok: false, error: "GitHub answered 401: Bad JWT" },
        }),
      ),
    );
    const result = await run(net, { PAGER_FIX_TOKEN: undefined });
    assert.equal(result.code, 1);
    assert.equal(result.lines.length, 2);
    assert.match(result.lines[0], /^::error::Telegram refuses the bot/);
    assert.match(result.lines[1], /^::error::GitHub refuses the app/);
    assert.match(result.summary, /- PAGER_FIX_TOKEN isn't set/);
  });

  it("fails when the pager can't be asked", async () => {
    const result = await run(new Net(), {
      PAGER_URL: undefined,
      PAGER_CONTROL_SECRET: undefined,
      PAGER_FIX_TOKEN: undefined,
    });
    assert.equal(result.code, 1);
    assert.match(result.lines[0], /^::error::The variable PAGER_URL/);
    assert.equal(result.summary, "");
  });
});
