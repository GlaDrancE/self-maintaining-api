# Breaking-change rules

The complete rule table from `src/rules.mjs`. Seventeen rules: eleven
`breaking`, one `warning`, five `safe`. No LLM is involved — the same two specs
always produce the same hits. `test/diff.test.mjs` asserts the exact hit set for
the bundled petstore v1 → v2, including the absence of false positives.

| Rule | Severity |
|---|---|
| [`PATH_REMOVED`](#path_removed) | breaking |
| [`METHOD_REMOVED`](#method_removed) | breaking |
| [`REQUIRED_PARAM_ADDED`](#required_param_added) | breaking |
| [`PARAM_REMOVED`](#param_removed) | breaking |
| [`PARAM_RENAMED`](#param_renamed) | breaking |
| [`PARAM_TYPE_CHANGED`](#param_type_changed) | breaking |
| [`PARAM_MADE_REQUIRED`](#param_made_required) | breaking |
| [`RESPONSE_FIELD_REMOVED`](#response_field_removed) | breaking |
| [`RESPONSE_FIELD_TYPE_CHANGED`](#response_field_type_changed) | breaking |
| [`ENUM_VALUE_REMOVED`](#enum_value_removed) | breaking |
| [`AUTH_SCHEME_CHANGED`](#auth_scheme_changed) | breaking |
| [`PATH_DEPRECATED`](#path_deprecated) | warning |
| [`PATH_ADDED`](#path_added) | safe |
| [`METHOD_ADDED`](#method_added) | safe |
| [`OPTIONAL_PARAM_ADDED`](#optional_param_added) | safe |
| [`RESPONSE_FIELD_ADDED`](#response_field_added) | safe |
| [`ENUM_VALUE_ADDED`](#enum_value_added) | safe |

Two non-rule ids also appear in reports: `UNCLASSIFIED` (a delta no rule covers,
with no LLM review available) and `LLM_REVIEWED` (a delta judged by the
fallback). Neither is in the table above, and only a `LLM_REVIEWED` finding at or
above the confidence floor can ever be `breaking`. See
[how-it-works.md](how-it-works.md#4-the-llm-fallback).

## How the engine reads a spec

Before any rule fires, two normalisers flatten the operation.

**Parameters.** `fieldsOf(op, pathItem)` merges path-item-level `parameters`,
operation-level `parameters`, and request-body properties into one map keyed
`"<in>:<name>"`, each entry `{ name, in, type, required, enum }`. Request-body
properties get the synthetic location `body`, and are required if they appear in
the schema's `required` array. Every parameter rule below operates on that map,
so a query parameter, a header and a body field are handled identically.

The `type` compared is `parameter.schema.type` (falling back to the Swagger 2
`parameter.type`). Only `type`. A change to `format`, `pattern`, `minimum`,
`nullable` or `items` is invisible to the parameter rules and falls through to
the LLM fallback or to `UNCLASSIFIED`.

**Responses.** `responseFieldsOf(op)` picks the lowest-numbered `2xx` response
code, then within it the first content type whose key contains `json` (else the
first content type at all), unwraps `type: array` down to `items` repeatedly, and
returns that schema's `properties`. Only the top level of `properties` is
compared. A field nested inside another object property is not modelled.

Method coverage is `get`, `put`, `post`, `delete`, `patch`, `head`, `options`,
`trace`.

---

## `PATH_REMOVED`

**Severity:** breaking.
**Triggers when:** a key of `paths` in the old spec is absent from the new one.
**Pointer:** `/paths/<path>`.
**Reason text:** `endpoint <path> no longer exists`.

When it fires, no method-level rules run for that path — the whole path item is
gone, so reporting each method separately would be noise.

```yaml
# before
paths:
  /pets/{id}:
    get: { operationId: getPet, responses: { "200": { description: a pet } } }

# after
paths: {}
```

**What it breaks:** every request to that URL, immediately. The client gets a 404
or the gateway's equivalent. There is no forward-compatible way to absorb this —
the code has to move to a different endpoint.

---

## `METHOD_REMOVED`

**Severity:** breaking.
**Triggers when:** the path still exists but an operation on it does not.
**Pointer:** `/paths/<path>/<method>`.
**Reason text:** `<METHOD> <path> was removed`.

```yaml
# before
paths:
  /pets:
    get: { operationId: listPets }
    post: { operationId: createPet }

# after
paths:
  /pets:
    get: { operationId: listPets }
```

**What it breaks:** the write path, usually. A `405 Method Not Allowed` from code
that was correct yesterday. Often harder to spot than a removed path, because
the GET beside it still works and health checks stay green.

---

## `REQUIRED_PARAM_ADDED`

**Severity:** breaking.
**Triggers when:** a parameter or body property exists in the new operation, did
not exist in the old one, and has `required: true` (or is listed in the request
body schema's `required` array).
**Detail:** `{ name, in, type }`.
**Reason text:** `new required <in> parameter '<name>'`.

Suppressed if the rename heuristic claimed the addition — see
[`PARAM_RENAMED`](#param_renamed).

```yaml
# before
NewPet:
  type: object
  properties:
    name: { type: string }
    tag:  { type: string }
  required: [name]

# after
NewPet:
  type: object
  properties:
    name:    { type: string }
    tag:     { type: string }
    ownerId: { type: integer }
  required: [name, ownerId]
```

This is the demo's `POST /pets` change. The rule fires as
`REQUIRED_PARAM_ADDED POST /pets` with detail
`{ name: 'ownerId', in: 'body', type: 'integer' }`.

**What it breaks:** every existing call, with a 400. The repair is rarely local:
the new value has to come from somewhere, so it usually has to be threaded up
through the wrapper's signature and into its callers. That is why the repair
prompt has an explicit rule about threading rather than hardcoding.

---

## `PARAM_REMOVED`

**Severity:** breaking.
**Triggers when:** a parameter or body property present in the old operation is
absent from the new one, and the rename heuristic did not claim it.
**Detail:** `{ name, in }`.
**Reason text:** `<in> parameter '<name>' was removed`.

```yaml
# before
/pets:
  get:
    parameters:
      - { name: limit,  in: query, schema: { type: integer } }
      - { name: offset, in: query, schema: { type: integer } }

# after
/pets:
  get:
    parameters:
      - { name: limit, in: query, schema: { type: integer } }
```

**What it breaks:** depends on the server. A strict API rejects the unknown
parameter with a 400 — the demo's petstore does exactly that. A lenient one
ignores it, which is worse: pagination quietly stops working and nothing fails.

---

## `PARAM_RENAMED`

**Severity:** breaking.
**Triggers when:** across the whole normalised field map for one operation,
**exactly one** field was removed and **exactly one** was added, and the two share
the same `in` and the same `type`.
**Detail:** `{ from, to, in }`.
**Reason text:** `<in> parameter '<from>' was renamed to '<to>'`.

```yaml
# before
/pets:
  get:
    parameters:
      - { name: limit, in: query, required: false, schema: { type: integer } }

# after
/pets:
  get:
    parameters:
      - { name: pageSize, in: query, required: false, schema: { type: integer } }
```

Hit: `PARAM_RENAMED GET /pets`, detail
`{ from: 'limit', to: 'pageSize', in: 'query' }`.

### The heuristic

Inference is **structural, not lexical**. `limit` and `pageSize` share no
letters, so any string-similarity approach misses this entirely. What the two
have in common is their position in the spec: same location, same type, and they
are the only two things that moved. `test/diff.test.mjs` asserts this exact case
and says so in a comment.

The four preconditions, all required:

1. `removed.length === 1` over the merged field map for that one operation.
2. `added.length === 1` over the same map.
3. `from.in === to.in`.
4. `from.type === to.type`.

The map merges path parameters, operation parameters and body properties, so the
counts are per operation, not per parameter list. A removed query parameter and
an added body property on the same operation are both in scope for the count.

When it fires, `PARAM_REMOVED` and `REQUIRED_PARAM_ADDED`/`OPTIONAL_PARAM_ADDED`
are skipped for that operation — the function returns straight into
`compareCommonFields`, which still checks the untouched fields for type changes,
new requirements and enum deltas.

### Known failure modes

**False positive.** The heuristic cannot distinguish a rename from an unrelated
removal and an unrelated addition that happen to share a location and a type. An
upstream release that drops the `sort` query string and adds a `filter` query
string in the same operation is reported as `PARAM_RENAMED sort → filter`. The
severity is right — both are breaking — but the reason and the detail handed to
the repair agent are wrong, and the agent will be told to rename a call-site
parameter rather than remove one and add another.

**False negative, two renames.** Two simultaneous renames on one operation make
the counts 2 and 2, the heuristic does not fire, and the result is two
`PARAM_REMOVED` hits plus two `*_PARAM_ADDED` hits. Correctly breaking, less
useful for a repair.

**False negative, retyped rename.** A rename that also changes the type
(`limit: integer` → `pageSize: string`) fails precondition 4 and comes out as a
removal plus an addition.

The source marks this as a deliberate ceiling and names the upgrade path: swap in
a real rename map if an API ever publishes one.

---

## `PARAM_TYPE_CHANGED`

**Severity:** breaking.
**Triggers when:** a field with the same `in` and `name` exists on both sides and
`from.type !== to.type`.
**Detail:** `{ name, in, from, to }`.
**Reason text:** `<in> parameter '<name>' changed type from <from> to <to>`.

```yaml
# before
- { name: id, in: path, required: true, schema: { type: integer } }

# after
- { name: id, in: path, required: true, schema: { type: string } }
```

**What it breaks:** serialisation and validation. Integer-typed code sending
`123` where the server now wants `"abc-123"`, or a typed client whose generated
signature no longer compiles. In a dynamic language it often fails at the server
boundary rather than at the call site, which makes the stack trace unhelpful.

Only `type` is compared. `integer` → `number`, or a `format` change from `int32`
to `int64`, is either a hit or invisible depending on whether `type` itself moved.

---

## `PARAM_MADE_REQUIRED`

**Severity:** breaking.
**Triggers when:** a field exists on both sides, was not required, and now is.
**Detail:** `{ name, in }`.
**Reason text:** `<in> parameter '<name>' is now required`.

```yaml
# before
- { name: limit, in: query, required: false, schema: { type: integer } }

# after
- { name: limit, in: query, required: true, schema: { type: integer } }
```

**What it breaks:** every call that omitted the parameter, with a 400. Code that
always passed it keeps working, so this often breaks one caller out of five —
the one with the convenience wrapper that leaves the argument undefined.

The reverse — required becoming optional — is not modelled and produces no hit,
because it cannot break a correct client.

---

## `RESPONSE_FIELD_REMOVED`

**Severity:** breaking.
**Triggers when:** a top-level property of the lowest `2xx` JSON response schema
existed before and does not now.
**Detail:** `{ field, code }`.
**Reason text:** `response field '<field>' was removed`.

```yaml
# before
Pet:
  type: object
  properties:
    id:     { type: integer }
    name:   { type: string }
    tag:    { type: string }
    status: { type: string, enum: [available, pending, sold] }

# after
Pet:
  type: object
  properties:
    id:     { type: integer }
    name:   { type: string }
    status: { type: string, enum: [available, pending, sold] }
```

In the demo this is one edit to one shared schema, and because `$ref`s are
inlined it surfaces as three hits — `GET /pets`, `POST /pets`,
`GET /pets/{id}` — which the impact join then regroups into a single repair.

**What it breaks:** reads of the missing field, silently. `pet.tag` becomes
`undefined`, and JavaScript will happily render `"Rex (undefined)"` rather than
throw. This is the class of break that reaches production without an alert,
which is why the one-hop caller pass exists: the assertion that catches it lives
in a test file that never mentions the URL.

---

## `RESPONSE_FIELD_TYPE_CHANGED`

**Severity:** breaking.
**Triggers when:** a response field exists on both sides with a different `type`.
**Detail:** `{ field, from, to }`.
**Reason text:** `response field '<field>' changed type from <from> to <to>`.

```yaml
# before
properties:
  id: { type: integer }

# after
properties:
  id: { type: string }
```

**What it breaks:** arithmetic, comparisons and lookups on the value. `id === 1`
stops matching `"1"`. Like a removed field, it rarely throws — it produces wrong
answers.

---

## `ENUM_VALUE_REMOVED`

**Severity:** breaking.
**Triggers when:** both sides have an `enum` array on the same field and a value
present before is absent after. Fires for both parameters (via
`compareCommonFields`) and response fields (via `compareResponses`).
**Detail:** the field's identifying keys plus `values: [...]` — `{ name, in, values }`
for a parameter, `{ field, values }` for a response field.
**Reason text:** `<label> no longer accepts <values>`.

```yaml
# before
status: { type: string, enum: [available, pending, sold] }

# after
status: { type: string, enum: [available, sold] }
```

**What it breaks:** on a request parameter, calls sending the dropped value now
fail validation. On a response field, exhaustive handling — a `switch` with no
`default`, a lookup table keyed by the enum — is now missing a case it will never
receive, which is harmless, while code that still *sends* the old value is not.

Both sides must actually have an array. Adding an `enum` where there was none, or
dropping the constraint entirely, produces no hit from this rule.

---

## `AUTH_SCHEME_CHANGED`

**Severity:** breaking.
**Triggers when:** a scheme present in `components.securitySchemes` before is
removed, or its JSON serialisation differs after. A scheme that did not exist
before does not fire it.
**Path and method:** both `null` — this is a whole-spec change.
**Detail:** `{ scheme, before, after }` with the full scheme objects. `after` is
`null` when the scheme was removed; `before` is always present.
**Reason text:** `authentication scheme '<name>' changed`.

```yaml
# before
components:
  securitySchemes:
    apiKey: { type: apiKey, in: header, name: X-Api-Key }

# after
components:
  securitySchemes:
    apiKey: { type: http, scheme: bearer }
```

**What it breaks:** every request at once. The header name, the token format, or
both.

Three things to know about this rule:

- It is the only member of `WHOLE_SPEC_RULES` in `src/impact.mjs`, so it is the
  only pathless change that matches every call site of that API. Every other
  pathless finding claims nothing.
- **Adding** a brand-new scheme does not fire it. A new scheme is an added
  option, not a changed contract, and because this rule claims every call site a
  false positive here opens a PR rewriting auth across the repo. Removing or
  modifying an existing scheme is still breaking. `test/auth.test.mjs` asserts
  all three.
- Comparison is `JSON.stringify` equality, so reordering the keys of a scheme
  object counts as a change.

Operation-level and root-level `security` requirements are not modelled by any
rule. A change there reaches the LLM fallback, or `UNCLASSIFIED`.

---

## `PATH_DEPRECATED`

**Severity:** warning.
**Triggers when:** an operation has `deprecated: true` in the new spec and did
not in the old one.
**Pointer:** `/paths/<path>/<method>`.
**Reason text:** `<METHOD> <path> is now deprecated`.

```yaml
# before
/pets/{id}:
  get: { operationId: getPet }

# after
/pets/{id}:
  get: { operationId: getPet, deprecated: true }
```

The name says path; the check is per operation. Deprecating three methods on one
path produces three hits.

**What it breaks:** nothing yet. That is the point of the severity. `warning`
findings are reported and never repaired — `repairable()` accepts `breaking`
only. This is the rule that gives you lead time before the `METHOD_REMOVED` that
follows it in the next release.

---

## `PATH_ADDED`

**Severity:** safe.
**Triggers when:** a key of `paths` exists in the new spec and not the old one.
**Pointer:** `/paths/<path>`. Method is `null`.
**Reason text:** `new endpoint <path>`.

```yaml
# after adds:
/pets/{id}/owner:
  get: { operationId: getPetOwner }
```

This is the demo's v2 addition. It appears in the impact report as
`[safe] PATH_ADDED /pets/{id}/owner` with
`not affected (no call sites in this repo)`.

**What it breaks:** nothing. Reported so the diff is complete.

---

## `METHOD_ADDED`

**Severity:** safe.
**Triggers when:** a path exists in both specs and gains an operation.
**Reason text:** `new operation <METHOD> <path>`.

```yaml
# before
/pets: { get: { operationId: listPets } }

# after
/pets: { get: { operationId: listPets }, post: { operationId: createPet } }
```

**What it breaks:** nothing.

---

## `OPTIONAL_PARAM_ADDED`

**Severity:** safe.
**Triggers when:** a parameter or body property is new and not required.
**Detail:** `{ name, in }`.
**Reason text:** `new optional <in> parameter '<name>'`.

```yaml
# after adds:
- { name: sort, in: query, schema: { type: string } }
```

**What it breaks:** nothing — existing calls that omit it stay valid. This rule
is the counterpart that makes `REQUIRED_PARAM_ADDED` meaningful: the two share a
trigger and differ only on `required`, and `test/diff.test.mjs` asserts that an
optional addition and a made-required change in the same release come out as
`safe` and `breaking` respectively.

---

## `RESPONSE_FIELD_ADDED`

**Severity:** safe.
**Triggers when:** the response schema gains a top-level property.
**Detail:** `{ field }`.
**Reason text:** `new response field '<field>'`.

**What it breaks:** nothing, for a client that reads the fields it needs. A
client doing exact-shape validation on responses would break, which is why the
finding is reported rather than dropped.

---

## `ENUM_VALUE_ADDED`

**Severity:** safe.
**Triggers when:** both sides have an `enum` array and the new one contains a
value the old did not.
**Reason text:** `<label> accepts new values <values>`.

```yaml
# before
status: { type: string, enum: [available, pending, sold] }

# after
status: { type: string, enum: [available, pending, sold, reserved] }
```

**What it breaks:** nothing on the request side. On the response side, a
non-exhaustive `switch` will now fall through for the new value — real, but not
something a static rule can call breaking without knowing the consuming code.
`test/diff.test.mjs` asserts that a release both dropping and adding an enum
value produces one `breaking` and one `safe` hit, in that order.

---

## Worked example: the demo's v1 → v2

`test/diff.test.mjs` pins the complete result:

| Hit | Severity |
|---|---|
| `PARAM_RENAMED GET /pets` | breaking |
| `RESPONSE_FIELD_REMOVED GET /pets` | breaking |
| `REQUIRED_PARAM_ADDED POST /pets` | breaking |
| `RESPONSE_FIELD_REMOVED POST /pets` | breaking |
| `RESPONSE_FIELD_REMOVED GET /pets/{id}` | breaking |
| `PATH_ADDED /pets/{id}/owner` | safe |

Six hits, five breaking, and a further test asserts that the rules explain the
entire diff with nothing left over for the LLM. The three
`RESPONSE_FIELD_REMOVED` hits are one upstream edit — `tag` dropped from the
shared `Pet` schema — seen on three operations, and the impact join collapses
them into one repair.

## Related

- [how-it-works.md](how-it-works.md) — where the rules sit in the pipeline.
- [cli.md](cli.md) — reading the output that contains these ids.
