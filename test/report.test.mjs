// The report renders strings that came from someone else's spec and someone else's
// code. A field named `<script>` must come out as text, not run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderReport } from '../src/report.mjs';

const cfg = { repoPath: '/repo', apis: [{ name: 'evil', spec: 'https://x.io/spec.json' }] };

test('spec- and code-derived strings are escaped', () => {
  const html = renderReport({
    cfg,
    impacts: [
      {
        api: 'evil',
        rule: 'RESPONSE_FIELD_REMOVED',
        severity: 'breaking',
        method: 'GET',
        path: '/pets',
        reason: "response field '<script>alert(1)</script>' was removed",
        affected: true,
        sites: [{ file: 'a.js', line: 3, kind: 'http', snippet: 'fetch("<img src=x onerror=1>")' }],
      },
    ],
    inventory: { sites: [] },
    runs: [],
  });
  assert.ok(!html.includes('<script>alert'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('the verdict says whether a breaking change reaches this repo', () => {
  const base = { api: 'evil', rule: 'PATH_REMOVED', severity: 'breaking', path: '/x', reason: 'gone' };
  const hit = renderReport({ cfg, impacts: [{ ...base, affected: true, sites: [] }], inventory: null, runs: [] });
  const miss = renderReport({ cfg, impacts: [{ ...base, affected: false, sites: [] }], inventory: null, runs: [] });
  assert.match(hit, /1 breaking change\(s\) reach this repo/);
  assert.match(miss, /none touch code in this repo/);
  assert.match(renderReport({ cfg, impacts: null, inventory: null, runs: [] }), /No check has run yet/);
});

test('a repair run covering every affected change says so instead of raising the alarm', () => {
  const impacts = [{ api: 'evil', rule: 'PATH_REMOVED', severity: 'breaking', path: '/x', reason: 'gone', affected: true, sites: [] }];
  const runs = [{ at: '2026-01-01', api: 'evil', rules: ['PATH_REMOVED'], branch: 'sma/evil-1', testsPass: true, needsHuman: false, pr: null }];
  assert.match(renderReport({ cfg, impacts, inventory: null, runs }), /patched on sma\/evil-1, tests pass, awaiting review/);
});
