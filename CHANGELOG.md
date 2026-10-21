# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.1] - 2026-10-21

### Fixed

- A repair agent that failed to run (bad `ANTHROPIC_API_KEY`, no credit) was
  reported only as "the agent made no edits". Its error is now printed.

## [1.1.0] - 2026-10-21

### Added

- `sma diff <old> <new>` classifies the changes between any two spec files or
  URLs, with no config, baseline or repo. `--json` prints them as data.
- `sma report` renders the latest findings, call sites and repair runs into one
  self-contained `.sma/report.html`. `sma run` writes it at the end of every run,
  and the workflow uploads it as an artifact.
- `apis[].headers` sends headers with the spec request. `${VAR}` is read from the
  environment, so private specs can be watched without writing the token to disk.
- `npm run demo:real` replays a real breaking change from OpenAI's published spec
  (commit `d9c3021a`, 2023-06-19) against a small app.
- `docs/market-research.md`: who publishes specs, what already exists, and where
  sma fits.

### Fixed

- `sma run --fix` always failed with "uncommitted changes" when sma lived inside
  the repo it patches (`repo: .`, the documented install): `check` had just written
  the new baseline to `.sma/specs/`. A baseline-only diff is now committed on the
  base branch before branching; any other dirty file still refuses.
- OpenAPI 3.1 `type: ["string", "null"]` was reported as `*_TYPE_CHANGED` on every
  run, because arrays were compared by reference. Found on api.weather.gov.
- Every modified file after the first was reported to the scope check as
  `M path`, so a correct repair was labelled `needs-human`. Found by running the
  demo end to end.
- Top-level `x-*` vendor extensions are no longer reported as unclassified
  changes. On OpenAI's real spec they were 4 of 9 findings.
- Spec fetches time out after 60s and retry 429/5xx up to three times. The repair
  agent (15 min) and the test run (10 min) have timeouts too.
- Credential-looking query values in a spec URL are masked in errors, PR bodies
  and the report.
- The CI workflow keeps the real exit code, so "an API broke you" (1) can be told
  apart from "sma failed" (2).

- `sma check` no longer advances the spec baseline when classification fails. A
  network blip used to record the new spec as already seen, and the change was
  never reported again.
- Files the repair agent creates now count as changes. A repair written as a new
  module used to be discarded as "the agent made no edits", or committed into
  the PR without ever being scope-checked against the predicted impact.
- Adding a new authentication scheme to a spec is no longer reported as
  breaking. It claimed every call site of the API and opened a PR rewriting
  auth everywhere. Removing or changing an existing scheme still is.
- A relative local `spec:` path now resolves against `watch.yaml` instead of the
  working directory, so `--config` from another directory no longer fails with
  `ENOENT`.
- A missing `gh` CLI is reported as such instead of `gh pr create failed:
  undefined`, and the note says the branch is already pushed and where the PR
  body was written.

## [1.0.0] - 2026-08-30

First release.

### Added

- `sma check` — fetch each watched OpenAPI spec, inline local `$ref`s, diff it
  against the committed `.sma/specs/` baseline, and classify every delta.
- A deterministic rule table — 11 breaking rules (path/method removal, parameter
  added-required, renamed, retyped, removed or made required, response field
  removed or retyped, enum value removed, auth scheme changed), 1 warning and
  5 safe. No LLM is involved in detection.
- Optional LLM second pass for deltas no rule models, gated behind
  `ANTHROPIC_API_KEY` and skippable with `--no-llm`. Verdicts below a 0.7
  confidence floor are reported, never auto-patched.
- `sma scan` — ts-morph AST inventory of call sites: `fetch`/axios/got/ky/request
  requests, generated-SDK method chains, and one hop of callers around each.
  Unresolvable runtime URLs are reported, not dropped.
- `sma impact` — joins changes to call sites by path shape and method, so a
  breaking change nobody calls is reported as not-affected instead of as work.
- `sma fix` — hands each breaking-and-used change to a headless Claude Code agent
  with Read/Edit/Write/Glob/Grep and no shell, one branch per API, then runs the
  test suite itself and opens a PR via `gh` (labelled `needs-human` when tests
  fail or the diff strays outside the predicted impact). Never merges.
- `sma init`, `sma doctor`, `sma reset`, `sma run [--fix]`, `--config <path>`.
- Distinct exit codes: `0` clear, `1` a breaking change reached this repo,
  `2` sma itself failed.
- Local petstore demo (`npm run petstore`) with v1/v2 specs and a demo app.
- Scheduled GitHub Actions workflow that self-tests, checks, patches and commits
  the new spec baseline.

[Unreleased]: https://github.com/GlaDrancE/self-maintaining-api/compare/v1.1.1...HEAD
[1.1.1]: https://github.com/GlaDrancE/self-maintaining-api/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/GlaDrancE/self-maintaining-api/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/GlaDrancE/self-maintaining-api/releases/tag/v1.0.0
