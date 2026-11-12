// The check of the token of the workflow in the smoke test: which repository it
// reads, what it reads there, and how it fails, against a simulated GitHub.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { checkAccess, SMOKE_REPOSITORY } from "../pager/access.mjs";
import { Refusal } from "../pager/core.mjs";
import { GitHub } from "../pager/github.mjs";
import { main } from "../pager/job.mjs";
import { json, Net } from "./fake.mjs";

const RUNS = "/actions/runs?status=success&per_page=1";

/** A public repository with a successful run, a skipped and a successful job, a log and discussions. */
function readable(repo = SMOKE_REPOSITORY) {
  return new Net()
    .on("GET", `/repos/${repo}${RUNS}`, () =>
      json({ total_count: 1, workflow_runs: [{ id: 41 }] }),
    )
    .on("GET", `/repos/${repo}/actions/runs/41/jobs?per_page=100`, () =>
      json({
        jobs: [
          { id: 7, conclusion: "skipped" },
          { id: 8, conclusion: "success" },
        ],
      }),
    )
    .on(
      "GET",
      `/repos/${repo}/actions/jobs/8/logs`,
      () => new Response("2026-11-12T00:00:00Z ok\n"),
    )
    .on("POST", "/graphql", () =>
      json({ data: { repository: { discussions: { totalCount: 3 } } } }),
    );
}

async function check(net, repo = SMOKE_REPOSITORY) {
  return checkAccess({ api: new GitHub("ghs_test", net.fetch), repo });
}

async function refusal(net, pattern, repo) {
  await assert.rejects(check(net, repo), (error) => {
    assert.ok(error instanceof Refusal);
    assert.match(error.message, pattern);
    return true;
  });
}

describe("the check of the token in the smoke test", () => {
  it("reads the pager's own public repository, which every copy reaches", async () => {
    assert.equal(SMOKE_REPOSITORY, "Dennis-Otto/repo-pager");
    const lines = [];
    const net = readable();
    const env = { GH_TOKEN: "ghs_test", GITHUB_REPOSITORY_OWNER: "monalisa" };
    const io = { fetch: net.fetch, log: (line) => lines.push(line) };
    assert.equal(await main("access", env, io), 0);
    assert.deepEqual(lines, [
      "The token of the workflow reads the log of job 8 and the 3 discussion(s) of Dennis-Otto/repo-pager.",
    ]);
    // Nothing of the owner of the copy: monalisa need not have a repo-pager.
    assert.ok(net.calls.every((call) => !call.url.includes("monalisa")));
    assert.deepEqual(net.calls.at(-1).body.variables, {
      owner: "Dennis-Otto",
      name: "repo-pager",
    });
    assert.equal(net.calls[0].headers.authorization, "Bearer ghs_test");
  });

  it("reads the repository that PAGER_SMOKE_REPOSITORY names", async () => {
    const lines = [];
    const net = readable("octo-org/hello");
    const env = {
      GH_TOKEN: "ghs_test",
      PAGER_SMOKE_REPOSITORY: "octo-org/hello",
    };
    const io = { fetch: net.fetch, log: (line) => lines.push(line) };
    assert.equal(await main("access", env, io), 0);
    assert.match(lines[0], /discussion\(s\) of octo-org\/hello\.$/);
    assert.ok(net.calls.every((call) => !call.url.includes("Dennis-Otto")));
  });

  it("says that PAGER_SMOKE_REPOSITORY is no owner/name, before it asks GitHub", async () => {
    for (const repo of ["repo-pager", "a/b/c", "a/", "/b", "a b/c"]) {
      const net = readable(repo);
      await refusal(
        net,
        /^PAGER_SMOKE_REPOSITORY is ".*", not owner\/name of a public repository$/,
        repo,
      );
      assert.equal(net.calls.length, 0);
    }
  });

  it("says that a repository has no successful run, instead of asking for the jobs of run null", async () => {
    const net = readable().on("GET", `/repos/${SMOKE_REPOSITORY}${RUNS}`, () =>
      json({ total_count: 0, workflow_runs: [] }),
    );
    await refusal(
      net,
      /^Dennis-Otto\/repo-pager has no successful run of Actions, which the smoke test reads: set the variable PAGER_SMOKE_REPOSITORY/,
    );
    assert.equal(net.calls.length, 1);
    assert.ok(net.calls.every((call) => !call.url.includes("null")));
  });

  it("says that a run has no successful job, which alone has a log", async () => {
    const net = readable().on(
      "GET",
      `/repos/${SMOKE_REPOSITORY}/actions/runs/41/jobs?per_page=100`,
      () => json({ jobs: [{ id: 7, conclusion: "skipped" }] }),
    );
    await refusal(net, /has no successful job in its run 41, which the smoke/);
    assert.equal(net.calls.length, 2);
  });

  it("names the status of GitHub for a repository that it can't read", async () => {
    await refusal(
      new Net(),
      /^GitHub answered 404: Not Found, for the runs of monalisa\/private$/,
      "monalisa/private",
    );
    const net = readable().on(
      "GET",
      `/repos/${SMOKE_REPOSITORY}/actions/runs/41/jobs?per_page=100`,
      () => json({ message: "Bad credentials" }, 401),
    );
    await refusal(
      net,
      /^GitHub answered 401: Bad credentials, for the jobs of run 41 of /,
    );
  });

  it("fails when the token reads no log, which a fix needs", async () => {
    const net = readable().on(
      "GET",
      `/repos/${SMOKE_REPOSITORY}/actions/jobs/8/logs`,
      () => json({ message: "Must have admin rights to Repository." }, 403),
    );
    const lines = [];
    const env = { GH_TOKEN: "ghs_test" };
    const io = { fetch: net.fetch, log: (line) => lines.push(line) };
    assert.equal(await main("access", env, io), 1);
    assert.match(
      lines[0],
      /^::error::GitHub answered 403: .*, for the log of job 8 of Dennis-Otto\/repo-pager, so a fix reads no log: prepare needs a token that can$/,
    );
  });

  it("fails when the token reads no discussions, which a draft needs", async () => {
    const refused = readable().on("POST", "/graphql", () =>
      json({ errors: [{ message: "Resource not accessible by integration" }] }),
    );
    await refusal(
      refused,
      /^GitHub answered 200: Resource not accessible by integration, for the discussions of .*: prepare needs a token that can$/,
    );
    const empty = readable().on("POST", "/graphql", () =>
      json({ data: { repository: null } }),
    );
    await refusal(
      empty,
      /^The token of the workflow reads no discussions of Dennis-Otto\/repo-pager, so a draft of a discussion has no thread/,
    );
  });

  it("lets a bug through", async () => {
    const broken = {
      get: async () => {
        throw new TypeError("fetch failed");
      },
    };
    await assert.rejects(
      checkAccess({ api: broken, repo: SMOKE_REPOSITORY }),
      TypeError,
    );
  });
});

describe("the workflows of the smoke tests", () => {
  const workflow = (name) =>
    readFile(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");

  it("read no repository that the owner of a copy need not have", async () => {
    for (const name of ["smoke.yml", "smoke-translate.yml"]) {
      assert.doesNotMatch(await workflow(name), /repo-pager\b(?!-control)/);
    }
  });

  it("check the token with the command access", async () => {
    const smoke = await workflow("smoke.yml");
    assert.match(smoke, /run: node pager\/job\.mjs access\n/);
    assert.match(
      smoke,
      /PAGER_SMOKE_REPOSITORY: \$\{\{ vars\.PAGER_SMOKE_REPOSITORY \}\}/,
    );
  });
});
