import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findConfig, loadConfig } from '../src/store.mjs';

function project(yaml) {
  const root = mkdtempSync(join(tmpdir(), 'sma-'));
  mkdirSync(join(root, 'a', 'b'), { recursive: true });
  writeFileSync(join(root, 'watch.yaml'), yaml);
  return root;
}

const VALID = 'repo: .\napis:\n  - name: petstore\n    spec: http://x/openapi.json\n';

test('findConfig walks up to the nearest watch.yaml', () => {
  const root = project(VALID);
  assert.equal(findConfig(join(root, 'a', 'b')), join(root, 'watch.yaml'));
});

test('findConfig returns null instead of looping at the filesystem root', () => {
  assert.equal(findConfig(mkdtempSync(join(tmpdir(), 'empty-'))), null);
});

test('repo is resolved against the config file, not the cwd', () => {
  const root = project(VALID);
  assert.equal(loadConfig(join(root, 'watch.yaml')).repoPath, root);
});

test('an api name that could escape .sma/specs/ is rejected', () => {
  const root = project('repo: .\napis:\n  - name: ../../etc\n    spec: http://x\n');
  assert.throws(() => loadConfig(join(root, 'watch.yaml')), /must be letters/);
});

test('duplicate api names are rejected — snapshots are keyed by name', () => {
  const root = project(`${VALID}  - name: petstore\n    spec: http://y\n`);
  assert.throws(() => loadConfig(join(root, 'watch.yaml')), /duplicate/);
});
