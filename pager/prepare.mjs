// The first job of a run: it reads the event, checks it, and collects what Claude
// reads into one folder, with the read-only token of the workflow. Claude's job
// gets that folder and the checkout of the repository, nothing else; it reaches
// no API of GitHub itself.
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { LIMITS, PROMPT, readJob, schema, task } from "./core.mjs";
import { GitHubError } from "./github.mjs";

/**
 * The most of each text that Claude reads, in characters; of a log, its lines and
 * the characters of each; the most jobs whose logs it reads, and attempts of a run
 * that the job looks through for the one that failed.
 */
export const READ = {
  body: 20000,
  comment: 5000,
  comments: 50,
  replies: 20,
  patch: 4000,
  patches: 60000,
  log: 400,
  line: 1000,
  jobs: 5,
  attempts: 5,
};

const SNAPSHOT = `query($owner: String!, $pulls: String!, $issues: String!) {
  repositoryOwner(login: $owner) {
    repositories(first: 30, isArchived: false, privacy: PUBLIC, ownerAffiliations: OWNER, orderBy: {field: PUSHED_AT, direction: DESC}) {
      nodes {
        nameWithOwner
        latestRelease { tagName }
        defaultBranchRef {
          name
          target {
            ... on Commit {
              statusCheckRollup {
                state
                contexts(first: 100) {
                  nodes {
                    __typename
                    ... on CheckRun { name conclusion }
                    ... on StatusContext { context state }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  pulls: search(query: $pulls, type: ISSUE, first: 50) {
    nodes {
      ... on PullRequest {
        number title url isDraft headRefName
        author { login }
        repository { nameWithOwner }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
  issues: search(query: $issues, type: ISSUE, first: 50) {
    nodes {
      ... on Issue {
        number title url
        author { login }
        repository { nameWithOwner }
        labels(first: 5) { nodes { name } }
      }
    }
  }
}`;

const FAILED = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "ERROR",
]);

function cut(value, max) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** The state of the owner's repositories, open pull requests and open issues. */
export async function snapshot(api, owner) {
  const scope = `user:${owner} is:open archived:false sort:updated-desc`;
  const data = await api.graphql(SNAPSHOT, {
    owner,
    pulls: `${scope} is:pr`,
    issues: `${scope} is:issue`,
  });
  const repositories = (data?.repositoryOwner?.repositories?.nodes ?? []).map(
    (node) => {
      const rollup = node.defaultBranchRef?.target?.statusCheckRollup;
      const failing = (rollup?.contexts?.nodes ?? [])
        .filter((each) => FAILED.has(each.conclusion ?? each.state))
        .map((each) => each.name ?? each.context);
      return {
        repo: node.nameWithOwner,
        branch: node.defaultBranchRef?.name ?? null,
        checks: rollup?.state ?? null,
        failing,
        release: node.latestRelease?.tagName ?? null,
      };
    },
  );
  const pulls = (data?.pulls?.nodes ?? [])
    .filter((node) => node?.number !== undefined)
    .map((node) => ({
      repo: node.repository?.nameWithOwner,
      number: node.number,
      title: node.title,
      url: node.url,
      author: node.author?.login ?? null,
      draft: node.isDraft,
      branch: node.headRefName,
      checks:
        node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null,
    }));
  const issues = (data?.issues?.nodes ?? [])
    .filter((node) => node?.number !== undefined)
    .map((node) => ({
      repo: node.repository?.nameWithOwner,
      number: node.number,
      title: node.title,
      url: node.url,
      author: node.author?.login ?? null,
      labels: (node.labels?.nodes ?? []).map((label) => label.name),
    }));
  return { repositories, pulls, issues };
}

/** A comment of a discussion, with its author, as Claude reads it. */
const MESSAGE = "url body createdAt authorAssociation author { login }";

