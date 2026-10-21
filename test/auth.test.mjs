// AUTH_SCHEME_CHANGED is the only whole-spec rule, so every hit claims every call
// site of the API and becomes repairable. A false positive here does not just add
// noise — it opens a PR that rewrites authentication across the whole repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRules } from '../src/rules.mjs';

const spec = (schemes) => ({
  openapi: '3.0.0',
  paths: { '/pets': { get: { operationId: 'listPets', responses: {} } } },
  components: { securitySchemes: schemes },
});

const authHits = (a, b) => applyRules(a, b).filter((h) => h.rule === 'AUTH_SCHEME_CHANGED');

const bearer = { type: 'http', scheme: 'bearer' };
const apiKey = { type: 'apiKey', in: 'header', name: 'X-Key' };

test('adding a new auth scheme is not breaking', () => {
  // The regression: an upstream offering OAuth *in addition to* the existing key
  // used to be reported as breaking and patched everywhere.
  assert.deepEqual(authHits(spec({ bearer }), spec({ bearer, apiKey })), []);
});

test('adding the first auth scheme to a previously open API is not breaking', () => {
  assert.deepEqual(authHits(spec({}), spec({ bearer })), []);
});

test('removing an auth scheme is still breaking', () => {
  const hits = authHits(spec({ bearer, apiKey }), spec({ bearer }));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].detail.scheme, 'apiKey');
  assert.equal(hits[0].severity, 'breaking');
});

test('changing an existing auth scheme is still breaking', () => {
  const hits = authHits(spec({ bearer }), spec({ bearer: { type: 'http', scheme: 'basic' } }));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].severity, 'breaking');
  assert.equal(hits[0].detail.after.scheme, 'basic');
});

test('an unchanged scheme produces nothing', () => {
  assert.deepEqual(authHits(spec({ bearer }), spec({ bearer })), []);
});
