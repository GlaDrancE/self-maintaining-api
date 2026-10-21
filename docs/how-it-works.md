# How it works

The pipeline, stage by stage, with the reasoning behind each shape.

```
watch.yaml → fetch spec → inline $refs → snapshot
                                            ↓
                          structural diff → JSON pointers
                                            ↓
                          rule engine → severity per change
                                            ↓
                          leftovers → LLM → severity + confidence
                                            ↓
        AST inventory of your repo   ⋈   impact join
                                            ↓
                    repair agent (Read/Edit/Write/Glob/Grep, no shell)
                                            ↓
                    harness runs the tests → branch → gh pr create
```

## 1. Fetch and normalise the spec

`src/watcher.mjs`.

`fetchSpec(location)` treats anything matching `/^https?:\/\//` as a URL and
everything else as a file path. Both go through the same YAML parser, because
YAML is a superset of JSON — one parser, two formats, no branch.

Network errors are unwrapped before they are rethrown. Node's `fetch` reports
every network problem as the same two words, `fetch failed`, which tells you
neither which spec nor why. `fetchOverHttp` pulls `err.cause.code` out and builds
a message naming the URL, and appends a "is the server running?" hint when the
code is `ECONNREFUSED` against localhost.

### `$ref` inlining

`resolveRefs(spec)` replaces every local `$ref` (`#/...`) with the node it points
at, recursively. Pointer segments are unescaped per RFC 6901 (`~1` → `/`, `~0` →
`~`). Remote and file `$ref`s are left untouched — only refs starting with `#/`
are followed.

This is done so the rule engine never has to chase pointers. Every operation
carries its full schema inline, and a rule can read
`op.responses['200'].content['application/json'].schema.properties` without a
resolver. It also means a change to a shared schema shows up independently on
every operation that uses it, which is what makes a single upstream edit produce
several findings that the impact join later regroups.

**Cyclic refs.** `walk` carries a `seen` set of the refs on the current path.
When it meets a ref already in that set it returns `{ $ref, $circular: true }`
rather than expanding forever. The cycle is marked, not expanded and not dropped.
The consequence is that a self-referential schema — a tree node, a nested
comment — is compared as that stub, so changes *inside* the recursive part of the
type are invisible to the rules. They may still reach the LLM fallback as a raw
pointer delta.

### Snapshots

`.sma/specs/<name>.json` holds the resolved spec, pretty-printed. `check` saves
the new one only after `classify()` has returned, so the comparison is always
"last run versus now" and a classifier failure leaves the old baseline on disk.
If the snapshot advanced first, a network blip or a malformed response would
record the new spec as already seen and the change would never be reported
again. The first run is the exception: with no previous snapshot there is
nothing to lose, so the baseline is written straight away.

The snapshot is committed to git rather than cached. A cache is evictable; an
eviction here is not a loud failure but a silent one. `loadSnapshot` returns
`null`, `check` takes its first-run branch, prints `baseline captured`, and exits
0 — reporting all clear while detecting nothing, indefinitely. Committing it also
buys history for free: `git log .sma/specs/stripe.json` is the log of every
change that API ever shipped.

## 2. Structural diff

`src/diff.mjs`.

`diff(before, after)` is a generic recursive comparison that emits RFC 6901 JSON
pointers with three ops: `add`, `remove`, `change`.

Arrays are the interesting case. Compared by index, a reordered `parameters` list
or a reordered `enum` reads as a wholesale change. Spec arrays are sets in
practice, so `diff` keys array elements by `v.name` when the element is an object
with a name, and by `JSON.stringify(v)` otherwise, then compares the two keyed
maps. `test/diff.test.mjs` asserts that reversing an enum produces no hits at
all.

`coveredBy(pointer, prefixes)` answers whether a pointer sits at or below any of
a set of prefixes. That is the mechanism the classifier uses to decide what the
rules already explained.

## 3. The rule engine

`src/rules.mjs`, driven by `applyRules(before, after)`.

Seventeen rule ids: eleven `breaking`, one `warning` (`PATH_DEPRECATED`), five
`safe`. Full reference in [rules.md](rules.md).

The engine is deterministic and has no LLM in it. The same two specs always give
the same verdicts, which is what makes it unit-testable — and
`test/diff.test.mjs` asserts the *exact* hit set for the demo's v1 → v2, checking
both that nothing is missed and that nothing is invented.

Two normalisers do most of the work:

- `fieldsOf(op, pathItem)` flattens path-level parameters, operation-level
  parameters and request-body properties into one map of
  `{ name, in, type, required, enum }`, keyed `"<in>:<name>"`. Body properties
  get the synthetic location `body`. Every parameter rule below then deals with
  one shape.
- `responseFieldsOf(op)` picks the lowest-numbered `2xx` response, prefers a
  content type whose key contains `json`, unwraps `type: array` down to `items`,
  and returns its `properties`.

Each hit carries the JSON pointers it explains. Those pointers are what the next
stage subtracts.

## 4. The LLM fallback