/** A discussion with its last comments and their last replies. */
const DISCUSSION = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    discussion(number: $number) {
      ${MESSAGE} title closed
      category { name }
      comments(last: ${READ.comments}) {
        nodes { ${MESSAGE} replies(last: ${READ.replies}) { nodes { ${MESSAGE} } } }
      }
    }
  }
}`;

/** The comment that the reply answers, which may be older than the last comments. */
const ANSWERING = `query($id: ID!) {
  node(id: $id) { ... on DiscussionComment { ${MESSAGE} } }
}`;

/** A message of a discussion: its author, when, and its text, not too long. */
function message(node, max) {
  return {
    url: node.url,
    author: node.author?.login ?? null,
    association: node.authorAssociation,
    created: node.createdAt,
    body: cut(node.body, max),
  };
}

/**
 * A discussion with its last comments and their replies, through the GraphQL API,
 * which alone has discussions, and in `answering` the comment that the reply
 * answers, if it answers one.
 */
export async function discussion(api, job) {
  const [owner, name] = job.repo.split("/");
  const data = await api.graphql(DISCUSSION, {
    owner,
    name,
    number: job.number,
  });
  const found = data?.repository?.discussion;
  if (!found) {
    throw new GitHubError(404, `${job.repo} has no discussion #${job.number}`);
  }
  const result = {
    repo: job.repo,
    number: job.number,
    kind: "discussion",
    ...message(found, READ.body),
    title: found.title,
    category: found.category?.name ?? null,
    state: found.closed ? "closed" : "open",
    comments: (found.comments?.nodes ?? []).map((comment) => ({
      ...message(comment, READ.comment),
      replies: (comment.replies?.nodes ?? []).map((reply) =>
        message(reply, READ.comment),
      ),
    })),
  };
  if (job.comment === undefined) {
    return result;
  }
  const answering = (await api.graphql(ANSWERING, { id: job.comment }))?.node;
  if (!answering?.url) {
    throw new GitHubError(404, "the comment that the reply answers is gone");
  }
  return { ...result, answering: message(answering, READ.comment) };
}

/** A comment of an issue or a pull request: its address, its author, when, and its text, not too long. */
function issueComment(comment) {
  return {
    url: comment.html_url,
    author: comment.user?.login ?? null,
    association: comment.author_association,
    created: comment.created_at,
    body: cut(comment.body, READ.comment),
  };
}

/**
 * The comment of an issue or a pull request that the reply answers, which may be
 * older than the last comments, or none when it is gone: the reply goes below the
 * issue or the pull request all the same.
 */
