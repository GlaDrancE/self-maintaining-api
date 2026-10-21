# Productionization

From a working v1.0.0 to something one person can rely on daily.

This is written for the person who built it and is about to run it against their
own repos. Every claim below is checked against the code in this repository as it
stands: commit `d07fc8d` plus the uncommitted working tree — which at the time of
writing adds `sma version`, `publishConfig.provenance`, `CHANGELOG.md`,
`CONTRIBUTING.md`, `SECURITY.md`, `docs/`, `site/`, the `ci`, `release` and
`pages` workflows, and the `demo/app` → `demo/demo-app` split.

Since the review, five of the findings below have been fixed in `sma.mjs`,
`src/repair.mjs`, `src/pr.mjs`, `src/rules.mjs` and `src/watcher.mjs`. Those are
marked where they appear. Line citations for anything else are against
`d07fc8d`.

## Current state

### What is production-ready today

| Part | Evidence |
|---|---|
| The rule table | `src/rules.mjs` — 11 breaking rules, deterministic, no network, no LLM. `test/diff.test.mjs` asserts the exact hit set for v1→v2 and, in the last three tests (lines 46-57), the absence of false positives on identical and reordered specs. |
| The impact join | `src/impact.mjs`. `test/impact.test.mjs` covers the cases that matter: cross-API leakage (line 37), unused changes reported as not-affected (line 45), a whole-spec `UNCLASSIFIED` delta claiming nothing (line 56, marked as a regression), and grouping one upstream edit across three operations into one repair (line 75). |
| Config as a trust boundary | `src/store.mjs:55-65` rejects an API name that could escape `.sma/specs/`, and duplicates. `test/store.test.mjs:31-38` asserts both. |
| Degradation layers | `sma doctor` (`sma.mjs:231-256`) enumerates them, and `classify.mjs:82-97` really does fall back to `UNCLASSIFIED` rather than guessing. Verified: `node sma.mjs doctor` exits 0 with no `ANTHROPIC_API_KEY`. |
| The safety model of the repair | `src/repair.mjs:11` gives the agent `Read,Edit,Write,Glob,Grep` and no shell; `repair.mjs:101` runs the tests in the harness, not the agent. `startSession` (`repair.mjs:76-83`) refuses to work in a dirty or non-git repo. Nothing merges. |
| Exit-code contract | `sma.mjs:19` defines three codes and every command sets one. |

### What is not

| Part | Evidence |
|---|---|
| Spec fetching | `src/watcher.mjs:10` is a bare `await fetch(url)`. No timeout, no retry, no size cap, no conditional request, no auth header. |
| Large specs | Measured against the GitHub spec `watch.yaml:12` suggests: 12.9 MB raw, 6.9 MB as parsed JSON, 815 paths. `resolveRefs` inlines it to **111.5 MB** serialized at 792 MB RSS. That file is what `store.write` (`store.mjs:81-86`) puts in `.sma/specs/github.json` — the file the README tells you to commit, every day. |
| Test coverage of the write path | `test/` now covers `watcher.mjs` and `repair.mjs` as well as `diff`, `impact`, `inventory` and `store`. `pr.mjs` and `sma.mjs` are still untested — pushing, committing and the command wiring have no regression net. |
| Test suite stability | `npm test` OOM-crashed `test/inventory.test.mjs` once during this review (`FATAL ERROR: Zone Allocation failed - process out of memory`, 23 of the then-30 tests reported) and passed four subsequent times. `scan()` builds a new ts-morph `Project` per call (`inventory.mjs:16`); measured RSS climbs 197 MB → 448 MB across the seven scans that file performs. |
| Concurrency | Nothing locks `.sma/` or the target repo. `sma.mjs:23` stamps runs to the second. |
| Observability | `store.appendRun` is called in exactly one place, `sma.mjs:203`, inside `fix()`. A run that found nothing, failed to fetch, or ran without `--fix` leaves no entry in `runs.json`. |
| Machine-readable output | `impact.mjs:67-78` returns text. `.sma/impact/<stamp>.json` exists on disk but no command emits JSON to stdout and there is no SARIF. |
| Forge portability | `pr.mjs:72` pushes to a literal `origin`; `pr.mjs:75` shells to `gh`. |
| Release metadata | `package.json` `repository`, `bugs` and `homepage` point at `github.com/ayush/self-maintaining-api`; the actual remote is `git@github.com:GlaDrancE/self-maintaining-api.git`. `SECURITY.md` repeats the wrong URL. `git tag -l` is empty — there is no `v1.0.0` tag, so the new `release.yml` has never fired. |
| The repo's own scheduled job | `.github/workflows/sma.yml:63` runs `node sma.mjs run` against a `watch.yaml` that names `repo: ./demo/demo-app` — a directory that is now gitignored and only exists after `npm run demo:setup`, which `sma.yml` does not run. `loadConfig` (`store.mjs:71`) throws `repo not found` and the job exits 2. Even past that, `watch.yaml:6` points at `http://localhost:8787`, which nothing serves in Actions. |

