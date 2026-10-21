# Pilot plan

How to find out whether this tool works, on your own projects, before trusting
it with a `--fix`.

The order is fixed: report only, then repair on a throwaway branch, then repair
in CI. Each stage has an entry condition, a thing to run, a thing to record, and
an exit condition. Do not skip a stage on a project because an earlier project
passed it — the thing being tested is the project, not the tool.

Every command below is checked against `sma.mjs`. Where a flag does not exist,
it is called out as proposed and not used.

## Picking the first pilot project

Pick for diagnosability, not for value. The first project is where you learn to
read the output.

Good first project:

- [ ] Depends on exactly one external API, and that API publishes an OpenAPI
      document at a stable URL (a token is fine, via `headers:`).
- [ ] JavaScript or TypeScript, ESM or CJS, no build step between source and the
      code that makes the request. `src/inventory.mjs:21` globs
      `.js,.jsx,.mjs,.cjs,.ts,.tsx,.mts,.cts` under the repo.
- [ ] Calls the API through `fetch`, `axios`, `got`, `ky` or `request`
      (`inventory.mjs:7`), with the URL written as a string or a template
      literal at the call site.
- [ ] Under a few hundred source files. `scan()` builds a ts-morph project and
      asks the language service for references (`inventory.mjs:56`); the cost
      is real and you want a fast loop.
- [ ] Has a test suite that actually exercises the API layer and fails when the
      contract breaks. Without this, `finish()` (`repair.mjs:101`) verifies
      nothing and every PR is as good as its agent's self-report — which is the
      one thing the design refuses to trust.
- [ ] Clean working tree between runs. `startSession` (`repair.mjs:78`) refuses
      a dirty repo.
- [ ] You own it and nobody else pulls from it hourly.

Avoid, for now:

| Shape | Why |
|---|---|
| A spec behind a token | Unsupported. `watcher.mjs:23-27` sends no headers. |
| A very large spec (GitHub, Stripe) | Measured: the GitHub spec inlines to 111.5 MB, and that is the file you are asked to commit. Wait for gap 4. |
| A repo whose API calls go through a generated client or three layers of wrappers | One hop out only (README, "What it does not do"). |
| A hand-written SDK wrapper | SDK matching is `operationId` as a substring of the method chain (`impact.mjs:29-33`). |
| A monorepo | `repo:` is a single path (`store.mjs:70`); one `watch.yaml` scans one tree. |
| Anything with a shared or protected main branch | Stage 2 creates and deletes branches in your worktree. |
| A repo with no tests | Nothing verifies the patch. |

## Stage 0 — bench rehearsal

Before touching a real project, run the loop you already control, so you know
what correct output looks like.

**Entry:** a clone of this repository, `npm install` done. `demo/demo-app` is
generated, not tracked — `demo/setup.mjs` copies `demo/app` and `git init`s it,
because `sma fix` branches whatever `repo:` points at and that must not be this
checkout.

**Run:**

```bash
npm run demo:setup                    # materialises demo/demo-app as its own git repo
node demo/petstore/server.mjs &
node sma.mjs doctor
node sma.mjs run                      # first run: captures the baseline
echo v2 > demo/petstore/ACTIVE        # upstream ships the breaking release
node sma.mjs run                      # detects, maps, reports — no patching
node sma.mjs fix                      # patches, verifies, writes the PR body
```

**Record:** the impact report, and the PR body written under `.sma/pr/`.

**Exit:**

- [ ] The second `run` reports the expected breaking changes with call sites.
- [ ] `sma fix` produced a branch in `demo/demo-app`, the harness ran the tests,
      and the PR body under `.sma/pr/` reads like something you would review.
- [ ] You can point at the line in the report that says a change is
      *not affected*, and say why it is not.

Reset before moving on:

```bash
echo v1 > demo/petstore/ACTIVE
node demo/setup.mjs --force           # recreate demo/demo-app from demo/app, sma branches and all
node sma.mjs reset
```

`sma reset` deletes all of `.sma/`, including the baseline (`sma.mjs:262-265`).
That is what you want here and never what you want on a real project.

