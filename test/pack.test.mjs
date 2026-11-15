// The data of a job and the change of a fix, handed on as outputs: what pager/pack.mjs
// packs, the steps of ask.yml unpack and pack again, run here with bash as GitHub
// runs them, and what they pack, pager/pack.mjs unpacks for the job pull-request.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { gzipSync } from "node:zlib";

import {
  chunksOf,
  dataOutputs,
  PACK,
  packOf,
  patchOf,
  sha256Of,
  sizeOf,
  tarOf,
} from "../pager/pack.mjs";
import { ROOT } from "./where.mjs";

const ASK = readFileSync(join(ROOT, ".github/workflows/ask.yml"), "utf8");

/** The script of a step of ask.yml, without its indent. */
function scriptOf(name) {
  const start = ASK.indexOf(`      - name: ${name}\n`);
  assert.notEqual(start, -1, name);
  const rest = ASK.slice(start).split("\n");
  const at = rest.indexOf("        run: |");
  assert.notEqual(at, -1, `${name} runs a script`);
  const lines = [];
  for (const line of rest.slice(at + 1)) {
    if (line !== "" && !line.startsWith(" ".repeat(10))) {
      break;
    }
    lines.push(line.slice(10));
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The bash of the runner: Git's on Windows, where the bash of the path may be
 * that of WSL, and none where neither is.
 */
const BASH =
  process.platform === "win32"
    ? ["C:/Program Files/Git/bin/bash.exe"].find((path) => existsSync(path))
    : "bash";

/** Run a script in dir as a step does, with RUNNER_TEMP and GITHUB_OUTPUT there. */
async function step(dir, script, env = {}) {
  await mkdir(join(dir, "runner"), { recursive: true });
  const result = spawnSync(BASH, ["-e", "-c", script], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      RUNNER_TEMP: "runner",
      GITHUB_OUTPUT: "runner/output",
      ...env,
    },
  });
  let output = "";
  try {
    output = await readFile(join(dir, "runner", "output"), "utf8");
  } catch {
    // A step that wrote no output.
  }
  const outputs = Object.fromEntries(
    output
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => [
        line.slice(0, line.indexOf("=")),
        line.slice(line.indexOf("=") + 1),
      ]),
  );
  return { status: result.status, stdout: result.stdout, outputs };
}

/** The environment of the step Get the data of the job, from outputs of prepare. */
function packEnv(outputs) {
  const env = { PACK_SHA256: outputs.pack_sha256 };
  for (let index = 1; index <= PACK.data; index += 1) {
    env[`PACK${index}`] = outputs[`pack${index}`];
  }
  return env;
}

/** The environment of the job pull-request, from the outputs of the job of Claude. */
function patchEnv(outputs) {
  const env = {};
  for (const name of ["sha256", "size"]) {
    if (outputs[`patch_${name}`] !== undefined) {
      env[`PATCH_${name.toUpperCase()}`] = outputs[`patch_${name}`];
    }
  }
  for (let index = 1; index <= PACK.patch; index += 1) {
    env[`PATCH${index}`] = outputs[`patch${index}`] ?? "";
  }
  return env;
}

const git = (cwd, ...args) =>
  spawnSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
    { cwd, encoding: "utf8" },
  );

describe("the size of outputs", () => {
  it("counts each name and value in UTF-16, as GitHub approximates it", () => {
    assert.equal(sizeOf({ a: "bc", d: "ü€" }), 2 * (3 + 3));
    assert.equal(sizeOf({}), 0);
  });

  it("keeps the outputs of a job under GitHub's limit, and each chunk under that of Linux for a variable", () => {
    assert.ok(PACK.outputs < 1_048_576);
    assert.ok(2 * PACK.patch * PACK.chunk < 1_048_576 - PACK.outputs / 4);
    assert.ok(PACK.chunk + "PACK1=".length < 131_072);
  });
});

describe("a pack", () => {
  it("splits into its outputs, empty past its end, and refuses more than they hold", () => {
    assert.deepEqual(chunksOf("x", "a".repeat(PACK.chunk + 1), 3), {
      x1: "a".repeat(PACK.chunk),
      x2: "a",
      x3: "",
    });
    const outputs = dataOutputs({ text: "abc", sha256: "s" });
    assert.deepEqual(Object.keys(outputs), [
      "pack1",
      "pack2",
      "pack3",
      "pack4",
      "pack_sha256",
    ]);
    assert.throws(
      () =>
        dataOutputs({
          text: "a".repeat(PACK.data * PACK.chunk + 1),
          sha256: "s",
        }),
      /larger than 4 outputs/,
    );
  });

  it("refuses a name that a tar can't hold", () => {
    assert.throws(() => tarOf({ ["a".repeat(101)]: "" }), /too long/);
    assert.equal(tarOf({}, []).length, 1024);
  });
});

