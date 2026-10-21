# FAQ

## Does it merge anything automatically?

No. Nothing in the codebase calls `gh pr merge`, `git merge`, or a merge API.
The furthest `src/pr.mjs` goes is `gh pr create`, and it adds the label
`needs-human` when the harness's own verification failed.

The PR is the deliverable. A human reads the diff, the test result, the list of
files the agent touched outside the predicted impact, and the agent's own
summary, and then decides.

## What does it cost to run?

Three separable costs.

**Detection costs nothing.** Fetch, `$ref` inlining, structural diff and the rule
engine are plain JavaScript. A run where nothing changed is one HTTP GET per API
and zero tokens. The bundled test suite runs the entire rule engine against both
petstore specs with no network and no key.

**The LLM fallback costs tokens only when the rules leave something
unexplained.** `classify()` computes the leftover deltas first and returns early
if there are none. For the demo's v1 → v2 the rules explain the whole diff and
nothing is sent. When something *is* left over, it is one request per API per
run, carrying only the leftover JSON-pointer deltas — not the spec, not your
code. The default model is `claude-opus-5`, overridable with `SMA_MODEL`.

**Repair costs the most, and only when you pass `--fix`, and only for changes
that are both breaking and actually called.** One headless Claude Code session
per repair group. Grouping matters here: one field removed from a shared schema
that surfaces on three operations is one agent run, not three.

Run `sma run` without `--fix` and the cost is detection plus, at most, one
classification request.

## Does it send my source code anywhere?

Detection and classification do not. The AST scan is local `ts-morph`. The
classification request contains the API name and the leftover JSON-pointer deltas
from the two **specs** — no file contents, no file names, no snippets.

`--fix` does. It runs the `claude` CLI with `cwd` set to your repo and tools
`Read,Edit,Write,Glob,Grep`, so the agent reads whatever files it needs to make
the edit. The prompt sma hands it contains the call sites as `file:line snippet`.
Every prompt is written to `.sma/prompts/` before the run, so you can read
exactly what was sent.

If that is not acceptable, run without `--fix`. You get the full report and
patch it yourself. If even the classification request is not acceptable, add
`--no-llm` and nothing leaves the machine except the spec fetches.

## What about a private or authenticated spec URL?

Add `headers:` to the API entry. `${VAR}` is read from the environment at fetch
time, so the token stays in a CI secret and never lands in `watch.yaml` or `.sma/`:

```yaml
apis:
  - name: billing
    spec: https://api.internal/openapi.json
    headers:
      Authorization: "Bearer ${BILLING_SPEC_TOKEN}"
```

An unset variable fails the run with its name rather than sending an empty header.
A credential left in the URL's query string is masked as `***` in errors, PR bodies
and the HTML report. Even so, prefer `headers:`.

Client certificates and network-only access still need either a self-hosted runner
inside the perimeter, or a prior CI step that fetches the spec to a file and
`spec: ./contracts/billing.json`.

## Does it work with GraphQL or gRPC?

No. The entire detector is OpenAPI-shaped. `src/rules.mjs` reads `paths`,
per-method operations, `parameters`, `requestBody`, `responses` and
`components.securitySchemes`. Nothing in it maps onto a GraphQL SDL or a
`.proto`.

The call-site scanner is closer to reusable — it looks for HTTP calls and SDK
method chains — but a GraphQL client posts every operation to the same URL, so
path matching would attribute every change to every call site.

Supporting either means a second rule engine and a second inventory strategy.
Nothing in the current code is a step toward that.

## TypeScript or JavaScript?

Both, through one parser. The scan adds
`**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}` with `allowJs: true`, so a mixed repo
works with no configuration.

There is one difference that matters. The one-hop caller pass calls
`findReferencesAsNodes()`, which needs the TypeScript language service. If the
lookup throws for a file — the source catches it and comments "no language
service for this file" — that site is skipped for the caller pass and the scan
continues. The direct HTTP site is still found; only its callers are missed. In
practice TypeScript resolves references more reliably than loose JavaScript,
especially across module boundaries with dynamic exports.

sma does not read `tsconfig.json`. The project is created with
`skipAddingFilesFromTsConfig: true` and one compiler option, `allowJs`. Path
aliases, custom module resolution and project references have no effect on the
scan.

