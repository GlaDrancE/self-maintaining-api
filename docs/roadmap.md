# Roadmap

Near, next, later. Ordered by what stops you using the tool, not by what is
interesting to build.

Every item names the problem it solves and the observation that would prove it
worked. Items marked **speculative** are guesses about future need and should be
deleted rather than built if the pilot log does not ask for them.

Gap numbers refer to the table in `productionization.md`.

## Fixed

Kept here rather than deleted, so the problem and its resolution stay together.

| Item | Problem it solved | Gap |
|---|---|---|
| Promote the baseline only after classification | `check()` wrote the new snapshot before classifying. Any failure after that point lost the change permanently and the next run reported all clear. `saveSnapshot()` now runs after `classify()` returns; the first-run branch still saves immediately. | 1 |
| Count created files as changes | `finish()` used `git diff --name-only`, which lists no new files, while `pr.mjs` committed with `git add -A` — so a file the agent created was never scope-checked and shipped anyway. `touchedFiles()` now reads `git status --porcelain --untracked-files=all`, and an agent that writes a new file outside the predicted impact produces a PR labelled `needs-human` naming it. | 2 |
| Stop reporting an added auth scheme as breaking | `compareAuth` fired on any difference, including a scheme with no "before". `AUTH_SCHEME_CHANGED` is the only whole-spec rule, so that false positive claimed every call site and became repairable. A scheme that did not exist before is now skipped; removal and modification are still breaking. | — |
| Resolve a local `spec:` against the config file | A relative local spec path was read from the cwd, so `--config ../watch.yaml` failed with `ENOENT`. `fetchSpec` now resolves against the config file's directory, like `repo:`. | — |
| Fetch timeout and retry | A hung spec URL hung CI and a 429 failed the run. 60s timeout, three retries on 429/5xx honouring `Retry-After`. (Size cap still open.) | 3 |
| Timeouts on the agent and the test run | 15 min per agent, 10 min for tests; a timeout counts as a failure. | 9, 10 |
| Preserve the exit code in CI | `sma.yml` re-exits with the real code and says which one it was. | 14 |
| Headers on the spec request | `apis[].headers` with `${VAR}` from the environment. | 6 |
| Redact secrets from output | Credential-looking query values are masked in errors, PR bodies and the report. | 7 |
| Every modified file keeps its name | Found by the demo: `touchedFiles()` returned `M test/api.test.mjs` for every modified file after the first, flagging correct repairs `needs-human`. | — |
| Ignore top-level `x-*` extensions | Found on OpenAI's real spec: `x-oaiMeta` docs metadata was 4 of 9 reported changes. | — |
| `sma diff` and `sma report` | Compare any two specs with no config; render findings and repairs to one HTML page (also uploaded as a CI artifact). | 13 (partly) |
| Name the missing `gh` CLI | On `ENOENT`, `spawnSync` leaves `status` and `stderr` null, so the note read `gh pr create failed: undefined`. It now says the gh CLI is not on PATH, that the branch is pushed, and where the PR body is. | — |

## Near

Things that make the tool safe to point at a repository you care about.
These are Phase 0 and Phase 1 work.

| Item | Problem | Done when | Gap |
|---|---|---|---|
| A lockfile at `.sma/lock` | Nothing stops two runs sharing a target worktree. `startSession` would check out a branch the other run is editing. | A second `sma run` started during a first exits 2 with a lock message and changes nothing. | 11 |
| Fix the shipped `watch.yaml` | `sma.yml:63` runs against a config whose `repo: ./demo/demo-app` is now generated and gitignored, and whose spec is `http://localhost:8787`. The repository's own daily job cannot get past `loadConfig`. | The scheduled run on this repository is green for a week without intervention. | 15 |
| Stabilise the test suite | `npm test` OOM-crashed `test/inventory.test.mjs` once during review and passed four other times. `inventory.mjs:16` builds a ts-morph `Project` per `scan()`. The suite now gates `ci.yml` on four matrix legs, `release.yml`, and `prepublishOnly`. | Twenty consecutive `npm test` runs pass. | 17 |
| A real run log | `store.appendRun` is called only from `fix()` (`sma.mjs:203`). Clean runs, failed fetches and report-only runs leave no trace, so questions like "has this ever produced a false positive" cannot be answered from the artifacts. | Four weeks of scheduled runs, each with an entry recording fetch status, change counts, token usage, duration and exit code. | 12 |

## Next

Things that make it work across several projects at once.
Phase 2 work, informed by whatever the pilot log says hurt.

