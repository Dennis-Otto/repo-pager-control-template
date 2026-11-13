# Repo Pager control template

The template of the private control repository of [Repo Pager](https://github.com/Dennis-Otto/repo-pager), the Telegram bot on a Cloudflare Worker that tells you only what needs you in your GitHub repositories. Its jobs run here: the drafts of replies, the fixes of what fails on `main`, the answers to free text and the notes of a release in the language of your pager, with Claude Code and **your own** Claude subscription, never an API key, and the questions and reports of your own agents.

Repo Pager is self-hosted: everyone who uses it runs an instance of their own, with their own Telegram bot, Worker on Cloudflare, GitHub App and private control repository, which the pager's [set-up](https://github.com/Dennis-Otto/repo-pager/blob/main/docs/setup.md) builds step by step. There is no shared app, so your tokens, your chat and the events of your repositories stay yours. Your control repository is a private copy of this template, because the logs of Actions in a public repository are public, and these logs show issues, drafts and what Claude read.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/diagrams/how-a-job-runs.dark.svg">
  <img src="docs/images/diagrams/how-a-job-runs.svg" alt="How a job of the pager runs: You press Draft a reply or Start fix, or write a text, or a release comes whose notes need your language, and the pager's Worker sends an event to this private repository. The job prepare checks the event and collects what Claude reads, with the read-only token of the workflow. The job ask runs Claude Code with your subscription on the egress-firewall runner; Claude only reads, in a fix edits a checkout, and translates with no tool at all. For a fix with a change, the job pull-request opens a pull request with PAGER_FIX_TOKEN, on another machine. The job answer checks Claude's answer against the allowlist, and a translation against its notes, and sends it to the Worker, signed. The Worker shows it in Telegram: a draft with Send, a note, a proposal with one Confirm button, which acts only when you press it, or the notes of a release in your language.">
</picture>

## Set it up

The pager's [set-up](https://github.com/Dennis-Otto/repo-pager/blob/main/docs/setup.md) makes your control repository at its start and sets it up in its steps 3, 4 and 7; these are the same steps, for the control repository alone. Name it in a variable of the shell first, your account and a name of your choice:

```sh
CONTROL=octocat/repo-pager-control
gh repo create "$CONTROL" --private --template Dennis-Otto/repo-pager-control-template
```

The new repository has every file of the template, in one commit, and no history of it. Delete its `.github/dependabot.yml`: the template's Dependabot keeps the actions and the tools current and the pull request of the workflow *Template* brings them to you, while bumps of your own would only fight it, since that pull request takes each changed file back to the template's pins. The template lists the file in its `own`, so it never comes back:

```sh
gh api -X DELETE "repos/$CONTROL/contents/.github/dependabot.yml"   -f message="chore: the template keeps the actions and the tools current"   -f sha="$(gh api "repos/$CONTROL/contents/.github/dependabot.yml" --jq .sha)"
```

A copy takes the files of the template, not its settings. Let GitHub enforce what the template promises under [Safety](#safety): only GitHub's own actions and `anthropics/claude-code-action` run, each pinned to a commit. GitHub then refuses a run of any other action, or of one pinned to a tag, before it starts; a workflow of your own that needs another action adds it to the list:

```sh
gh api -X PUT "repos/$CONTROL/actions/permissions"   -F enabled=true -f allowed_actions=selected -F sha_pinning_required=true
gh api -X PUT "repos/$CONTROL/actions/permissions/selected-actions"   -F github_owned_allowed=true -F verified_allowed=false   -f "patterns_allowed[]=anthropics/claude-code-action@*"
```

Then give it its secrets and variables:

| Name | Kind | Needed | What it is |
| --- | --- | --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | Secret | Yes | The token of your Claude subscription, from `claude setup-token`, valid for a year |
| `PAGER_CONTROL_SECRET` | Secret | Yes | The same random text as `CONTROL_SECRET` of your Worker: both sides sign with it |
| `PAGER_URL` | Variable | Yes | The address of your Worker, such as `https://repo-pager.ACCOUNT.workers.dev` |
| `PAGER_APP` | Variable | Yes | The name of your GitHub App in its address, its slug, such as `repo-pager-of-octocat` for *Repo Pager of octocat*: the only bot whose events start Claude |
| `PAGER_FIX_TOKEN` | Secret | For 🛠 Start fix and the template | A [fine-grained token](https://github.com/settings/personal-access-tokens/new) of yours for the repositories that the pager watches and for this one, with *Contents*, *Pull requests* and *Workflows* read and write. *Workflows* is for the pull request of the workflow *Template*, which changes the workflows of this repository, not for a fix: a fix changes no workflow unless `PAGER_FIX_WORKFLOWS` allows it. GitHub gives a fine-grained token the same permissions on every repository that it names |
| `PAGER_FIX_WORKFLOWS` | Variable | No | `true` lets a fix change what the CI of the target repository runs: a file under `.github/workflows/` or `.github/actions/`, or an `action.yml`. Without it, Claude leaves such a file alone and names the change instead, and the job `pull-request` refuses a change that touches one, since its checks would run it with the secrets of the target repository before you have read it |
| `PAGER_LANGUAGE` | Variable | No | `de` for German, as `LANGUAGE` of your Worker: the language of the report of the workflow *Template*, which no event of the pager names |
| `PAGER_SMOKE_REPOSITORY` | Variable | No | The public repository, as `owner/name`, whose job log and discussions the *Smoke test* reads to prove that the workflow's token still reads them; `Dennis-Otto/repo-pager` without it. Any public repository with a successful run of Actions and discussions does |
| `PAGER_MODEL` | Variable | No | Another model of Claude Code for every kind of job, such as `claude-sonnet-5-5` |
| `PAGER_AI_RUNNER` | Variable | No | Another runner for the job of Claude, should GitHub rename or end its egress-firewall runner; on another runner, Claude's network is open |
| `PAGER_PAUSED` | Variable | No | Any value holds every job of Claude, a press of yours too, such as for a week whose limit you need for your own work: the job `prepare` sends nothing to Claude, and the job `answer` tells the pager at once, so a draft or a fix brings its button back and a text of yours gets its 😢, each with the reason. Delete the variable to start the jobs again |
| `PAGER_DAILY_RUNS` | Variable | No | The most runs a day, from 00:00 UTC, of the jobs that start without a press of yours: the draft of a discussion, or of a comment on one, and a translation. A further one is held as with `PAGER_PAUSED`: the discussion brings ✍️ **Draft a reply** back, and the release keeps its notes in English. A press of yours never counts, so `0` runs only what you press; but the pager doesn't tell a press of ✍️ **Draft a reply** on a discussion apart from its draft by itself, so that one counts too. Each such run carries *(by itself)* in its title in the Actions tab, and `prepare` counts those of today that started before its own run, also the ones that the cap or the pause held, so of several that start together the first ones run |

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
| `pager-translate` | The message of a release, when the pager speaks another language than English | Translates the notes of the release, with no tool at all: they come in its prompt | The message of the release, edited in place, with its notes in your language |

**Discussions:** a draft of a discussion carries `discussion: true` and, when the reply answers a comment, `comment`, the id of that comment in GitHub's GraphQL API. The job reads the discussion, its last 50 comments and the last 20 replies of each through GraphQL, which alone has discussions, and the comment that the reply answers as `answering` of `data/thread.json`, also when it is older than those. The pager's GitHub App posts the reply that you send, in the thread of that comment. A discussion or a comment that is gone fails the job, which brings ✍️ **Draft a reply** back.

**Comments:** a draft of an issue or a pull request whose thing a comment of someone else opened or changed carries `issueComment`, the id of that comment in GitHub's REST API, never with `discussion`. The job reads that comment as `answering` of `data/thread.json`, also when it is older than the last 50 comments, and goes on without it when it was deleted, since the reply goes below the issue or the pull request all the same.

**Topics:** the pager gives each thing its own topic in the chat. A text that you write in the topic of a thing comes with that thing as `thing`: its `id`, `kind`, `repo` and `state`, the `number` and the `version` where it has them, its `links` to GitHub and `text`, its message as you see it, in Telegram's HTML. The job hands it to Claude as `data/item.json`, so a short question such as *why?* is about that thing, and the answer goes back into the topic. A `thing` that doesn't check out is left out, and the text is answered without it, as one from General.

**The notes of a release:** the repositories write their notes in English. A pager in another language words their headings, such as *Features*, itself, and sends the rest to translate, once for each version of the notes: `item`, the release, `repo`, `number` and `version` of its pull request, `of`, the key of the notes, eight hexadecimal digits, `lines`, each line of the notes that is no heading without its scope, such as `deps: `, 1 to 15 lines of at most 300 characters, and `language`, never `en`. Claude gets the lines in its prompt, as a JSON array between two lines of a random word, which no note can hold, and no tool, so a note that tries to steer it has nothing to act with. Its answer is one line for each, and the job `answer` checks each against its English line, as the pager does: it must say something, fit into 450 characters, keep every reference such as `#12`, every code span between backticks, every name of code such as `anchore/syft`, `check.sh` or `v1.56.0`, and add no reference and no link, not even a host, a mention such as `@a_bot`, a command or an address that Telegram links by itself, and all of them together fit the message. Only a translation in which every line checks out goes to the pager, as `{"type": "translation", "item", "of", "lines"}`, and edits the message in place, which notifies no one; one line that fails may be the mark of a note that steered Claude, so nothing goes, the message keeps its English, and the run says why in a warning.

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

`wait` and `answer` print the answer as JSON, with `id`, `question`, `options`, `choice` (the place of the option, from 0, or `null` for an answer in your own words), `answer` (the text of the option, or your words) and `answered` (the time of the press or of the text), and exit with 0; while there is none, they exit with 3. `ask` prints the time of its question, and `wait`, `answer` and `withdraw` with `--since` and that time ignore an answer that is older, that of an earlier question with the same id, with a minute of leeway for the clocks. `withdraw` takes back a question that the agent no longer needs, such as after its `wait` gave up; a question that has an answer already keeps it, and `withdraw` refuses, so that the agent reads it with `answer`. An id is used once: its answer stays on `pager-answers` for good, so `ask` refuses an id that has one already. A refusal of `gh` or of a check exits with 1, a wrong command line with 2. `wait` rides out a failure of `gh` that passes, such as a network error, an error of GitHub's servers or a rate limit: it says so once on the standard error, asks again after `--every` seconds, and exits with 3 at its timeout as ever, naming the last failure when no read came through. A failure that asking again would only repeat, such as a `gh` that isn't signed in, a 401, or a 403 that isn't a rate limit, ends it with 1 at once; `answer`, a single read, refuses every failure. The [contract](https://github.com/Dennis-Otto/repo-pager/blob/main/docs/how-it-works.md#questions-and-reports-of-your-agents) of the pager has the rest.

## Four jobs on four machines

| Job | What it does | Its tokens |
| --- | --- | --- |
| `prepare` | Checks the event: its kind, an item id of the pager, a repository of the owner of this repository, entries that point into it. Holds the job, with its reason for the job `answer`, while `PAGER_PAUSED` is set, or once a job that starts by itself would pass `PAGER_DAILY_RUNS`. Collects what Claude reads into a folder: the thread, why the failed jobs failed, the state of the repositories; the notes of a translation go into its prompt. Hands the job on to the jobs after it | The workflow's token, read-only, which reads public repositories, the logs of their jobs and their discussions; the smoke test checks that it still does. With `actions: read` besides, it counts today's runs of *Pager* for `PAGER_DAILY_RUNS` |
| `ask` ([`ask.yml`](.github/workflows/ask.yml)) | Runs Claude Code on GitHub's egress-firewall runner, whose network reaches only the hosts of [`.github/egress-firewall.yaml`](.github/egress-firewall.yaml). `--restricted` and `--tools` leave Claude the tools that read files, and in a fix those that write them, in the checkout alone: it runs no command and reaches no network. `--permission-prompts none` refuses whatever would wait for a yes, so a fix runs in the mode `acceptEdits`, in which its edits of the checkout need none; Claude Code still refuses a write of its own settings, of git and of the configuration of a tool, such as `.npmrc` or `.husky/`, and the job `answer` warns of each refused write. A translation has no tool at all, and no checkout | `CLAUDE_CODE_OAUTH_TOKEN` and the read-only token |
| `pull-request` | A fix with a change only: applies Claude's patch to a fresh checkout at the commit that Claude saw, makes what it wrote into the index one commit through the API, which GitHub signs, on a new branch, and opens a pull request that runs the checks and the review of the repository. It refuses a change of a workflow or an action of the CI unless `PAGER_FIX_WORKFLOWS` is `true` | `PAGER_FIX_TOKEN`, which never reaches the machine of Claude |
| `answer` | Checks Claude's answer against the schema and the allowlist again, and sends it to the pager, signed; when Claude failed, it says why. A translation goes only when every line keeps its English line, and otherwise nothing does | `PAGER_CONTROL_SECRET` |

## How the Worker and the control repository trust each other

- **The Worker to this repository:** only who may write here can send a repository dispatch. The Worker sends it with a token of its GitHub App for this repository alone, and the job of Claude runs only for the bot that `PAGER_APP` names; the events of your agents go on only when you sent them.
- **This repository to the Worker:** every answer is a `POST` to `/control` of the Worker, with the headers `X-Pager-Timestamp` (seconds since 1970) and `X-Pager-Signature`: `sha256=` and the HMAC-SHA256, under `PAGER_CONTROL_SECRET`, of the timestamp, a dot and the body. The Worker checks it against its `CONTROL_SECRET` in constant time and refuses a time more than five minutes off, so nobody without the secret can forge an answer or send one again later. An answer and the question of [Health](#the-health-of-the-pager) go again, three times at most and with a new signature each time, after a failure of the network or of the Worker and after a `408` or a `429`, which Cloudflare answers in front of the Worker when a request took too long or met its rate limit: the next try waits 2 and then 4 seconds, or as long as the header `Retry-After` asks, up to a minute. Every other refusal ends it at once; when all tries meet the rate limit, the run says so instead of blaming the secret.

[How it works](https://github.com/Dennis-Otto/repo-pager/blob/main/docs/how-it-works.md#the-control-repository) of the pager is the contract; the bodies are:

| Body | When |
| --- | --- |
| `{"type": "draft", "item", "text"}` | A draft of a reply |
| `{"type": "note", "item", "text"}` | A fix with its pull request |
| `{"type": "note", "text", "message"}` | An answer to free text |
| `{"type": "proposal", "text", "action", "target": {"kind", "repo", "number"}, "message"}` | An answer to free text that proposes one action of the allowlist |
| `{"type": "failed", "text", "message"}` | Free text whose answer didn't come to be |
| `{"type": "failed", "text"}` | The problems that the daily check *Health* found while the pager answered it and Telegram takes its bot, in the main view of the chat |
| `{"type": "failed", "item", "text"}` | A draft or fix that didn't come to be: the pager brings its button back |
| `{"type": "failed", "item", "text", "action": "rerun"}` | A fix of an alarm that found an outage of GitHub or of a download and changed nothing: the pager brings its buttons back and proposes 🔁 Rerun in its topic, with one ✅ Confirm button |
| `{"type": "ask", "id", "question", "options"}` | A question of one of your agents, which [Agents](.github/workflows/agents.yml) forwards |
| `{"type": "withdraw", "id", "reason"}` | The end of a question that its agent no longer needs; the pager answers 409 for an answered question and 404 for one that it doesn't know, which the run logs without failing |
| `{"type": "report", "text", "title"}` | The report of a run of an agent, or of the workflow *Template*, which the pager shows in a topic of its own |
| `{"type": "translation", "item", "of", "lines"}` | The notes of a release in the language of the pager, one line for each line that it sent; the pager answers 409 for notes that changed since, which the run logs without failing, and 422 for lines that don't fit them, which fails it |
| `{"type": "health"}` | The daily check *Health*, below |

`message` is the id of your text, from the event, and the pager turns its 👀 into 👍, or into 😢 for a failure. Each body may carry `"usage": {"turns", "seconds", "effort", "models": [{"model", "tokens"}]}`: the turns, the time and each model with every token that it read and wrote, the most first.

**Why the answer goes to the Worker and not to Telegram itself:** the token of the bot stays in Cloudflare alone, and this repository holds no secret that can write to the chat or act on GitHub in the pager's name. The Worker keeps the state of each thing, so a draft lands in the message of its contribution with the version that ✅ **Send** posts, a failed job brings its button back, and a proposal gets a button only while its thing still offers that action. A leaked `PAGER_CONTROL_SECRET` can only show text with buttons of the allowlist; it can't press one.

## The health of the pager

The pager writes only when something needs you, so a quiet day looks the same whether all is well or the pager is dead. The workflow [Health](.github/workflows/health.yml) runs once a day at 06:23 UTC, and by hand from the Actions tab, and asks the pager's Worker, signed with `PAGER_CONTROL_SECRET` as every answer, for its health. The run fails, with one `::error::` per problem that names it and how to fix it, when the pager doesn't answer after three tries or refuses the signature, the one refusal that names `PAGER_CONTROL_SECRET`; its schedule last ran to its end more than an hour ago, or never; Telegram refuses the bot, no webhook is set, or the webhook reported an error in the last day; GitHub refuses the pager's app; or a token expires within a week, or GitHub refuses it: `CLAUDE_CODE_OAUTH_TOKEN`, the Worker's `GITHUB_USER_TOKEN` or `PAGER_FIX_TOKEN`.

A failed run reaches you in three ways, so that one broken part can't silence it:

- **An issue of this repository,** *The health check of the pager fails*, which the job `issue` opens with `GITHUB_TOKEN` and the problems of the run, and which names the owner of this repository, so that GitHub notifies you of it and of every comment; a repository of an organization has no person to name, so there, watch the repository's issues to hear of it. Each further failed run adds a comment with its problems, and the next run that passes closes it with a last comment. It needs neither the Worker nor Telegram, nor GitHub's mails of Actions, which you may well have turned off since the pager reports red runs; and it stays as the record of when the pager broke and when it was well again. A run that broke before the check could name a problem still opens it and points to its log. Keep the issues of this repository turned on, as a new repository has them; the pager leaves an issue of a bot alone, so the issue makes no message of its own in the chat.
- **The chat:** when the pager answered and Telegram takes its bot, but something else is wrong, such as a token that expires within a week or a webhook that failed, the job sends the problems to `/control` as `{"type": "failed", "text"}`, and the pager says them in its main view. When that doesn't arrive, the run warns; the issue is there all the same.
- **GitHub's own notification** of a failed run of a schedule, by mail and on github.com, when you have it on.

The job also asks GitHub with `PAGER_FIX_TOKEN` for `GET /rate_limit`, which counts against no limit, reads the day on which the token expires from the header `github-authentication-token-expiration`, and sends it as `tokens.fix`, so the pager reminds three weeks before it. No token goes into the log or the summary, and no Claude runs.

## The changes of the template

This template is the one source of the code of every control repository, so a fix or a new feature reaches yours without a copy by hand. [`.github/template.json`](.github/template.json) names the template, the commit of it that your repository took last, and `own`, the files of your own:

```json
{
  "template": "Dennis-Otto/repo-pager-control-template",
  "commit": "",
  "own": [".github/dependabot.yml", "README.md", "pager/voice.md"]
}
```

The workflow [Template](.github/workflows/template.yml) runs every Monday, and by hand from the Actions tab. It compares the files of your default branch with those of the template's newest commit, and brings each file that differs, and deletes each that the template deleted since the commit taken last, or, before the first, since the commit that your repository was made from, as one pull request of the branch `template-sync`, titled *chore: take the template up to …*. Its one commit comes through the API, which GitHub signs, with `PAGER_FIX_TOKEN`, since only a token with *Workflows* may change a workflow; the pull request runs the tests of your repository, and you merge it. A newer change of the template comes onto the same branch and pull request, which stays open: its commit comes to be on the branch `template-sync-next`, on your default branch, and `template-sync` moves to it in one step, after which `template-sync-next` goes again; should someone have closed the pull request meanwhile, the run opens it again, or a new one when GitHub won't. The pager gets a report, *🧾 Run: Template …*, with the link, in the language of `PAGER_LANGUAGE`.

- **Your files stay yours:** each path of `own`, or each folder with a slash at its end, the `own` of the template, and every file that the template never had, such as a workflow of your own. The template names `.github/dependabot.yml`, `README.md` and `pager/voice.md`; add a file that you change on purpose.
- **Everything else is the template's:** a file of the template that your repository changed goes back to the template's with the next pull request, which shows it in its diff. Propose a change that every control repository needs to the template, or keep the file apart in `own`.
- **Without `PAGER_FIX_TOKEN`,** or when GitHub refuses it, the run fails and lists what waits in its summary, so that GitHub tells you; give the token this repository too.

## Safety

- **Data is never an instruction:** issues, comments, logs and the text of the messages are files in `data/` that Claude reads, and the notes of a release are a block of its prompt between two lines of a random word; [`pager/rules.md`](pager/rules.md), its system prompt, says so, and the task says what the files and the block are. The rules are the template's, so that a better rule reaches every control repository.
- **Claude only proposes.** Its answer is JSON of a schema, checked twice: by Claude Code and by the job `answer` against the same allowlist as the pager's buttons. ✅ **Send** and ✏️ **Edit** can't be proposed; they stay with the message of the draft, which shows the text they post. Nothing is posted in your name without your press.
- **Start fix** is the one job that writes to your other repositories: a branch and a pull request, never a merge, through the rules of the target repository. The pull request comes from a branch of the target repository, so its checks run Claude's change with the secrets of that repository before you have read it, and Claude wrote it after reading logs and files that other people can write into. So a fix changes no workflow or action of the CI, a file under `.github/workflows/` or `.github/actions/` or an `action.yml`: [`pager/rules.md`](pager/rules.md) and the task tell Claude, and the job `pull-request` refuses such a change, which the pager shows. `PAGER_FIX_WORKFLOWS` set to `true` allows it, for an owner who wants fixes of the CI and reads them as such. A script that a workflow runs, such as a test, is still part of a fix, and so is the code that a local action outside `.github/actions/` runs, such as the `index.js` beside a `tools/lint/action.yml`: a repository whose checks give a secret to its scripts in a pull request takes that into its review.
- **Pinned and few:** every action is pinned to a commit; besides GitHub's own, only `anthropics/claude-code-action` runs. The Actions policy of the template, selected actions with required SHA pinning, has GitHub refuse anything else, as that of your copy does after [Set it up](#set-it-up), and [`test/workflows.test.mjs`](test/workflows.test.mjs) fails on such an action before it reaches `main`. Harden-Runner would block hosts only with a paid plan in a private repository, so the firewall runner does that. The tests run actionlint and zizmor from images pinned by their digest. Every pin is in a place that Dependabot reads and keeps current with a pull request: the actions in the workflows; Biome in `package.json` and Claude Code of *Check the Claude token* in `.github/tools/claude-code/`, each with a `package-lock.json` whose hashes `npm ci` checks; and the images of actionlint, zizmor and mermaid-cli in the `FROM` of a Dockerfile each in [`.github/tools/`](.github/tools/), which the workflow *Tests* and `scripts/diagrams.sh` read. [`test/pins.test.mjs`](test/pins.test.mjs) fails on a version that a workflow or a script pins anywhere else.
- **You trust the template's `main` as an automatic update:** the pull request of the workflow *Template* comes from a branch of your repository, so its checks run the template's new workflows and scripts with your repository's secrets, `CLAUDE_CODE_OAUTH_TOKEN`, `PAGER_CONTROL_SECRET` and `PAGER_FIX_TOKEN` among them, before you have read it. Merging it is your review of what stays; the checks have run by then. A copy that won't trust the template that far turns the workflow *Template* off and takes its changes by hand.
- **Least permissions:** every workflow starts with `permissions: {}`, and each job gets `contents: read` at most, which [`test/workflows.test.mjs`](test/workflows.test.mjs) checks. There are three exceptions. The job `prepare` of [Pager](.github/workflows/pager.yml) gets `actions: read` besides, to count today's runs of its own workflow for `PAGER_DAILY_RUNS`; it writes nothing. The jobs of [Health](.github/workflows/health.yml) get `issues: write` besides, for the one issue of a failed check, and only their steps that keep that issue get the token: the step that holds `PAGER_CONTROL_SECRET` and `PAGER_FIX_TOKEN` gets none. The job of [Dependabot](.github/workflows/dependabot.yml) runs in the template alone and never in your copy, and gets `contents: write` and `pull-requests: write`, to turn on auto-merge for the pull request that Dependabot opened.

[SECURITY.md](SECURITY.md) says how to report a vulnerability.

## What it costs

Each job is a run of Claude Code with your subscription and counts against the same weekly limit as your other work; each kind runs with the model and the effort of `LIMITS` in [`pager/core.mjs`](pager/core.mjs), and stops at its budget in dollars of the API, the measure that Claude Code has, and at its turns, where it has any:

| Job | Model | Effort | Tools of Claude | Turns | Budget |
| --- | --- | --- | --- | --- | --- |
| Free text | Sonnet 5.5 | high | Read, Grep, Glob | 12 | 0.50 |
| Draft | Opus 5.5 | high | Read, Grep, Glob | 16 | 1.00 |
| Fix | Opus 5.5 | extra high (`xhigh`) | Read, Grep, Glob, Edit, Write | no limit | 3.00 |
| Translation | Sonnet 5.5 | medium | none | no limit | 0.30 |

A free text reads what the job prepared and answers in a few lines, so Sonnet does it well and spares the limit. A draft speaks for you to someone else, and a fix changes code that becomes a pull request: both take Opus, a fix at the deeper effort. The budget is what caps a run; the turns only stop a loop, so a fix, which reads the logs, the code and the tests of a change, runs without `--max-turns`: its budget and the 30 minutes of its job cap it. A translation turns a few lines into another language, which Sonnet does well at medium effort; with no tool, its only turns are the tries of its schema, so it has no limit of turns either.

**What bounds the runs:** the budget caps each run, not how many come. Two kinds start without a press of yours: every discussion of someone else in a repository that the pager watches, and every comment on one, gets its draft with Opus at once, and every release a translation while the pager speaks another language than English. On a busy repository, a wave of discussions could spend much of your week. `PAGER_DAILY_RUNS` caps those runs a day, and `PAGER_PAUSED` holds every job until you delete it; both are variables of this repository, in [Set it up](#set-it-up), and a held job tells the pager at once, so no button waits for the hour after which the pager gives up on a job.

**What a fix reads:** for each job that failed, the part of its log that says why, 400 lines at most: each step with an `##[error]` gets its share first, its last error and its command, then its first 20 errors and the lines before them. A run counts by the attempt that failed, and the newest attempt goes along with its state, so the answer says *already being retried* or *passed on retry* instead of guessing. When the logs show an outage of GitHub or of a download, Claude changes nothing and the pager offers 🔁 **Rerun** with a ✅ **Confirm** button, which runs the failed jobs again without another run of Claude.

The minutes of Actions of a private repository count against the free minutes of your account, 2,000 a month on GitHub Free: a job takes about two to four minutes on four runners. The daily check *Health* takes about a minute a day, some 30 a month, and one more on a day that fails, and the weekly *Template* about a minute a week.

## Development

- `npm test` runs the tests of [`pager/`](pager/) with every line, branch and function covered; `npm ci` then `npm run lint` checks the code with Biome, the one dependency of development. Node 24; the scripts of `pager/` need no dependency.
- The workflow [Tests](.github/workflows/test.yml) runs both, actionlint and zizmor; [Smoke test](.github/workflows/smoke.yml) runs the job of Claude for one word in a pull request that changes it, [Smoke test of a translation](.github/workflows/smoke-translate.yml) translates one line and checks that Claude Code had no tool for it, and [Smoke test of a fix](.github/workflows/smoke-fix.yml) has Claude add a line to a workflow and to the README of a checkout of this repository, with the tools and the mode of a fix, and checks the change, which it never commits: a new version of Claude Code or of its action that refuses such a write fails there, not in your next fix. Before it asks Claude, the smoke test reads a job log and the discussions of [Dennis-Otto/repo-pager](https://github.com/Dennis-Otto/repo-pager), or of the repository that `PAGER_SMOKE_REPOSITORY` names, with the workflow's token, as `prepare` reads those of your repositories: the pager's own public repository, which every control repository reaches, whatever its owner's repositories are called.
- `bash scripts/diagrams.sh` draws [`docs/diagrams/`](docs/diagrams/) as the pictures in `docs/images/diagrams/`, with Docker.
- A change that every control repository needs is a pull request here; the workflow *Template* of each control repository brings it there.
- **A pull request of Dependabot merges by itself:** the workflow [Dependabot](.github/workflows/dependabot.yml) turns on its auto-merge with a squash, and the ruleset of `main` holds the merge until the required check *Tests, lint and workflows* passes, so a new pin reaches the control repositories in the next pull request of their workflow *Template*, without waiting for the maintainer. It runs only where GitHub marks the repository as a template, so never in a copy; while the setting *Allow auto-merge* is off, it warns and the pull request waits for a person. Since the workflow's own token turns on the merge, its squash commit starts no run of *Tests* on `main`, and the required check doesn't ask for a branch that is up to date: the next pull request and the pull request of the workflow *Template* in each control repository test the combined result.
- **The settings of the template** are these, as in the other public repositories of the pager; GitHub keeps them apart from the files, so these are the commands that set them, also after a change by hand:

  ```sh
  REPO=Dennis-Otto/repo-pager-control-template
  gh api -X PATCH "repos/$REPO"   -F allow_auto_merge=true -F web_commit_signoff_required=true   -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=PR_BODY   -F has_projects=false -f homepage=https://dennis-otto.github.io/repo-pager/setup.html
  gh api -X PUT "repos/$REPO/topics"   -f "names[]=repo-pager" -f "names[]=telegram-bot" -f "names[]=claude-code"   -f "names[]=github-actions" -f "names[]=template" -f "names[]=self-hosted"
  gh api -X PUT "repos/$REPO/actions/permissions"   -F enabled=true -f allowed_actions=selected -F sha_pinning_required=true
  gh api -X PUT "repos/$REPO/actions/permissions/selected-actions"   -F github_owned_allowed=true -F verified_allowed=false   -f "patterns_allowed[]=anthropics/claude-code-action@*"
  ```

  *Allow auto-merge* lets Dependabot's pull requests merge; the Actions policy has GitHub enforce the pins and the few actions of [Safety](#safety); a commit made on the web carries a sign-off; the squash commit of a pull request takes its title and description, also when it has one commit; and the repository has no empty Projects tab, but topics and the guide of the pager as its homepage, so that it can be found.

## License

[MIT](LICENSE).
