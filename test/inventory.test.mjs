// The scanner must find every call site, attribute it to the right endpoint, and
// stay quiet about everything else. Runs against test/fixtures/repo so it does not
// depend on whatever branch the demo app happens to be on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { scan, shape } from '../src/inventory.mjs';

const cfg = {
  repoPath: resolve('test/fixtures/repo'),
  apis: [{ name: 'widgets', baseUrl: 'https://api.example.com' }],
};

const at = (sites, file, line) => sites.find((s) => s.file === file && s.line === line);

test('finds every request and resolves its endpoint', () => {
  const { sites } = scan(cfg);
  const http = sites.filter((s) => s.kind === 'http');
  assert.deepEqual(
    http.map((s) => `${s.method} ${s.path}`).sort(),
    ['GET /widgets', 'GET /widgets/{}', 'POST /widgets'].sort(),
  );
});

test('template literals collapse to spec-comparable paths', () => {
  const { sites } = scan(cfg);
  const site = at(sites, 'api.js', 8);
  assert.equal(site.path, '/widgets/{}');
  assert.equal(shape('/widgets/{id}'), site.path);
});

test('the method comes from the options object, not the default', () => {
  const { sites } = scan(cfg);
  assert.equal(at(sites, 'api.js', 12).method, 'POST');
});

test('requests to other hosts are ignored', () => {
  const { sites } = scan(cfg);
  assert.equal(
    sites.some((s) => s.snippet.includes('example.org')),
    false,
  );
});

test('a runtime-computed URL is reported as unresolved, never silently dropped', () => {
  const { unresolved } = scan(cfg);
  assert.equal(unresolved.length, 1);
  assert.match(unresolved[0].snippet, /fetch\(path\)/);
});

test('one-hop callers are found and attributed to the endpoint they reach', () => {
  const { sites } = scan(cfg);
  const callers = sites.filter((s) => s.kind === 'caller');
  assert.deepEqual(
    callers.map((s) => `${s.file}:${s.via} -> ${s.method} ${s.path}`),
    ['consumer.js:getWidget -> GET /widgets/{}'],
  );
});

test('import statements are not mistaken for call sites', () => {
  const { sites } = scan(cfg);
  assert.equal(at(sites, 'consumer.js', 1), undefined);
});
