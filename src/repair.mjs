// Hand the breaking changes to a headless Claude Code run, then check its work
// ourselves. The agent gets edit tools only — running the tests is our job, so its
// self-report can never be the thing we trust.
//
// One spec bump is one branch. Each change gets its own focused agent run, but they
// all land on the same branch: a PR that fixes half of what an upgrade broke would
// fail its own test suite.
import { spawnSync } from 'node:child_process';
import * as store from './store.mjs';

const AGENT_TOOLS = 'Read,Edit,Write,Glob,Grep';

export function git(repo, args, opts = {}) {
  const res = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', ...opts });
  if (res.error) throw res.error;
  if (res.status !== 0 && !opts.allowFail) {
    throw new Error(`git ${args.join(' ')} failed: ${res.stderr?.trim() || res.stdout?.trim()}`);
  }
  return (res.stdout ?? '').trim();
}

export const isGitRepo = (repo) =>
  spawnSync('git', ['-C', repo, 'rev-parse', '--git-dir'], { encoding: 'utf8' }).status === 0;

export const isClean = (repo) => git(repo, ['status', '--porcelain']) === '';

export function buildPrompt(impact) {
  const sites = impact.sites.map((s) => `  - ${s.file}:${s.line}   ${s.snippet}`).join('\n');
  const endpoints = (impact.endpoints ?? [[impact.method, impact.path].filter(Boolean).join(' ')]).join(', ');

  return `An external API this codebase depends on has changed. Update the affected call sites.

API:        ${impact.api}
Change:     ${impact.rule} (${impact.severity})
Endpoints:  ${endpoints || '(whole spec)'}
What happened: ${impact.reason}
Details:    ${JSON.stringify(impact.detail)}

Affected call sites found by static analysis:
${sites}

Rules for this edit:
1. Change ONLY what is needed to keep working against the new API. Touch only the files listed above (and, if a listed change forces it, their direct callers).
2. Do not refactor, rename, reformat, add comments, or "improve" anything else.
3. Keep the existing code style.
4. If a caller has to pass new information (e.g. a newly required parameter), thread it through the function signature rather than hardcoding a value. If you must invent a placeholder, name it obviously and say so in your summary.
5. The repo may already contain fixes for other changes from the same spec update. Leave those alone.
6. Do not run any commands or tests — the harness runs them.

When you are done, reply with a short plain-text summary: what you changed in each file, and anything a human reviewer must double-check.`;
}

function runAgent(prompt, cfg) {
  const res = spawnSync('claude', ['-p', '--permission-mode', 'acceptEdits', '--allowedTools', AGENT_TOOLS], {
    cwd: cfg.repoPath,
    input: prompt,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.error) throw new Error(`could not run the claude CLI: ${res.error.message}`);
  return { ok: res.status === 0, output: (res.stdout ?? '').trim(), stderr: (res.stderr ?? '').trim() };
}

export function runTests(cfg) {
  // One shell string rather than command+args: passing an args array alongside
  // `shell: true` is deprecated and prints a warning on every run.
  const res = spawnSync(cfg.test ?? 'npm test', {
    cwd: cfg.repoPath,
    encoding: 'utf8',
    shell: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { pass: res.status === 0, output: `${res.stdout ?? ''}${res.stderr ?? ''}`.trim() };
}

export function startSession(cfg, apiName, stamp) {
  if (!isGitRepo(cfg.repoPath)) throw new Error(`${cfg.repoPath} is not a git repo — cannot branch`);
  if (!isClean(cfg.repoPath)) throw new Error(`${cfg.repoPath} has uncommitted changes — commit or stash first`);
  const base = git(cfg.repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = `sma/${apiName}-${stamp}`;
  git(cfg.repoPath, ['checkout', '-b', branch]);
  return { base, branch };
}

export function applyOne(impact, cfg, branch) {
  const prompt = buildPrompt(impact);
  const slug = `${branch}-${impact.rule}`.replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase();
  store.writeText(`prompts/${slug}.txt`, prompt);
  return runAgent(prompt, cfg);
}

// Independent verification. The agent never ran any of this.
export function finish(cfg, impacts, base, branch) {
  const changedFiles = git(cfg.repoPath, ['diff', '--name-only']).split('\n').filter(Boolean);
  if (!changedFiles.length) {
    git(cfg.repoPath, ['checkout', base]);
    git(cfg.repoPath, ['branch', '-D', branch], { allowFail: true });
    return { applied: false, base, branch, reason: 'the agent made no edits' };
  }

  const tests = runTests(cfg);
  const expected = new Set(impacts.flatMap((i) => i.sites.map((s) => s.file)));
  const outsideScope = changedFiles.filter((f) => !expected.has(f));

  return {
    applied: true,
    base,
    branch,
    changedFiles,
    outsideScope,
    tests,
    diffstat: git(cfg.repoPath, ['diff', '--stat']),
    needsHuman: !tests.pass || outsideScope.length > 0,
  };
}