describe("the data of a job in ask.yml", { skip: !BASH && "no bash" }, () => {
  const script = scriptOf("Get the data of the job");

  it("unpacks into data/ what the job prepare packed, over more than one output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pack-"));
    const files = {
      "task.md": "The task, with ü and €.\n",
      "rules.md": "",
      "logs/1-5.txt": randomBytes(150_000).toString("base64"),
    };
    const outputs = dataOutputs(packOf(files, ["logs"]));
    assert.ok(outputs.pack2.length > 0, "the pack takes two outputs");
    const { status } = await step(dir, script, packEnv(outputs));
    assert.equal(status, 0);
    for (const [name, content] of Object.entries(files)) {
      assert.equal(await readFile(join(dir, "data", name), "utf8"), content);
    }
  });

  it("fails before it unpacks a pack that doesn't match its sha256, such as one with an output that GitHub skipped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pack-"));
    const outputs = dataOutputs(
      packOf({ "task.md": randomBytes(120_000).toString("base64") }),
    );
    const { status, stdout } = await step(
      dir,
      script,
      packEnv({ ...outputs, pack2: "" }),
    );
    assert.notEqual(status, 0);
    assert.match(
      stdout,
      /^::error::The data of the job didn't arrive whole: 100000, 0, 0 and 0 characters/m,
    );
    assert.equal(existsSync(join(dir, "data")), false);
    const none = await step(dir, script, {});
    assert.notEqual(none.status, 0);
  });
});

describe("the change of a fix in ask.yml", { skip: !BASH && "no bash" }, () => {
  const script = scriptOf("Collect the change of the fix");

  /** A checkout as ask.yml leaves it for Claude: its history apart, in RUNNER_TEMP. */
  async function checkout() {
    const dir = await mkdtemp(join(tmpdir(), "fix-"));
    const repo = join(dir, "repo");
    await mkdir(repo);
    git(repo, "init", "-q");
    await writeFile(join(repo, "a.txt"), "old\n");
    git(repo, "add", "a.txt");
    git(repo, "commit", "-q", "-m", "first");
    await mkdir(join(dir, "runner"));
    await rename(join(repo, ".git"), join(dir, "runner", "repo.git"));
    return { dir, repo };
  }

  it("hands back the change of the checkout, binary files too, for the job pull-request", async () => {
    const { dir, repo } = await checkout();
    await writeFile(join(repo, "a.txt"), "new\n");
    // A NUL makes it binary to git, whatever the random bytes are.
    await writeFile(
      join(repo, "b.bin"),
      Buffer.concat([Buffer.alloc(8), randomBytes(400)]),
    );
    const { status, outputs } = await step(dir, script);
    assert.equal(status, 0);
    assert.equal(outputs.changed, "true");
    const handed = patchOf(patchEnv(outputs));
    assert.equal(handed.error, undefined);
    const patch = handed.patch.toString("utf8");
    assert.match(patch, /^diff --git a\/a\.txt b\/a\.txt$/m);
    assert.match(patch, /^\+new$/m);
    assert.match(patch, /^GIT binary patch$/m);
  });

  it("says that nothing changed, and hands back no pack", async () => {
    const { dir } = await checkout();
    const { status, outputs } = await step(dir, script);
    assert.equal(status, 0);
    assert.deepEqual(outputs, { changed: "false" });
  });

  it("hands back a change too large for its outputs without its sha256, which the job pull-request names", async () => {
    const { dir, repo } = await checkout();
    await writeFile(
      join(repo, "a.txt"),
      randomBytes(PACK.patch * PACK.chunk).toString("hex"),
    );
    const { status, stdout, outputs } = await step(dir, script);
    assert.equal(status, 0);
    assert.equal(outputs.changed, "true");
    assert.equal(outputs.patch_sha256, undefined);
    assert.ok(Number(outputs.patch_size) > PACK.patch * PACK.chunk);
    assert.match(stdout, /^::warning::The change of the fix is too large/m);
    assert.deepEqual(patchOf(patchEnv(outputs)), {
      error: `the change is too large to hand over: ${outputs.patch_size} characters packed, more than the 300000 that the outputs of the job of Claude hold`,
    });
  });
});

describe("the change of a fix for the job pull-request", () => {
  const gzip = gzipSync("diff --git a/a b/a\n");
  const text = gzip.toString("base64");

  it("unpacks a change that came whole", () => {
    const handed = patchOf({
      PATCH1: text.slice(0, 5),
      PATCH2: text.slice(5),
      PATCH_SHA256: sha256Of(gzip),
      PATCH_SIZE: String(text.length),
    });
    assert.equal(handed.patch.toString("utf8"), "diff --git a/a b/a\n");
  });

  it("names a change that didn't come, didn't come whole or doesn't unpack", () => {
    assert.deepEqual(patchOf({}), {
      error: "the change didn't come from the job of Claude",
    });
    assert.deepEqual(
      patchOf({
        PATCH1: text.slice(0, 5),
        PATCH_SHA256: sha256Of(gzip),
        PATCH_SIZE: String(text.length),
      }),
      {
        error: `the change didn't arrive whole: 5 of ${text.length} characters, and its sha256 differs`,
      },
    );
    const plain = Buffer.from("not a gzip");
    assert.match(
      patchOf({
        PATCH1: plain.toString("base64"),
        PATCH_SHA256: sha256Of(plain),
      }).error,
      /^the change doesn't unpack: /,
    );
  });
});
