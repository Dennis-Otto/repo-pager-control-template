# Contributing

Thank you for helping with the template of the control repository of [Repo Pager](https://github.com/Dennis-Otto/repo-pager). Every control repository is a private copy of this template and takes its changes through its workflow *Template*, so a pull request here reaches all of them. A change that only your own copy needs belongs in that copy, in a file of its `own` in `.github/template.json`.

This file, the issue forms in `.github/ISSUE_TEMPLATE/` and `.github/pull_request_template.md` are for the template alone: `own` of the template's `.github/template.json` lists them, so the workflow *Template* never brings them to a copy.

## Report a bug or propose a change

Open an issue with the form [for a bug](https://github.com/Dennis-Otto/repo-pager-control-template/issues/new?template=bug.yml) or the one [for a proposal](https://github.com/Dennis-Otto/repo-pager-control-template/issues/new?template=proposal.yml). A vulnerability goes to the private report of [SECURITY.md](SECURITY.md), never into an issue.

**Never paste the log of a run of your control repository**, nor its summary, an `answers/*.json` of the branch `pager-answers` or a secret: your copy is private because these logs show issues, drafts and what Claude read. Describe what happened instead, with the name of the workflow, its step and the `::error::` line in your own words; a log of a run in a public repository, such as one of this template, may be linked.

## Test a change

You need Node 24 and npm.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test        # the tests of pager/, with every line, branch and function covered
npm run lint    # Biome: the lint and the format of the code
```

`npx biome check --write .` fixes what Biome can fix by itself. The workflow [Tests](.github/workflows/test.yml) runs both on every pull request, and actionlint and zizmor on the workflows, from the images that `.github/tools/` pins; with Docker you can run them as that workflow does. A diagram is a Mermaid source in `docs/diagrams/`, and `bash scripts/diagrams.sh` draws its pictures in `docs/images/diagrams/`, with Docker.

A change of behaviour comes with its tests in `test/`, and a bug fix with a test that fails without the fix: the tests run the jobs against a simulated GitHub and a simulated pager in `test/fake.mjs`, never a real one. A change of what a workflow promises, such as its permissions, changes `test/workflows.test.mjs` with it, and the README says what changes for the owner of a copy.

## Where the runs of Claude are tested

Never here. The smoke tests, [Smoke test](.github/workflows/smoke.yml), [of a translation](.github/workflows/smoke-translate.yml) and [of a fix](.github/workflows/smoke-fix.yml), run Claude Code with the subscription of the owner of a control repository, so they skip this template, which has no token of Claude. They run in a pull request of a copy that changes the jobs of Claude: the pull request of its workflow *Template* that brings your change, or a pull request of your own in your own copy, made before the one here. Say in your pull request which copy ran them, and whether they passed, without its log.

## Commit and open the pull request

- **Sign every commit and sign it off:** `git commit -S -s`. `-S` signs it, with GPG, SSH or gitsign, so that GitHub shows it as verified; `-s` adds the `Signed-off-by` of the [Developer Certificate of Origin](https://developercertificate.org/).
- **The title of the pull request is a [Conventional Commit](https://www.conventionalcommits.org/),** such as `fix: ride out a 429 of Cloudflare` or `feat(health): open an issue when the check fails`: `feat`, `fix`, `perf`, `docs`, `test`, `refactor`, `ci`, `build` or `chore`. The pull request is squashed into one commit with its title, which the pull request of the workflow *Template* in every copy then lists.
- **The description** follows the template of the pull request: what changes and why, how it was tested, and `Fixes #123` for the issue that it closes.
- Every check of the pull request passes before it is merged; nothing here is merged red.
