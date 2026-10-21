# Onboarding a project

The checklist for adding sma to project number N. Copy-pasteable, start to
finish. Budget thirty minutes, most of it spent on step 4.

Commands assume sma installed into the project (`npm i -D self-maintaining-api`,
then `npx sma`). Running it from a clone works the same way: replace `npx sma`
with `node /path/to/Self-MaintainingAI/sma.mjs`. sma finds its config by walking
up from the cwd to the nearest `watch.yaml`, the way git finds `.git`
(`src/store.mjs:13-19`), so run everything from the project root.

## 1. Prerequisites

```bash
cd /path/to/project
npx sma doctor
```

Read the table. Only the first two rows block anything:

| Row | Needed for | If it is MISS |
|---|---|---|
| `node` | everything | Install node 22 or later. Nothing works below that. |
| `config` | everything | Expected at this point. Step 2 fixes it. |
| `git` | branching, PRs | Detection still works. `--fix` does not. |
| `ANTHROPIC_API_KEY` | judging deltas no rule models | They are reported as `UNCLASSIFIED` instead. Fine for onboarding. |
| `claude CLI` | `--fix` | `sma fix` refuses with a message (`sma.mjs:169-173`). |
| `gh CLI` | opening the PR | The PR body is written to `.sma/pr/` and printed (`src/pr.mjs:68-70`). |
| `GH_TOKEN` | opening the PR | Same. |

- [ ] `npx sma doctor` prints `Detection works.` or, at this stage, only the
      config row is MISS.

## 2. Write `watch.yaml`

```bash
npx sma init
```

With no config present this writes a commented template and stops
(`sma.mjs:81-86`). Edit it:

```yaml
# The repo that gets scanned and patched, relative to this file.
repo: .

# How sma runs your test suite to verify an agent's edit. Defaults to `npm test`.
test: npm test

apis:
  - name: acme
    spec: https://api.acme.example/openapi.json
    baseUrl: https://api.acme.example
    # sdk: "@acme/client"   # only for a generated, operationId-named SDK
```

Field by field:

| Field | Rules |
|---|---|
| `repo` | Required. Resolved against the config file, not the cwd (`store.mjs:70`). Must exist or `loadConfig` throws (`store.mjs:71`). |
| `test` | Optional; defaults to `npm test`. Run through a shell in the repo directory (`repair.mjs:67-72`). Make it the command that fails when the API contract breaks. |
| `name` | Required. Letters, digits, dot, dash, underscore only — it becomes a filename under `.sma/specs/` (`store.mjs:60-62`). Must be unique (`store.mjs:63`). |
| `spec` | Required. An `http://` or `https://` URL, or a local path (`watcher.mjs:24`). JSON or YAML. No auth headers are sent — a spec behind a token will not work today. |
| `baseUrl` | Optional but nearly always needed. **This is the field that decides whether the scan finds anything.** See step 4. |
| `sdk` | Optional. Must equal the import specifier exactly (`inventory.mjs:177`). |

Getting `baseUrl` right, before you go further: take a real request URL from
your code and the `servers[0].url` from the spec. `baseUrl` must be the prefix
that, once removed from your request URL, leaves a path that appears verbatim in
the spec's `paths`. Include any version segment. No trailing slash.

- [ ] `watch.yaml` written, committed alongside the rest of this work.

## 3. Capture and commit the baseline

```bash
npx sma init          # config exists now, so this captures the baseline
git add .gitignore .sma/specs
git commit -m "chore: sma baseline"
```

`init` also appends the per-run artifact paths to `.gitignore`
(`sma.mjs:55-62`), leaving `.sma/specs/` tracked on purpose.

Verify:

```bash
git ls-files .sma        # must list .sma/specs/<name>.json and nothing else
```

- [ ] `.sma/specs/<name>.json` exists and is committed.
- [ ] `.sma/changes/`, `.sma/impact/`, `.sma/inventory.json` are ignored.
- [ ] The first run printed `baseline captured (N endpoints)` with an `N` that
      matches the API you think you are watching.

If the baseline is ever lost, every subsequent run is a first run and sma
reports all clear forever while detecting nothing. That is the one failure the
whole design is arranged around.