async function answeringComment(api, job) {
  try {
    return issueComment(
      await api.get(`/repos/${job.repo}/issues/comments/${job.issueComment}`),
    );
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

/**
 * An issue or pull request with its comments and, for a pull request, its changes,
 * and in `answering` the comment that the reply answers, if it answers one; a
 * discussion with its comments and their replies.
 */
export async function thread(api, job) {
  if (job.discussion) {
    return discussion(api, job);
  }
  const path = `/repos/${job.repo}`;
  const issue = await api.get(`${path}/issues/${job.number}`);
  const comments = await api.get(
    `${path}/issues/${job.number}/comments?per_page=100`,
  );
  const result = {
    repo: job.repo,
    number: job.number,
    kind: job.pull ? "pull request" : "issue",
    url: issue.html_url,
    title: issue.title,
    state: issue.state,
    author: issue.user?.login ?? null,
    association: issue.author_association,
    labels: (issue.labels ?? []).map((label) => label.name ?? label),
    created: issue.created_at,
    body: cut(issue.body, READ.body),
    comments: comments.slice(-READ.comments).map(issueComment),
  };
  if (job.issueComment !== undefined) {
    const answering = await answeringComment(api, job);
    if (answering !== null) {
      result.answering = answering;
    }
  }
  if (!job.pull) {
    return result;
  }
  const pull = await api.get(`${path}/pulls/${job.number}`);
  const files = await api.get(`${path}/pulls/${job.number}/files?per_page=100`);
  let left = READ.patches;
  result.pull = {
    head: pull.head?.label ?? null,
    base: pull.base?.ref ?? null,
    additions: pull.additions,
    deletions: pull.deletions,
    files: files.map((file) => {
      const patch = cut(file.patch, Math.min(READ.patch, Math.max(left, 0)));
      left -= patch.length;
      return {
        name: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        patch,
      };
    }),
  };
  return result;
}

/** A line of a log as Claude reads it: without its time and its colors, and not too long. */
function plain(line) {
  const text = line
    .replace(/^﻿/, "")
    .replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /, "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the colors of a log start with ESC.
    .replace(/\u001b\[[\d;]*m/g, "");
  return text.length > READ.line ? `${text.slice(0, READ.line)}…` : text;
}

/**
 * A line of the report that Harden-Runner writes after the job: hundreds of them,
 * each domain resolved and each endpoint called, which say nothing about why the
 * job failed.
 */
const REPORT = /domain resolved:|endpoint called /;

/** The lines of a log, without the times, the colors and the report of Harden-Runner. */
function linesOf(log) {
  const lines = [];
  let report = false;
  for (const raw of log.split(/\r?\n/)) {
    const line = plain(raw);
    if (line.startsWith("[harden-runner] post-step")) {
      report = true;
    } else if (
      line === "Post job cleanup." ||
      line.startsWith("Cleaning up orphan processes")
    ) {
      report = false;
    }
    if (!report && !REPORT.test(line)) {
      lines.push(line);
    }
  }
  return lines;
}

/** The first line of a step in the log of a job, and that of an error. */
const STEP = "##[group]Run ";
const ERROR = "##[error]";

/**
 * The most lines of the command of a failed step, of those after an error, and the
 * most errors of a step whose lines around them the excerpt reads, besides its last.
 */
const COMMAND = 20;
const AFTER = 5;
const ERRORS = 20;

/** The kept lines of a log, in their order, with … where lines are left out. */
function shown(lines, keep) {
  const kept = [...keep].sort((a, b) => a - b);
  const out = [];
  let last = -1;
  for (const index of kept) {
    if (index > last + 1) {
      out.push("…");
    }
    out.push(lines[index]);
    last = index;
  }
  if (last < lines.length - 1) {
    out.push("…");
  }
  return out;
}

/**
 * The steps of a log that hold an error, in one pass over its lines: where each
 * starts (-1 for lines before the first step), the end of its command, where the
 * next step starts, and its errors.
 */
function failedSteps(lines) {
  const steps = [];
  let step = { start: -1, header: -1, errors: [] };
  const close = (next) => {
    if (step.errors.length > 0) {
      steps.push({ ...step, next });
    }
  };
  lines.forEach((line, index) => {
    if (line.startsWith(STEP)) {
      close(index);
      step = { start: index, header: -1, errors: [] };
    } else if (line.startsWith(ERROR)) {
      step.errors.push(index);
    } else if (line === "##[endgroup]" && step.header < 0) {
      step.header = index;
    }
  });
  close(lines.length);
  return steps;
}

/** Where the output of a step starts for an error: after its command, its shell and its env. */
function bodyOf({ start, header }, at) {
  return start >= 0 && header >= 0 && header < at ? header + 1 : start + 1;
}

/**
 * The part of the log of a job that says why it failed, in at most max lines. Each
 * step with an error gets its share first: its last `##[error]` and its command;
 * then its first errors, ERRORS at most, and the lines before them and before its
 * last, the nearest first, with a few after each; so that a step of hundreds of
 * annotations leaves room for the step that really failed after it. Without the
 * times, the colors and the report of Harden-Runner at the end, whose noise is all
 * that the end of such a log shows. A log without an error keeps its end.
 */
export function excerpt(log, max = READ.log) {
  const lines = linesOf(log);
  const steps = failedSteps(lines);
  if (steps.length === 0) {
    return lines.slice(-max).join("\n");
  }
  const keep = new Set();
  const added = [];
  const take = (index) => {
    if (keep.size === max || keep.has(index)) {
      return false;
    }
    keep.add(index);
    added.push(index);
    return true;
  };
  for (const { errors } of steps) {
    take(errors.at(-1));
  }
  for (const step of steps) {
    const end = Math.min(
      bodyOf(step, step.errors.at(-1)),
      step.start + COMMAND,
    );
    for (let index = Math.max(step.start, 0); index < end; index += 1) {
      take(index);
    }
  }
  // The errors whose lines around them the excerpt reads: the first of each step,
  // then the second of each, and so on, and its last.
  const anchors = steps.map((step) => ({ step, at: [] }));
  for (let rank = 0; rank < ERRORS; rank += 1) {
    for (const { step, at } of anchors) {
      if (rank < step.errors.length - 1) {
        take(step.errors[rank]);
        at.push(step.errors[rank]);
      }
    }
  }
  const around = anchors.flatMap(({ step, at }) =>
    [...at, step.errors.at(-1)].map((each) => ({
      at: each,
      body: bodyOf(step, each),
      next: step.next,
    })),
  );
  // The lines around them, one at a time, the nearest first, until a round adds
  // none: then every step is read back to its command.
  let more = true;
  for (let distance = 1; more && keep.size < max; distance += 1) {
    more = false;
    for (const { at, body, next } of around) {
      if (at - distance >= body && take(at - distance)) {
        more = true;
      }
      if (distance <= AFTER && at + distance < next && take(at + distance)) {
        more = true;
      }
    }
  }
  // The … between the parts count as lines too.
  let out = shown(lines, keep);
  while (out.length > max) {
    keep.delete(added.pop());
    out = shown(lines, keep);
  }
  return out.join("\n");
}

const JOB_FAILED = new Set(["failure", "timed_out", "startup_failure"]);

/** Whether a value is a positive whole number, such as the id of a run. */
function positive(value) {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * The run and the attempt that an issue of the bot-health bot names in its marker,
 * such as `<!-- bot-health {"attempt": 2, "run": 41995567564, …} -->`, or null for
 * another issue.
 */
export function healthRun(body) {
  const marker = /<!--\s*bot-health\s+(\{[^\n]*?\})\s*-->/.exec(
    String(body ?? ""),
  );
  let value;
  try {
    value = JSON.parse(marker?.[1] ?? "null");
  } catch {
    return null;
  }
  if (!positive(value?.run)) {
    return null;
  }
  return positive(value.attempt)
    ? { run: value.run, attempt: value.attempt }
    : { run: value.run };
}

/** The failed jobs of one attempt of a run. */
async function failedJobs(api, repo, run, attempt) {
  const answer = await api.get(
    `/repos/${repo}/actions/runs/${run}/attempts/${attempt}/jobs?per_page=100`,
  );
  return (answer.jobs ?? [])
    .filter((job) => JOB_FAILED.has(job.conclusion))
    .map((job) => ({ id: job.id, name: job.name ?? null }));
}

/**
 * The attempt of a run that failed, and its failed jobs: the attempt named, or else
 * the newest of the last READ.attempts with a failed job. The jobs of a run without
 * an attempt are those of its newest, which may be a rerun that still runs, so the
 * job always names the attempt. The newest attempt and its state go along: one
 * that runs or passed says that the failure is being retried or passed on retry.
 */
async function runOf(api, repo, id, named) {
  const run = await api.get(`/repos/${repo}/actions/runs/${id}`);
  const newest = positive(run.run_attempt) ? run.run_attempt : 1;
  const latest = {
    attempt: newest,
    status: run.status ?? null,
    conclusion: run.conclusion ?? null,
  };
  const tries =
    named === undefined
      ? Array.from(
          { length: Math.min(newest, READ.attempts) },
          (_, index) => newest - index,
        )
      : [named];
  for (const attempt of tries) {
    const jobs = await failedJobs(api, repo, id, attempt);
    if (jobs.length > 0) {
      return { run: { id, attempt, latest }, jobs };
    }
  }
  return { run: { id, attempt: null, latest }, jobs: [] };
}

/**
 * The jobs that an entry of the fix points to: those of a run, of the attempt that
 * failed, one of its jobs, a check, or those of the run that an issue of the
 * bot-health bot names. Returns the run as well, where there is one.
 */
async function jobsOf(api, repo, url, details) {
  const issue = /\/issues\/(\d+)$/.exec(url);
  if (issue !== null) {
    const found = await api.get(`/repos/${repo}/issues/${issue[1]}`);
    details.issue = { title: found.title, body: cut(found.body, READ.body) };
    const health = healthRun(found.body);
    return health === null
      ? { jobs: null }
      : runOf(api, repo, health.run, health.attempt);
  }
  const run =
    /\/actions\/runs\/(\d+)(?:\/attempts\/(\d+))?(?:\/job\/(\d+))?/.exec(url);
  if (run?.[3] !== undefined) {
    return { jobs: [{ id: Number(run[3]), name: null }] };
  }
  if (run !== null) {
    const attempt = run[2] === undefined ? undefined : Number(run[2]);
    return runOf(api, repo, Number(run[1]), attempt);
  }
  const check = /\/runs\/(\d+)(?:$|[?#])/.exec(url);
  return { jobs: check === null ? [] : [{ id: Number(check[1]), name: null }] };
}

/**
 * What fails, entry by entry: the part of the log of each failed job that says why,
 * of READ.jobs at most, the attempt of its run that failed with the state of the
 * newest, and the text of an issue of the bot-health bot with the logs of the run
 * that it names. What can't be read says why in `unread`, with the status of
 * GitHub: that of the entry, or that of a job whose log is missing. What GitHub
 * doesn't show the token of the workflow, such as code-scanning alerts, stays its
 * label and address.
 */
export async function failures(api, job) {
  const entries = [];
  const logs = {};
  for (const entry of job.entries) {
    const details = { label: entry.label, url: entry.url };
    entries.push(details);
    let found;
    try {
      found = await jobsOf(api, job.repo, entry.url, details);
    } catch (error) {
      if (!(error instanceof GitHubError)) {
        throw error;
      }
      details.unread = error.message;
      continue;
    }
    if (found.run !== undefined) {
      details.run = found.run;
    }
    // An issue of another bot is its text alone.
    if (found.jobs === null) {
      continue;
    }
    details.jobs = [];
    for (const each of found.jobs) {
      const read = { id: each.id, name: each.name };
      details.jobs.push(read);
      if (Object.keys(logs).length === READ.jobs) {
        read.unread = `the job reads the logs of ${READ.jobs} jobs at most`;
        continue;
      }
      try {
        const log = await api.text(
          `/repos/${job.repo}/actions/jobs/${each.id}/logs`,
        );
        read.log = `logs/${Object.keys(logs).length + 1}-${each.id}.txt`;
        logs[read.log] = excerpt(log);
      } catch (error) {
        if (!(error instanceof GitHubError)) {
          throw error;
        }
        read.unread = error.message;
      }
    }
  }
  return { entries, logs };
}

/**
 * Prepare a job: check its event, collect its data into out and return the job and
 * the outputs of the step, which name the limits and the schema of its kind.
 */
export async function prepare({
  eventName,
  event,
  owner,
  api,
  out,
  read,
  workflows = false,
}) {
  const job = readJob(eventName, event, owner);
  const files = {};
  let error = "";
  if (job.kind === "text") {
    files["text.txt"] = job.text;
    if (job.reply !== "") {
      files["reply.txt"] = job.reply;
    }
    // The thing whose topic the text came from, from a Worker with topics.
    if (job.item !== undefined) {
      files["item.json"] = JSON.stringify(job.item, null, 1);
    }
    // An answer without the state of the repositories is still an answer.
    files["github.json"] = JSON.stringify(
      await snapshot(api, owner).catch((failure) => {
        if (!(failure instanceof GitHubError)) {
          throw failure;
        }
        return { unread: failure.message };
      }),
      null,
      1,
    );
  } else if (job.kind === "draft") {
    // A draft without its thread is none: the pager hears why, and brings back
    // its button, instead of waiting for an answer that never comes.
    try {
      files["thread.json"] = JSON.stringify(await thread(api, job), null, 1);
    } catch (failure) {
      if (!(failure instanceof GitHubError)) {
        throw failure;
      }
      error = `the thread didn't come from GitHub: ${failure.message}`;
    }
    files["voice.md"] = await read("voice.md");
  } else if (job.kind === "fix") {
    const found = await failures(api, job);
    files["failures.json"] = JSON.stringify(found.entries, null, 1);
    Object.assign(files, found.logs);
  }
  // A translation has no tool to read a file with: its task holds its notes, between
  // lines that no note can hold, and is its prompt; data/task.md keeps it for the
  // maintainer, who may look at what Claude got.
  const data = `notes-${randomBytes(8).toString("hex")}`;
  files["task.md"] = task(job, Object.keys(files).sort(), data, workflows);
  files["rules.md"] = await read("rules.md");
  await mkdir(join(out, "logs"), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(out, name), content);
  }
  // The outputs name the job for the jobs after this one. The thing of a text is
  // data for Claude alone; the item of a draft, a fix or a translation is the thing
  // that its answer goes back to, so it stays. A translation reads no checkout: its
  // notes are all that it needs.
  const { text: _text, reply: _reply, item, ...rest } = job;
  const named = job.kind === "text" ? rest : { ...rest, item };
  const translates = job.kind === "translate";
  return {
    job,
    outputs: {
      job: JSON.stringify(named),
      kind: job.kind,
      repo: translates ? "" : (job.repo ?? ""),
      ...LIMITS[job.kind],
      schema: JSON.stringify(schema(job.kind, job.lines?.length)),
      prompt: translates ? files["task.md"] : PROMPT,
      error,
    },
  };
}
