# Self-Maintaining API — Implementation Plan

## Context

External APIs change (fields removed, params made required, endpoints deprecated). Dependent
apps break in production because nobody reads changelogs. This project closes the loop:
**watch a spec → detect breaking changes → find the exact call sites in your code → have a
coding agent patch them → open a PR.**

Built by one developer. Target repos are **JavaScript/TypeScript**. Change source is
**OpenAPI spec diffing**. Output surface is **CLI + a real GitHub PR** — no web app.

The project directory `A:\Beautiful_Pain\Projects\Self-MaintainingAI` is currently empty.
Everything below is new code.

---

## Architecture

```
                     watch.yaml            ← you write this (5 lines per API)
                         │
                         ▼
   ┌─────────────────────────────────────────────────────────────────────┐
   │                        sma  (Node CLI, ESM)                         │
   │                                                                     │
   │  1 INVENTORY          2 WATCHER            3 CLASSIFIER             │
   │  ts-morph AST walk    fetch spec URL       rule engine (12 rules)   │
   │  of target repo       normalize + diff     + LLM for prose/ambiguous│
   │  → where APIs are     vs saved snapshot    → BREAKING / SAFE / ?    │
   │    used                                                            │
   │        │                     │                     │               │
   │        └────────┬────────────┴─────────────────────┘               │
   │                 ▼                                                  │
   │           4 IMPACT MAPPER   join diff ⋈ inventory                  │
   │           → per-change list of file:line call sites                │
   │                 │                                                  │
   │                 ▼                                                  │
   │           5 REPAIR AGENT    spawn `claude -p` inside the target     │
   │                             repo on a fresh branch; it edits,       │
   │                             runs `npm test`, reports back           │
   │                 │                                                  │
   │                 ▼                                                  │
   │           6 PR WRITER       `gh pr create` — diff + explanation     │
   │                             + validation checklist                  │
   └─────────────────────────────────────────────────────────────────────┘
                         │
                         ▼
              .sma/   ← plain JSON state on disk
              ├── specs/<api>.json        last-seen spec snapshot
              ├── inventory.json          call sites found in repo
              ├── changes/<ts>.json       detected diffs + verdicts
              └── runs.json               history: what was patched, PR url
```

Trigger: `node sma.mjs run` locally, or a GitHub Actions cron (`schedule: daily`) that runs
the same command. No server, no queue, no database.

---

## Tech choices (and what was rejected)

| Need | Choice | Why not the other thing |
|---|---|---|
| Language of the tool | **Plain ESM JavaScript** (`.mjs`), no build step | Same ecosystem as target repos; TS would add `tsc` for no gain in a solo tool |
| Find call sites | **`ts-morph`** | Regex/ripgrep is noisy — you want `stripe.charges.create` resolved, not string matches |
| Spec diff | **hand-written, ~120 lines** | `oasdiff` is a Go binary; and the breaking-change rules *are* the intellectual core of your project — own them |
| Classifier | **rules first, LLM second** | Pure-LLM detection is non-deterministic and undemoable. Rules give you a reliable demo; LLM only handles prose changelogs and "unclear" cases |
| State | **JSON files under `.sma/`** | SQLite is one more dep and one more thing to explain; JSON is diffable and inspectable during the demo |
| Repair | **shell out to `claude -p` (headless Claude Code)** in the target repo | Gives you file editing, test running, and multi-file reasoning for free. Writing your own edit loop with the raw SDK is days of work you don't need |
| LLM calls (classifier only) | `@anthropic-ai/sdk`, `claude-sonnet-5` | Cheap structured judgement; Opus not needed for a yes/no + reason |
| PR | **`gh` CLI** | Octokit means auth plumbing; `gh` is already authed on your machine |

Total dependencies: `ts-morph`, `@anthropic-ai/sdk`, `yaml`. External CLIs: `gh`, `claude`.

---

## File layout

