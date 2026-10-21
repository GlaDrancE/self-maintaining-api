# CLI reference

```
sma <command> [flags]
```

The command is the first argument. Anything after it starting with `--` is
collected into a flag set. An unrecognised command prints the help text and
exits 0.

## Global flags

| Flag | Effect |
|---|---|
| `--no-llm` | Skip the LLM fallback. Unmodelled deltas become `UNCLASSIFIED`. Read by `check`, and by `run` because it calls `check`. |
| `--config <path>` | Use this `watch.yaml`. Highest-precedence config source. |
| `--fix` | Only meaningful on `run`. Makes it continue into `fix`. |

Flag position: `--config` is found by scanning the whole `process.argv`, so it
works anywhere on the line. `--no-llm` and `--fix` are only collected from the
arguments *after* the command name, so they must be written after it.

```bash
sma run --no-llm --config ./ci/watch.yaml    # correct
sma --no-llm run                             # --no-llm is ignored
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Nothing broken |
| `1` | A breaking change reached this repo |
| `2` | sma itself failed — bad config, network, missing prerequisite |

Any thrown error is caught at the top of `sma.mjs`, printed as `error: <message>`
and exits 2.

---

## `sma init`

```
sma init [--config <path>]
```

Two modes, chosen on whether the resolved config file exists.

**Reads:** `watch.yaml` if present, `.gitignore` at the config's directory.
**Writes:** `watch.yaml` (mode 1 only), `.gitignore` (both, if the sma block is
missing), `.sma/specs/<name>.json` and `.sma/changes/<stamp>.json` (mode 2).

Mode 1, no config:

```
updated /path/to/project/.gitignore
wrote /path/to/project/watch.yaml

Next: uncomment an api (or add your own), then run `sma init` again to capture the baseline.
```

Mode 2, config present — it runs `check` and then prints the baseline reminder:

```
using /path/to/project/watch.yaml
petstore: baseline captured (3 endpoints) — commit .sma/specs/petstore.json

Baseline captured. There is nothing to compare against yet — the NEXT run is the one that detects changes.
Commit .sma/specs/ so future runs have something to diff against.
```

**Exit codes:** 0 on success in both modes. Mode 2 explicitly resets the exit
code to 0 after `check`, so an `init` on an already-baselined project that finds
breaking changes still exits 0. 2 on any config or fetch error.

The template written in mode 1 has every API commented out, so running `init` a
second time without editing it fails with ``watch.yaml: `apis` is empty``.

---

## `sma doctor`

```
sma doctor
```

Reports what is installed and what each missing piece costs. Probes by running
`<cmd> --version` through a shell and checking for exit 0.

**Reads:** `process.versions.node`, the config path, `git --version`,
`claude --version`, `gh --version`, `ANTHROPIC_API_KEY`, `GH_TOKEN` or
`GITHUB_TOKEN`.
**Writes:** nothing.

```
  sma 1.0.0
  ok    node 24.0.0
  ok    config /path/to/project/watch.yaml
  ok    git
  MISS  ANTHROPIC_API_KEY
          without it: unmodelled deltas are reported as UNCLASSIFIED instead of judged
  ok    claude CLI
  ok    gh CLI
  MISS  GH_TOKEN
          without it: `gh` cannot open the PR

Detection works. Anything missing above only limits repair, never detection.
```

**Exit codes:** 2 if node is below 22 or no config was found — those two block
detection. 0 otherwise, however many other rows say `MISS`.

`doctor` does not parse or validate `watch.yaml`. It only checks the file exists.

---

## `sma scan`

```
sma scan [--config <path>]
```

Walks the target repo's AST with `ts-morph` and records every call site for the
watched APIs, plus one hop of callers.

**Reads:** `watch.yaml`, every `*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}` under
`repo`, excluding `node_modules`.
**Writes:** `.sma/inventory.json` — `{ scannedAt, sites, unresolved }`.

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

For an `sdk` site the second column is the method chain rather than a method and
path, because `s.method ?? s.symbol` is printed.

Requests whose URL cannot be resolved statically get their own block:

```
1 request(s) with a URL this scanner could not resolve statically:
  api.js:22  fetch(path)
