# Demo guide

How to show that sma works, live, in about 10 minutes.

## What you are proving

> When a third-party API changes, sma finds out first, shows exactly which lines
> of *your* code break, patches them, runs your tests, and hands you a PR to review.

```
 upstream spec changes
        │
        ▼
 1. check    fetch spec, diff against last snapshot (.sma/specs/)
        │    17 deterministic rules → breaking / warning / safe
        ▼
 2. impact   AST scan of your repo (ts-morph) → which call sites hit each change,
        │    plus the functions that call those (one hop)
        ▼
 3. fix      Claude agent edits only the affected files (no shell access)
        │    sma runs YOUR tests itself + checks no unexpected files changed
        ▼
 4. PR       branch + PR (or .sma/pr/*.md with no remote); needs-human label if unsure
        │
        ▼
 5. report   .sma/report.html: verdict, findings, call sites, repair results
```

## Which projects to demo on

Use **both**, in this order. Each one answers a different question from the audience.

| | Part A: Petstore (the full loop) | Part B: OpenAI (the real-world proof) |
|---|---|---|
| Proves | detect → map → **patch → test → PR** | it works on a **real** API, not a toy |
| Upstream | `demo/petstore`, a local fake API you control | OpenAI's public spec, June 2023 commit `d9c3021a` |
| Your code | `demo/demo-app` (a small JS client) | `demo/real-world/app` (a small bot) |
| Needs | `claude` CLI logged in (for the fix step) | internet only, no API key |
| Time | ~2 min (the fix takes ~75 s) | ~5 s |

If something goes wrong on the day, Part B alone still makes the point. It's the safest thing to run in front of people.

## Before the demo (do this once, the day before)

```powershell
node --version        # must be 22 or newer
npm install
npm test              # 51 tests should pass
claude --version      # needed only for the fix step in Part A
npm run demo:setup -- --force    # fresh demo/demo-app, its own git repo at "API v1"
```

