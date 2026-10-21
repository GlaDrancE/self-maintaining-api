# Configuration

All configuration lives in one YAML file, `watch.yaml`. It is parsed by the
`yaml` package and validated in `loadConfig()` in `src/store.mjs`. There are no
other config files, no `package.json` section, and no CLI flags that set config
values.

## Minimal file

```yaml
repo: .

apis:
  - name: petstore
    spec: http://localhost:8787/openapi.json
    baseUrl: http://localhost:8787
```

## Key reference

| Key | Type | Required | Default | Notes |
|---|---|---|---|---|
| `repo` | string | yes | — | Path to the repo sma scans and patches. Resolved against the directory holding `watch.yaml`, not the cwd. Must exist. |
| `test` | string | no | `npm test` | Shell command used to verify a repair. Run with `shell: true` in `repo`. |
| `apis` | list | yes | — | Must be a non-empty array. |
| `apis[].name` | string | yes | — | Charset-restricted, must be unique. Becomes `.sma/specs/<name>.json`. |
| `apis[].spec` | string | yes | — | `http://` or `https://` URL, or a local file path. |
| `apis[].baseUrl` | string | no | none | Origin prefix stripped from matched URLs during the AST scan. |
| `apis[].sdk` | string | no | none | Module specifier. When set, SDK method chains are also scanned. |

Any other key in the file is parsed and ignored. There is no unknown-key check.

### `repo`

```yaml
repo: ./services/checkout
```

Resolved as `resolve(dirname(configFile), repo)`, then checked with `existsSync`.
A missing directory throws `repo not found: <absolute path>`.

The resolution is deliberately relative to the config file. Without that,
`repo: ./app` would mean a different directory depending on which subdirectory
you ran `sma` from. `test/store.test.mjs` asserts this.

`repo` does not have to be a git repository for `scan`, `check` or `impact`. It
does for `fix`, which throws `<path> is not a git repo — cannot branch`.

### `test`

```yaml
test: npm run test:integration
```

Passed to `spawnSync` as a single shell string with `cwd` set to `repoPath`. Only
`fix` uses it. A zero exit is a pass; anything else is a fail and marks the PR
`needs-human`.

### `apis[].name`

Validated against `/^[a-zA-Z0-9._-]+$/`. Letters, digits, dot, dash, underscore.
A violation throws:

```
watch.yaml: api name "bad name" must be letters, digits, dot, dash or underscore
```

The restriction exists because the name is interpolated straight into a file path
— `.sma/specs/${name}.json` — so it is a trust boundary. A name like `../../etc`
in a config file must not decide where sma writes. `test/store.test.mjs` asserts
that case is rejected.

Duplicate names are rejected as well:

```
watch.yaml: duplicate api name "petstore"
```

Snapshots are keyed by name. Two APIs sharing one would silently overwrite each
other's baseline and each would diff against the other's spec.

The name is also the join key between changes and call sites. `impact.mjs`
refuses to match a site whose `api` differs from the change's.

### `apis[].spec`

A string matching `/^https?:\/\//` is fetched over HTTP; anything else is read
from disk. Both JSON and YAML work — YAML is a superset of JSON, so one parser
handles both.

A relative local spec path is resolved against the **config file's directory**,
the same rule `repo` follows, so `--config ../watch.yaml` reads the same spec
from anywhere. Absolute paths are used as given. `test/watcher.test.mjs` asserts
this.

HTTP failures are unwrapped rather than reported as `fetch failed`:

```
could not fetch http://localhost:8787/openapi.json: ECONNREFUSED — is the server running? (`node demo/petstore/server.mjs`)
could not fetch https://api.example.com/openapi.json: HTTP 404 Not Found
```

The `is the server running?` hint is only appended when the code is
`ECONNREFUSED` and the URL contains `localhost` or `127.0.0.1`.

A fetch that gets no response in 60 seconds fails with the API named. HTTP 429
and 5xx are retried up to three times, honouring `Retry-After` (capped at 30s).
A credential in the URL's query string (`api_key=`, `token=`, `sig=`, ...) is
masked as `***` in errors, the PR body, and the HTML report.

### `apis[].headers`

```yaml
headers:
  Authorization: "Bearer ${SPEC_TOKEN}"
```

Sent with the spec request only. `${VAR}` is read from the environment at fetch
time, so the token lives in a CI secret and is never written to `watch.yaml` or
`.sma/`. An unset variable is an error naming it, not a silent empty header.

### `apis[].baseUrl`

Used only by the AST scanner, in `toPath()` in `src/inventory.mjs`. A URL
literal that starts with `baseUrl` has that prefix stripped and the remainder is
treated as the spec path. Matching is a plain `startsWith` on the raw string —
no URL normalisation, so a trailing slash or a differing scheme will not match.