### Fixed since this review

Two of the rows above have since been closed. They are kept here so the gap and
its resolution stay on the same page.

| Part | Was | Now |
|---|---|---|
| The baseline write ordering | `check()` saved the new snapshot before classification ran, so any failure after that line lost the change permanently. | `watcher.saveSnapshot()` runs only after `classify()` returns. A classifier failure leaves the old baseline on disk and the change is reported again next run. The first-run branch still saves immediately — there is nothing to lose. |
| Verification completeness | `finish()` collected changed files with `git diff --name-only`, which lists no untracked files, while `pr.mjs` committed with `git add -A`. A file the agent *created* was never scope-checked and still landed in the PR. | `finish()` calls `touchedFiles()`, which reads `git status --porcelain --untracked-files=all`. Created files are counted, scope-checked, and can trigger `needs-human`. `diffstat` stages first, so they appear in the stat too. `test/repair.test.mjs` covers creation, a new directory, and a rename. |

## Gap analysis

Gaps 1 and 2 are closed. They keep their numbers, in a table of their own, so
every reference elsewhere still resolves and the history stays readable.

| # | Gap | Risk it carried | How it was closed |
|---|---|---|---|
| 1 | Baseline advances before the change is acted on | Silent permanent miss. A network blip in `classify` or a malformed LLM response meant tomorrow diffed against the already-updated snapshot and the breaking change was never reported again. The failure mode the README warns about, inverted. | `check()` saves the snapshot after `classify()` returns, not before. The first-run branch is unchanged. |
| 3 | Unbounded spec fetch | A hung connection hung CI; a 429 failed the run. | `AbortSignal.timeout(60s)`; 429 and 5xx retried three times honouring `Retry-After`. Tested against a local server that returns 503 first. Size cap still open. |
| 6 | No auth for private specs | Could not watch any spec behind a token. | `apis[].headers` with `${VAR}` expanded from the environment at fetch time; an unset variable is a named error. |
| 7 | Secrets leak through the spec URL | `?token=` landed in PR bodies. | `redact()` masks credential-looking query values in fetch errors, the PR body and the HTML report. |
| 10 | Unbounded test run | A hung suite hung the job. | `timeout` on the spawn (10 min); a timeout is a failed test, so `needs-human`. The agent spawn has a 15-min timeout too (half of gap 9). |
| 14 | Exit codes collapse in CI | 1 and 2 looked identical. | `sma.yml` captures the real code into `$GITHUB_OUTPUT`, annotates which it was, and re-exits with it. |
| — | Porcelain parse dropped into filenames | Found by running the demo: every modified tracked file after the first was reported as `M path`, so a correct repair was labelled `needs-human`. | `touchedFiles()` matches optional leading space plus 1–2 status chars. Regression test fails on the old regex. |
| 2 | Agent-created files escape scope verification but are committed | An unreviewed new file shipped in a PR labelled clean. The `needs-human` label is the whole trust model and this path bypassed it. | `finish()` uses `touchedFiles()` — `git status --porcelain --untracked-files=all` — so created files are scope-checked. `diffstat` stages before reading `git diff --cached --stat`. |

The rest are open.