## Stage 1 — shadow mode

Report only. No branches, no agent, no spend beyond at most one classifier call
per API per run.

**Entry:**

- [ ] Stage 0 exit criteria ticked.
- [ ] A pilot project chosen against the list above.
- [ ] `node sma.mjs doctor` in that project shows `ok` for node and config.
      Missing `claude`, `gh` or `GH_TOKEN` is fine — this stage uses none of them.

**Set up.** In the pilot project's root, `watch.yaml`:

```yaml
# The repo that gets scanned. `.` means this project.
repo: .

# How the harness would verify a repair. Unused in shadow mode, but get it right now.
test: npm test

apis:
  - name: acme
    spec: https://api.acme.example/openapi.json
    baseUrl: https://api.acme.example
```

Then, from that project's root (sma walks up from the cwd to the nearest
`watch.yaml`, `store.mjs:13-19`):

```bash
node /path/to/Self-MaintainingAI/sma.mjs init     # writes .gitignore entries, captures the baseline
git add .gitignore .sma/specs && git commit -m "chore: sma baseline"
```

If sma is installed into the project (`npm i -D self-maintaining-api`), the same
commands are `npx sma init` and so on. Everything below uses `sma` for brevity.

**Run, daily, by hand or by cron:**

```bash
sma scan            # what it thinks you call — read this once, carefully
sma run             # scan + check + impact, report only
```

`sma run` without `--fix` prints the report and stops (`sma.mjs:225-226`). Use
`--no-llm` for a run that is guaranteed to make no API calls at all
(`classify.mjs:82`).

**Record:** after every run, one row in the observation log below for every
change reported. Also keep `.sma/changes/<stamp>.json` and
`.sma/impact/<stamp>.json` — they are gitignored per run, so copy the ones that
matter somewhere you will still have them in a month.

**Exit:**

- [ ] Two full weeks of runs, or at least three real upstream changes,
      whichever comes later.
- [ ] Every reported change has a log row with a true/false positive verdict.
- [ ] `sma scan` output has been read line by line and matches the call sites
      you know exist. Nothing important is missing; nothing listed is wrong.
- [ ] Zero false positives in the last five runs, or each remaining one is
      understood and written down.
- [ ] You have read one report and correctly predicted, before looking, which
      changes would be marked not-affected.

**Rollback:** delete `watch.yaml` and `.sma/`, revert the `.gitignore` commit.
Nothing else was touched. Shadow mode writes only inside `.sma/`.

## Stage 2 — assisted fix on a throwaway branch

The agent edits, the harness verifies, you read every line. Local only.

**Entry:**

- [ ] Stage 1 exit criteria ticked on this project.
- [ ] `sma doctor` shows `ok` for `claude CLI` and `git`.
- [ ] `git status` clean (`repair.mjs:78` will refuse otherwise).
- [ ] A throwaway branch to sit on, so the base branch is never the base of an
      sma branch: `git switch -c pilot/sma-stage2`.

**Run, only when stage 1 reported a breaking change with call sites:**

```bash
sma run              # confirm the report first
sma fix              # one branch per API, one agent per grouped change
```

`sma fix` reuses `.sma/impact/<stamp>.json` from the run in the same second, and
otherwise re-runs `impact` itself (`sma.mjs:174`). It creates
`sma/<api>-<stamp>` off the current branch (`repair.mjs:80-81`), runs each
agent, runs your `test:` command itself, commits, and — with no remote, or with
`gh` unavailable — writes the PR body to `.sma/pr/` and prints the path
(`pr.mjs:68-70`). Then it checks the base branch back out (`sma.mjs:212`).

**Before reading the diff, read the prompt.** `.sma/prompts/*.txt` is exactly
what the agent was told (`repair.mjs:88`). If the patch is wrong, the prompt is
usually why.

**Record:** the log row, plus for each PR: did the tests pass, did the diff stay
inside the predicted impact (`outsideScope` in the output), and how many lines
you had to change by hand.

**Exit:**

