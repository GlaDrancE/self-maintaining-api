// Commit the branch and open a PR. With no git remote the body is written to .sma/
// and printed instead, so the local demo works without GitHub.
import { spawnSync } from 'node:child_process';
import { git } from './repair.mjs';
import * as store from './store.mjs';
import { redact } from './watcher.mjs';

const endpointsOf = (i) =>
  (i.endpoints ?? [[i.method, i.path].filter(Boolean).join(' ')]).filter(Boolean).join(', ') || '(whole spec)';

export function prBody(impacts, agents, result, api) {
  const sections = impacts
    .map((i, n) => {
      const sites = i.sites.map((s) => `- \`${s.file}:${s.line}\` — \`${s.snippet}\``).join('\n');
      return `### ${n + 1}. ${i.rule} — ${endpointsOf(i)}

${i.reason}
_Detected by ${i.source === 'rule' ? 'the rule engine' : 'LLM review'}; details: \`${JSON.stringify(i.detail)}\`_

Call sites:
${sites}

What the agent reported:
> ${(agents[n]?.output ?? '(no summary)').split('\n').join('\n> ')}`;
    })
    .join('\n\n');

  const outside = result.outsideScope.length
    ? `\n> **Files changed outside the predicted impact:** ${result.outsideScope.join(', ')}\n`
    : '';

  return `## \`${api.name}\` spec changed — ${impacts.length} breaking change(s) patched

Spec: ${redact(api.spec)}

${sections}

### Diff
\`\`\`
${result.diffstat}
\`\`\`

### Verification (run by the harness, not the agent)
- **${result.tests.pass ? 'PASS' : 'FAIL'}** — test suite
- ${result.outsideScope.length ? `${result.outsideScope.length} file(s) outside predicted impact` : 'every changed file was predicted'}
${outside}
### Reviewer checklist
- [ ] The new contract matches the spec linked above
- [ ] No unrelated files were touched
- [ ] Any invented placeholder values are called out and replaced
- [ ] Tests assert the new behaviour, not just that nothing throws
${result.needsHuman ? '\n**needs-human** — tests failed or the diff went outside the predicted impact. Do not merge without reading it.\n' : ''}`;
}

const hasRemote = (repo) => git(repo, ['remote'], { allowFail: true }).length > 0;

export function open(impacts, agents, result, api, cfg) {
  const body = prBody(impacts, agents, result, api);
  const title = `fix(${api.name}): patch ${impacts.length} breaking API change(s)`;
  const bodyFile = store.writeText(`pr/${result.branch.replace(/\//g, '_')}.md`, body);

  git(cfg.repoPath, ['add', '-A']);
  git(cfg.repoPath, [
    'commit',
    '-m',
    `${title}\n\n${impacts.map((i) => `- ${i.rule}: ${i.reason}`).join('\n')}\n\nDetected and patched by sma.`,
  ]);

  if (!hasRemote(cfg.repoPath)) {
    return { url: null, title, bodyFile, note: `no git remote — PR body written to ${bodyFile}` };
  }

  git(cfg.repoPath, ['push', '-u', 'origin', result.branch]);
  const args = ['pr', 'create', '--title', title, '--body', body, '--head', result.branch, '--base', result.base];
  if (result.needsHuman) args.push('--label', 'needs-human');
  const res = spawnSync('gh', args, { cwd: cfg.repoPath, encoding: 'utf8' });
  // On ENOENT spawnSync sets `error` and leaves status and stderr null, so reading
  // stderr alone reported `gh pr create failed: undefined`. The branch is already
  // pushed by this point — say where the body is so the PR can be opened by hand.
  if (res.error || res.status !== 0) {
    const why = res.error ? `the gh CLI is not on PATH (${res.error.code ?? res.error.message})` : res.stderr?.trim() || `exit ${res.status}`;
    return { url: null, title, bodyFile, note: `gh pr create failed: ${why} — branch ${result.branch} is pushed; body in ${bodyFile}` };
  }
  return { url: res.stdout.trim(), title, bodyFile };
}
