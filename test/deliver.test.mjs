// The answer on its way to the pager: signed, again after a failure, and what each
// answer of the pager means. Plus the small client of GitHub.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";

import { deliver, wait } from "../pager/deliver.mjs";
import { GitHub, GitHubError } from "../pager/github.mjs";
import { json, Net } from "./fake.mjs";

const URL = "https://pager.example.workers.dev/";
const body = { type: "note", text: "All green." };

function send(net, fields = {}) {
  const sleeps = [];
  const result = deliver({
    url: URL,
    secret: "control-secret",
    body,
    fetcher: net.fetch,
    now: () => 1700000000500,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
    ...fields,
  });
  return result.then((value) => ({ ...value, sleeps }));
}

describe("the delivery to the pager", () => {
  it("posts the body to /control, signed over the time and the body", async () => {
    const net = new Net().on("POST", "/control", () => new Response("said"));
    assert.deepEqual(await send(net), {
      sent: true,
      fatal: false,
      note: "The pager answered: said",
      sleeps: [],
    });
    const call = net.calls[0];
    assert.equal(call.url, "https://pager.example.workers.dev/control");
    assert.equal(call.headers["x-pager-timestamp"], "1700000000");
    const hmac = createHmac("sha256", "control-secret")
      .update(`1700000000.${JSON.stringify(body)}`)
      .digest("hex");
    assert.equal(call.headers["x-pager-signature"], `sha256=${hmac}`);
    assert.deepEqual(call.body, body);
  });

  it("only shows the answer in the run while the pager isn't set up", async () => {
    const net = new Net();
    for (const fields of [{ url: "" }, { secret: "" }]) {
      const result = await send(net, fields);
      assert.equal(result.sent, false);
      assert.equal(result.fatal, false);
      assert.match(result.note, /PAGER_URL or the secret PAGER_CONTROL_SECRET/);
    }
    assert.equal(net.calls.length, 0);
  });

  it("passes over a thing that is gone or changed, and fails on a refusal", async () => {
    const answers = {
      404: [false, /no such thing/],
      409: [false, /changed in between/],
      401: [true, /refused the signature/],
      400: [true, /same contract/],
      413: [true, /too long/],
      422: [true, /translation doesn't fit the notes/],
      418: [true, /answered 418: teapot/],
    };
    for (const [status, [fatal, note]] of Object.entries(answers)) {
      const net = new Net().on(
        "POST",
        "/control",
        () => new Response("teapot", { status: Number(status) }),
      );
      const result = await send(net);
      assert.equal(result.sent, false);
      assert.equal(result.fatal, fatal, status);
      assert.match(result.note, note);
    }
  });

  it("tries again after a failure of the Worker or of the network", async () => {
    let calls = 0;
    const net = new Net().on("POST", "/control", () => {
      calls += 1;
      if (calls === 1) {
        throw new TypeError("fetch failed");
      }
      return calls === 2
        ? new Response("busy", { status: 503 })
        : new Response("drafted");
    });
    const result = await send(net);
    assert.equal(result.sent, true);
    assert.deepEqual(result.sleeps, [2000, 4000]);
    const down = new Net().on(
      "POST",
      "/control",
      () => new Response("down", { status: 502 }),
    );
    const failed = await send(down, { tries: 2 });
    assert.deepEqual(failed, {
      sent: false,
      fatal: true,
      note: "Not sent after 2 tries: the pager answered 502: down.",
      sleeps: [2000],
    });
  });

  it("tries again after a limit of Cloudflare, for as long as its Retry-After asks", async () => {
    const answers = [
      new Response("<!DOCTYPE html>", {
        status: 429,
        headers: { "retry-after": "7" },
      }),
      new Response("<!DOCTYPE html>", { status: 408 }),
      new Response("drafted"),
    ];
    const net = new Net().on("POST", "/control", () => answers.shift());
    const result = await send(net);
    assert.equal(result.sent, true);
    assert.equal(net.calls.length, 3);
    assert.deepEqual(result.sleeps, [7000, 4000]);
  });

  it("names the limit of Cloudflare, not the secret, when every try meets it", async () => {
    const net = new Net().on(
      "POST",
      "/control",
      () => new Response("<!DOCTYPE html>", { status: 429 }),
    );
    const result = await send(net);
    assert.deepEqual(result, {
      sent: false,
      fatal: true,
      note: "Not sent after 3 tries: the pager answered 429, the rate limit of Cloudflare in front of the Worker.",
      sleeps: [2000, 4000],
    });
    assert.doesNotMatch(result.note, /SECRET/);
  });

  it("waits for real between tries by default", async () => {
    const net = new Net().on(
      "POST",
      "/control",
      () => new Response("x", { status: 500 }),
    );
    const result = await deliver({
      url: URL,
      secret: "s",
      body,
      fetcher: net.fetch,
      tries: 1,
    });
    assert.equal(result.fatal, true);
    const started = Date.now();
    await wait(20);
    assert.ok(Date.now() - started >= 15);
  });
});

describe("the client of GitHub", () => {
  it("sends the token, the version and its name, and reads JSON, nothing or text", async () => {
    const net = new Net()
      .on("GET", "/thing", () => json({ a: 1 }))
      .on("POST", "/empty", () => new Response(null, { status: 204 }))
      .on("GET", "/log", () => new Response("text"));
    const api = new GitHub("ghs_test", net.fetch);
    assert.deepEqual(await api.get("/thing"), { a: 1 });
    assert.equal(await api.post("/empty", { b: 2 }), null);
    assert.equal(await api.text("/log"), "text");
    assert.equal(net.calls[0].headers.authorization, "Bearer ghs_test");
    assert.equal(net.calls[0].headers["user-agent"], "repo-pager-control");
    assert.equal(net.calls[0].headers["content-type"], undefined);
    assert.equal(net.calls[1].headers["content-type"], "application/json");
  });

  it("names the status and the message of a refusal", async () => {
    const net = new Net()
      .on("GET", "/json", () => json({ message: "Not allowed" }, 403))
      .on("GET", "/bare", () => json({}, 500))
      .on(
        "GET",
        "/html",
        () => new Response("<html>oops</html>", { status: 502 }),
      );
    const api = new GitHub("t", net.fetch);
    const refusal = async (path) => {
      try {
        await api.get(path);
      } catch (error) {
        assert.ok(error instanceof GitHubError);
        return [error.status, error.detail];
      }
    };
    assert.deepEqual(await refusal("/json"), [403, "Not allowed"]);
    assert.deepEqual(await refusal("/bare"), [500, "{}"]);
    assert.deepEqual(await refusal("/html"), [502, "<html>oops</html>"]);
  });

  it("asks GraphQL, and takes its first error as a refusal", async () => {
    const net = new Net().on("POST", "/graphql", (call) =>
      json(
        call.body.variables.fail
          ? { errors: [{ message: "Bad query" }] }
          : { data: { ok: true } },
      ),
    );
    const api = new GitHub("t", net.fetch);
    assert.deepEqual(await api.graphql("{ ok }", {}), { ok: true });
    await assert.rejects(
      api.graphql("{ ok }", { fail: true }),
      /GitHub answered 200: Bad query/,
    );
    const empty = new GitHub(
      "t",
      new Net().on("POST", "/graphql", () => json({ errors: [] })).fetch,
    );
    assert.equal(await empty.graphql("{ ok }", {}), undefined);
  });

  it("uses fetch of the runtime by default", () => {
    assert.equal(new GitHub("t").fetch, fetch);
  });
});
