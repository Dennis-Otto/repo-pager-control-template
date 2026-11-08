# Security policy

This is the template of the control repository of [Repo Pager](https://github.com/Dennis-Otto/repo-pager): the workflows that run Claude Code for a pager, with its owner's subscription, and answer its Worker, signed. Every control repository is made from it and takes its changes by the workflow *Template*, so a fix here reaches all of them.

## Supported versions

Security fixes go to the default branch of this template. A control repository takes them with the next pull request of its workflow *Template*, once a week or at once when its owner starts the workflow by hand.

## Reporting a vulnerability

Please do not open a public issue, discussion or pull request for a suspected vulnerability. Use GitHub's private vulnerability reporting for this repository:

<https://github.com/Dennis-Otto/repo-pager-control-template/security/advisories/new>

A vulnerability of the Worker belongs to [Repo Pager](https://github.com/Dennis-Otto/repo-pager/security/advisories/new). Include the commit, the set-up, reproduction steps and the potential impact. Reports in English or German are welcome. Never include a token, a secret or the log of a run of your own control repository, which shows what Claude read: describe them instead.

## What happens next

| Step | Target |
| --- | --- |
| Acknowledgement of the report | within 7 days |
| First assessment, including whether the report is accepted | within 14 days |
| Fix on the default branch for a confirmed vulnerability | as fast as possible, at the latest within 90 days |
| Public disclosure | when the fix is on the default branch, in a GitHub security advisory |

## How the template keeps a control repository safe

- **Data is never an instruction.** Issues, comments, logs and the texts of messages are files that Claude reads; [`pager/rules.md`](pager/rules.md), its system prompt, says so.
- **Claude only proposes.** It runs on GitHub's egress-firewall runner, which reaches only the hosts of [`.github/egress-firewall.yaml`](.github/egress-firewall.yaml), with the tools that read files, and in a fix those that write them in a checkout: it runs no command. Its answer is JSON of a schema, checked again against the allowlist of the pager's buttons before it goes to the Worker.
- **The tokens that write never meet Claude.** `PAGER_FIX_TOKEN` opens the pull request of a fix on another machine, and `PAGER_CONTROL_SECRET` signs the answer on a third; a leaked `PAGER_CONTROL_SECRET` can only show text with buttons of the allowlist, never press one.
- **Pinned and few.** Every action is pinned to a commit, besides GitHub's own only `anthropics/claude-code-action` runs, and every workflow starts with `permissions: {}`. The tests run actionlint and zizmor from images pinned by their digest, and Dependabot keeps the actions current.