Without `baseUrl`, only two forms still resolve: a URL literal that begins with
`/`, and a template literal whose first `${...}` is the origin (`` `${BASE}/pets` ``
arrives as `{}/pets` and the leading `{}` is dropped). An absolute
`http(s)://` literal that does not start with `baseUrl` is treated as another
host and ignored.

### `apis[].sdk`

```yaml
sdk: "@octokit/rest"
```

The exact module specifier as written in the `import`. `collectSdk()` collects
default, named, aliased and namespace imports of that specifier as call roots,
plus any variable initialised with `new <Root>()`. Every call expression whose
chain starts at one of those roots is recorded as a site of kind `sdk`.

An SDK site matches a change when the change's `operationId` appears
case-insensitively somewhere in the method chain text. That works for SDKs
generated from the spec and is a guess for hand-written ones.

## Config discovery

`src/store.mjs` picks the config file once, at module load, in this order:

| Precedence | Source | Notes |
|---|---|---|
| 1 | `--config <path>` | The argument immediately after `--config` anywhere in `process.argv`. |
| 2 | `SMA_CONFIG` | Environment variable holding a path. |
| 3 | Upward search | Nearest `watch.yaml` walking up from the cwd, stopping at the filesystem root. |
| 4 | Fallback | `<cwd>/watch.yaml`, whether or not it exists. |

The result is passed through `resolve()`, so relative paths in `--config` and
`SMA_CONFIG` are relative to the cwd. `ROOT` is the directory holding the chosen
config; `.sma/` always lives there, not in the cwd.

Finding nothing is not an error at discovery time — `init`, `doctor`, `version`
and `help` all have to run before a config exists. The absence becomes an error
in `loadConfig()`:

```
no watch.yaml in /some/dir or any parent directory — run `sma init`
```

The upward search is why `sma check` from a subdirectory behaves the same as from
the root. Without it, running from `src/` would start a fresh project against an
empty `.sma/` and report `baseline captured` forever. `test/store.test.mjs`
covers both the walk and the stop-at-root case.

## Environment variables

| Variable | Read by | Effect |
|---|---|---|
| `ANTHROPIC_API_KEY` | `src/classify.mjs`, `doctor` | Enables the LLM fallback for deltas no rule explains. Without it those deltas become `UNCLASSIFIED`. The Anthropic SDK client reads the key itself; sma only tests for presence. |
| `GH_TOKEN` or `GITHUB_TOKEN` | `doctor` | `doctor` reports either one as present. sma never reads the value — `gh` does. |
| `SMA_CONFIG` | `src/store.mjs` | Config path, below `--config` and above the upward search. |
| `SMA_MODEL` | `src/classify.mjs` | Model id for the fallback. Defaults to `claude-opus-5`. Undocumented in `--help`. |

## Examples

### A local spec file, a remote URL, and an SDK-matched API

```yaml
repo: .
test: npm run test:unit

apis:
  # A spec vendored into this repo. Path is relative to this file, like `repo`.
  - name: billing
    spec: ./contracts/billing.openapi.yaml
    baseUrl: https://billing.internal.example.com

  # A public spec fetched over HTTP on every run.
  - name: stripe
    spec: https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json
    baseUrl: https://api.stripe.com

  # Matched through an SDK's method chains as well as raw HTTP.
  - name: github
    spec: https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json
    baseUrl: https://api.github.com
    sdk: "@octokit/rest"
```

That produces three baselines: `.sma/specs/billing.json`,
`.sma/specs/stripe.json`, `.sma/specs/github.json`. Commit all three.

### A monorepo service

```yaml
repo: ./services/orders
test: npm --prefix services/orders test

apis:
  - name: inventory
    spec: https://inventory.example.com/openapi.json
    baseUrl: https://inventory.example.com
```

`test` runs with `cwd` set to `repoPath`, so a command written for the monorepo
root needs adjusting. See [faq.md](faq.md#monorepos).

## `.sma/` layout

| Path | Written by | Tracked |
|---|---|---|
| `.sma/specs/<name>.json` | `check` | **yes — this is the baseline** |
| `.sma/inventory.json` | `scan` | no |
| `.sma/changes/<stamp>.json` | `check` | no |
| `.sma/impact/<stamp>.json` | `impact` | no |
| `.sma/prompts/<slug>.txt` | `fix` | no |
| `.sma/pr/<branch>.md` | `fix` | no |
| `.sma/runs.json` | `fix` | no |

Everything is plain JSON, readable with `cat` and diffable with `git`.

## Related

- [cli.md](cli.md) — which command reads and writes which of these.
- [troubleshooting.md](troubleshooting.md) — every config error message and its fix.