| # | Gap | Evidence | Risk if unaddressed | Proposed fix | Effort |
|---|---|---|---|---|---|
| 4 | Inlined specs are enormous | `watcher.mjs:31-53`; measured 111.5 MB for the GitHub spec | 111 MB rewritten into git history daily. Repository bloat, slow clones, and a `git diff` no human can read — while the README's selling point is that `git log .sma/specs/stripe.json` is useful. | Snapshot the *raw* spec, not the inlined one, and inline in memory at compare time. Alternatively store a normalized digest per operation. Either way, cap the on-disk baseline and refuse a spec above the cap with a clear error. | M |
| 5 | `$ref` fan-out multiplies findings | `watcher.mjs:31-53`; `classify.mjs:12-17` already ignores `/components/schemas` *because* it is inlined elsewhere | One field removed from a shared schema becomes one rule hit per referencing operation. On an 815-path spec the report is unreadable. `repairable()` (`impact.mjs:48-64`) groups for the repair path only; `report()` does not. | Group `report()` output by `rule` + subject the same way `repairable()` does, and print an endpoint count instead of one line per operation. | S |
| 8 | No cost ceiling on the LLM pass | `classify.mjs:65-70` — one call, `max_tokens: 8000`, no timeout, no retry, whole delta list inlined at `classify.mjs:62` | A large spec diff produces a very large prompt; nothing bounds it. Default model is `claude-opus-5` (`classify.mjs:7`), not the `claude-sonnet-5` PLAN.md line 72 specified for a yes/no verdict. | Cap the leftover-delta count and truncate with a stated "N not reviewed"; switch the default to the cheaper model; record input/output tokens from the response into the run log. | S |
| 9 | No cost or time ceiling on the repair agent | `sma.mjs:187-190` spawns one agent per repairable group; `repair.mjs:54-59` has no timeout | One spec bump with many affected groups fans out to many unbounded agent runs. Cost is invisible until the bill. | `--max-agents <n>` defaulting to something small, a per-agent `timeout` on `spawnSync`, and a printed count before starting. | S |
| 11 | No locking | `sma.mjs:23` (second-resolution stamp); nothing guards `.sma/` or the repo | Two overlapping runs share a target worktree. `startSession` checks out a branch the other run is editing. Corrupt PRs, lost edits. | An exclusive lockfile at `.sma/lock` written with `wx`, containing pid and start time; refuse with exit 2 and a clear message if held. In CI, a `concurrency:` group as well — `pages.yml:17-19` already does this correctly and `sma.yml` does not. | S |
| 12 | Run log records almost nothing | `sma.mjs:203-211`; `appendRun` called only from `fix()` | No history of clean runs, fetch failures, LLM spend, or durations. You cannot answer "has this ever produced a false positive" from the artifacts. | Append one entry per run from `run()`, always: timestamp, command, per-API fetch status and byte count, change counts by severity, leftover count, tokens, agent count, duration, exit code. | S |
| 13 | No machine-readable output | `impact.mjs:67-78` | CI can only read the exit code. No way to annotate a PR, feed a dashboard, or assert on results in a test. | `--json` on `check` and `impact`, printing the same objects already written under `.sma/`. SARIF for `impact` after that, so GitHub code scanning can render call sites inline. | M |
| 15 | The repo's own daily job cannot pass | `sma.yml:63`, `watch.yaml:2` (`repo: ./demo/demo-app`, now gitignored and generated), `watch.yaml:6` (`localhost`) | Broken-window signal on your own dogfood project; you learn to ignore a red badge. | Give the repository a `watch.yaml` that names a real public spec and `repo: .`, and keep the demo config under `demo/` for `--config`. | S |
| 16 | Untracked write paths | `test/watcher.test.mjs` and `test/repair.test.mjs` now cover spec-path resolution and `touchedFiles()` against a temp git repo; no tests for `pr.mjs` or `sma.mjs` | The modules that push, commit and wire the commands still have no regression net. | Unit-test `resolveRefs` (circular, missing target, deep nesting) and `buildPrompt`/`prBody` as pure functions. No mocking framework needed. | S |
| 17 | Flaky test suite under memory pressure | observed OOM in `test/inventory.test.mjs`; `inventory.mjs:16` builds a `Project` per `scan()` | Three gates now depend on this suite: `ci.yml` on every push and PR across four matrix legs, `release.yml` before every publish, and `prepublishOnly`. A random OOM blocks all of them, and on a red release you will be tempted to retry rather than diagnose. | Build the `Project` once per test file and reuse it, or run `scan()` once and assert against the single result. | S |
| 18 | SDK matching is a substring test | `impact.mjs:29-33` | False positives: an `operationId` of `get` matches every chain. False negatives on any hand-written SDK. | Require the `operationId` to match a whole segment of the chain, and allow an explicit `operations:` name map in `watch.yaml`. | M |
| 19 | GitHub-only publishing | `pr.mjs:72,75` | No GitLab, no Gitea, no non-`origin` remote. | Extract the two calls behind a small `forge` object; add a `push` branch that stops after the commit and prints the branch name for any other forge. | M |
| 20 | Release metadata names the wrong repository | `package.json` `repository`/`bugs`/`homepage` and `SECURITY.md` say `github.com/ayush/...`; the remote is `github.com/GlaDrancE/...`. `git tag -l` is empty. | Provenance attests the source repository, so a mismatched `repository` field either fails the publish or attests something that is not yours. The security contact link 404s. | Fix the URLs everywhere, then tag `v1.0.0` at `d07fc8d` so `release.yml` runs once under observation. The workflow itself now exists and is correct: tag-triggered, `id-token: write`, `npm test` before `npm publish`. | S |
| 21 | `watch.yaml` is executable config | `repair.mjs:67` runs `cfg.test` through a shell | A repo whose `watch.yaml` you did not write runs arbitrary commands. Acceptable for your own repos; must be stated before anyone else's. | Document it as a trust boundary in the README. Refuse `test:` from a config outside the repo root if that ever becomes a real scenario. | S |
| 22 | No `sma check` timeout budget overall | measured: GitHub spec fetch + parse took 14.2 s, `resolveRefs` 1.0 s, full-spec diff 1.7 s | Per-API cost is seconds today, but nothing bounds the total when several large APIs are watched. | Report per-API elapsed time in the run log (gap 12) before adding any limit. | S |