- [ ] At least three repairs attempted on this project.
- [ ] Every produced branch was reviewed line by line.
- [ ] No repair was merged that you had to substantially rewrite.
- [ ] Any repair that touched a file outside the predicted impact was labelled
      `needs-human` and you agreed with the label.
- [ ] You have seen at least one failure — a wrong patch, a failed test — and
      the tool reported it honestly rather than claiming success.

**Rollback:**

```bash
git switch <your base branch>
git branch -D $(git branch --list 'sma/*' | tr -d ' *')
git switch -c pilot/sma-stage2        # fresh throwaway, if continuing
```

Nothing is pushed at this stage as long as the branch has no upstream. If a
remote exists, `pr.mjs:72` pushes — so run stage 2 in a clone with no remote, or
accept that the branches will appear on the forge.

## Stage 3 — `--fix` in CI with human review

**Entry:**

- [ ] Stage 2 exit criteria ticked.
- [ ] `ANTHROPIC_API_KEY` set as a repository secret.
- [ ] The baseline is committed and up to date on the default branch.
- [ ] You know, from the stage 1 and 2 log, roughly how often this API changes
      and what a run costs.

**Workflow** — the one in `.github/workflows/sma.yml` of this repo, with the
exit-code fix from gap 14 and a concurrency group from gap 11. Minimum version
for a consumer project:

```yaml
name: sma
on:
  schedule: [{ cron: '0 6 * * *' }]
  workflow_dispatch:

concurrency:
  group: sma
  cancel-in-progress: false

permissions:
  contents: write
  pull-requests: write

jobs:
  watch:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npm install -g @anthropic-ai/claude-code
      - name: Configure git
        run: |
          git config user.name  "sma[bot]"
          git config user.email "sma@users.noreply.github.com"
      - id: sma
        continue-on-error: true
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          set +e
          npx sma run --fix
          echo "code=$?" >> "$GITHUB_OUTPUT"
      - name: Commit the new baseline
        run: |
          git add .sma/specs
          git diff --cached --quiet || git commit -m "chore(sma): update spec baseline"
          git push origin HEAD:${{ github.ref_name }} || echo "nothing to push"
      - name: Report result
        run: exit ${{ steps.sma.outputs.code }}
```

Start with the schedule commented out and only `workflow_dispatch`, for the
first week. Run it by hand, watch it, then enable the cron.

**Record:** the log row per detection, plus the workflow run URL and the PR URL.
`.sma/runs.json` records the repair (`sma.mjs:203-211`) but not the clean runs
(gap 12), so the log is still the source of truth.

**Exit:**

- [ ] Four consecutive weeks of green scheduled runs.
- [ ] At least one PR opened unattended, reviewed, and merged without edits.
- [ ] No run has ever pushed a baseline for a change it failed to report
      (see "stop and fix the tool" below — this is the one that matters).
- [ ] You trust the red badge enough to act on it the same day.

**Rollback:** disable the schedule (comment out `on: schedule`, or disable the
workflow in the Actions tab) and close the open sma PRs. The baseline stays
committed, so re-enabling later resumes from the last pushed snapshot rather
than starting over. If a bad baseline was pushed, revert that commit — do not
run `sma reset`, which would delete the baseline and make the next run a first
run (`sma.mjs:262-265`).

## Observation log

One row per reported change. Keep it in the pilot project, at `docs/sma-log.md`.

| Date | API | Rule | Endpoint | Sites found | True positive | Patch applied cleanly | Tests passed | Human intervention | Notes |
|---|---|---|---|---|---|---|---|---|---|
| 2026-09-11 | acme | `RESPONSE_FIELD_REMOVED` | `GET /things` | 3 | yes | n/a (shadow) | n/a | none | example row — delete |

Column meanings, so the rows stay comparable:

- **Sites found** — the count from the impact report; `0` means reported as
  not-affected.
- **True positive** — yes if the upstream API really did make that change, no if
  the rule fired on something that did not break anything. `partial` if the rule
  was right but the endpoint or the field was wrong.
- **Patch applied cleanly** — stage 2 onward: did the agent's diff compile and
  stay inside the predicted impact.
- **Human intervention** — `none`, `review only`, `edited N lines`, or
  `discarded`.

