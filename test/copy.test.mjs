// The tests as a control repository has them. Its workflow Template brings it every
// file of the template but those of `own` of .github/template.json, these tests among
// them, so each must pass without the files that the template alone has. Here the
// tree of a copy is made with the code of that workflow, from the files of this
// checkout, and runs `npm test` as the check *Tests, lint and workflows* of a copy
// does: once as a copy that deleted the files of the template's contributors and of
// its social preview, and once as one that kept them, as the README allows.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { promisify } from "node:util";

import {
  changesOf,
  filesOf,
  isOwn,
  SETTINGS,
  settingsOf,
} from "../pager/template.mjs";
import { IN_TEMPLATE, ROOT } from "./where.mjs";

const run = promisify(execFile);

// The files of `own` that a copy has a version of its own of: its README and its voice
// after the set-up, and .github/template.json with the commit that it took last. It
// deletes .github/dependabot.yml, as the README says.
const README = "# repo-pager-control\n\nMy instance of Repo Pager.\n";
const VOICE = "# My voice\n\nShort and friendly, in English.\n";
const MINE = new Set([SETTINGS, "README.md", "pager/voice.md"]);
const DELETED = new Set([".github/dependabot.yml"]);

/** The files of this checkout as a tree of git: the tracked and the new ones. */
function treeHere() {
  const paths = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: ROOT, encoding: "utf8" },
  )
    .split("\0")
    .filter((path) => path !== "" && existsSync(join(ROOT, path)));
  return {
    truncated: false,
    tree: [...new Set(paths)].map((path) => ({
      path,
      mode: lstatSync(join(ROOT, path)).isSymbolicLink() ? "120000" : "100644",
      type: "blob",
      sha: path,
    })),
  };
}

/**
 * A copy of this template in a new folder: what the workflow Template brings to a
 * repository that has none of it, its own versions of README.md, pager/voice.md and
 * .github/template.json, and with `kept` the other files of `own` too.
 */
async function copyOf({ kept }) {
  const settings = settingsOf(await readFile(join(ROOT, SETTINGS), "utf8"));
  const latest = filesOf(treeHere());
  const { write } = changesOf({
    latest,
    before: new Map(),
    here: new Map(),
    own: settings.own,
  });
  const keep = kept
    ? [...latest.keys()].filter(
        (path) =>
          isOwn(path, settings.own) && !MINE.has(path) && !DELETED.has(path),
      )
    : [];
  const dir = await mkdtemp(join(tmpdir(), "pager-copy-"));
  for (const path of [...write, ...keep]) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await cp(join(ROOT, path), join(dir, path));
  }
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
  await writeFile(
    join(dir, SETTINGS),
    `${JSON.stringify({ template: settings.template, commit, own: settings.own }, null, 2)}\n`,
  );
  await writeFile(join(dir, "README.md"), README);
  await writeFile(join(dir, "pager/voice.md"), VOICE);
  return { dir, write, keep };
}

/** Runs the script test of the copy's package.json in the copy, as npm test does. */
async function npmTest(dir) {
  const { scripts } = JSON.parse(
    await readFile(join(dir, "package.json"), "utf8"),
  );
  const [node, ...args] = scripts.test.split(/\s+/);
  assert.equal(node, "node", "the script test of package.json runs node");
  // Without the context of this run, so that the copy reports and covers itself.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_V8_COVERAGE;
  try {
    await run(process.execPath, args, {
      cwd: dir,
      env,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, failures: "" };
  } catch (error) {
    const output = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
    const failures = output
      .split("\n")
      .filter((line) => /✖|^not ok|ENOENT|Error/.test(line))
      .slice(0, 40)
      .join("\n");
    return { ok: false, failures: failures || output.slice(-4000) };
  }
}

describe("the tests in a control repository", {
  skip: !IN_TEMPLATE && "a control repository is a copy already",
}, () => {
  const made = [];
  after(() =>
    Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true }))),
  );

  for (const kept of [false, true]) {
    const what = kept
      ? "that kept the files of the template's contributors and its social preview"
      : "without the files that the template alone has";
    it(`pass in a copy ${what}`, async () => {
      const copy = await copyOf({ kept });
      made.push(copy.dir);
      // The copy is what the workflow Template makes of it: the tests and the jobs,
      // without the files of `own` that the template alone has.
      assert.ok(copy.write.includes("test/template.test.mjs"));
      assert.ok(copy.write.includes("pager/template.mjs"));
      assert.ok(!copy.write.includes(".github/social-preview.png"));
      assert.ok(!copy.write.includes("CONTRIBUTING.md"));
      assert.equal(copy.keep.includes("CONTRIBUTING.md"), kept);
      assert.ok(!existsSync(join(copy.dir, ".github/dependabot.yml")));
      const { ok, failures } = await npmTest(copy.dir);
      assert.ok(ok, `npm test fails in a copy ${what}:\n${failures}`);
    });
  }
});