## 4. Verify the scan found the right call sites

This is the step that decides whether the tool works on this project. Do not
skip it, and do not accept a plausible-looking count.

```bash
npx sma scan
```

Read every line against what you know:

- [ ] Every place the project talks to this API appears, with the right file,
      line, method and path.
- [ ] The paths printed match paths in the spec, character for character, once
      `{...}` is collapsed (`inventory.mjs:11`).
- [ ] The methods are right. A `POST` printed as `GET` will never match a `POST`
      change.
- [ ] Nothing listed is not actually a call to this API.
- [ ] The unresolved list is short and you recognise each entry.

### When the scan finds nothing

`scan` prints two lists: resolved call sites, and requests whose URL could not
be resolved statically. A call site can also be dropped from **both** — that is
what makes this confusing, and it is almost always one of the first three rows
below.

| Symptom | Cause in `src/inventory.mjs` | Fix |
|---|---|---|
| Zero sites, zero unresolved | `toPath` returned null. Your URL starts with `http` but does not start with `baseUrl`, so line 155 drops it silently. A scheme mismatch (`http` vs `https`), a trailing slash, a `www.`, or a missing version segment is enough. | Correct `baseUrl`. Check it against a literal URL in your source. |
| Zero sites, but the request is a template literal | `${BASE}/pets` arrives as `{}/pets` and line 154 strips the leading `{}`. `${BASE}pets` arrives as `{}pets`, becomes `pets`, fails the leading-slash test on line 156, and is dropped. | Put the slash in the template, not in `BASE`. |
| Sites found but never matched by `impact` | The path resolved, but it is not a path in the spec. A spec with `servers: [{url: "https://api.x/v2"}]` and `paths: /pets` is called at `https://api.x/v2/pets`, so `baseUrl` must be `https://api.x/v2`. | Extend `baseUrl` to include the prefix. |
| Zero sites, code uses an HTTP client | Line 103 matches on the **root** of the callee text: `callee.split('.')[0]` must be one of `fetch, axios, got, ky, request` (line 7). `client.get(url)` where `client = axios.create(...)` has root `client` and is not matched. Nor is `globalThis.fetch`, nor `this.http.get`. | For now, call the library by its own name at the call site, or accept that this project needs the proposed configurable-client-names work. Do not rename production code to suit the scanner without noting why. |
| The URL is in a variable | `urlOf` (lines 131-146) handles a string literal, a template literal, and an object literal with a `url` property. Anything else returns null and the request is reported as **unresolved**, not dropped. | Inline the path at the call site, or accept the unresolved entry and review it by hand. It will appear in the report; it will never be patched. |
| The method is wrong | `methodOf` (lines 160-169) reads the verb from the callee's last segment, then a literal `method:` in the second argument, then defaults to `GET`. A computed method (`{ method: verb }`) reads as `GET`. | Use a literal method string at the call site, or expect only `GET` changes to match. |
| SDK sites missing | `collectSdk` requires an import whose specifier equals `api.sdk` exactly (line 177), then chains rooted at that import or at a `new` instance of it (lines 186-190). A re-exported or dependency-injected client is invisible. | Set `sdk:` to the exact specifier. If the client is injected, it will not be found — note it in the pilot log. |
| Sites found, but no callers | `callersOf` needs the enclosing function to have a **name** (`enclosingName`, lines 87-95): a function declaration, a method, or a named variable holding a function. An anonymous arrow passed inline, or an unnamed default export, has no name node and yields no callers. | Name the function. This matters more than it looks: the one-hop callers are what catch the tests asserting the old response shape. |
| Requests to other hosts silently absent | By design — `test/inventory.test.mjs:37` asserts it. | Nothing to fix. |

### When the scan finds too much