Then do a full dry run of Parts A and B, and reset again afterwards (see [Resetting](#resetting-between-runs)).

Open in your editor ahead of time:
- `demo/demo-app/src/pets.js` (the code that will break)
- `demo/petstore/openapi.v2.json` (the "new release")

Use **two terminals**. Terminal 1 runs the fake API; terminal 2 runs sma.

## Part A: Petstore, the full loop

### 1. Start the upstream API (terminal 1)

```powershell
npm run petstore
```

Say: *"This is a third-party API. I don't own it. Right now it's on v1."*

### 2. Show the code that depends on it

Open `demo/demo-app/src/pets.js`:

```js
fetch(`${BASE}/pets?limit=${limit}`)          // query param "limit"
body: JSON.stringify({ name, tag })            // no ownerId
return `${pet.name} (${pet.tag})`              // reads pet.tag
```

Say: *"Normal client code. Its tests pass today."*

### 3. Record the baseline (terminal 2)

```powershell
node sma.mjs reset
node sma.mjs run
```

Expected: no breaking changes, exit code 0. sma has saved a snapshot of v1.

### 4. Upstream ships a breaking release

```powershell
Set-Content -Encoding ascii demo/petstore/ACTIVE v2
```

(Use this rather than `echo v2 >`: Windows PowerShell's `>` writes UTF-16, which the server can't read. In Git Bash, `echo v2 > demo/petstore/ACTIVE` is fine.)

Say: *"The provider just released v2. They renamed `limit` to `pageSize`, made `ownerId` required, and dropped `tag` from responses. Nobody emailed me."*

### 5. Detect and map

```powershell
node sma.mjs run
```

Point out in the output:
- **6 changes found, 5 breaking**, each labelled with the rule that caught it (e.g. `PARAM_RENAMED`, `RESPONSE_FIELD_REMOVED`).
- Each breaking change is joined to **file:line** in `demo-app`, including indirect callers (`report.js → describePet()`).
- **Exit code 1** means "an API broke you". In CI that fails the build, so you hear about it before your users do.

### 6. Repair

```powershell
node sma.mjs fix
```

Takes about 75 seconds. Say while it runs: *"The agent can only read and edit files. It can't run commands. sma runs the tests itself afterwards, so the agent can't claim success it didn't earn."*

Then show the result:

```powershell
git -C demo/demo-app log --oneline --all
git -C demo/demo-app diff main sma/petstore-<stamp>   # exact branch name is printed by fix
```

You should see `limit` → `pageSize`, `ownerId` threaded through `createPet`, and the `tag` display removed. Then open the PR body in `.sma/pr/` (it's written there because the demo repo has no GitHub remote).

### 7. Show the report

```powershell
node sma.mjs report
start .sma/report.html
```

The report shows a verdict banner, stat tiles, findings sorted by severity with their call sites, and the repair run marked *"patched, tests pass, awaiting review"*.

## Part B: OpenAI, a real API

```powershell
npm run demo:real
```

Say: *"In June 2023 OpenAI removed five deprecated endpoints from its API. This replays that exact change against an app written for the old API. Both spec versions are pinned to commit SHAs, so the demo gives the same result every time."*

Point out:
- All **5 removals detected** (`/engines`, `/answers`, `/classifications`, ...).
- Only the **2 the app actually calls** are flagged, with file:line, and the other 3 say *not affected*.
- A second real change, `prompt` becoming required, is caught too.

Optional: compare any two specs with no setup:

```powershell
node sma.mjs diff demo/petstore/openapi.v1.json demo/petstore/openapi.v2.json
```

## Showing it in CI (optional, if you have a GitHub repo)

`.github/workflows/sma.yml` runs `sma run --fix` on a schedule. Show the Actions tab:
- a red run when an API broke the repo (exit 1),
- the `sma-report` artifact attached to it,
- the PR it opened.

## Questions you'll likely get

| Question | Answer |
|---|---|
| Doesn't something like this already exist? | oasdiff, Optic and similar tools serve the **provider** checking its own API. Dependabot only bumps package versions. Nothing established watches someone else's API and patches your code. See `docs/market-research.md`. |
| What if the AI writes a bad fix? | It never merges anything. sma runs your tests itself, rejects edits to unexpected files, and labels anything doubtful `needs-human`. The PR is a proposal. |
| What if my tests are weak? | Then a passing run proves less, the same as for a human's PR. The scope check still catches edits outside the affected files, and review is still required. |
| Cost? | Detection and mapping are deterministic and free. The LLM runs only for repairs, plus rare changes the rules can't classify (`--no-llm` turns that off). |
| What can't it catch? | APIs with no published spec (Twitter/X, Reddit), specs that lag production, pricing or shutdown decisions. The scanner reads JS/TS only. |
| Which real APIs can it watch? | Any that publish an OpenAPI spec: OpenAI, Stripe, GitHub, Cloudflare, Twilio, DigitalOcean, Box, Asana, and others. |

## Resetting between runs

```powershell
Set-Content -Encoding ascii demo/petstore/ACTIVE v1
npm run demo:setup -- --force
node sma.mjs reset
git checkout -- .sma/specs demo/petstore/ACTIVE
```

## If something breaks on the day

| Symptom | Fix |
|---|---|
| `ACTIVE contains "﻿v2"` or similar | You used `echo >` in PowerShell. Use the `Set-Content -Encoding ascii` line above. |
| `fetch failed` / `ECONNREFUSED` | Terminal 1 isn't running `npm run petstore`. |
| The second `run` reports no changes | `ACTIVE` still says v1, or you ran `reset` after flipping. Reset and repeat steps 3–5. |
| `fix` says claude isn't found | Run `node sma.mjs doctor`, then skip `fix` and show Part B plus the report. |
| No internet for Part B | Use Part A and `sma diff` on the local v1/v2 files. |
