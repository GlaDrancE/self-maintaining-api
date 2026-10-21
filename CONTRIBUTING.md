# Contributing

## Setup

```bash
git clone https://github.com/GlaDrancE/self-maintaining-api
cd self-maintaining-api
npm install          # node 22+ required: native fetch and node --test
node sma.mjs doctor  # tells you what is missing and what each miss costs
```

## Run the demo

The demo is a local petstore whose spec changes under you.

```bash
npm run petstore                   # terminal 1: the fake upstream API
node sma.mjs run                   # terminal 2: first run records the baseline
echo v2 > demo/petstore/ACTIVE     # upstream ships a breaking release (no restart)
node sma.mjs run                   # detects it, maps it to call sites, reports
```

Add `--fix` to let the repair agent patch `demo/demo-app` and open a PR.
`sma reset` forgets every snapshot and starts over.

## Tests

```bash
npm test    # node --test test/*.test.mjs — 44 tests, no framework, no network
```

Tests run against `demo/petstore/openapi.v1.json` / `.v2.json`,
`test/fixtures/repo`, and temp directories they create themselves, so they never
depend on a live API or on whatever state the demo app is in. `git` on PATH is
the only external requirement — `test/repair.test.mjs` drives a throwaway repo.

## Design principles

These are not aspirations; they are what the code already does, and a PR that
breaks one of them will be sent back.

- **Deterministic by default.** The rule engine in `src/rules.mjs` classifies
  changes with no model call. The LLM is a second pass over the leftovers only,
  and `--no-llm` must always remain a fully working path.
- **Low confidence never auto-patches.** LLM verdicts below `CONFIDENCE_FLOOR`
  are reported, not acted on.
- **Exact assertions, no false positives.** `test/diff.test.mjs` asserts the
  precise set of rule hits for the v1→v2 diff. A new rule means updating that set
  — and proving it does not also fire on unrelated deltas. Over-reporting is the
  failure mode this project cares about most.
- **The harness verifies, the agent does not.** The repair agent gets edit tools
  and no shell. Tests are run by `src/repair.mjs`, and a PR is opened but never
  merged.
- **Minimal dependencies.** Three runtime deps (`@anthropic-ai/sdk`, `ts-morph`,
  `yaml`) and zero dev deps. Adding a fourth needs a real argument; a linter,
  formatter, build step or test framework will be declined.
- **Comments explain why, not what.** Most non-obvious lines here carry the
  reason they exist. Match that voice.

## A good PR

- One concern. A rule fix and a scanner fix are two PRs.
- A test that fails without the change. For a new rule, that means adding the
  delta to the petstore specs and the expected hit to `EXPECTED`.
- `npm test` green on node 22 and 24, Linux and Windows (CI checks all four).
- No new dependency, no reformatting, no drive-by refactors.
- A `CHANGELOG.md` entry under `## [Unreleased]` for anything user-visible.
- If you deliberately cut a corner, mark it with a `ponytail:` comment naming the
  ceiling and the upgrade path, as the existing ones do.