| Symptom | Cause | Fix |
|---|---|---|
| The same call site reported several times | One entry per API in `watch.yaml` whose `baseUrl` matches (`inventory.mjs:29-32`). Two APIs on the same host both claim it. | Give each API a `baseUrl` specific enough to separate them. |
| Hundreds of sites in `dist/`, `build/`, `coverage/` | Line 20 globs every JS and TS file under `repo` and excludes only `node_modules`. | Point `repo:` at your source directory (`repo: ./src`) rather than the project root, or delete the build output before scanning. Excluding paths in config is proposed, not built. |
| Sites in vendored or generated code | Same cause. | Same fix. |
| An SDK chain matched that is nothing to do with the API | `impact.mjs:32` tests whether the `operationId` is a substring of the method chain, case-insensitively. A short `operationId` like `get` matches everything. | Treat SDK matches as advisory on this project. Record it in the pilot log. |

Do not move on until `sma scan` is right. Everything downstream — the impact
join, the agent prompt, the outside-scope check — is built on this list.

## 5. Dry run the whole pipeline

```bash
npx sma run
```

On the first run after the baseline this reports no changes, because the
snapshot was just captured. That is expected and is what `sma.mjs:117-121`
prints. What you are checking here is that `scan`, `check` and `impact` all
complete and the exit code is 0.

- [ ] `npx sma run` exits 0 and prints a scan summary plus `0 change(s)`.
- [ ] `echo $?` (or `$LASTEXITCODE`) is 0.

## 6. Add the CI workflow

Use the workflow in `docs/pilot-plan.md`, stage 3. Start with only
`workflow_dispatch` and add the `schedule:` block once you have watched a manual
run succeed.

- [ ] `.github/workflows/sma.yml` added.
- [ ] `permissions: { contents: write, pull-requests: write }` present — the job
      pushes the updated baseline and opens PRs.
- [ ] A `concurrency:` group is set, so two runs never share the worktree.
- [ ] The final step re-exits sma's real code, so exit 1 and exit 2 stay
      distinguishable (`sma.mjs:19`).
- [ ] No cache step for `.sma/`. The baseline is committed; a cache eviction
      would silently reset detection.

## 7. Secrets

| Secret | Where | Needed for |
|---|---|---|
| `ANTHROPIC_API_KEY` | repository secret | Judging deltas no rule models, and the repair agent. Without it, detection still works and unmodelled deltas become `UNCLASSIFIED` (`classify.mjs:82-97`). |
| `GH_TOKEN` | `${{ secrets.GITHUB_TOKEN }}` | `gh pr create`. The built-in token is enough with the permissions above. |

Do not put a token in the `spec:` URL. Use `headers:` with `${VAR}` from a CI secret
(see [configuration.md](configuration.md#apisheaders)). A query-string credential is
masked in output, but `headers:` keeps it out of `watch.yaml` entirely.

- [ ] `ANTHROPIC_API_KEY` set, or deliberately not set with the consequence
      understood.
- [ ] No credential anywhere in `watch.yaml`.

## 8. The first real detection

Wait for it. Do not fake one by editing the committed baseline — a hand-edited
snapshot produces findings that teach you nothing about the API.

When it arrives:

```bash
npx sma run                            # read the report
cat .sma/impact/*.json | head -50      # the same thing, structured
cat .sma/prompts/*.txt                 # what the agent would be told, if --fix
```

- [ ] Every reported change is real — confirmed against the upstream release
      notes or the spec diff itself.
- [ ] Every change reported as not-affected genuinely has no call site.
- [ ] A row is written in the project's observation log
      (template in `docs/pilot-plan.md`).
- [ ] The new baseline is committed, whether or not you acted on the change.
      Skipping this re-reports the same change tomorrow.

## Definition of done

- [ ] `watch.yaml` committed, with a correct `baseUrl` and a `test:` command
      that fails when the API contract breaks.
- [ ] `.sma/specs/<name>.json` committed; the per-run paths ignored.
- [ ] `npx sma doctor` clean for every layer this project actually uses.
- [ ] `npx sma scan` output read line by line and agreed with.
- [ ] `npx sma run` exits 0 on a quiet day.
- [ ] The workflow has run manually at least once and was green.
- [ ] The schedule is enabled.
- [ ] Secrets set; no credential in the config.
- [ ] One real detection has been reviewed and logged.
- [ ] Somebody other than sma knows this is running: a line in the project's
      own README saying what opens those PRs.
