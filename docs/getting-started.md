# Getting started

## Requirements

Node 22 or newer. `package.json` declares `"engines": { "node": ">=22" }`, and
`sma doctor` fails the node row below 22. The code relies on native `fetch` and
`node --test`.

Nothing else is required to detect changes. Git, the `claude` CLI, `gh` and an
Anthropic API key each unlock a later stage; see
[the degradation table](#what-you-need-and-when).

## Install

```bash
npm i -D self-maintaining-api
```

Or globally:

```bash
npm i -g self-maintaining-api
```

The package exposes one binary, `sma`. In a project install, run it through
`npx sma`.

## `sma init` has two modes

`init` behaves differently depending on whether a config already exists. Read
`store.hasConfig()` in `sma.mjs` for the exact branch.

**Mode 1 — no `watch.yaml` found.** It writes a commented template `watch.yaml`,
appends the sma block to `.gitignore` if it is missing, and stops. It does not
fetch anything, because there is nothing configured to fetch.

```
updated /path/to/project/.gitignore
wrote /path/to/project/watch.yaml

Next: uncomment an api (or add your own), then run `sma init` again to capture the baseline.
```

The template it writes has every API commented out. Running `init` again before
you add one fails with ``watch.yaml: `apis` is empty``.

**Mode 2 — a `watch.yaml` already exists.** It runs `sma check`, which fetches
every configured spec and writes the first snapshot, then prints the baseline
reminder.

```
using /path/to/project/watch.yaml
petstore: baseline captured (3 endpoints) — commit .sma/specs/petstore.json

Baseline captured. There is nothing to compare against yet — the NEXT run is the one that detects changes.
Commit .sma/specs/ so future runs have something to diff against.
```

Mode 2 is the common one in practice. `watch.yaml` is a CI file like any other,
so most people write it by hand and never see mode 1.

## Commit `.sma/specs/`

This is the step that decides whether sma works at all.

```bash
git add .sma/specs && git commit -m "chore: sma baseline"
```

`.sma/specs/<name>.json` is the resolved spec as it looked the last time sma ran.
Every detection is a diff against that file. `sma init` deliberately leaves it
out of the `.gitignore` block it writes — every other path under `.sma/` is
ignored, `specs/` is not.

If the baseline is lost — never committed, cached in CI and evicted, deleted by
`sma reset` — then `watcher.loadSnapshot()` returns `null`, `check` takes the
`if (!previous)` branch, prints `baseline captured`, and exits 0. It reports
success while detecting nothing. There is no error, no warning, and no way to
notice from the exit code. That is the failure mode the committed baseline
exists to prevent.

The `.gitignore` block `init` writes:

```
# sma: per-run artifacts. .sma/specs/ is deliberately NOT ignored — it is the
# baseline every future run diffs against, and it belongs in version control.
.sma/changes/
.sma/impact/
.sma/prompts/
.sma/pr/
.sma/runs.json
.sma/inventory.json
```

## First real detection

With the baseline committed, the next run is the first that can find anything:

```bash
npx sma run
```

`run` calls `scan`, then `check`, then `impact`, and stops there unless you pass
`--fix`. Exit code 1 means a breaking change reached call sites in this repo;
exit 0 means it did not.

## Worked example: the bundled petstore demo

The repository ships a fake upstream API with a real v1 → v2 breaking release,
plus a small app that consumes it. Run this from the repository root.

### 1. Start the fake upstream

```bash
npm install
node demo/petstore/server.mjs &
```

It listens on `http://localhost:8787` and serves whichever spec version
`demo/petstore/ACTIVE` names. It reads that file on every request, so version
flips need no restart.

```
petstore (v1) on http://localhost:8787
```

### 2. Look at the config

`watch.yaml` in the repository root:

```yaml
repo: ./demo/demo-app

apis:
  - name: petstore
    spec: http://localhost:8787/openapi.json
    baseUrl: http://localhost:8787
```

### 3. Scan the consuming repo

```bash
node sma.mjs scan
```

```
8 call site(s) across 3 file(s)
  src/pets.js:4  GET /pets
  src/pets.js:9  GET /pets/{}
  src/pets.js:14  POST /pets
  src/report.js:7  GET /pets/{}
  test/api.test.mjs:16  GET /pets
  test/api.test.mjs:22  GET /pets/{}
  test/api.test.mjs:32  POST /pets
  test/api.test.mjs:28  GET /pets/{}
```

Three of those are `fetch` calls. The four in `test/api.test.mjs` are one-hop
callers: the test never calls `fetch`, it calls `listPets()`, `getPet()` and
`createPet()`, and the scanner attributes each to the endpoint the wrapper
reaches. `src/report.js:7` is a second independent `fetch` for the same endpoint.

### 4. Check against the baseline

The repository ships a committed baseline at v1, so the first check finds
nothing:

```bash
node sma.mjs check --no-llm
```

```
petstore: 0 change(s), 0 breaking
```

Exit code 0.

### 5. Ship the breaking release

```bash
echo v2 > demo/petstore/ACTIVE
node sma.mjs check --no-llm
```

```
petstore: 6 change(s), 5 breaking

wrote /path/to/repo/.sma/changes/20260911114310.json
```

Exit code 1. The filename is a `YYYYMMDDHHMMSS` stamp taken once per process.

### 6. Map the changes onto the code

```bash
node sma.mjs impact
```

```
[breaking] PARAM_RENAMED  GET /pets
    query parameter 'limit' was renamed to 'pageSize'
    -> src/pets.js:4  fetch(`${BASE}/pets?limit=${limit}`)
    -> test/api.test.mjs:16  const pets = await listPets(2)
[breaking] RESPONSE_FIELD_REMOVED  GET /pets
    response field 'tag' was removed
    -> src/pets.js:4  fetch(`${BASE}/pets?limit=${limit}`)
    -> test/api.test.mjs:16  const pets = await listPets(2)
[breaking] REQUIRED_PARAM_ADDED  POST /pets
    new required body parameter 'ownerId'
    -> src/pets.js:14  fetch(`${BASE}/pets`, {
    -> test/api.test.mjs:32  const pet = await createPet('Nix', 'ferret')
[breaking] RESPONSE_FIELD_REMOVED  POST /pets
    response field 'tag' was removed
    -> src/pets.js:14  fetch(`${BASE}/pets`, {
    -> test/api.test.mjs:32  const pet = await createPet('Nix', 'ferret')
[breaking] RESPONSE_FIELD_REMOVED  GET /pets/{id}
    response field 'tag' was removed
    -> src/pets.js:9  fetch(`${BASE}/pets/${id}`)
    -> src/report.js:7  fetch(`${BASE}/pets/${id}`)
    -> test/api.test.mjs:22  const pet = await getPet(1)
    -> test/api.test.mjs:28  assert.equal(await petSummary(2), '#2 Mia (cat) [pending]')
[safe] PATH_ADDED  /pets/{id}/owner
    new endpoint /pets/{id}/owner
    -> not affected (no call sites in this repo)

3 breaking change(s) with call sites in this repo.
```

Exit code 1.

### 7. Read the output

- The severity in brackets comes from the rule table in `src/rules.mjs`. See
  [rules.md](rules.md).
- Findings are sorted `breaking`, `unknown`, `warning`, `safe`.
- A `->` line is a call site: `file:line` plus the first 120 characters of the
  first line of the matched expression.
- `not affected (no call sites in this repo)` means the change was detected but
  nothing here calls that endpoint. Unused changes are reported, not dropped —
  that is how you tell the mapper is matching rather than guessing.
- The trailing count is **not** the number of breaking findings. It is the number
  of *repair groups*: five breaking findings collapse to three because the same
  `RESPONSE_FIELD_REMOVED` on field `tag` appears on three operations and is
  grouped into one repair. See [how-it-works.md](how-it-works.md#6-the-impact-join).

### 8. Patch it

```bash
node sma.mjs fix
```

This requires the `claude` CLI on `PATH` and a clean git working tree inside
`demo/demo-app`. It creates a branch `sma/petstore-<stamp>`, runs one agent per
repair group, runs `npm test` in the consuming repo itself, commits, and either
opens a PR with `gh` or writes the PR body to `.sma/pr/`.

### 9. Put the demo back

```bash
echo v1 > demo/petstore/ACTIVE
git checkout -- .sma/specs
```

## What you need, and when

`sma doctor` prints this for your machine. Nothing below the first two rows can
block detection.

| Layer | Needs | Without it |
|---|---|---|
| Detect: fetch, diff, rules | node 22+, a `watch.yaml` | detection is blocked; `doctor` exits 2 |
| Impact: AST scan | bundled (`ts-morph`) | — |
| Judge unmodelled deltas | `ANTHROPIC_API_KEY` | they are reported as `UNCLASSIFIED`; rules still apply |
| Repair | `claude` CLI, `git` | `fix` throws and exits 2; you get the report |
| Open the PR | `gh`, `GH_TOKEN`/`GITHUB_TOKEN` | the PR body is written to `.sma/pr/` and the path is printed |

## Next

- [configuration.md](configuration.md) — every `watch.yaml` key.
- [cli.md](cli.md) — every command.
- [ci.md](ci.md) — run it on a schedule.