`src/classify.mjs`.

```
hits       = applyRules(before, after)
leftovers  = diff(before, after) − IGNORED − coveredBy(hits.pointers)
```

If there are no leftovers, nothing is sent anywhere and the run costs nothing.
For the demo's v1 → v2 the rules explain the entire diff, and a test asserts
that.

`IGNORED` drops four categories of noise: `/info`, `/servers`,
`/components/schemas` (already inlined into every operation, so counting it again
would double-report), and any pointer segment named `description`, `summary`,
`example`, `examples`, `title`, `operationId` or `tags`.

What remains is sent to Claude in one request with the raw pointer deltas as
JSON, a definition of each severity, and an explicit instruction to answer with
low confidence rather than guessing `breaking`. The response is constrained by a
JSON schema requiring `pointer`, `severity`, `reason` and `confidence` per
verdict. Model: `SMA_MODEL` or `claude-opus-5`.

### The 0.7 confidence floor

`CONFIDENCE_FLOOR = 0.7`. A verdict at or above it keeps its claimed severity. A
verdict below it is stored with severity `unknown`, and its reason is suffixed
`(low confidence <n>, not auto-patched)`.

The finding is kept, not discarded. What it loses is authority: `repairable()`
only accepts `severity === 'breaking'`, so an `unknown` can never reach the
repair agent. The floor is the line between "worth telling a human about" and
"worth letting a machine edit code over". A model that is 0.55 sure a change
breaks something is useful in a report and dangerous in a codemod.

### No key, no guessing

Without `ANTHROPIC_API_KEY`, or with `--no-llm`, every leftover is recorded as
rule `UNCLASSIFIED`, severity `unknown`, with the reason
`no rule covers <pointer> and no LLM review was run`. Nothing is silently
dropped and nothing is invented. `--no-llm` therefore gives a fully
deterministic, fully offline classification path, at the cost of leaving
unmodelled deltas unjudged.

## 5. The AST inventory

`src/inventory.mjs`.

`ts-morph` parses every `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts` and
`.cts` file under `repo`, excluding `node_modules`. TypeScript and JavaScript go
through the same parser with `allowJs`.

AST rather than grep, because grep cannot tell a URL from a comment mentioning
one. A string that merely contains `/pets` is not a call site; `fetch(\`${BASE}/pets/${id}\`)`
is, and resolves to `GET /pets/{}`.

**HTTP sites.** Any call expression whose callee root is `fetch`, `axios`, `got`,
`ky` or `request`. The URL comes from `urlOf(args[0])`, which handles string
literals, no-substitution template literals, template expressions (each
`${...}` becomes `{}`), and object literals with a `url` property. The method
comes from the last segment of the callee when it is an HTTP verb
(`axios.post(...)`), else from a `method:` string in the options object, else
defaults to `GET`.

**Path shapes.** `shape(path)` rewrites every `{...}` to `{}`, so the spec's
`/pets/{id}` and the code's `` `/pets/${id}` `` compare equal.

**Unresolved URLs.** When the first argument is anything else — a variable, a
function call, a computed expression — the site goes into `unresolved` with its
file, line and snippet, and is printed as its own block by `sma scan`. It is not
silently dropped, because a silently dropped call site is an undetected break.
`test/inventory.test.mjs` asserts exactly one unresolved entry in the fixture and
that it is the `fetch(path)` case.

**Other hosts.** A URL literal that is absolute and does not start with
`baseUrl` returns `null` from `toPath()` and is ignored entirely — not even
recorded as unresolved. It belongs to someone else's API.

**SDK sites.** Only when `apis[].sdk` is set. Import roots for that module
specifier (default, named, aliased, namespace) plus any `new Root()` instance
variable become call roots; every dotted call chain starting at one is a site.

### One hop out

`callersOf()` takes each HTTP site, finds the name node of the function it lives
inside — a function declaration, a method, or a variable assigned a function —
and asks the TypeScript language service for every reference to that name. Each
reference that is not already a known site, and is not inside an import or export
declaration, becomes a `caller` site carrying the *same* method and path as the
request it wraps.

This is the rule that catches the tests. A removed response field looks, without
it, like it touches only the file holding the `fetch`. The assertions that
depend on the old shape live in a test file that mentions no URL at all and never
imports `fetch`. They break too. In the demo, four of the eight sites found are
one-hop callers in `test/api.test.mjs`.

One hop, not a full call graph, is a deliberate ceiling. It is marked as such in
the source. Three layers of wrappers are not found. A real call graph is a much
larger piece of machinery, and the wrapper-plus-its-tests case is the one that
actually recurs. If a reference lookup throws — usually because there is no
language service for that file — the site is skipped rather than failing the
whole scan.

## 6. The impact join

`src/impact.mjs`.

`buildImpact(changes, sites, spec)` pairs each change with the sites it matches.
Matching rules:

- The site's `api` must equal the change's `api`. Always.
- For `http` and `caller` sites: `shape(site.path)` must equal
  `shape(change.path)`, and if the change names a method, `site.method` must
  match it.
