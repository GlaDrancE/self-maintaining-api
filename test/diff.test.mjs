// The rule engine is the core of the project, so this is the test that matters:
// feed it the two petstore specs and assert the exact hit set — no misses, and
// just as importantly no false positives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchSpec, resolveRefs } from '../src/watcher.mjs';
import { applyRules } from '../src/rules.mjs';
import { unexplainedDeltas } from '../src/classify.mjs';

const load = async (v) => resolveRefs(await fetchSpec(`demo/petstore/openapi.${v}.json`));
const key = (h) => `${h.rule} ${h.method ?? '-'} ${h.path ?? '-'}`;

const EXPECTED = [
  'PARAM_RENAMED GET /pets',
  'RESPONSE_FIELD_REMOVED GET /pets',
  'REQUIRED_PARAM_ADDED POST /pets',
  'RESPONSE_FIELD_REMOVED POST /pets',
  'RESPONSE_FIELD_REMOVED GET /pets/{id}',
  'PATH_ADDED - /pets/{id}/owner',
];

test('v1 -> v2 produces exactly the expected rule hits', async () => {
  const hits = applyRules(await load('v1'), await load('v2'));
  assert.deepEqual(hits.map(key).sort(), [...EXPECTED].sort());
});

test('every breaking hit is breaking, and the added endpoint is safe', async () => {
  const hits = applyRules(await load('v1'), await load('v2'));
  const bySeverity = (s) => hits.filter((h) => h.severity === s).map(key);
  assert.equal(bySeverity('breaking').length, 5);
  assert.deepEqual(bySeverity('safe'), ['PATH_ADDED - /pets/{id}/owner']);
});

test('the rules explain the whole diff — nothing is left for the LLM', async () => {
  const [a, b] = [await load('v1'), await load('v2')];
  assert.deepEqual(unexplainedDeltas(a, b, applyRules(a, b)), []);
});

test('rename is detected structurally, not by name similarity', async () => {
  const hits = applyRules(await load('v1'), await load('v2'));
  const rename = hits.find((h) => h.rule === 'PARAM_RENAMED');
  // `limit` and `pageSize` share no letters — a lexical heuristic would miss this.
  assert.deepEqual(rename.detail, { from: 'limit', to: 'pageSize', in: 'query' });
});

test('no false positives: a spec compared against itself reports nothing', async () => {
  const v2 = await load('v2');
  assert.deepEqual(applyRules(v2, structuredClone(v2)), []);
  assert.deepEqual(applyRules(await load('v1'), structuredClone(await load('v1'))), []);
});

test('reordered parameters and enum values are not a change', async () => {
  const a = await load('v1');
  const b = structuredClone(a);
  b.paths['/pets/{id}'].get.responses['200'].content['application/json'].schema.properties.status.enum.reverse();
  assert.deepEqual(applyRules(a, b), []);
});

test('a removed endpoint is breaking', async () => {
  const a = await load('v1');
  const b = structuredClone(a);
  delete b.paths['/pets/{id}'];
  const hits = applyRules(a, b);
  assert.deepEqual(hits.map(key), ['PATH_REMOVED - /pets/{id}']);
  assert.equal(hits[0].severity, 'breaking');
});

test('an optional param becoming required is breaking; a new optional one is not', async () => {
  const a = await load('v1');
  const b = structuredClone(a);
  b.paths['/pets'].get.parameters[0].required = true;
  b.paths['/pets'].get.parameters.push({ name: 'sort', in: 'query', schema: { type: 'string' } });
  const hits = applyRules(a, b);
  assert.deepEqual(
    hits.map((h) => [h.rule, h.severity]).sort(),
    [
      ['OPTIONAL_PARAM_ADDED', 'safe'],
      ['PARAM_MADE_REQUIRED', 'breaking'],
    ].sort(),
  );
});

test('dropping an enum value is breaking, adding one is not', async () => {
  const a = await load('v1');
  const b = structuredClone(a);
  const status = (spec) =>
    spec.paths['/pets/{id}'].get.responses['200'].content['application/json'].schema.properties.status;
  status(b).enum = ['available', 'sold', 'reserved'];
  const hits = applyRules(a, b).filter((h) => h.path === '/pets/{id}');
  assert.deepEqual(
    hits.map((h) => [h.rule, h.severity, h.detail.values]),
    [
      ['ENUM_VALUE_REMOVED', 'breaking', ['pending']],
      ['ENUM_VALUE_ADDED', 'safe', ['reserved']],
    ],
  );
});

test('a changed auth scheme is breaking', async () => {
  const a = await load('v1');
  const b = structuredClone(a);
  b.components.securitySchemes.apiKey = { type: 'http', scheme: 'bearer' };
  const hits = applyRules(a, b);
  assert.deepEqual(hits.map((h) => [h.rule, h.severity]), [['AUTH_SCHEME_CHANGED', 'breaking']]);
});
