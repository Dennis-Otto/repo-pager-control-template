# Repo Pager control template

The template of the private control repository of [Repo Pager](https://github.com/Dennis-Otto/repo-pager), the Telegram bot on a Cloudflare Worker that tells you only what needs you in your GitHub repositories. Its jobs run here: the drafts of replies, the fixes of what fails on `main` and the answers to free text, with Claude Code and **your own** Claude subscription, never an API key, and the questions and reports of your own agents.

Repo Pager is self-hosted: everyone who uses it runs an instance of their own, with their own Telegram bot, Worker on Cloudflare, GitHub App and private control repository, which the pager's [set-up](https://github.com/Dennis-Otto/repo-pager/blob/main/docs/setup.md) builds step by step. There is no shared app, so your tokens, your chat and the events of your repositories stay yours. Your control repository is a private copy of this template, because the logs of Actions in a public repository are public, and these logs show issues, drafts and what Claude read.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/diagrams/how-a-job-runs.dark.svg">
  <img src="docs/images/diagrams/how-a-job-runs.svg" alt="How a job of the pager runs: You press Draft a reply or Start fix, or write a text, and the pager's Worker sends an event to this private repository. The job prepare checks the event and collects what Claude reads, with the read-only token of the workflow. The job ask runs Claude Code with your subscription on the egress-firewall runner; Claude only reads, and in a fix edits a checkout. For a fix with a change, the job pull-request opens a pull request with PAGER_FIX_TOKEN, on another machine. The job answer checks Claude's answer against the allowlist and sends it to the Worker, signed. The Worker shows it in Telegram: a draft with Send, a note, or a proposal with one Confirm button, which acts only when you press it.">
</picture>

## Set it up

The pager's [set-up](https://github.com/Dennis-Otto/repo-pager/blob/main/docs/setup.md) makes your control repository at its start and sets it up in its steps 3, 4 and 7; these are the same steps, for the control repository alone. Name it in a variable of the shell first, your account and a name of your choice:

```sh
CONTROL=octocat/repo-pager-control
gh repo create "$CONTROL" --private --template Dennis-Otto/repo-pager-control-template
```

The new repository has every file of the template, in one commit, and no history of it. Then give it its secrets and variables:

| Name | Kind | Needed | What it is |
| --- | --- | --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | Secret | Yes | The token of your Claude subscription, from `claude setup-token`, valid for a year |
| `PAGER_CONTROL_SECRET` | Secret | Yes | The same random text as `CONTROL_SECRET` of your Worker: both sides sign with it |
| `PAGER_URL` | Variable | Yes | The address of your Worker, such as `https://repo-pager.ACCOUNT.workers.dev` |
| `PAGER_APP` | Variable | Yes | The name of your GitHub App in its address, its slug, such as `repo-pager-of-octocat` for *Repo Pager of octocat*: the only bot whose events start Claude |
| `PAGER_FIX_TOKEN` | Secret | For 🛠 Start fix and the template | A [fine-grained token](https://github.com/settings/personal-access-tokens/new) of yours for the repositories that the pager watches and for this one, with *Contents*, *Pull requests* and *Workflows* read and write |
| `PAGER_LANGUAGE` | Variable | No | `de` for German, as `LANGUAGE` of your Worker: the language of the report of the workflow *Template*, which no event of the pager names |
| `PAGER_MODEL` | Variable | No | Another model of Claude Code for every kind of job, such as `claude-sonnet-5-5` |
| `PAGER_AI_RUNNER` | Variable | No | Another runner for the job of Claude, should GitHub rename or end its egress-firewall runner; on another runner, Claude's network is open |

```sh
claude setup-token                                   # prints the token of your subscription
gh secret set CLAUDE_CODE_OAUTH_TOKEN -R "$CONTROL"  # paste it
printf %s "$CONTROL_SECRET" | gh secret set PAGER_CONTROL_SECRET -R "$CONTROL"
gh variable set PAGER_URL -R "$CONTROL" --body "$WORKER"
gh variable set PAGER_APP -R "$CONTROL" --body repo-pager-of-octocat
gh secret set PAGER_FIX_TOKEN -R "$CONTROL"          # paste the fine-grained token
```

`$CONTROL_SECRET` and `$WORKER` are those of step 3 of the pager's set-up. Install your GitHub App on this repository as well, so that the Worker can send its events here: its step 4 does it. Then:

1. **Write your voice:** [`pager/voice.md`](pager/voice.md) says how a draft of a reply in your name reads: your language, your tone and what you never promise. The template's copy is an example; write it in your own words, since it is the one file of a draft that is yours alone, and the workflow *Template* never changes it.
2. **Try it:** `gh workflow run pager.yml -R "$CONTROL" -f text="What fails on main?"`. Without `PAGER_URL` and `PAGER_CONTROL_SECRET`, the summary of the run shows the answer instead of the chat. The workflow *Check the Claude token* proves that the token of Claude works, for two words of your limit.
3. **Renew the tokens:** the token of Claude a few weeks before its year ends, as the pager reminds, with `claude setup-token` and `gh secret set CLAUDE_CODE_OAUTH_TOKEN -R "$CONTROL"`, and `PAGER_FIX_TOKEN` the same way, whose day the daily check *Health* reads from GitHub for the pager's reminder.

## What runs here

The pager's Worker sends a [repository dispatch](https://docs.github.com/rest/repos/repos#create-a-repository-dispatch-event) with a token of its GitHub App for this repository alone, and the workflow [Pager](.github/workflows/pager.yml) answers it:

| Event | Sent by | Claude | The answer in Telegram |
| --- | --- | --- | --- |
| `pager-draft` | ✍️ **Draft a reply**, and a discussion or a comment on one as it comes | Reads the issue or pull request, its comments and changes, or the discussion with its last comments and their replies, and the repository, and drafts a reply in your voice ([`pager/voice.md`](pager/voice.md)), in the language of the thread | The draft, with ✅ **Send** and ✏️ **Edit** |
| `pager-fix` | 🛠 **Start fix** | Reads why each job failed, in the attempt that failed, also for an issue of the bot-health bot, and fixes it in a checkout, or says why not: an outage of GitHub, a retry that runs already | A note with the pull request of the fix, or why there is none, with 🛠 **Start fix** again, in the topic of its thing; for an outage of GitHub, the proposal of 🔁 **Rerun** with a ✅ **Confirm** button |
| `pager-text` | A text to the bot | Reads the text, the message of the pager that it answers, the thing whose topic it came from, and the state of your repositories | An answer, and at most one proposed action with a ✅ **Confirm** button |

**Discussions:** a draft of a discussion carries `discussion: true` and, when the reply answers a comment, `comment`, the id of that comment in GitHub's GraphQL API. The job reads the discussion, its last 50 comments and the last 20 replies of each through GraphQL, which alone has discussions, and the comment that the reply answers as `answering` of `data/thread.json`, also when it is older than those. The pager's GitHub App posts the reply that you send, in the thread of that comment. A discussion or a comment that is gone fails the job, which brings ✍️ **Draft a reply** back.

**Comments:** a draft of an issue or a pull request whose thing a comment of someone else opened or changed carries `issueComment`, the id of that comment in GitHub's REST API, never with `discussion`. The job reads that comment as `answering` of `data/thread.json`, also when it is older than the last 50 comments, and goes on without it when it was deleted, since the reply goes below the issue or the pull request all the same.

**Topics:** the pager gives each thing its own topic in the chat. A text that you write in the topic of a thing comes with that thing as `thing`: its `id`, `kind`, `repo` and `state`, the `number` and the `version` where it has them, its `links` to GitHub and `text`, its message as you see it, in Telegram's HTML. The job hands it to Claude as `data/item.json`, so a short question such as *why?* is about that thing, and the answer goes back into the topic. A `thing` that doesn't check out is left out, and the text is answered without it, as one from General.

Under each answer the pager shows on one line what the run took: the model, the effort and every token, with the share of each model when more than one worked. Your text gets a 👀 when it comes here, a 👍 when its answer reaches the pager and a 😢 when none came to be. A run by hand from the Actions tab, *Pager* with a text, is a free text too, to try it.

**Language:** each event carries `language`, `LANGUAGE` of the pager's Worker: `en`, or `de`, and English when it has none; another value refuses the job. Claude answers you in it, in a free text and in the note of a fix, and the frame of an answer that didn't come to be follows it too, such as `❌ Keine Antwort: … Der Lauf: …`; the reason inside, the words of a check, stays as the check says it. A draft of a reply goes to someone else, so it keeps the language of its thread, and the title and the description of a fix's pull request are in English. A run by hand takes the language from its input `language`, English unless you choose German.

## Questions and reports of your agents

Your own agents, such as an orchestrator that works through the night on your PC with `gh` signed in as you, ask you through the pager instead of leaving a line in a report, take back a question that they no longer need, and send the report of a run. They send a repository dispatch here with that `gh`, and the workflow [Agents](.github/workflows/agents.yml) checks it and forwards it to `/control` of the Worker, signed, without Claude:

| Event | Client payload | Body for the pager | In Telegram |
| --- | --- | --- | --- |
| `pager-ask` | `id`, `question`, `options` | `{"type": "ask", "id", "question", "options"}` | A topic *🤔 Decision: …*, with one button per option |
| `pager-withdraw` | `id`, and `reason` if any | `{"type": "withdraw", "id", "reason"}` | The question loses its buttons, and its message says that the agent took it back, with the reason |
| `pager-report` | `text`, and `title` if any | `{"type": "report", "text", "title"}` | A topic *🧾 Run: …*, with the report |

Only an event that the owner of this repository sent goes on; one of the pager's GitHub App, which sends the jobs here, or of anyone else who may write here, fails the run. The checks are those of the pager: an `id` of 1 to 64 letters, digits, dots, dashes and underscores, starting with a letter or a digit, which names the answer; a `question` of at most 1000 characters; two to four different `options` of at most 64 characters; a `title` of at most 100, and a `reason` of at most 500. The pager shows the first 3000 characters of a report.

When you press an option, or write your own answer in the topic of the question, the pager's GitHub App saves it here as `answers/<id>.json` on the branch `pager-answers`, which its first answer makes without a parent and without the code of this repository, so no workflow runs on it. [`scripts/ask.mjs`](scripts/ask.mjs) does everything with the `gh` of its machine and needs no secret; it sends to the repository of its own checkout, by the address of its remote `origin`, or to the one that `PAGER_CONTROL_REPOSITORY` names:

```sh
node scripts/ask.mjs ask 2026-11-08-merge-order "Which release goes first?" "The library" "The app"
node scripts/ask.mjs wait 2026-11-08-merge-order --since 2026-11-08T07:00:00.000Z --timeout 3600 --every 30
node scripts/ask.mjs answer 2026-11-08-merge-order --since 2026-11-08T07:00:00.000Z
node scripts/ask.mjs withdraw 2026-11-08-merge-order --reason "No answer within the hour: the library went first."
node scripts/ask.mjs report --title "Night run" "Merged: 12 pull requests, 2 waiting for you."
some-command | node scripts/ask.mjs report -
```

`wait` and `answer` print the answer as JSON, with `id`, `question`, `options`, `choice` (the place of the option, from 0, or `null` for an answer in your own words), `answer` (the text of the option, or your words) and `answered` (the time of the press or of the text), and exit with 0; while there is none, they exit with 3. `ask` prints the time of its question, and `wait`, `answer` and `withdraw` with `--since` and that time ignore an answer that is older, that of an earlier question with the same id, with a minute of leeway for the clocks. `withdraw` takes back a question that the agent no longer needs, such as after its `wait` gave up; a question that has an answer already keeps it, and `withdraw` refuses, so that the agent reads it with `answer`. An id is used once: its answer stays on `pager-answers` for good, so `ask` refuses an id that has one already. A refusal of `gh` or of a check exits with 1, a wrong command line with 2. The [contract](https://github.com/Dennis-Otto/repo-pager/blob/main/docs/how-it-works.md#questions-and-reports-of-your-agents) of the pager has the rest.

## Four jobs on four machines

| Job | What it does | Its tokens |
| --- | --- | --- |
| `prepare` | Checks the event: its kind, an item id of the pager, a repository of the owner of this repository, entries that point into it. Collects what Claude reads into a folder: the thread, why the failed jobs failed, the state of the repositories. Hands the job on to the jobs after it | The workflow's token, read-only, which reads public repositories, the logs of their jobs and their discussions; the smoke test checks that it still does |
| `ask` ([`ask.yml`](.github/workflows/ask.yml)) | Runs Claude Code on GitHub's egress-firewall runner, whose network reaches only the hosts of [`.github/egress-firewall.yaml`](.github/egress-firewall.yaml). `--restricted` and `--tools` leave Claude the tools that read files, and in a fix those that write them, in the checkout alone: it runs no command and reaches no network | `CLAUDE_CODE_OAUTH_TOKEN` and the read-only token |
| `pull-request` | A fix with a change only: applies Claude's patch to a fresh checkout at the commit that Claude saw, makes it one commit through the API, which GitHub signs, on a new branch, and opens a pull request that runs the checks and the review of the repository | `PAGER_FIX_TOKEN`, which never reaches the machine of Claude |
| `answer` | Checks Claude's answer against the schema and the allowlist again, and sends it to the pager, signed; when Claude failed, it says why | `PAGER_CONTROL_SECRET` |

## How the Worker and the control repository trust each other

- **The Worker to this repository:** only who may write here can send a repository dispatch. The Worker sends it with a token of its GitHub App for this repository alone, and the job of Claude runs only for the bot that `PAGER_APP` names; the events of your agents go on only when you sent them.
- **This repository to the Worker:** every answer is a `POST` to `/control` of the Worker, with the headers `X-Pager-Timestamp` (seconds since 1970) and `X-Pager-Signature`: `sha256=` and the HMAC-SHA256, under `PAGER_CONTROL_SECRET`, of the timestamp, a dot and the body. The Worker checks it against its `CONTROL_SECRET` in constant time and refuses a time more than five minutes off, so nobody without the secret can forge an answer or send one again later.

[How it works](https://github.com/Dennis-Otto/repo-pager/blob/main/docs/how-it-works.md#the-control-repository) of the pager is the contract; the bodies are:

| Body | When |
| --- | --- |
| `{"type": "draft", "item", "text"}` | A draft of a reply |
| `{"type": "note", "item", "text"}` | A fix with its pull request |
| `{"type": "note", "text", "message"}` | An answer to free text |
| `{"type": "proposal", "text", "action", "target": {"kind", "repo", "number"}, "message"}` | An answer to free text that proposes one action of the allowlist |
| `{"type": "failed", "text", "message"}` | Free text whose answer didn't come to be |
| `{"type": "failed", "item", "text"}` | A draft or fix that didn't come to be: the pager brings its button back |
| `{"type": "failed", "item", "text", "action": "rerun"}` | A fix of an alarm that found an outage of GitHub or of a download and changed nothing: the pager brings its buttons back and proposes 🔁 Rerun in its topic, with one ✅ Confirm button |
| `{"type": "ask", "id", "question", "options"}` | A question of one of your agents, which [Agents](.github/workflows/agents.yml) forwards |
| `{"type": "withdraw", "id", "reason"}` | The end of a question that its agent no longer needs; the pager answers 409 for an answered question and 404 for one that it doesn't know, which the run logs without failing |
| `{"type": "report", "text", "title"}` | The report of a run of an agent, or of the workflow *Template*, which the pager shows in a topic of its own |
| `{"type": "health"}` | The daily check *Health*, below |

`message` is the id of your text, from the event, and the pager turns its 👀 into 👍, or into 😢 for a failure. Each body may carry `"usage": {"turns", "seconds", "effort", "models": [{"model", "tokens"}]}`: the turns, the time and each model with every token that it read and wrote, the most first.

**Why the answer goes to the Worker and not to Telegram itself:** the token of the bot stays in Cloudflare alone, and this repository holds no secret that can write to the chat or act on GitHub in the pager's name. The Worker keeps the state of each thing, so a draft lands in the message of its contribution with the version that ✅ **Send** posts, a failed job brings its button back, and a proposal gets a button only while its thing still offers that action. A leaked `PAGER_CONTROL_SECRET` can only show text with buttons of the allowlist; it can't press one.

## The health of the pager

The pager writes only when something needs you, so a quiet day looks the same whether all is well or the pager is dead. The workflow [Health](.github/workflows/health.yml) runs once a day at 06:23 UTC, and by hand from the Actions tab, and asks the pager's Worker, signed with `PAGER_CONTROL_SECRET` as every answer, for its health. The run fails, with one `::error::` per problem that names it and how to fix it, when the pager doesn't answer after three tries or refuses the signature; its schedule last ran to its end more than an hour ago, or never; Telegram refuses the bot, no webhook is set, or the webhook reported an error in the last day; GitHub refuses the pager's app; or a token expires within a week, or GitHub refuses it: `CLAUDE_CODE_OAUTH_TOKEN`, the Worker's `GITHUB_USER_TOKEN` or `PAGER_FIX_TOKEN`.

GitHub notifies you of a failed run of a schedule by itself, by mail and on github.com, which works also when Telegram or the Worker is the part that broke. The job also asks GitHub with `PAGER_FIX_TOKEN` for `GET /rate_limit`, which counts against no limit, reads the day on which the token expires from the header `github-authentication-token-expiration`, and sends it as `tokens.fix`, so the pager reminds three weeks before it. No token goes into the log or the summary, and no Claude runs.

## The changes of the template

This template is the one source of the code of every control repository, so a fix or a new feature reaches yours without a copy by hand. [`.github/template.json`](.github/template.json) names the template, the commit of it that your repository took last, and `own`, the files of your own:

```json
{
  "template": "Dennis-Otto/repo-pager-control-template",
  "commit": "",
  "own": ["README.md", "pager/voice.md"]
}
```

The workflow [Template](.github/workflows/template.yml) runs every Monday, and by hand from the Actions tab. It compares the files of your default branch with those of the template's newest commit, and brings each file that differs, and deletes each that the template deleted since the commit taken last, as one pull request of the branch `template-sync`, titled *chore: take the template up to …*. Its one commit comes through the API, which GitHub signs, with `PAGER_FIX_TOKEN`, since only a token with *Workflows* may change a workflow; the pull request runs the tests of your repository, and you merge it. A newer change of the template comes onto the same branch and pull request, and the pager gets a report, *🧾 Run: Template …*, with the link, in the language of `PAGER_LANGUAGE`.

- **Your files stay yours:** each path of `own`, or each folder with a slash at its end, the `own` of the template, and every file that the template never had, such as a workflow of your own. The template names `README.md` and `pager/voice.md`; add a file that you change on purpose.
- **Everything else is the template's:** a file of the template that your repository changed goes back to the template's with the next pull request, which shows it in its diff. Propose a change that every control repository needs to the template, or keep the file apart in `own`.
- **Without `PAGER_FIX_TOKEN`,** or when GitHub refuses it, the run fails and lists what waits in its summary, so that GitHub tells you; give the token this repository too.

## Safety

- **Data is never an instruction:** issues, comments, logs and the text of the messages are files in `data/` that Claude reads; [`pager/rules.md`](pager/rules.md), its system prompt, says so, and the task says what the files are. The rules are the template's, so that a better rule reaches every control repository.
- **Claude only proposes.** Its answer is JSON of a schema, checked twice: by Claude Code and by the job `answer` against the same allowlist as the pager's buttons. ✅ **Send** and ✏️ **Edit** can't be proposed; they stay with the message of the draft, which shows the text they post. Nothing is posted in your name without your press.
- **Start fix** is the one job that writes to your other repositories: a branch and a pull request, never a merge, through the rules of the target repository.
- **Pinned and few:** every action is pinned to a commit; besides GitHub's own, only `anthropics/claude-code-action` runs. Harden-Runner would block hosts only with a paid plan in a private repository, so the firewall runner does that. The tests run actionlint and zizmor from images pinned by their digest, and Dependabot keeps the actions current.
- **Least permissions:** every workflow starts with `permissions: {}`, and each job gets `contents: read` at most.

[SECURITY.md](SECURITY.md) says how to report a vulnerability.

## What it costs

Each job is a run of Claude Code with your subscription and counts against the same weekly limit as your other work; each kind runs with the model and the effort of `LIMITS` in [`pager/core.mjs`](pager/core.mjs), and stops at its budget in dollars of the API, the measure that Claude Code has, and at its turns, where it has any:

| Job | Model | Effort | Tools of Claude | Turns | Budget |
| --- | --- | --- | --- | --- | --- |
| Free text | Sonnet 5.5 | high | Read, Grep, Glob | 12 | 0.50 |
| Draft | Opus 5.5 | high | Read, Grep, Glob | 16 | 1.00 |
| Fix | Opus 5.5 | extra high (`xhigh`) | Read, Grep, Glob, Edit, Write | no limit | 3.00 |

A free text reads what the job prepared and answers in a few lines, so Sonnet does it well and spares the limit. A draft speaks for you to someone else, and a fix changes code that becomes a pull request: both take Opus, a fix at the deeper effort. The budget is what caps a run; the turns only stop a loop, so a fix, which reads the logs, the code and the tests of a change, runs without `--max-turns`: its budget and the 30 minutes of its job cap it.

**What a fix reads:** for each job that failed, the part of its log that says why, 400 lines at most: each step with an `##[error]` gets its share first, its last error and its command, then its first 20 errors and the lines before them. A run counts by the attempt that failed, and the newest attempt goes along with its state, so the answer says *already being retried* or *passed on retry* instead of guessing. When the logs show an outage of GitHub or of a download, Claude changes nothing and the pager offers 🔁 **Rerun** with a ✅ **Confirm** button, which runs the failed jobs again without another run of Claude.

The minutes of Actions of a private repository count against the free minutes of your account, 2,000 a month on GitHub Free: a job takes about two to four minutes on four runners. The daily check *Health* takes about a minute a day, some 30 a month, and the weekly *Template* about a minute a week.

## Development

- `npm test` runs the tests of [`pager/`](pager/) with every line, branch and function covered; `npm run lint` checks the code with Biome. Node 24, no dependencies.
- The workflow [Tests](.github/workflows/test.yml) runs both, actionlint and zizmor; [Smoke test](.github/workflows/smoke.yml) runs the job of Claude for one word in a pull request that changes it.
- `bash scripts/diagrams.sh` draws [`docs/diagrams/`](docs/diagrams/) as the pictures in `docs/images/diagrams/`, with Docker.
- A change that every control repository needs is a pull request here; the workflow *Template* of each control repository brings it there.

## License

[MIT](LICENSE).