- For `sdk` sites: the change's `operationId` — looked up in the snapshot at
  `paths[path][method]` — must appear case-insensitively in the method chain.
- A change with no path only matches anything if its rule is in
  `WHOLE_SPEC_RULES`, which contains exactly `AUTH_SCHEME_CHANGED`.

That last one is a guard against a specific false-positive class. An
`UNCLASSIFIED` delta also has no path — a version-string bump, a vendor
extension — and letting "no path" mean "everywhere" made every such delta claim
every call site in the repo and drown the report. `test/impact.test.mjs` keeps
that regression fixed.

Changes with no matching sites are kept with `affected: false` and rendered as
`not affected (no call sites in this repo)`. Reporting them is how you tell the
mapper is matching rather than guessing.

### What counts as repairable

`repairable(impacts)` filters to `severity === 'breaking' && affected`, then
groups. Nothing else is ever handed to the agent — not `warning`, not `unknown`,
not a breaking change nobody calls.

The group key is `<api>:<rule>:<subject>`, where subject is the first present of
`detail.field`, `detail.name`, `detail.from`, `detail.scheme`, or the path. One
field removed from a shared schema surfaces as one finding per operation; the
key collapses them into a single repair carrying the list of endpoints and the
deduplicated union of their call sites. Three findings become one agent run and
one section of the PR.

## 7. The repair agent

`src/repair.mjs`.

`startSession` refuses unless `repo` is a git repository with a clean working
tree, records the current branch as `base`, and creates `sma/<api>-<stamp>`.

Each repair group gets its own agent run. `buildPrompt(impact)` writes a prompt
naming the API, the rule, the endpoints, the reason, the raw detail JSON, and
every call site as `file:line snippet`, followed by six explicit constraints:
touch only the listed files, do not refactor, keep the existing style, thread new
parameters through signatures rather than hardcoding, leave other changes from
the same spec bump alone, and **do not run any commands or tests**. The prompt is
written to `.sma/prompts/` before the run, so what was asked is auditable
afterwards.

The agent is invoked as:

```
claude -p --permission-mode acceptEdits --allowedTools Read,Edit,Write,Glob,Grep
```

with the prompt on stdin and `cwd` set to `repo`.

### Why no shell

The allowed tool list has no Bash. The agent cannot run the test suite. That is
the point: if the agent could run the tests, its report of the result would be
the evidence that the repair worked, and the thing being verified would be
verifying itself. Removing the capability removes the temptation and the
ambiguity. The agent's job is to edit; deciding whether the edit was correct is
someone else's.

### Independent verification

`finish()` does three things the agent had no part in:

1. `touchedFiles()` for the list of files that actually changed. An empty
   list means the agent made no edits — the branch is deleted and the group is
   skipped rather than opening an empty PR.
2. Runs `cfg.test ?? 'npm test'` in `repo` and records pass or fail from the
   exit code.
3. Diffs the changed-file list against the set of files the impact join
   predicted. Anything not predicted is `outsideScope`.

`needsHuman` is true if the tests failed **or** anything landed outside the
predicted impact. Either is a signal that the model's understanding and the
static analysis disagreed.

`touchedFiles()` runs `git status --porcelain --untracked-files=all`, so a file
the agent creates from scratch counts as a change like any other: it is
scope-checked against the predicted impact and can trigger `needs-human`.
`--untracked-files=all` is what keeps a new directory from collapsing to
`nested/`, which would never match a predicted path. A rename is attributed to
the new name. The diffstat in the PR body runs `git add -A` first and reads
`git diff --cached --stat`, so created files appear there too.

## 8. PR assembly

`src/pr.mjs`.

The body is built from the impacts and the agents' own summaries: one numbered
section per change with its reason, whether it was detected by the rule engine or
by LLM review, its call sites, and the agent's plain-text report quoted. Then the
diffstat, then a verification block stating the test result and the
outside-scope count, then a reviewer checklist. If `needsHuman`, a bold
`**needs-human**` paragraph is appended saying not to merge without reading it.

The body is written to `.sma/pr/<branch>.md` unconditionally, before anything is
pushed. Then `git add -A` and one commit titled
`fix(<api>): patch N breaking API change(s)`, with a bullet per rule in the body.

If `git remote` is empty, it stops there and returns a note pointing at the
markdown file — the local demo works with no GitHub involved. Otherwise it
pushes the branch and runs `gh pr create`, adding `--label needs-human` when the
verification said so. A failed `gh` call is not fatal: the note names the
failure and the body file is already on disk.

One spec bump is one branch and one PR per API. Each change gets its own focused
agent run, but they all land together — a PR that fixed half of what an upgrade
broke would fail its own test suite.

**Nothing merges automatically.** The PR is the deliverable.

## Related

- [rules.md](rules.md) — the rule table in detail.
- [cli.md](cli.md) — which command runs which stage.
- [faq.md](faq.md) — the trade-offs above, as questions.