| Item | Problem | Done when | Gap |
|---|---|---|---|
| Snapshot the raw spec, inline at compare time | `resolveRefs` (`watcher.mjs:31-53`) inlines everything. Measured on the GitHub spec: 12.9 MB raw becomes 111.5 MB on disk — and that file is what the README tells you to commit, daily. | The baseline for the largest watched spec is a file a human can `git diff`, and the daily commit is proportional to what actually changed. | 4 |
| Group the report the way repairs are grouped | One field removed from a shared schema fans out to one hit per referencing operation. `repairable()` (`impact.mjs:48-64`) already collapses these; `report()` (`impact.mjs:67-78`) does not. On an 815-path spec the report is unreadable. | A shared-schema removal prints as one finding with an endpoint count, not one line per endpoint. | 5 |
| `--json` on `check` and `impact` | `report()` returns text. CI can read only the exit code, so there is no way to annotate a PR, drive a dashboard, or assert on results in a test. The objects already exist on disk under `.sma/`. | A CI step consumes `sma impact --json` and posts a comment without parsing prose. | 13 |
| Cost ceiling on classification | `classify.mjs:65-70` sends every leftover delta in one prompt with no bound, at `claude-opus-5` by default. | A run against a large spec diff has a predictable, logged token cost, and truncation is stated in the output rather than silent. | 8 |
| Better SDK matching | `impact.mjs:32` tests whether the `operationId` is a substring of the method chain. A short `operationId` matches everything; a hand-written client matches nothing. | An `operations:` name map in `watch.yaml` makes a hand-written client's call sites resolve, and a one-word `operationId` no longer matches unrelated chains. | 18 |
| Scan-scope configuration | `inventory.mjs:20-23` globs every JS and TS file under `repo` and excludes only `node_modules`. A repo with committed build output floods the inventory. | A repo with a `dist/` directory scans in the same time as one without, and reports the same sites. | — |
| Tests for the write path | `test/watcher.test.mjs` and `test/repair.test.mjs` cover spec-path resolution and `touchedFiles()` against a temp git repo. `pr.mjs` and `sma.mjs` are still untested — the modules that push, commit and spend money. | `resolveRefs` has cases for circular, missing and deeply nested refs, and `prBody` is asserted as a pure function. | 16 |
| SARIF output | **Speculative.** Useful only if you want call sites rendered inline in GitHub's code scanning UI. Do not build it before `--json` has been used in anger. | A detection appears as an annotation on the right line of the right file, without opening a PR. | 13 |

## Later

Phase 3 and beyond. Mostly about other people using it.

| Item | Problem | Done when |
|---|---|---|
| Fix the release metadata and cut the first tag | `.github/workflows/release.yml` now exists and is correct — `v*` tag, `id-token: write`, tests before publish. But `git tag -l` is empty, so it has never run, and `package.json`'s `repository`, `bugs` and `homepage`, plus the advisory link in `SECURITY.md`, name `github.com/ayush/...` while the remote is `github.com/GlaDrancE/...`. Provenance attests the source repository; a mismatch is not cosmetic. | A `v1.0.0` tag publishes from CI with provenance, and the npm page links to a repository that exists. |
| Forge abstraction | `pr.mjs:72` pushes to a literal `origin` and `pr.mjs:75` shells to `gh`. GitLab, Gitea, and any non-`origin` remote are out. | A repository on a non-GitHub forge gets a branch pushed and a printed next step, with no code change in `repair.mjs`. |
| Keep `SECURITY.md` true as the code changes | `SECURITY.md` now documents the trust model, which closes the original gap. The risk inverts: a security document that drifts from the code is worse than none. It already claims a supported-version policy for releases that do not exist yet, and links to the wrong repository. | Every change to `watcher.mjs`, `repair.mjs` or `pr.mjs` is accompanied by a re-read of `SECURITY.md`, and the claims still hold line by line. |
| Deeper call graph | **Speculative.** The README commits to one hop out. Going further needs a real call graph and will find more false positives, not fewer. Build only if the pilot log shows repairs repeatedly missing a layer. | On a project with three layers of wrappers, the patch reaches the tests that assert the old shape, with no increase in the false-positive rate. |
| More HTTP client shapes | **Speculative.** `inventory.mjs:103` matches the root identifier against a fixed list, so `client.get()` where `client = axios.create()` is invisible. A configurable list of client names is cheap; following the assignment is not. | A project using an axios instance scans correctly with one line of config. |
| Cross-run analytics | **Speculative.** PLAN.md line 246 says SQLite when you want cross-run queries. Nothing has wanted them yet. The run log from Phase 0 is the prerequisite; do not build the store before there is a question it answers. | A question like "which rule has the worst false-positive rate across my projects" is answerable without grepping JSON by hand. |
| Multi-repo from one config | **Speculative.** `store.mjs:70` resolves a single `repo:`. Onboarding project N is a checklist, not a feature. If the checklist stays under thirty minutes, this is not needed. | Three projects are watched from one scheduled job, and a failure in one does not stop the others. |