## Phases

Phases advance on exit criteria, not dates. Do not start a phase until the
previous one's boxes are all ticked.

### Phase 0 — harden

Make the tool safe to point at something you care about.

Scope: gaps 3, 10, 11, 14, 17. Gaps 1 and 2 are done.

Exit criteria:

- [x] A crash injected between the fetch and the end of `check` leaves the old
      baseline on disk, and the next run still detects the change.
- [x] An agent that creates a new file produces a PR labelled `needs-human`.
- [ ] A spec URL that never responds fails the run in under a minute with an
      error naming the API.
- [ ] A second `sma run` started while one is in flight exits 2 with a lock
      message and touches nothing.
- [ ] `npm test` passes twenty consecutive times.
- [ ] A workflow run where sma itself fails is distinguishable, from the logs
      alone, from one where an API broke the repo.

### Phase 1 — self-hosting

Run sma against this repository, watching a real public spec, from CI.

Scope: gaps 6, 7, 8, 12, 15. Plus the dogfood loop in `pilot-plan.md`.

Exit criteria:

- [ ] `watch.yaml` in this repo names at least one real, remote, frequently
      changing spec, and the scheduled workflow is green.
- [ ] `.sma/runs.json` has an entry for every scheduled run over four
      consecutive weeks, including the ones that found nothing.
- [ ] At least one genuine upstream change was detected, and the observation log
      in `pilot-plan.md` records whether it was a true positive.
- [ ] A PR body has been read and contains no secret-bearing URL.
- [ ] The cost of a report-only run is known from the run log, not estimated.

### Phase 2 — multi-project

Three of your own repositories onboarded through
`onboarding-a-project.md`, at least one of them in `--fix` mode.

Scope: gaps 4, 5, 13, 18. Whatever the pilot log says hurt most.

Exit criteria:

- [ ] Three repos onboarded; each has a committed baseline and a green
      scheduled run.
- [ ] At least one merged PR that sma opened, where the diff was correct without
      human edits.
- [ ] The false-positive rate over the pilot log is written down.
- [ ] A baseline for the largest watched spec is small enough to `git diff` by
      eye.
- [ ] Onboarding repo number three took under thirty minutes using the
      checklist, with no undocumented step.

### Phase 3 — public release

Scope: gaps 16, 19, 20, 21.

Exit criteria:

- [ ] `release.yml` has published at least once, from a tag, with provenance, and
      the published metadata names the real repository.
- [ ] `CHANGELOG.md` has an entry for every released version, written before
      the tag.
- [ ] Every module has at least one test; the ones that spawn processes have
      tests that spawn processes.
- [ ] The README's "What it does not do" list matches the code, re-checked.
- [ ] A stranger following the README on a fresh machine reaches a committed
      baseline without asking you anything.

## Hardening topics, assessed

