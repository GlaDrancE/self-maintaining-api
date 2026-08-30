// Joining changes to call sites is where over-reporting creeps in: a change with no
// endpoint must not claim the whole repo, and one upstream edit hitting three
// operations must not become three PRs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildImpact, repairable } from '../src/impact.mjs';

const SPEC = { paths: { '/pets': { get: { operationId: 'listPets' } } } };

const sites = [
  { api: 'petstore', kind: 'http', method: 'GET', path: '/pets', file: 'src/pets.js', line: 4, snippet: 'fetch' },
  { api: 'petstore', kind: 'http', method: 'GET', path: '/pets/{}', file: 'src/pets.js', line: 9, snippet: 'fetch' },
  { api: 'petstore', kind: 'caller', method: 'GET', path: '/pets', file: 'test/a.mjs', line: 3, snippet: 'listPets()' },
  { api: 'petstore', kind: 'http', method: 'POST', path: '/pets', file: 'src/pets.js', line: 14, snippet: 'fetch' },
  { api: 'other', kind: 'http', method: 'GET', path: '/pets', file: 'src/x.js', line: 1, snippet: 'fetch' },
];

const change = (over = {}) => ({
  api: 'petstore',
  rule: 'RESPONSE_FIELD_REMOVED',
  severity: 'breaking',
  detail: { field: 'tag' },
  path: '/pets',
  method: 'GET',
  reason: 'gone',
  ...over,
});

test('a change matches its own endpoint, including one-hop callers', () => {
  const [i] = buildImpact([change()], sites, SPEC);
  assert.deepEqual(
    i.sites.map((s) => `${s.file}:${s.line}`),
    ['src/pets.js:4', 'test/a.mjs:3'],
  );
});

test('call sites belonging to a different api are never matched', () => {
  const [i] = buildImpact([change()], sites, SPEC);
  assert.equal(
    i.sites.some((s) => s.file === 'src/x.js'),
    false,
  );
});

test('an unused change is reported as not-affected rather than dropped', () => {
  const [i] = buildImpact([change({ path: '/unused' })], sites, SPEC);
  assert.equal(i.affected, false);
  assert.equal(i.sites.length, 0);
});

test('an auth change reaches every call site', () => {
  const [i] = buildImpact([change({ rule: 'AUTH_SCHEME_CHANGED', path: null, method: null })], sites, SPEC);
  assert.equal(i.sites.length, 4); // all petstore sites, not the `other` one
});

test('an unclassified whole-spec delta claims nothing', () => {
  // Regression: this used to match every site, drowning the report in false impact.
  const [i] = buildImpact(
    [change({ rule: 'UNCLASSIFIED', severity: 'unknown', path: null, method: null })],
    sites,
    SPEC,
  );
  assert.equal(i.affected, false);
});

test('only breaking-and-used changes are repairable', () => {
  const impacts = buildImpact(
    [change({ severity: 'safe' }), change({ severity: 'unknown' }), change({ path: '/unused' })],
    sites,
    SPEC,
  );
  assert.deepEqual(repairable(impacts), []);
});

test('one upstream edit across several operations becomes one repair', () => {
  // Same field removed from a shared schema, seen on three operations.
  const impacts = buildImpact(
    [change({ path: '/pets', method: 'GET' }), change({ path: '/pets', method: 'POST' }), change({ path: '/pets/{id}', method: 'GET' })],
    sites,
    SPEC,
  );
  const todo = repairable(impacts);
  assert.equal(todo.length, 1);
  assert.deepEqual(todo[0].endpoints, ['GET /pets', 'POST /pets', 'GET /pets/{id}']);
  // and it carries the union of the call sites, deduplicated
  assert.deepEqual(
    todo[0].sites.map((s) => `${s.file}:${s.line}`),
    ['src/pets.js:4', 'test/a.mjs:3', 'src/pets.js:14', 'src/pets.js:9'],
  );
});

test('different changes stay separate repairs', () => {
  const impacts = buildImpact([change(), change({ rule: 'PARAM_RENAMED', detail: { from: 'limit' } })], sites, SPEC);
  assert.equal(repairable(impacts).length, 2);
});
