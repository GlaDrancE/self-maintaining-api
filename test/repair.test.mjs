// The verification path. These cover the cases where the harness used to lose or
// wave through the agent's work — both of them silent, which is why they get tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { touchedFiles } from '../src/repair.mjs';

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'sma-repair-'));
  const git = (...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'test');
  git('config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'tracked.js'), 'export const a = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  return { dir, git };
}

test('a file the agent created is reported, not silently dropped', () => {
  const { dir } = repo();
  // The failure this guards: `git diff --name-only` lists tracked modifications
  // only, so a repair written as a new module read as "the agent made no edits"
  // and the branch was deleted with the work on it.
  writeFileSync(join(dir, 'created.js'), 'export const b = 2;\n');
  assert.deepEqual(touchedFiles(dir), ['created.js']);
});

test('modified and created files are both reported', () => {
  const { dir } = repo();
  writeFileSync(join(dir, 'tracked.js'), 'export const a = 99;\n');
  writeFileSync(join(dir, 'created.js'), 'export const b = 2;\n');
  assert.deepEqual(touchedFiles(dir).sort(), ['created.js', 'tracked.js']);
});

test('every modified tracked file keeps its name, not just the first', () => {
  // Found by the demo: git() trims the whole output, so the second " M x" line kept
  // its leading space and was reported as "M test/api.test.mjs" — outside scope.
  const { dir, git } = repo();
  writeFileSync(join(dir, 'second.js'), 'export const c = 3;\n');
  git('add', '.');
  git('commit', '-qm', 'second');
  writeFileSync(join(dir, 'tracked.js'), 'export const a = 99;\n');
  writeFileSync(join(dir, 'second.js'), 'export const c = 99;\n');
  assert.deepEqual(touchedFiles(dir).sort(), ['second.js', 'tracked.js']);
});

test('a created file in a new directory keeps its full path', () => {
  const { dir } = repo();
  // Porcelain collapses an untracked directory to "dir/" unless asked otherwise.
  // The scope check compares against predicted file paths, so a bare directory
  // name would never match and would read as outside-scope noise.
  mkdirSync(join(dir, 'nested'));
  writeFileSync(join(dir, 'nested', 'deep.js'), 'export const c = 3;\n');
  assert.deepEqual(touchedFiles(dir), ['nested/deep.js']);
});

test('a rename is attributed to the new name', () => {
  const { dir, git } = repo();
  git('mv', 'tracked.js', 'renamed.js');
  assert.deepEqual(touchedFiles(dir), ['renamed.js']);
});

test('a clean repo reports nothing touched', () => {
  const { dir } = repo();
  assert.deepEqual(touchedFiles(dir), []);
});
