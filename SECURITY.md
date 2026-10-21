# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 1.0.x | yes |
| < 1.0 | no |

Only the latest 1.0.x release receives fixes. There are no backports.

## Reporting a vulnerability

Report privately — do not open a public issue.

- Preferred: [GitHub private vulnerability reporting](https://github.com/ayush/self-maintaining-api/security/advisories/new)
- Or email the maintainer listed on the repository's GitHub profile.

Include the version, your `watch.yaml` (redact tokens), and the smallest spec or
repo that reproduces it. Expect an acknowledgement within 7 days and a fix or a
clear decision within 30. Please give us that window before disclosing publicly.

## Security model

sma reads untrusted input (a remote spec you do not control) and writes to your
filesystem and your GitHub repo. Here is exactly how much it is allowed to do.

**It fetches remote specs over the network.** `watcher.fetchSpec` fetches any URL
in `watch.yaml` and parses it as YAML/JSON; `resolveRefs` inlines local `#/`
pointers only, and refuses to follow cycles. Remote `$ref`s are never fetched, so
a spec cannot pull in a second document. A spec is data throughout: it is diffed
and pattern-matched, never executed.

**It can send spec diffs to the Anthropic API.** When `ANTHROPIC_API_KEY` is set
and `--no-llm` is not passed, the deltas the rule engine could not explain — JSON
pointers and their before/after values, from your watched specs — are sent to the
Anthropic API for classification. Your source code is never part of that request.
Without a key, those deltas are reported as UNCLASSIFIED and nothing leaves the
machine; the rule engine is fully deterministic and offline.

**It runs a coding agent with no shell.** `sma fix` shells out to the `claude`
CLI with `--allowedTools Read,Edit,Write,Glob,Grep` and
`--permission-mode acceptEdits`. Bash and every other command-running tool are
deliberately excluded: the agent can edit files in the target repo and nothing
else. The test suite is run by the harness (`repair.runTests`), never by the
agent, so the agent's self-report can never be the thing that certifies its own
work. Note that `acceptEdits` means edits inside the repo are not individually
confirmed — `startSession` therefore refuses to run unless the repo is a clean
git working tree, and every edit lands on a fresh `sma/<api>-<stamp>` branch.

**It opens PRs, it never merges.** `pr.open` commits the branch, pushes, and runs
`gh pr create`. There is no merge path anywhere in the codebase. A run whose
tests failed, or whose diff touched files outside the predicted impact, is
labelled `needs-human`. `sma fix` exits non-zero even after a PR is opened,
because an unmerged PR is still an unfixed break.

**API names are validated because they become filesystem paths.** An api `name`
from `watch.yaml` is used as `.sma/specs/<name>.json`, so `store.loadConfig`
rejects anything outside `[a-zA-Z0-9._-]+` and rejects duplicates (two apis
sharing a name would silently overwrite each other's baseline). This is covered
by a test.

**Credentials.** `ANTHROPIC_API_KEY`, `GH_TOKEN`/`GITHUB_TOKEN` are read from the
environment only. sma never writes them to `.sma/`, to a PR body, or to a log.

## Trust boundary, stated plainly

If you point sma at a malicious spec, the worst it should do is misclassify a
change and ask an agent to edit your call sites — on a branch, in a PR, with the
tests run independently and the result waiting for your review. If you find a way
to get it to do more than that, that is the bug we want to hear about.
