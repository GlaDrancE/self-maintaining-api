# Running sma in CI

sma is built for a scheduled job. Detection needs node and network access;
everything else is optional and degrades rather than blocks.

## Secrets and scopes

| Secret | Needed for | Least privilege |
|---|---|---|
| `ANTHROPIC_API_KEY` | The LLM fallback, and the repair agent | An Anthropic API key. Without it, unmodelled deltas become `UNCLASSIFIED` and `--fix` cannot run the agent. |
| `GH_TOKEN` / `GITHUB_TOKEN` | `gh pr create` | `contents: write` to push the branch and the baseline, `pull-requests: write` to open the PR. Nothing else. No admin, no packages, no actions scope. |

sma never reads the value of `GH_TOKEN` — `doctor` only checks that one of the
two names is set, and `gh` reads the token itself.

If you want detection but not repair, omit both secrets entirely. The job still
fetches, diffs, classifies with rules only, maps impact, and fails on exit 1.

## GitHub Actions

This is the workflow shipped in `.github/workflows/sma.yml`, annotated.

```yaml
name: self-maintaining-api

# Detection is only as fresh as this cron. Daily at 06:00 UTC means up to 24
# hours between the upstream change and the PR.
on:
  schedule:
    - cron: '0 6 * * *'
  workflow_dispatch:
    inputs:
      fix:
        description: 'Patch and open a PR (otherwise report only)'
        type: boolean
        default: true

# contents: write pushes the branch and the updated baseline.
# pull-requests: write opens the PR. Nothing more is needed.
permissions:
  contents: write
  pull-requests: write

jobs:
  # sma's own tests run first. If the detector is broken, its verdicts mean
  # nothing — a green "all clear" from a broken rule engine is worse than a
  # failed job.
  self-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - run: npm ci
      - run: npm test

  check:
    needs: self-test
    runs-on: ubuntu-latest
    steps:
      # fetch-depth: 0 because the job pushes a commit back.
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: '22'

      - run: npm ci

      # The repair step shells out to headless Claude Code. Skip this install
      # if you never pass --fix.
      - run: npm install -g @anthropic-ai/claude-code

      # sma commits through git, so git needs an identity.
      - name: Configure git
        run: |
          git config user.name  "sma[bot]"
          git config user.email "sma@users.noreply.github.com"

      # continue-on-error so exit 1 does not skip the baseline push below.
      - name: Check specs, map impact, open PRs
        id: sma
        continue-on-error: true
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: node sma.mjs run ${{ inputs.fix == false && '' || '--fix' }}

      # Push the new baseline even when a breaking change was found —
      # especially then. Skipping it would re-detect and re-report the same
      # change tomorrow, and every day after.
      - name: Commit the new baseline
        run: |
          git add .sma/specs
          git diff --cached --quiet || git commit -m "chore(sma): update spec baseline"
          git push origin HEAD:${{ github.ref_name }} || echo "nothing to push"

      # Fail the job, but only after the baseline is safely pushed.
      - name: Report result
        run: exit ${{ steps.sma.outcome == 'success' && '0' || '1' }}
```

For a consuming repo that installed sma from npm, replace `node sma.mjs run`
with `npx sma run` and drop the `self-test` job.

### Why the baseline is committed, not cached

`.sma/specs/` is the memory of what each spec looked like last time. Every
detection is a diff against it.

A cache can be evicted, and an eviction here is silent. With no snapshot,
`check` takes its first-run branch, prints `baseline captured`, and exits 0 —
reporting all clear forever while detecting nothing. Nothing in the exit code,
the logs or the PR list would tell you. A committed file cannot be evicted, and
its absence is visible in `git status`.

The side benefit is free history: `git log .sma/specs/stripe.json` is the log of
every change that API has shipped since you started watching it.

The ordering in the workflow matters for the same reason. The baseline push
happens *before* the job fails. Reverse them and a breaking change would be
re-detected, re-reported and re-PR'd every single day until someone fixed it.

## Acting on the exit code

| Code | What happened | What CI should do |
|---|---|---|
| `0` | Nothing breaking reached this repo | Pass. |
| `1` | A breaking change reached call sites in this repo | Fail the job — after pushing the baseline. If `--fix` ran, there is a PR to review; exit 1 is still correct, because an open PR is an unmerged break. |
| `2` | sma itself failed | Fail the job, and treat it as an outage of the detector, not of the API. Bad config, unreachable spec, missing prerequisite. Page differently from 1. |

The workflow above collapses 1 and 2 into a single failing job. To distinguish
them, capture the code explicitly:

```yaml
      - name: Check specs
        id: sma
        continue-on-error: true
        run: |
          node sma.mjs run --fix
          echo "code=$?" >> "$GITHUB_OUTPUT"
```

Note that `run` leaves the exit code of whichever sub-command ran last, so a run
that finds changes but no call sites exits 0. That is intended: a change nobody
calls has not broken you.

## GitLab CI

```yaml
stages: [watch]

sma:
  stage: watch
  image: node:22
  rules:
    - if: $CI_PIPELINE_SOURCE == "schedule"
    - if: $CI_PIPELINE_SOURCE == "web"
  variables:
    GIT_DEPTH: "0"
  before_script:
    - npm ci
    - npm install -g @anthropic-ai/claude-code
    - git config user.name "sma[bot]"
    - git config user.email "sma@example.invalid"
    - git remote set-url origin "https://oauth2:${SMA_PUSH_TOKEN}@${CI_SERVER_HOST}/${CI_PROJECT_PATH}.git"
  script:
    - set +e
    - npx sma run --fix
    - echo "SMA_EXIT=$?" > sma.exit
    - set -e
    # Push the baseline before failing, for the same reason as above.
    - git add .sma/specs
    - git diff --cached --quiet || git commit -m "chore(sma): update spec baseline"
    - git push origin "HEAD:${CI_COMMIT_REF_NAME}" || echo "nothing to push"
    - . ./sma.exit && exit "$SMA_EXIT"
  artifacts:
    when: always
    paths:
      - .sma/pr/
      - .sma/impact/
    expire_in: 30 days
```