```
Self-MaintainingAI/
├── sma.mjs                  CLI entry — arg parse + command dispatch (~80 lines)
├── src/
│   ├── inventory.mjs        ts-morph scan → call sites
│   ├── watcher.mjs          fetch + normalize + snapshot
│   ├── diff.mjs             OpenAPI structural diff
│   ├── rules.mjs            breaking-change rule table  ← the core
│   ├── classify.mjs         rules + LLM fallback
│   ├── impact.mjs           join diff ⋈ inventory
│   ├── repair.mjs           spawn claude -p, capture result
│   ├── pr.mjs               branch + commit + gh pr create
│   └── store.mjs            read/write .sma/*.json
├── watch.yaml               config
├── test/
│   ├── diff.test.mjs        node:test — fixture v1 vs v2 → expected rule hits
│   └── inventory.test.mjs   node:test — fixture repo → expected call sites
└── demo/
    ├── petstore/            fake API you control
    │   ├── openapi.v1.json
    │   ├── openapi.v2.json  ← the breaking change, on demand
    │   └── server.mjs       serves whichever version is active
    └── demo-app/            sample JS repo consuming petstore (your victim)
```

`watch.yaml`:
```yaml
repo: ./demo/demo-app
apis:
  - name: petstore
    spec: http://localhost:8787/openapi.json
    baseUrl: http://localhost:8787
  - name: github
    spec: https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json
    baseUrl: https://api.github.com
    sdk: "@octokit/rest"
```

---

## Data contracts (define these first, everything else plugs in)

**Call site** (`inventory.json`)
```js
{ api: "petstore", kind: "http" | "sdk",
  method: "GET", path: "/pets/{id}",     // for kind:http
  symbol: "octokit.repos.get",           // for kind:sdk
  file: "src/pets.js", line: 42, snippet: "await fetch(`${BASE}/pets/${id}`)" }
```

**Change** (`changes/<ts>.json`)
```js
{ api: "petstore", rule: "REQUIRED_PARAM_ADDED",
  path: "/pets", method: "POST", detail: { param: "ownerId" },
  severity: "breaking" | "warning" | "safe",
  reason: "...", source: "rule" | "llm" }
```

**Impact** = change + `sites: [CallSite]`. Only changes with `severity:breaking` **and**
non-empty `sites` reach the repair agent.

---

## Breaking-change rules (`rules.mjs`)

Deterministic, each ~5 lines over the two normalized specs. This table is your project's
contribution — put it in the report.

| Rule | Severity |
|---|---|
| `PATH_REMOVED` — endpoint gone | breaking |
| `METHOD_REMOVED` — verb gone from existing path | breaking |
| `REQUIRED_PARAM_ADDED` | breaking |
| `PARAM_REMOVED` / `PARAM_RENAMED` (name-similarity heuristic) | breaking |
| `PARAM_TYPE_CHANGED` | breaking |
| `PARAM_MADE_REQUIRED` (was optional) | breaking |
| `RESPONSE_FIELD_REMOVED` | breaking |
| `RESPONSE_FIELD_TYPE_CHANGED` | breaking |
| `ENUM_VALUE_REMOVED` | breaking |
| `AUTH_SCHEME_CHANGED` | breaking |
| `PATH_DEPRECATED` (`deprecated: true`) | warning |
| `PATH_ADDED` / `OPTIONAL_PARAM_ADDED` / `ENUM_VALUE_ADDED` | safe |

Anything the rules don't cover (description text changes, `x-` extensions, rate-limit notes)
goes to the LLM with the raw JSON-pointer diff and returns
`{severity, reason, confidence}`. Confidence < 0.7 → report only, never auto-patch.

---

## Build phases

Each phase ends with something runnable. Do not start the next until the current one prints
real output.

### Phase 0 — Demo harness first (½ day)
Counter-intuitive, but do this first: **you cannot test any of this without a breaking
change you control.** Stripe won't break on your demo day.
- `demo/petstore/openapi.v1.json` — 3 endpoints: `GET /pets`, `GET /pets/{id}`, `POST /pets`.
- `openapi.v2.json` — same but: `POST /pets` gains required `ownerId`; `GET /pets/{id}`
  response drops `tag`; `GET /pets` param `limit` renamed to `pageSize`. Three different
  rule classes on purpose.
- `server.mjs` — 20-line `node:http` server, serves `openapi.json` from whichever version
  file `ACTIVE` points at, plus fake data endpoints.
- `demo/demo-app/` — small JS app: `fetch` calls to all three endpoints across 2–3 files,
  plus a `npm test` that actually hits the local server and asserts responses. **The tests
  must fail after you flip to v2** — that's your proof the repair worked.

### Phase 1 — Store + CLI skeleton (½ day)
`sma.mjs` with subcommands `init | scan | check | impact | fix | run`, `store.mjs` for
`.sma/` JSON read/write. `run` = scan → check → impact → fix → pr.

