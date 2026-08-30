# sma — self-maintaining API integrations

Watches the OpenAPI specs your code depends on. When one changes, it works out
whether the change breaks anything **you actually call**, patches the call sites with a
coding agent, verifies the result itself, and opens a PR.

```
watch.yaml → fetch spec → diff vs snapshot → 12 breaking-change rules
                                                   ↓
                        AST inventory of your repo  ⋈  impact
                                                   ↓
                     headless Claude Code patches the call sites
                                                   ↓
                    harness runs the tests → git branch → gh pr create
```

Nothing merges automatically. The PR is the deliverable.

## Install

```bash
npm i -D self-maintaining-api    # or: npm i -g self-maintaining-api
npx sma init                     # writes watch.yaml
# edit watch.yaml, add the APIs you depend on
npx sma init                     # captures the baseline
git add .sma/specs && git commit -m "chore: sma baseline"
```

Then `npx sma check` in CI. Requires node 22+.

> **The baseline is the whole product.** `.sma/specs/` is what the API looked like
> last time. Commit it. If it is lost, every run is a first run and sma reports
> "all clear" forever while detecting nothing.

## Try the demo

```bash
npm install
node demo/petstore/server.mjs &        # a fake upstream API you control

node sma.mjs run                       # first run: records the baseline
echo v2 > demo/petstore/ACTIVE         # upstream ships a breaking release
node sma.mjs run                       # detects it, maps it, reports
node sma.mjs fix                       # patches it, verifies, opens a PR
```

## Commands

| Command | What it does |
|---|---|
| `sma init` | Write `watch.yaml`, or capture the baseline if one already exists |
| `sma doctor` | Report what is installed and what each missing piece costs you |
| `sma scan` | Find every call site for the watched APIs in your repo |
| `sma check` | Fetch specs, diff against the last snapshot, classify each change |
| `sma impact` | Map the latest changes onto the call sites |
| `sma fix` | Hand breaking-and-used changes to the repair agent, open PRs |
| `sma run [--fix]` | All of the above |
| `sma reset` | Forget every snapshot and start over |

`--no-llm` keeps it purely deterministic: rules only, never calls the API.
`--config <path>` overrides the config; by default sma walks up from the cwd to the
nearest `watch.yaml`, the way `git` finds `.git`.

## Exit codes

CI can only tell "your API broke" from "sma broke" if those are different numbers.

| Code | Meaning |
|---|---|
| `0` | Nothing broken |
| `1` | A breaking change reached this repo |
| `2` | sma itself failed — bad config, network, missing prerequisite |

## What you need, and what you lose without it

Detection needs nothing but node and a network. Everything else degrades rather
than blocks — `sma doctor` prints this table for your machine.

| Layer | Needs | Missing it |
|---|---|---|
| Detect (fetch, diff, rules) | node 22+ | — this layer must never fail |
| Impact (AST scan) | bundled | an unparsable file is reported, not fatal |
| Explain ambiguous deltas | `ANTHROPIC_API_KEY` | they become `UNCLASSIFIED`; rules still apply |
| Repair | `claude` CLI, `git` | `--fix` refuses; you get the report and patch it yourself |
| Open the PR | `gh`, `GH_TOKEN` | the PR body is written to `.sma/pr/` and printed |

## Configuration

```yaml
repo: ./demo/demo-app        # the repo to scan and patch
test: npm test               # optional; how the harness verifies a repair

apis:
  - name: petstore
    spec: http://localhost:8787/openapi.json
    baseUrl: http://localhost:8787
    sdk: "@octokit/rest"     # optional; also match SDK method chains
```

## How it decides something is breaking

Deterministic rules over the two specs — no LLM in the default path, so the same
input always gives the same answer and the whole thing is unit-testable.

| Rule | Severity |
|---|---|
| `PATH_REMOVED`, `METHOD_REMOVED` | breaking |
| `REQUIRED_PARAM_ADDED`, `PARAM_MADE_REQUIRED` | breaking |
| `PARAM_REMOVED`, `PARAM_RENAMED`, `PARAM_TYPE_CHANGED` | breaking |
| `RESPONSE_FIELD_REMOVED`, `RESPONSE_FIELD_TYPE_CHANGED` | breaking |
| `ENUM_VALUE_REMOVED`, `AUTH_SCHEME_CHANGED` | breaking |
| `PATH_DEPRECATED` | warning |
| `PATH_ADDED`, `METHOD_ADDED`, `OPTIONAL_PARAM_ADDED`, `RESPONSE_FIELD_ADDED`, `ENUM_VALUE_ADDED` | safe |

