#!/usr/bin/env node
// The command line of the maintainer's agents for the pager: ask a question, send the
// report of a run, read or wait for an answer, with the gh of this machine.
// pager/ask.mjs describes the commands, and README.md the way of a question.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { run } from "../pager/ask.mjs";

/** The checkout of this script, whose remote origin names the control repository. */
const HOME = fileURLToPath(new URL("..", import.meta.url));

process.exitCode = await run(process.argv.slice(2), {
  gh(args, input) {
    const done = spawnSync("gh", args, { input, encoding: "utf8" });
    return {
      status: done.status ?? 1,
      stdout: done.stdout ?? "",
      stderr: done.stderr || (done.error?.message ?? ""),
    };
  },
  origin: () =>
    spawnSync("git", ["-C", HOME, "remote", "get-url", "origin"], {
      encoding: "utf8",
    }).stdout ?? "",
  env: process.env,
  stdin: () => readFileSync(0, "utf8"),
  now: Date.now,
  sleep: (milliseconds) =>
    new Promise((done) => setTimeout(done, milliseconds)),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});