## Stop and fix the tool, versus a real upstream break

| Signal | Reading |
|---|---|
| A rule fires and the upstream spec really did change that way | Real break. Act on it. |
| A change is reported as not-affected and you can confirm no call site exists | Working as designed. |
| A run reports zero changes on a day the API definitely changed | **Stop.** Either an earlier `check` that day already classified the change and advanced the baseline, or the fetch returned a cached or wrong document. Check `git log .sma/specs/<api>.json` against the upstream release notes before running again. |
| The same change is reported two days running | **Stop.** The baseline is not being committed. Check the workflow's push step and that `.sma/specs/` is not in your `.gitignore`. |
| A rule fires on a spec you can diff by hand and see no such change | **Stop.** A rule bug. Save both snapshots and write a `test/diff.test.mjs` case before changing anything. |
| The same rule fires on hundreds of endpoints at once | Usually one shared schema, fanned out by `$ref` inlining (gap 5). Real, but the report is lying about its scale. Group it, do not silence it. |
| `UNCLASSIFIED` entries appear | Not a break. A delta no rule models, with no key or with `--no-llm`. Read it; if it is a real class of change, it wants a rule. |
| Exit 2 | sma failed, not the API. Nothing was detected. Do not treat a green-after-retry as a clear run. |
| The agent edits a file nobody predicted | **Stop** if it happens twice. Either the inventory is missing a call site, or the agent is refactoring. Read `.sma/prompts/`. |
| Tests pass but the patch is wrong | **Stop.** The test suite is not covering the API contract. Fix the tests before trusting any further repair on this project. |
| A PR opens with no `needs-human` label and needs human work | **Stop.** That label is the entire trust boundary. Work out which check missed it. |

## Cost and time per run

Reasoned from the code. No dollar figures: the per-token price is not something
this repository knows, and the agent's spend depends on your repo.

**LLM calls in a report-only run.** At most one Anthropic API call per API per
run, and only when all three hold: the rule engine left something unexplained
(`classify.mjs:78-80`), `--no-llm` was not passed, and `ANTHROPIC_API_KEY` is
set (`classify.mjs:82`). Zero on the baseline run (`sma.mjs:117-121`), zero when
the spec did not change, zero when the rules explain everything — which is the
case for the whole petstore v1→v2 diff, asserted at `test/diff.test.mjs:34-37`.
The call is capped at `max_tokens: 8000` (`classify.mjs:67`) and the prompt
carries the full leftover-delta list (`classify.mjs:62`), so the input size
scales with how much of the diff the rules do not model. The default model is
`claude-opus-5` (`classify.mjs:7`), overridable with `SMA_MODEL`; PLAN.md line
72 intended a cheaper model for this yes/no judgement, so setting
`SMA_MODEL=claude-sonnet-5` during the pilot is reasonable and reversible.

**LLM calls in a `--fix` run.** One headless `claude` session per repairable
group (`sma.mjs:187-190`), where groups are `api:rule:subject`
(`impact.mjs:52-53`) — so one shared-schema change across ten endpoints is one
session, not ten. Each session is a full agentic loop of unknown length. There
is no cap and no timeout (gaps 9, 10). Assume a repair costs one to two orders
of magnitude more than a classification and treat any run with more than a
couple of groups as something to supervise.

**Wall clock, measured on this machine.** Numbers from actual runs during this
review, on Windows, node 24, warm network.

| Step | Measured |
|---|---|
| `scan` on a two-file fixture | 0.9 s, mostly ts-morph and language-service startup |
| Fetch + parse the GitHub spec (12.9 MB) | 14.2 s |
| `resolveRefs` on that spec | 1.0 s, 792 MB RSS |
| Full-spec diff of two copies of it | 1.7 s |

A report-only run on a small project with a small spec is seconds. A `--fix`
run is dominated by the agent and by your test suite, neither of which sma
bounds.

**Assumptions, stated.** Everything above is one machine, one network, one spec.
The only way to get real numbers for your projects is the run log in gap 12.
Until that exists, time the runs by hand for the first week and put the numbers
in the observation log's notes column.