### Phase 2 — Watcher + diff + rules (1.5 days) ← the core
`watcher.mjs` fetches spec (JSON or YAML), normalizes (resolve `$ref`s, sort keys), saves to
`.sma/specs/<api>.json`. First run = baseline only, no changes reported.
`diff.mjs` walks both specs and emits raw structural deltas.
`rules.mjs` maps deltas → rule hits + severity.
**Test now**: `node --test test/diff.test.mjs` — feed it v1 and v2, assert exactly the three
expected rule hits. This test is the single most valuable thing in the repo.

### Phase 3 — Inventory scanner (1.5 days)
`ts-morph` project over `repo` from `watch.yaml`. Two detectors:
- **HTTP**: find `fetch` / `axios.*` / `got` calls, extract the URL argument. Handle template
  literals (`` `${BASE}/pets/${id}` `` → `/pets/{id}`) by replacing every `${...}` with `{}`
  and fuzzy-matching against spec paths. This is the fiddly bit — budget the time here.
- **SDK**: for APIs with `sdk:` set, find the import, then collect member-expression chains
  off that identifier (`octokit.repos.get`).

Test with a fixture repo, assert the exact `file:line` set.

### Phase 4 — Impact mapper (½ day)
Join: for each breaking change, match `method+path` (http) or symbol (sdk) against inventory.
Output a human-readable report — this alone is already a useful, demoable tool. If a change
has zero call sites, mark it `not-affected` and log it (proves the mapper isn't just guessing).

### Phase 5 — Repair agent (1.5 days)
For each affected change:
1. `git -C <repo> checkout -b sma/<api>-<rule>-<shortdate>`
2. Write a prompt file containing: the rule, the before/after spec fragment, every affected
   `file:line` with surrounding code, and explicit instructions — *change only these call
   sites, do not refactor anything else, run `npm test` and report the result.*
3. `spawn('claude', ['-p', promptText, '--permission-mode', 'acceptEdits'], {cwd: repo})`,
   capture stdout.
4. Verify independently: run `npm test` yourself and `git diff --stat`. **Do not trust the
   agent's self-report.** If tests fail or the diff touches files outside the impact list →
   still open the PR, but label it `needs-human` and say so in the body.

### Phase 6 — PR writer (½ day)
Commit, push, `gh pr create` with a body containing: what changed in the API (with spec URL
and rule name), affected files, the reasoning, test result, and a manual validation
checklist. Store the PR URL in `.sma/runs.json`.

### Phase 7 — Automation (½ day)
`.github/workflows/sma.yml` — daily cron, `npm ci`, `node sma.mjs run`, with
`ANTHROPIC_API_KEY` and `GITHUB_TOKEN` as secrets. Runs against real public specs (GitHub's
OpenAPI spec changes almost weekly — good live proof).

**Total: ~6–7 focused days.**

---

## Deliberately skipped (and when to add)

- **Web dashboard** — the PR is the UI. Add if a viva/presentation demands visuals.
- **SQLite** — JSON files are fine at this scale. Add when you want cross-run analytics.
- **Multi-repo / multi-language** — one repo, JS/TS only. The inventory module is the only
  thing that would change.
- **Changelog/HTML scraping** — spec diffing is strictly better where a spec exists. Add a
  scraper only for a specific API you care about that publishes no spec.
- **Auto-merge** — never. Human reviews the PR. That's the whole safety model.
- **Semantic/embedding-based code search** — AST resolution is exact and free.

---

## Verification

1. **Unit**: `node --test` — `test/diff.test.mjs` (v1→v2 produces exactly 3 expected rule
   hits, no false positives) and `test/inventory.test.mjs` (fixture repo → expected call
   sites). These two tests are non-negotiable; everything else is glue.
2. **End-to-end demo loop** (this is your project demo, run it start to finish):
   - `node demo/petstore/server.mjs` (serving v1)
   - `cd demo/demo-app && npm test` → **passes**
   - `node sma.mjs run` → baseline captured, "no changes"
   - flip the server to v2
   - `node sma.mjs run` → detects 3 breaking changes, maps to N call sites, agent patches
     them, `npm test` passes again, PR opens
   - open the PR, read the body, `git diff` the branch
3. **Live proof**: point `watch.yaml` at the GitHub REST OpenAPI spec, run twice a week
   apart, confirm it detects real upstream changes and correctly reports `not-affected` for
   endpoints your repo doesn't call.
4. **False-positive check**: run `sma check` against two identical spec copies → must
   report zero changes.