Renames are detected structurally — one parameter out, one in, same location and
type — because `limit` → `pageSize` shares no letters with its predecessor.

Anything the rules don't cover goes to Claude with the raw JSON-pointer diff and
comes back with a severity and a confidence. Below 0.7 it is reported but never
auto-patched. Without `ANTHROPIC_API_KEY` those deltas are surfaced as
`UNCLASSIFIED` rather than guessed at.

## How it finds the call sites

`ts-morph` walks the AST, so a string that merely mentions `/pets` is not a match
but `fetch(\`${BASE}/pets/${id}\`)` is, resolved to `GET /pets/{}`. It then takes
**one hop out**: the function wrapping each request, and everything that calls it.
That is what catches the tests and helpers asserting the old response shape —
they break too, and they live nowhere near the `fetch`.

A URL that can't be resolved statically is reported as unresolved, never silently
dropped.

## Why you can trust the patch

The repair agent gets `Read,Edit,Write,Glob,Grep` — **no shell**. It cannot run the
tests, so its own report is never the evidence. The harness runs `npm test` itself
and diffs the changed file list against the predicted impact. If the tests fail, or
the agent touched a file nobody predicted, the PR still opens — labelled
`needs-human` and saying so in the body.

One spec bump is one branch and one PR. Each change gets its own focused agent run,
but they land together: a PR that fixed half of what an upgrade broke would fail its
own test suite.

## Layout

```
sma.mjs              CLI
src/watcher.mjs      fetch spec, inline $refs, snapshot
src/diff.mjs         structural diff → JSON pointers
src/rules.mjs        the breaking-change rule table
src/classify.mjs     rules + LLM fallback for the leftovers
src/inventory.mjs    ts-morph call-site scan + one-hop callers
src/impact.mjs       join changes ⋈ call sites
src/repair.mjs       branch, run the agent, verify independently
src/pr.mjs           commit, push, gh pr create
demo/petstore/       fake upstream API with a v1 → v2 breaking release
demo/demo-app/       sample repo that consumes it
```

State lives in `.sma/` as plain JSON — snapshots, inventory, detected changes, the
prompts sent to the agent, PR bodies, and a run log. Everything there is a per-run
artifact and gitignored, **except `.sma/specs/`** — that is the baseline, and
`sma init` deliberately leaves it tracked. Committing it means the history of every
change an upstream API ever shipped is `git log .sma/specs/stripe.json`.

## What it does not do

Each of these is a deliberate trade, not an oversight. They become bugs only if
they surprise you.

- **One hop out.** A request wrapped in a function, and that function's callers, are
  found. Three layers of wrappers are not — that needs a real call graph.
- **Rename inference is a heuristic.** Exactly one parameter out, one in, same
  location and type. Two simultaneous renames on one endpoint are reported as a
  removal plus an addition.
- **SDK matching looks for the `operationId` in the method chain.** Good for
  Octokit-shaped SDKs, a guess for others.
- **Detection is as fresh as your cron.** A daily schedule means up to 24 hours
  between the upstream change and the PR.

## Tests

```bash
npm test
```

`test/diff.test.mjs` asserts the exact rule hits for v1 → v2 with no false
positives; `test/inventory.test.mjs` asserts the exact call sites found in a
fixture repo. Those two are the load-bearing ones.

## Automation

`.github/workflows/sma.yml` runs the whole thing daily. Drop this into any repo:

```yaml
on:
  schedule: [{ cron: '0 6 * * *' }]
  workflow_dispatch:
jobs:
  watch:
    runs-on: ubuntu-latest
    permissions: { contents: write, pull-requests: write }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npx sma run --fix
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

No cache step: the baseline is committed, so it cannot be evicted. Drop both secrets
and the same workflow still runs — it just fails the job when an API breaks you
instead of writing the fix.