Set `ANTHROPIC_API_KEY` and `SMA_PUSH_TOKEN` as masked, protected CI/CD
variables. `SMA_PUSH_TOKEN` needs a project access token with `write_repository`
— that is enough to push the branch and the baseline.

GitLab is not GitHub, so `gh pr create` will not work. Without a GitHub remote,
`open()` finds no usable `gh` and falls back to writing the PR body to
`.sma/pr/<branch>.md`, which the artifact block above collects. Opening the merge
request itself is not something sma does on GitLab — use `glab mr create` in a
follow-up step, or read the markdown body from the artifact.

Schedule it under **CI/CD → Schedules**, which is what the
`$CI_PIPELINE_SOURCE == "schedule"` rule matches.

## Jenkins

```groovy
pipeline {
  agent { docker { image 'node:22' } }

  triggers { cron('H 6 * * *') }

  environment {
    ANTHROPIC_API_KEY = credentials('anthropic-api-key')
    GH_TOKEN          = credentials('sma-github-token')
  }

  stages {
    stage('Install') {
      steps {
        sh 'npm ci'
        sh 'npm install -g @anthropic-ai/claude-code'
      }
    }

    stage('Watch') {
      steps {
        script {
          sh 'git config user.name "sma[bot]"'
          sh 'git config user.email "sma@example.invalid"'
          // returnStatus so exit 1 does not abort before the baseline is pushed.
          env.SMA_EXIT = sh(script: 'npx sma run --fix', returnStatus: true).toString()
        }
      }
    }

    stage('Push baseline') {
      steps {
        sh '''
          git add .sma/specs
          git diff --cached --quiet || git commit -m "chore(sma): update spec baseline"
          git push origin HEAD:${BRANCH_NAME} || echo "nothing to push"
        '''
      }
    }

    stage('Report') {
      steps {
        script {
          if (env.SMA_EXIT == '2') {
            error('sma itself failed — check config, network and prerequisites')
          }
          if (env.SMA_EXIT == '1') {
            unstable('a breaking API change reached this repo')
          }
        }
      }
    }
  }

  post {
    always {
      archiveArtifacts artifacts: '.sma/pr/**,.sma/impact/**', allowEmptyArchive: true
    }
  }
}
```

Mapping exit 1 to `unstable` and exit 2 to `error` keeps the two apart in the
Jenkins UI, which is the whole reason they are different numbers.

## Self-hosted runners

- **Persistent workspaces.** A reused workspace keeps `.sma/` between runs. That
  is harmless for `specs/` — the committed file wins after a checkout — but stale
  `.sma/changes/` and `.sma/impact/` files survive. `impact` reads the
  newest changes file by filename sort, so a leftover from a previous run is
  never picked over a current one, since `check` writes a fresh file on every run
  including empty ones. Still, prefer a clean checkout.
- **Egress.** The runner needs outbound HTTPS to every `apis[].spec` host, to
  `api.anthropic.com` if the LLM fallback or `--fix` is in play, and to
  `github.com` for the push and the PR. An internal-only spec is the case where a
  self-hosted runner earns its keep — see
  [faq.md](faq.md#what-about-a-private-or-authenticated-spec-url).
- **Tooling.** `node` 22+, `git`, and — only for `--fix` — the `claude` CLI and
  `gh`. Run `npx sma doctor` as the first step of a new runner's first job; it
  prints exactly which of those are missing and what each costs.
- **Concurrency.** `fix` creates a branch named `sma/<api>-<stamp>` where the
  stamp is second-precision. Two runs in the same second on the same repo would
  collide. In practice the bigger risk is two concurrent runs both pushing a
  baseline commit; serialise the job.
- **Clean tree.** `fix` refuses to start if the target repo has uncommitted
  changes. A runner that leaves build output behind will hit
  `<path> has uncommitted changes — commit or stash first`. Either clean the
  workspace or add the output to `.gitignore`.

## Scheduling cadence

Detection is exactly as fresh as the cron. There is no webhook, no push
notification from the upstream API, and no polling between runs. A daily
schedule means up to 24 hours between an upstream release and the PR.

| Cadence | Worst-case lag | Trade-off |
|---|---|---|
| Hourly | 1 hour | 24× the spec fetches. Fine for a small self-hosted spec, rude to a public one, and every run that finds changes on a shared `main` produces a baseline commit. |
| Daily | 24 hours | The shipped default. One commit per changed spec per day at most. |
| Weekly | 7 days | Cheapest, and long enough that a breaking change can reach production before sma notices. Only sensible for an API with a contractual deprecation window. |

Two things scale with frequency: the spec fetch, and the LLM fallback when the
rules leave something unexplained. The rule engine itself is free. A run where
nothing changed costs one HTTP GET per API and no tokens at all.

`workflow_dispatch` is worth keeping regardless of cadence. When you hear that an
upstream shipped something, running the job manually is faster than waiting for
the cron, and the result is identical.

## Related

- [cli.md](cli.md) — exit codes per command.
- [troubleshooting.md](troubleshooting.md) — CI-specific failure modes.
- [getting-started.md](getting-started.md) — the baseline commit step.
