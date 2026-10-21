# Troubleshooting

Every message below is a literal string from `sma.mjs` or `src/`. If you are
looking at something not in this list, it came from `node`, `git`, `gh`, or your
own test suite.

## Quick table

| Symptom | Cause | Fix |
|---|---|---|
| `<api>: baseline captured` on every run | `.sma/specs/<name>.json` is not persisting | Commit it. See [the baseline section](#baseline-captured-forever). |
| `could not fetch ...: ECONNREFUSED` | Nothing is listening at that URL | Start the server, or fix the URL. |
| `could not fetch ...: HTTP 401 Unauthorized` | The spec needs auth sma cannot send | Vendor the spec locally, or fetch it in a prior CI step. |
| ``the `claude` CLI is not on PATH`` | `fix` has no agent to run | `npm i -g @anthropic-ai/claude-code`, or drop `--fix`. |
| `no git remote — PR body written to ...` | The target repo has no remote | Read the markdown file, or add a remote. |
| `gh pr create failed: ...` | `gh` missing, unauthenticated, or refused | Install `gh`, set `GH_TOKEN`, check the scopes. |
| `N request(s) with a URL this scanner could not resolve statically` | The URL is computed at runtime | Inline the path literal, or review those sites by hand. |
| `UNCLASSIFIED` findings | No `ANTHROPIC_API_KEY`, or `--no-llm` | Set the key, or accept rules-only classification. |
| `repo not found: <path>` | `repo` points nowhere | It resolves against the config file, not the cwd. |
| `api name "..." must be letters, digits, dot, dash or underscore` | Illegal character in `apis[].name` | Rename it. |
| `duplicate api name "..."` | Two entries share a name | Rename one. Snapshots are keyed by name. |
| `no watch.yaml in ... or any parent directory` | No config anywhere above the cwd | `sma init`, or pass `--config`. |
| ``watch.yaml: `apis` is empty`` | The template's APIs are all still commented out | Uncomment one or add your own. |
| `<path> has uncommitted changes` | `fix` refuses to branch over a dirty tree | Commit or stash first. |
| `skipped: the agent made no edits` | No file changed or was created | See [the agent made no edits](#skipped-the-agent-made-no-edits). |
| `nothing checked yet — run \`sma check\` first` | No `.sma/changes/` directory | Run `sma check`. |
| `no inventory — run \`sma scan\` first` | No `.sma/inventory.json` | Run `sma scan`. |
| `ENOENT: no such file or directory, open '.../spec.json'` | A local `spec:` path that does not exist | Relative paths resolve against the config file. Check the path is right relative to `watch.yaml`. |

---

## "baseline captured" forever

**Symptom.** Every run prints
`<api>: baseline captured (N endpoints) — commit .sma/specs/<api>.json` and exits
0. Nothing is ever detected.

**Cause.** `watcher.loadSnapshot(name)` returned `null`, so `check` took its
first-run branch. That happens when `.sma/specs/<name>.json` does not exist at
the moment the check runs. Common reasons:

- The baseline was never committed. `.sma/` is in `.gitignore` in most repos
  before sma is installed, and even the block `sma init` writes lists five other
  paths under `.sma/` — `specs/` is the one deliberately left out. If someone
  "tidied" the `.gitignore` to a blanket `.sma/`, the baseline never reaches git.
- CI caches `.sma/` instead of committing it, and the cache was evicted.
- `sma reset` was run. It deletes `.sma/` recursively, baseline included.
- The API was renamed in `watch.yaml`. The snapshot is keyed by name, so
  `petstore` → `pet-store` orphans the old file and starts over.
- The cwd moved and a *different* `watch.yaml` is being found by the upward
  search, pointing at a different `.sma/`.

This is the worst failure mode in the tool, because it is indistinguishable from
success at the exit-code level.

**Fix.**

```bash
git check-ignore -v .sma/specs/petstore.json   # prints the ignoring rule, or nothing
ls -la .sma/specs/
git log --oneline -- .sma/specs
```

Then make sure `.gitignore` matches the block `sma init` writes — the five
per-run paths, not a blanket `.sma/` — and commit:

```bash
git add .sma/specs && git commit -m "chore: sma baseline"
```

In CI, verify the workflow pushes the baseline *before* it fails the job. See
[ci.md](ci.md#why-the-baseline-is-committed-not-cached).

**Confirming it works.** Change the spec by one field and run `sma check` twice.
The first run should report the change; the second should report zero, because
the first already advanced the baseline.

---

## `could not fetch ...: ECONNREFUSED`

**Message.**

```
error: could not fetch http://localhost:8787/openapi.json: ECONNREFUSED — is the server running? (`node demo/petstore/server.mjs`)
```

Exit code 2.

**Cause.** Node's `fetch` reports every network failure as `fetch failed`, so
`src/watcher.mjs` unwraps `err.cause.code` and names the URL. The hint about the
demo server is appended only when the code is `ECONNREFUSED` and the URL contains
`localhost` or `127.0.0.1`.

**Fix.** For the bundled demo, start the upstream first:

```bash
node demo/petstore/server.mjs &
curl -s http://localhost:8787/openapi.json | head -3
```

For your own local spec server, check the port matches `apis[].spec`. In CI,
`ECONNREFUSED` against `localhost` almost always means the config is pointing at
a developer's machine — a spec URL in a CI config should be a real host or a
vendored file.

**Other network codes.** `ENOTFOUND` (bad hostname), `ETIMEDOUT` (firewall or
egress rules), `CERT_HAS_EXPIRED`. All come through the same message with the
code substituted and no hint appended.

**HTTP errors** are separate:

```
error: could not fetch https://api.example.com/openapi.json: HTTP 404 Not Found
```

`401` or `403` means the spec needs authentication. Add `headers:` to the API entry;
see [faq.md](faq.md#what-about-a-private-or-authenticated-spec-url).

---

## `--fix` refuses without the `claude` CLI

**Message.**

```
error: the `claude` CLI is not on PATH — install @anthropic-ai/claude-code, or drop --fix to report only
```

Exit code 2.

**Cause.** `sma fix` probes with `claude --version` through a shell and requires
exit 0 before it does anything else. This check runs before the git checks, so it
fires even on a dirty repo.

**Fix.**

```bash
npm install -g @anthropic-ai/claude-code
claude --version
```

In CI, that install is a step of its own in the shipped workflow. If you never
use `--fix`, delete the step and the flag — everything before repair works
without it.

**Verify what sma thinks is installed:**

```bash
npx sma doctor
```

`claude CLI` will read `MISS`, with the line
`without it: --fix is unavailable — sma reports what broke, you patch it`.

### Related repair-stage refusals

These come from `startSession()` in `src/repair.mjs`, after the CLI check:

```
error: /path/to/app is not a git repo — cannot branch
error: /path/to/app has uncommitted changes — commit or stash first
```

The second is the one that bites in CI on a reused workspace. `fix` needs a clean
tree because it identifies the agent's edits with `git status --porcelain` — any
pre-existing modification or untracked file would be attributed to the agent and
committed into the PR.

---

## The PR body landed in `.sma/pr/` instead of GitHub

Two different paths produce this, with two different messages.

**No remote:**

```
    no git remote — PR body written to /path/.sma/pr/sma_petstore-20260911114310.md
```

`open()` checks `git remote` in the target repo. An empty result means there is
nowhere to push, so it commits locally, writes the body, and stops. This is the
normal outcome for the bundled demo, which has a local-only git repo.

**`gh` failed:**

```
    gh pr create failed: <stderr> — branch sma/petstore-20260911114310 is pushed; body in /path/.sma/pr/sma_petstore-20260911114310.md
```

The branch was already pushed at this point — only the PR creation failed, and
the note says so along with where the body is, so you can open the PR by hand.
Causes: `gh` not installed, `GH_TOKEN`/`GITHUB_TOKEN` unset or expired, the token
lacking `pull-requests: write`, or a PR already open for that branch.

If `gh` is missing entirely the reason reads
`the gh CLI is not on PATH (ENOENT)` — `spawnSync` reports that through `error`
and leaves `status` and `stderr` null. Check with `npx sma doctor` — it probes
`gh --version` and `GH_TOKEN` as separate rows.

**Fix.**

```bash
gh --version
gh auth status
export GH_TOKEN=...          # or GITHUB_TOKEN
```

In GitHub Actions the workflow needs:

```yaml
permissions:
  contents: write
  pull-requests: write
```

**In the meantime,** the body file is always written, before any push is
attempted. Nothing is lost:

```bash
cat .sma/pr/sma_petstore-20260911114310.md
git -C ./path/to/repo log --oneline -1     # the commit exists on the branch
```

Open the PR by hand with that body. The branch name is `sma/<api>-<stamp>` and
the file name is the same with `/` replaced by `_`.

---

## Unresolved dynamic URLs in the scan

**Output.**

```
1 request(s) with a URL this scanner could not resolve statically:
  api.js:22  fetch(path)
```

**Cause.** `urlOf()` in `src/inventory.mjs` understands four shapes: a string
literal, a no-substitution template literal, a template expression (each
`${...}` becomes `{}`), and an object literal with a `url` property. Anything
else — a bare variable, a function call, a ternary, string concatenation with
`+` — cannot be resolved without executing the program.

Those requests are recorded in `unresolved` and printed as their own block. They
are never silently dropped, because a silently dropped call site is an undetected
break. `test/inventory.test.mjs` asserts exactly this behaviour.

**Consequence.** An unresolved request is not in `sites`, so the impact join
cannot match any change to it. Changes to the endpoint it actually calls will be
reported as `not affected (no call sites in this repo)`.

**Fix.** Either make the URL statically visible:

```js
// unresolved
const path = buildPath(id);
return fetch(path);

// resolved as GET /widgets/{}
return fetch(`${BASE}/widgets/${id}`);
```

…or accept it and review the unresolved block by hand after each `sma scan`. A
generic HTTP helper wrapping every call in the codebase will produce one
unresolved entry and no sites at all — that is the shape sma cannot analyse.

**Not the same thing:** a request to a host that is not any watched `baseUrl` is
ignored outright, not listed as unresolved. `toPath()` returns `null` for an
absolute URL belonging elsewhere.

---

## `UNCLASSIFIED` changes without an API key

**Output.**

```
petstore: 9 change(s), 5 breaking, 4 unclassified (no API key)
```

and in the impact report:

```
[unknown] UNCLASSIFIED  (whole spec)
    no rule covers /paths/~1pets/get/x-rate-limit and no LLM review was run
    -> not affected (no call sites in this repo)
```

**Cause.** The delta is real but no rule in `src/rules.mjs` models it, and the
LLM fallback did not run — either `ANTHROPIC_API_KEY` is unset or `--no-llm` was
passed. `classify()` records each leftover as `UNCLASSIFIED` with severity
`unknown` rather than guessing.

**What it means for you.**

- `unknown` is never repairable. `repairable()` accepts `breaking` only, so an
  `UNCLASSIFIED` finding is never handed to the agent.
- An `UNCLASSIFIED` change has no path, and pathless changes only claim call
  sites if the rule is `AUTH_SCHEME_CHANGED`. So it always prints
  `not affected`. That is deliberate: an earlier version matched every site and
  drowned the report in false impact, and `test/impact.test.mjs` keeps the
  regression fixed.
- It still needs a human to read it. `x-rate-limit` halving is breaking in
  practice and no rule will ever know.

**Fix, if you want them judged.** Set `ANTHROPIC_API_KEY` and drop `--no-llm`.
The deltas go to Claude in a single request and come back as `LLM_REVIEWED` with
a severity and a confidence. Anything below 0.7 confidence keeps severity
`unknown` and gains
`(low confidence <n>, not auto-patched)` in its reason.

**Fix, if you want fewer of them.** The classifier already ignores `/info`,
`/servers`, `/components/schemas`, and any `description`, `summary`, `example`,
`examples`, `title`, `operationId` or `tags` segment. A spec whose vendor
extensions churn every release will still generate noise. There is no config key
for the ignore list — it is a constant in `src/classify.mjs`.

---

## `repo not found`

**Message.**

```
error: repo not found: /path/to/project/demo/demo-app
```

Exit code 2.

**Cause.** `resolve(dirname(configFile), cfg.repo)` does not exist. The path in
the message is the resolved absolute one — read it, it usually shows the mistake.

The resolution base is the **config file's directory**, not the cwd. That is
deliberate and tested: otherwise `repo: ./app` would mean a different directory
depending on where you were standing when you ran the command.

**Fix.** Make `repo` relative to `watch.yaml`:

```
project/
  watch.yaml          # repo: ./services/orders
  services/orders/
```

For the repo holding the config itself, `repo: .`.

### The sibling

`apis[].spec`, when it is a local path rather than a URL, follows the same rule.
`fetchSpec` resolves a relative path against the config file's directory, so
`--config ../watch.yaml` reads the same spec from anywhere. Absolute paths are
used as given, and `http(s)` URLs are fetched instead of read.

An `ENOENT` here means the path is wrong relative to `watch.yaml`:

```
error: ENOENT: no such file or directory, open '/project/contracts/billing.yaml'
```

---

## Invalid or duplicate api names

**Messages.**

```
error: watch.yaml: api name "bad name" must be letters, digits, dot, dash or underscore
error: watch.yaml: duplicate api name "petstore"
error: watch.yaml: each api needs `name` and `spec`
```

All exit 2, all from `loadConfig()` in `src/store.mjs`.

**The charset rule** is `/^[a-zA-Z0-9._-]+$/`. It exists because the name is
interpolated directly into a path — `.sma/specs/${name}.json` — which makes it a
trust boundary. A config file containing `name: ../../etc` must not decide where
sma writes. `test/store.test.mjs` asserts that exact case is rejected. Spaces,
slashes, colons and every other character are refused for the same reason.

**The duplicate rule** exists because snapshots are keyed by name. Two APIs
called `petstore` would write to the same `.sma/specs/petstore.json`, so each
would diff against the other's spec and report a stream of nonsense. The name is
also the join key in `impact.mjs` — a site is only matched to a change when
`site.api === change.api`.

**Fix.** Rename. If you genuinely watch two versions of one API, give them
distinct names:

```yaml
apis:
  - name: petstore-v1
    spec: https://api.example.com/v1/openapi.json
  - name: petstore-v2
    spec: https://api.example.com/v2/openapi.json
```

Renaming an api orphans its old snapshot. Rename the file too, or the next run
reports `baseline captured` for the new name:

```bash
git mv .sma/specs/petstore.json .sma/specs/petstore-v1.json
```

---

## No `watch.yaml` found

**Message.**

```
error: no watch.yaml in /current/dir or any parent directory — run `sma init`
```

Exit code 2. The directory named is the cwd, not the place it searched last.

**Cause.** The upward search from the cwd reached the filesystem root without
finding `watch.yaml`, and neither `--config` nor `SMA_CONFIG` was set.

**Fix.** One of:

```bash
sma init                                   # write one here
sma check --config /path/to/watch.yaml     # point at an existing one
SMA_CONFIG=/path/to/watch.yaml sma check   # same, via the environment
cd /path/to/project && sma check           # let the upward search find it
```

Precedence is `--config`, then `SMA_CONFIG`, then the upward search. See
[configuration.md](configuration.md#config-discovery).

**`init` does not error here** — it takes its no-config branch and writes the
template. `doctor`, `version` and `help` also run without a config; `doctor`
reports the missing config as a `MISS` row and exits 2, since detection is
blocked without one.

### The empty-template follow-up

Running `sma init` twice in a row, without editing the file in between:

```
using /path/to/project/watch.yaml
error: watch.yaml: `apis` is empty
```

The template `init` writes has every API commented out, by design. Uncomment one
or add your own, then run `init` again to capture the baseline.

---

## `skipped: the agent made no edits`

**Output.**

```
    skipped: the agent made no edits
```

The branch is deleted and the group is skipped. No PR opens.

**Causes.**

- The agent genuinely decided nothing needed changing — the prompt tells it to
  leave alone anything another change in the same run already fixed.
- The agent ran out of turns or errored. `runAgent` records the exit status but
  `finish()` only looks at the working tree, so a failed run and a no-op run look
  identical from here.

A repair implemented purely as a new module is not a cause. `finish()` uses
`touchedFiles()`, which reads `git status --porcelain --untracked-files=all`, so
created files count as edits and are scope-checked like any other.

**Fix.** Read the prompt that was sent — it is on disk before the run:

```bash
cat .sma/prompts/sma_petstore-20260911114310-response_field_removed.txt
git -C ./path/to/repo status --porcelain --untracked-files=all
```

The slug is the branch name plus the rule id, lowercased with non-alphanumerics
collapsed to `_`. Two repairs with the same rule id on one branch overwrite the
same prompt file, so only the last is on disk.

---

## Precondition messages from `impact`

These are not errors. Each prints and returns with exit code 0.

```
nothing checked yet — run `sma check` first
the latest check found no changes — nothing to map
no inventory — run `sma scan` first
```

The first means `.sma/changes/` does not exist. The second means the newest
changes file is an empty array — `check` writes one on every run, including runs
that find nothing, precisely so that yesterday's file never looks current. The
third means `sma scan` has not run, or `.sma/inventory.json` was deleted.

`sma run` calls all three in order, so it never hits any of them.

---

## `git ... failed:`

**Message.**

```
error: git push -u origin sma/petstore-20260911114310 failed: <stderr>
```

Exit code 2. Any git command sma runs that exits non-zero throws with its stderr
attached, except the two it deliberately allows to fail (`branch -D` during
cleanup, and `remote` when probing).

The push is the one that fails most often, and it fails *before* `gh pr create`.
Causes: no write permission on the branch, a protected branch pattern matching
`sma/*`, a token without `contents: write`, or a missing git identity on a fresh
CI runner:

```bash
git config user.name  "sma[bot]"
git config user.email "sma@users.noreply.github.com"
```

## Related

- [cli.md](cli.md) — exit codes per command.
- [configuration.md](configuration.md) — the validation rules behind the config errors.
- [ci.md](ci.md) — the CI-specific version of the baseline problem.