```

**Exit codes:** 0, or 2 on a config error. `scan` never sets a non-zero exit code
of its own — an unparsable file is reported, not fatal.

---

## `sma check`

```
sma check [--no-llm] [--config <path>]
```

Fetches every configured spec, inlines local `$ref`s, diffs against the stored
snapshot, classifies each delta, then overwrites the snapshot.

**Reads:** `watch.yaml`, each `apis[].spec`, `.sma/specs/<name>.json`.
**Writes:** `.sma/specs/<name>.json` (once the delta has been classified, or
immediately on a first run), and `.sma/changes/<stamp>.json` (always, even when
empty).

First run for an API — no snapshot yet:

```
petstore: baseline captured (3 endpoints) — commit .sma/specs/petstore.json
```

Nothing changed:

```
petstore: 0 change(s), 0 breaking
```

Changes found:

```
petstore: 6 change(s), 5 breaking

wrote /path/to/repo/.sma/changes/20260911114310.json
```

With the LLM fallback active the line gains `, N LLM-reviewed`. Without an API
key, or with `--no-llm`, it gains `, N unclassified (no API key)` instead.

The changes file is written even when it is an empty array. Skipping the empty
ones would leave yesterday's file looking current, and `impact` — which reads the
newest file by filename sort — would re-report the same change every day.

The snapshot is saved only after `classify()` returns, so a failed classification
leaves the old baseline in place and the change is reported again on the next
run. A `check` that completes has advanced the baseline, so run it once per
intended comparison.

**Exit codes:** 1 if any change in any API is `breaking`, 0 otherwise, 2 on
error. `check` has no call-site knowledge, so every breaking change counts —
`impact` is what narrows this to changes that reach your code.

---

## `sma impact`

```
sma impact [--config <path>]
```

Joins the newest changes file against the inventory.

**Reads:** `watch.yaml`, `.sma/changes/<newest>.json`, `.sma/inventory.json`,
`.sma/specs/<name>.json` (for `operationId` lookup).
**Writes:** `.sma/impact/<stamp>.json`.

```
[breaking] PARAM_RENAMED  GET /pets
    query parameter 'limit' was renamed to 'pageSize'
    -> src/pets.js:4  fetch(`${BASE}/pets?limit=${limit}`)
    -> test/api.test.mjs:16  const pets = await listPets(2)
[safe] PATH_ADDED  /pets/{id}/owner
    new endpoint /pets/{id}/owner
    -> not affected (no call sites in this repo)

3 breaking change(s) with call sites in this repo.
```

Findings are sorted `breaking`, `unknown`, `warning`, `safe`. A change with no
endpoint prints `(whole spec)` where the method and path would go.

The trailing count is the number of repair *groups*, not the number of breaking
findings. One upstream edit that hits several operations collapses into one
group.

Preconditions, each of which prints a message and returns:

| Situation | Message |
|---|---|
| No `.sma/changes/` at all | `nothing checked yet — run \`sma check\` first` |
| Newest changes file is empty | `the latest check found no changes — nothing to map` |
| No `.sma/inventory.json` | `no inventory — run \`sma scan\` first` |

**Exit codes:** 1 if there is at least one repairable group, 0 otherwise
including all three precondition returns, 2 on error.

---

## `sma fix`

```
sma fix [--config <path>]
```

Hands every repairable group to a headless Claude Code run, verifies the result
independently, commits, and opens a PR.

**Reads:** `watch.yaml`, `.sma/impact/<stamp>.json` for the current run stamp —
and if that file does not exist, it runs `impact` itself first.
**Writes:** `.sma/prompts/<slug>.txt` per agent run, `.sma/pr/<branch>.md`,
`.sma/runs.json`. In the target repo: a branch `sma/<api>-<stamp>` and one
commit.

Because the stamp carries seconds, a standalone `sma fix` will almost always
miss the impact file a separate `sma impact` wrote and recompute it. Inside
`sma run --fix` both share one stamp, so the file is reused.

Preconditions:

