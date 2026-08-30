#!/usr/bin/env node
// sma — watch external API specs, find what they break in this repo, patch it, open a PR.
import { rmSync, existsSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as store from './src/store.mjs';
import * as watcher from './src/watcher.mjs';
import { scan } from './src/inventory.mjs';
import { classify } from './src/classify.mjs';
import { buildImpact, repairable, report } from './src/impact.mjs';
import { startSession, applyOne, finish, git } from './src/repair.mjs';
import { open } from './src/pr.mjs';

// CI can only tell "your API broke" from "sma broke" if those are different numbers.
const EXIT = { OK: 0, BREAKING: 1, FAILED: 2 };

const [, , command = 'help', ...rest] = process.argv;
const flags = new Set(rest.filter((a) => a.startsWith('--')));
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

// Everything under .sma/ is a per-run artifact except specs/ — that is the baseline,
// the only thing that makes change detection possible, so it belongs in git.
const IGNORE_LINES = [
  '# sma: per-run artifacts. .sma/specs/ is deliberately NOT ignored — it is the',
  '# baseline every future run diffs against, and it belongs in version control.',
  '.sma/changes/',
  '.sma/impact/',
  '.sma/prompts/',
  '.sma/pr/',
  '.sma/runs.json',
  '.sma/inventory.json',
];

const CONFIG_TEMPLATE = `# The repo that gets scanned and patched, relative to this file.
repo: .

# How sma runs your test suite to verify an agent's edit. Defaults to \`npm test\`.
# test: npm test

apis:
  # - name: stripe
  #   spec: https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json
  #   baseUrl: https://api.stripe.com

  # - name: github
  #   spec: https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json
  #   baseUrl: https://api.github.com
  #   sdk: "@octokit/rest"
`;

function ensureGitignore() {
  const file = join(store.ROOT, '.gitignore');
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const missing = IGNORE_LINES.filter((l) => !l.startsWith('#') && !current.split(/\r?\n/).includes(l));
  if (!missing.length) return null;
  appendFileSync(file, (current && !current.endsWith('\n') ? '\n' : '') + '\n' + IGNORE_LINES.join('\n') + '\n');
  return file;
}

// One shell string rather than command+args: passing an args array alongside
// `shell: true` is deprecated and prints a warning on every run. `cmd` is only ever
// a literal from this file, so there is nothing to escape.
const has = (cmd) => {
  const res = spawnSync(`${cmd} --version`, { encoding: 'utf8', shell: true });
  return res.status === 0 ? (res.stdout ?? '').trim().split('\n')[0] : null;
};

const commands = {
  // Two modes on purpose. No config yet: write one and stop, because we have nothing
  // to fetch. Config already there (the usual case — people write watch.yaml by hand
  // like any other CI file): capture the baseline, which is the step everyone forgets
  // and then wonders why nothing is ever detected.
  async init() {
    const wrote = ensureGitignore();
    if (wrote) console.log(`updated ${wrote}`);

    if (!store.hasConfig()) {
      writeFileSync(store.CONFIG, CONFIG_TEMPLATE);
      console.log(`wrote ${store.CONFIG}`);
      console.log('\nNext: uncomment an api (or add your own), then run `sma init` again to capture the baseline.');
      return;
    }

    console.log(`using ${store.CONFIG}`);
    await commands.check();
    console.log(
      '\nBaseline captured. There is nothing to compare against yet — the NEXT run is the one that detects changes.' +
        '\nCommit .sma/specs/ so future runs have something to diff against.',
    );
    process.exitCode = EXIT.OK;
  },

  async scan() {
    const cfg = store.loadConfig();
    const { sites, unresolved } = scan(cfg);
    store.write('inventory.json', { scannedAt: new Date().toISOString(), sites, unresolved });
    console.log(`${sites.length} call site(s) across ${new Set(sites.map((s) => s.file)).size} file(s)`);
    for (const s of sites) console.log(`  ${s.file}:${s.line}  ${s.method ?? s.symbol} ${s.path ?? ''}`);
    if (unresolved.length) {
      console.log(`\n${unresolved.length} request(s) with a URL this scanner could not resolve statically:`);
      for (const u of unresolved) console.log(`  ${u.file}:${u.line}  ${u.snippet}`);
    }
  },

  async check() {
    const cfg = store.loadConfig();
    const all = [];
    for (const api of cfg.apis) {
      const spec = watcher.resolveRefs(await watcher.fetchSpec(api.spec));
      const previous = watcher.loadSnapshot(api.name);
      watcher.saveSnapshot(api.name, spec);

      if (!previous) {
        const n = Object.keys(spec.paths ?? {}).length;
        console.log(`${api.name}: baseline captured (${n} endpoints) — commit .sma/specs/${api.name}.json`);
        continue;
      }
      const { changes, reviewed, skipped } = await classify(previous, spec, {
        apiName: api.name,
        useLlm: !flags.has('--no-llm'),
      });
      for (const c of changes) all.push({ ...c, api: api.name });
      const breaking = changes.filter((c) => c.severity === 'breaking').length;
      console.log(
        `${api.name}: ${changes.length} change(s), ${breaking} breaking` +
          (reviewed ? `, ${reviewed} LLM-reviewed` : '') +
          (skipped ? `, ${skipped} unclassified (no API key)` : ''),
      );
    }
    // Always record the run, even when it found nothing. `impact` reads the newest
    // file; skipping the empty ones would leave yesterday's changes looking current
    // and re-open the same PR every day.
    const file = store.write(`changes/${stamp}.json`, all);
    if (all.length) console.log(`\nwrote ${file}`);
    // On its own `check` has no call-site knowledge, so any breaking change counts.
    // `impact` narrows this to the ones that actually reach this repo.
    process.exitCode = all.some((c) => c.severity === 'breaking') ? EXIT.BREAKING : EXIT.OK;
    return all;
  },

  async impact() {
    const cfg = store.loadConfig();
    const changes = store.latestChanges();
    if (!changes) return console.log('nothing checked yet — run `sma check` first');
    if (!changes.length) return console.log('the latest check found no changes — nothing to map');
    const inv = store.read('inventory.json');
    if (!inv) return console.log('no inventory — run `sma scan` first');

    const impacts = [];
    for (const api of cfg.apis) {
      const spec = watcher.loadSnapshot(api.name);
      const mine = changes.filter((c) => c.api === api.name);
      impacts.push(...buildImpact(mine, inv.sites, spec));
    }
    store.write(`impact/${stamp}.json`, impacts);
    console.log(report(impacts));
    const todo = repairable(impacts);
    console.log(`\n${todo.length} breaking change(s) with call sites in this repo.`);
    process.exitCode = todo.length ? EXIT.BREAKING : EXIT.OK;
    return impacts;
  },

  async fix() {
    const cfg = store.loadConfig();
    if (!has('claude')) {
      throw new Error(
        'the `claude` CLI is not on PATH — install @anthropic-ai/claude-code, or drop --fix to report only',
      );
    }
    const impacts = store.read(`impact/${stamp}.json`) ?? (await commands.impact());
    const todo = repairable(impacts ?? []);
    if (!todo.length) return console.log('nothing to repair');

    // One branch and one PR per API: a spec bump is a single event, and a PR that
    // fixed only some of what it broke would fail its own tests.
    for (const apiName of new Set(todo.map((i) => i.api))) {
      const api = cfg.apis.find((a) => a.name === apiName);
      const group = todo.filter((i) => i.api === apiName);
      console.log(`\n--- ${apiName}: ${group.length} change(s) to repair`);

      const { base, branch } = startSession(cfg, apiName, stamp);
      const agents = [];
      for (const impact of group) {
        console.log(`    agent: ${impact.rule} ${impact.method ?? ''} ${impact.path ?? ''}`);
        agents.push(applyOne(impact, cfg, branch));
      }

      const result = finish(cfg, group, base, branch);
      if (!result.applied) {
        console.log(`    skipped: ${result.reason}`);
        continue;
      }
      console.log(`    branch ${result.branch}, tests ${result.tests.pass ? 'PASS' : 'FAIL'}`);
      if (result.outsideScope.length) console.log(`    outside predicted impact: ${result.outsideScope.join(', ')}`);
      if (!result.tests.pass) console.log(result.tests.output.trim().slice(-1200));

      const opened = open(group, agents, result, api, cfg);
      console.log(`    ${opened.url ?? opened.note}`);
      store.appendRun({
        at: new Date().toISOString(),
        api: apiName,
        rules: group.map((i) => i.rule),
        branch: result.branch,
        testsPass: result.tests.pass,
        needsHuman: result.needsHuman,
        pr: opened.url ?? null,
      });
      git(cfg.repoPath, ['checkout', base]);
    }
    // A PR that exists is still an unmerged break. Leave the failure signal up.
    process.exitCode = EXIT.BREAKING;
  },

  async run() {
    await commands.scan();
    console.log('');
    const changes = await commands.check();
    if (!changes.length) return;
    console.log('');
    await commands.impact();
    if (flags.has('--fix')) await commands.fix();
    else console.log('\n(report only — pass --fix to patch and open PRs)');
  },

  // What is available, and — the part that matters — what you lose without it.
  // Nothing here is required for detection; layers 3 and 4 degrade, they never block.
  async doctor() {
    const node = process.versions.node;
    const rows = [
      [Number(node.split('.')[0]) >= 22, `node ${node}`, 'node 22+ required (native fetch, node --test)'],
      [store.hasConfig(), `config ${store.CONFIG}`, `no ${store.CONFIG_NAME} found — run \`sma init\``],
      [!!has('git'), 'git', 'without git: no branches, no PRs — reporting still works'],
      [
        !!process.env.ANTHROPIC_API_KEY,
        'ANTHROPIC_API_KEY',
        'without it: unmodelled deltas are reported as UNCLASSIFIED instead of judged',
      ],
      [!!has('claude'), 'claude CLI', 'without it: `--fix` is unavailable — sma reports what broke, you patch it'],
      [!!has('gh'), 'gh CLI', 'without it: the PR body is written to .sma/pr/ instead of opened'],
      [!!(process.env.GH_TOKEN || process.env.GITHUB_TOKEN), 'GH_TOKEN', 'without it: `gh` cannot open the PR'],
    ];
    for (const [ok, label, why] of rows) {
      console.log(`  ${ok ? 'ok  ' : 'MISS'}  ${label}${ok ? '' : `\n          ${why}`}`);
    }

    const blocked = !rows[0][0] || !rows[1][0];
    console.log(
      `\n${blocked ? 'Detection is blocked — fix the MISS rows above.' : 'Detection works. Anything missing above only limits repair, never detection.'}`,
    );
    process.exitCode = blocked ? EXIT.FAILED : EXIT.OK;
  },

  async reset() {
    rmSync(store.SMA, { recursive: true, force: true });
    console.log(`cleared ${store.SMA} — the next run captures a fresh baseline and detects nothing`);
  },

  help() {
    console.log(`sma — self-maintaining API integrations

  sma init            write watch.yaml, or capture the baseline if it exists
  sma doctor          report what is installed and what each missing piece costs
  sma scan            find call sites for the watched APIs in this repo
  sma check           fetch specs, diff against the last snapshot, classify changes
  sma impact          map the latest changes onto the call sites
  sma fix             hand breaking+used changes to the repair agent, open PRs
  sma run [--fix]     all of the above
  sma reset           forget every snapshot and start over

  --no-llm            rules only; never call the API for ambiguous deltas
  --config <path>     use this watch.yaml (default: nearest one up from the cwd)

exit codes
  0  nothing broken
  1  a breaking change reached this repo
  2  sma itself failed (bad config, network, missing prerequisite)
`);
  },
};

try {
  await (commands[command] ?? commands.help)();
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(EXIT.FAILED);
}