| Topic | Where it stands | What to do |
|---|---|---|
| Fetch timeouts | None. `watcher.mjs:10`. | Gap 3. |
| Retries | None. Any non-2xx throws at `watcher.mjs:19`. | Gap 3. Honour `Retry-After`. |
| Rate limits | Unauthenticated `raw.githubusercontent.com` requests are rate-limited by IP; a 429 currently reads as a hard failure. | Gap 3, plus conditional requests (`If-None-Match` against a stored ETag) so an unchanged spec costs one 304. |
| Large specs | Measured: 12.9 MB raw → 111.5 MB inlined, 792 MB RSS. Works on a laptop with headroom; the committed artifact is the problem, not the compute. | Gap 4. |
| Authenticated specs | Unsupported. | Gap 6. |
| Secret handling | The spec URL is printed in three places and written to `.sma/pr/`. No other secret is read by sma itself; `ANTHROPIC_API_KEY` goes to the SDK (`classify.mjs:49`) and the `claude` CLI inherits the environment (`repair.mjs:54`). | Gap 7. Also: the agent runs with the parent environment, so it can read `.env` in the target repo via `Read`. Say so in the README. |
| Agent cost control | None. One agent per repairable group, no timeout, no cap, no accounting. | Gaps 8, 9. |
| Token spend per run | Not recorded anywhere. | Gap 12 — log `usage` from the classifier response; the CLI agent's spend has to be read from your Anthropic console until the CLI reports it. |
| Concurrency and locking | None. | Gap 11. |
| Observability | `.sma/` holds `changes/`, `impact/`, `prompts/`, `pr/`, `inventory.json`, `runs.json`. `runs.json` is written only on a repair. | Gap 12. |
| Structured output | `.sma/impact/<stamp>.json` on disk; nothing on stdout. | Gap 13. |
| Non-GitHub forges | `gh` and `origin` hardcoded. | Gap 19. |
| Supply chain | `package-lock.json` is committed. Three runtime dependencies. `prepublishOnly: npm test`. `release.yml` publishes only from a `v*` tag with `id-token: write` and runs the tests first. `ci.yml` tests ubuntu and windows on node 22 and 24. No tag has been pushed, so none of it has run. | Gap 20. Add `npm audit --omit=dev` to `ci.yml` and pin third-party Actions by SHA. |

## Release engineering

**Versioning.** Semver against the CLI's observable contract: command names,
flags, exit codes, the shape of `.sma/*.json`, and the rule identifiers. A new
rule is a minor. Changing the severity of an existing rule, renaming a rule, or
changing the on-disk snapshot format is a major, because a committed baseline
written by the previous version must still be readable — or the upgrade silently
becomes a first run, which is the failure the README already calls out.

**Changelog.** `CHANGELOG.md` exists and follows Keep a Changelog. Keep the
discipline: every user-visible change lands in `## [Unreleased]` in the same
commit that makes it, and the release commit only renames that heading and adds
the compare link. The 1.0.0 entry is a good model — it describes behaviour, not
diffs.

**Publishing.** `.github/workflows/release.yml` does the right thing: `v*` tag
trigger, `id-token: write` for provenance, `npm ci` and `npm test` before
`npm publish`. Two things remain. Fix the `repository`, `bugs` and `homepage`
URLs in `package.json` and the advisory link in `SECURITY.md` to the real remote
— provenance attests the source repository, so a mismatch is not cosmetic. Then
tag `v1.0.0` at `d07fc8d` and watch that first run, because it is also the first
time the flaky suite (gap 17) stands between you and a release.

**What "supported" means.** State it in the README before anyone else installs:

- Node 22 and later, on Linux, macOS and Windows. Windows is a first-class target
  — `store.mjs:40-45` exists because of it.
- Target repos in JavaScript and TypeScript. One repo per `watch.yaml`.
- OpenAPI 3.x documents that parse as JSON or YAML.
- Detection is supported without any API key. Repair is best-effort and always
  produces a reviewable PR, never a merge.
- The latest minor only. Security fixes are not backported.

## Non-goals

Inherited from the README's "What it does not do", plus PLAN.md's
"Deliberately skipped". These are settled; reopening one needs a reason written
down first.

- **No auto-merge, ever.** The human reviewing the PR is the safety model.
- **No call graph.** One hop out from the request, and no further.
- **No lexical rename inference.** One parameter out, one in, same location and
  type, or it is reported as a removal plus an addition.
- **No general SDK support.** `operationId` in the method chain, and a name map
  if that is not enough.
- **No changelog or HTML scraping.** Spec diffing where a spec exists.
- **No web dashboard.** The PR is the UI. `site/` is a landing page, not a
  console.
- **No database.** JSON under `.sma/`, as `store.mjs:2` says.
- **No multi-language inventory.** JS and TS only.
- **No semantic or embedding-based code search.** AST resolution is exact.
- **No sub-cron freshness.** Detection is as fresh as the schedule.