- The `claude` CLI must be on `PATH`. Otherwise it throws:
  `the \`claude\` CLI is not on PATH — install @anthropic-ai/claude-code, or drop --fix to report only`
- `repo` must be a git repository: `<path> is not a git repo — cannot branch`
- `repo` must have a clean working tree:
  `<path> has uncommitted changes — commit or stash first`

Per API it prints:

```
--- petstore: 3 change(s) to repair
    agent: PARAM_RENAMED GET /pets
    agent: RESPONSE_FIELD_REMOVED GET /pets
    agent: REQUIRED_PARAM_ADDED POST /pets
    branch sma/petstore-20260911114310, tests PASS
    https://github.com/you/repo/pull/42
```

If the agent changed nothing, the branch is deleted and it prints
`skipped: the agent made no edits`. Files the agent created count here as much
as files it modified. If the agent touched files outside the predicted impact,
an `outside predicted impact: <files>` line follows. If the tests failed, the
last 1200 characters of the test output are printed.

With no git remote, or if `gh pr create` fails, the last line is the fallback
note instead of a URL — for example
`no git remote — PR body written to /path/.sma/pr/sma_petstore-20260911114310.md`.

`nothing to repair` is printed and the command returns if no group qualifies.

**Exit codes:** 1 whenever it repaired anything — a PR that exists is still an
unmerged break, so the failure signal stays up. 0 for `nothing to repair`. 2 on
any thrown error, including the missing `claude` CLI.

---

## `sma run`

```
sma run [--fix] [--no-llm] [--config <path>]
```

`scan`, then `check`, then — only if `check` found at least one change —
`impact`, then `fix` if `--fix` was passed.

**Reads and writes:** the union of the commands it calls. One shared stamp for
the whole process, so `run --fix` reuses the impact file it just wrote.

Without `--fix` the last line is:

```
(report only — pass --fix to patch and open PRs)
```

If `check` finds zero changes, `run` skips `impact` and `fix`.

**Exit codes:** whichever sub-command set it last. Zero changes leaves `check`'s
0. Changes but no call sites leaves `impact`'s 0. Changes with call sites leaves
1, and `fix` leaves 1 as well.

After that, `run` always writes `.sma/report.html` (see `sma report`) and keeps
the exit code it had before.

---

## `sma diff`

```
sma diff <old-spec> <new-spec> [--json] [--no-llm]
```

Classifies the changes between two specs, given as file paths (resolved against
the cwd) or URLs. No config, baseline or repo is involved, and nothing is written.
It is the quickest way to ask "would moving from this version to that one break
anyone?"

**Exit codes:** 1 if any change is breaking, otherwise 0.

---

## `sma report`

```
sma report [--config <path>]
```

Reads the newest `.sma/impact/` file (or, failing that, the newest `.sma/changes/`
file), `inventory.json` and `runs.json`, and writes one self-contained HTML page
to `.sma/report.html`. It never fetches anything. The banner states whether a
breaking change reaches the repo and whether the last repair covers it.

---

## `sma reset`

```
sma reset [--config <path>]
```

Deletes the entire `.sma/` directory, recursively and without prompting.

```
cleared /path/to/project/.sma — the next run captures a fresh baseline and detects nothing
```

This includes `.sma/specs/`. The baseline is gone and the next `check` reports
`baseline captured` again. Recover a committed baseline with
`git checkout -- .sma/specs`.

**Exit codes:** 0. It does not load or validate the config, so it works on a
broken `watch.yaml`.

---

## `sma version`

```
sma version
sma --version
sma -v
```

Prints the version from the installed `package.json`, resolved against the
location of `sma.mjs` rather than the cwd.

```
1.0.0
```

**Exit codes:** 0.

---

## `sma help`

```
sma help
sma
sma <anything-unrecognised>
```

Prints the command list, the two general flags, and the exit-code table.

**Exit codes:** 0 — including for an unrecognised command, which falls through to
`help`.

## Related

- [configuration.md](configuration.md) — the keys each command reads.
- [troubleshooting.md](troubleshooting.md) — every error message these commands can print.