## Reconciliation with PLAN.md

PLAN.md's build phases 0 through 7 all shipped. The spine of the plan survived
contact: `watch.yaml`, the rule table, the AST inventory, the impact join, the
headless agent, the `gh` PR, the JSON state under `.sma/`, and the daily cron.
The dependency list is exactly what was planned — `ts-morph`,
`@anthropic-ai/sdk`, `yaml`, plus `gh` and `claude` as external CLIs.

### Shipped as planned

| PLAN.md | Where it landed |
|---|---|
| Phase 0, petstore demo with a v1→v2 breaking release | `demo/petstore/`, `demo/demo-app/` |
| Phase 1, CLI skeleton and `store.mjs` | `sma.mjs`, `src/store.mjs` |
| Phase 2, watcher, diff, rules, and the "single most valuable test" | `src/watcher.mjs`, `src/diff.mjs`, `src/rules.mjs`, `test/diff.test.mjs` |
| Phase 3, ts-morph HTTP and SDK detectors with template-literal collapsing | `src/inventory.mjs`, `test/inventory.test.mjs` |
| Phase 4, impact join with `not-affected` reporting | `src/impact.mjs:41` |
| Phase 5, agent on a fresh branch, independent verification, `needs-human` | `src/repair.mjs:93-114` |
| Phase 6, PR with reasoning, test result and a validation checklist | `src/pr.mjs:46-51` |
| Phase 7, daily workflow with both secrets | `.github/workflows/sma.yml` |
| Confidence floor below which nothing is auto-patched | `classify.mjs:8,101` |
| Verification item 4, identical specs report zero changes | `test/diff.test.mjs:46-50` |

### Shipped differently, on purpose

| PLAN.md said | What shipped | Why it is better |
|---|---|---|
| Phase 5: the agent runs `npm test` and reports the result | The agent gets `Read,Edit,Write,Glob,Grep` and no shell (`repair.mjs:11`); the harness runs the tests (`repair.mjs:101`) | The agent's self-report can never be the evidence. This is the strongest decision in the codebase. |
| Branch `sma/<api>-<rule>-<shortdate>` | `sma/<api>-<stamp>`, one branch per API (`repair.mjs:80`) | A PR that fixed half of what an upgrade broke would fail its own test suite. |
| `spawn('claude', ['-p', promptText, ...])` | The prompt goes in over stdin (`repair.mjs:54-58`) | No command-line length limit, no quoting. |

### Planned but not delivered

| PLAN.md | Status |
|---|---|
| `claude-sonnet-5` for the classifier (line 72: "Opus not needed for a yes/no + reason") | Shipped as `claude-opus-5` (`classify.mjs:7`), overridable with `SMA_MODEL`. Costs more than planned for the same judgement. Gap 8. |
| Verification item 3: point `watch.yaml` at the GitHub REST spec and run a week apart as live proof | Not done. The entry is commented out in `watch.yaml:9-13` with a note that it is a ~10MB download. The measurements in `productionization.md` show why: it inlines to 111.5 MB. This is the single largest untested claim in the project, and Phase 1 of the productionization plan exists to close it. |
| `sma.mjs` at "~80 lines" | 298 lines. Not a problem, but the CLI absorbed `doctor`, `reset`, `version` and the `.gitignore` management that the plan did not anticipate. |

### Shipped without being planned

Worth noting because none of it is in PLAN.md and all of it is load-bearing:
one-hop callers (`inventory.mjs:45-84`) and the reasoning for them; the
three-code exit contract (`sma.mjs:19`); `sma doctor` and its degradation table;
the `UNCLASSIFIED` fallback when no key is present (`classify.mjs:82-97`);
config validation as a trust boundary (`store.mjs:55-65`); UTF-16 handling for
Windows (`store.mjs:40-45`); and five tests the plan did not call for,
`test/impact.test.mjs`, `test/store.test.mjs`, `test/repair.test.mjs`,
`test/auth.test.mjs` and `test/watcher.test.mjs`.

### Non-goals, still intact

PLAN.md line 240's "deliberately skipped" list holds, with one nuance: `site/`
is a landing page, not the web dashboard the plan ruled out. The PR is still the
UI. Auto-merge is still never.