Type information is not used for matching. A typed client whose generated
interfaces change is found through the same `fetch` and method-chain matching as
untyped code.

## Monorepos?

One `watch.yaml` points at one `repo`. There is no glob, no workspace list, no
array of repos.

Two workable shapes:

**One config per service.** Each service directory gets its own `watch.yaml`,
its own `.sma/`, and its own baseline. The upward config search means running
`sma check` from inside a service finds that service's config. This keeps
baselines and reports scoped to the service that owns the integration, and lets
services watch different APIs.

```
repo/
  services/orders/watch.yaml     # repo: .
  services/orders/.sma/specs/
  services/billing/watch.yaml    # repo: .
  services/billing/.sma/specs/
```

**One config at the root.** `repo: .` scans the whole tree — every service, every
package. Everything shares one baseline and one report, which is simpler to
schedule and much noisier to read. `node_modules` is excluded, but nothing else
is; there is no ignore list for the scan beyond that.

Whichever you pick, `test` runs with `cwd` set to `repoPath`, so a root-level
config needs a command that works from the root:

```yaml
repo: .
test: npm run test --workspaces
```

A per-service config can use the plain `npm test`.

## Why one hop and not a full call graph?

Because one hop catches the case that actually recurs, and a call graph is a
much larger piece of machinery to maintain and to trust.

The case is: a `fetch` inside a wrapper function, and a test file that calls the
wrapper and asserts the old response shape. The test mentions no URL, imports no
HTTP client, and lives nowhere near the request — and it breaks. Without the
caller pass, a removed response field looks like it touches exactly one file. In
the bundled demo, four of the eight sites found are one-hop callers in the test
file.

What one hop misses is three layers of wrappers. A request in `http.js`, wrapped
in `petsClient.js`, wrapped in `petsService.js`, called from a test — the test is
two hops out and is not found. The source marks this as a deliberate ceiling and
names the upgrade path.

The honest reason to stop at one is precision. Reference resolution is
approximate in loose JavaScript, and each additional hop multiplies both the
false-positive rate and the number of files a repair agent is told it may touch.
A report that names four files you should look at is useful; one that names
forty is a call graph printed as a to-do list.

## Why commit the baseline instead of caching it?

Because losing it fails silently.

`.sma/specs/<name>.json` is what the spec looked like last time, and every
detection is a diff against it. With no snapshot, `check` takes its first-run
branch, prints `baseline captured`, and exits 0. The job is green. The PR list is
empty. The detector is doing nothing, and there is no signal anywhere that says
so.

A cache can be evicted by policy, by a key change, by a runner migration. A
committed file cannot. Its absence shows up in `git status` and its history shows
up in `git log`.

That history is the second reason: `git log .sma/specs/stripe.json` is the log of
every change that API has shipped since you started watching it, in a form you
can `git show` and `git diff` like any other file.

`sma init` writes a `.gitignore` block that ignores five paths under `.sma/` and
deliberately leaves `specs/` out. If you replace that block with a blanket
`.sma/`, you have turned detection off without turning anything off.

## How do I turn the LLM off entirely?

`--no-llm`, on any command that classifies:

```bash
sma check --no-llm
sma run --no-llm
```

The flag must come after the command name. `classify()` checks
`!useLlm || !process.env.ANTHROPIC_API_KEY` and takes the no-key branch, so
simply not setting `ANTHROPIC_API_KEY` has the same effect on classification.

Either way, the rule engine still runs in full — all seventeen rules, all
severities, all impact mapping. What you lose is the judgement on deltas no rule
models: they come back as `UNCLASSIFIED` with severity `unknown` instead of a
severity and a confidence. `unknown` is never repairable, so they are reported
for a human and never auto-patched.

The rule path is deterministic. The same two specs always produce the same
verdicts, which is what makes `test/diff.test.mjs` able to assert an exact hit
set. If reproducibility matters more to you than coverage of the long tail,
`--no-llm` is the right default.

Note that `--no-llm` does not affect `--fix`, which is a separate stage with its
own prerequisite. To turn off everything model-driven, use `--no-llm` and do not
pass `--fix`.

## Related

- [how-it-works.md](how-it-works.md) — the reasoning behind each of these trade-offs.
- [configuration.md](configuration.md) — the keys and environment variables named above.
- [rules.md](rules.md) — what the deterministic path actually covers.
