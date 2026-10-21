// A local `spec:` path has to mean the same directory whatever the cwd is, for the
// same reason `repo:` does: otherwise running from a subdirectory quietly looks
// somewhere else. store.test.mjs asserts that rule for `repo`; this is `spec`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { fetchSpec, redact, expandHeaders } from '../src/watcher.mjs';

const MINIMAL = { openapi: '3.0.0', info: { title: 'local', version: '1' }, paths: {} };

test('a local spec path resolves against the given base, not the cwd', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sma-spec-'));
  writeFileSync(join(dir, 'openapi.json'), JSON.stringify(MINIMAL));
  const spec = await fetchSpec('openapi.json', dir);
  assert.equal(spec.info.title, 'local');
});

test('a nested local spec path resolves against the base', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sma-spec-'));
  mkdirSync(join(dir, 'specs'));
  writeFileSync(join(dir, 'specs', 'api.yaml'), 'openapi: 3.0.0\ninfo:\n  title: nested\n  version: "1"\npaths: {}\n');
  const spec = await fetchSpec('specs/api.yaml', dir);
  assert.equal(spec.info.title, 'nested');
});

test('an absolute local spec path is left alone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sma-spec-'));
  const file = join(dir, 'openapi.json');
  writeFileSync(file, JSON.stringify(MINIMAL));
  // resolve() returns an absolute argument unchanged, so an unrelated base is fine.
  const spec = await fetchSpec(file, tmpdir());
  assert.equal(spec.info.title, 'local');
});

test('a missing local spec names the resolved path, not the bare string', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sma-spec-'));
  await assert.rejects(fetchSpec('nope.json', dir), (err) => err.message.includes('nope.json'));
});

test('a credential in a spec URL is masked; the rest of the URL is not', () => {
  assert.equal(
    redact('https://x.io/openapi.json?api_key=abc123&v=2&access_token=zzz'),
    'https://x.io/openapi.json?api_key=***&v=2&access_token=***',
  );
  assert.equal(redact('https://x.io/openapi.json?v=2'), 'https://x.io/openapi.json?v=2');
});

test('header values read ${VAR} from the environment and refuse an unset one', () => {
  process.env.SMA_TEST_TOKEN = 's3cret';
  assert.deepEqual(expandHeaders({ Authorization: 'Bearer ${SMA_TEST_TOKEN}' }), { Authorization: 'Bearer s3cret' });
  delete process.env.SMA_TEST_UNSET;
  assert.throws(() => expandHeaders({ Authorization: 'Bearer ${SMA_TEST_UNSET}' }), /SMA_TEST_UNSET/);
});

test('a 503 is retried, headers are sent, and the spec comes back', async () => {
  let calls = 0;
  let auth;
  const server = createServer((req, res) => {
    calls++;
    auth = req.headers.authorization;
    if (calls === 1) {
      res.writeHead(503, { 'retry-after': '1' });
      return res.end();
    }
    res.end(JSON.stringify(MINIMAL));
  });
  await new Promise((r) => server.listen(0, r));
  try {
    process.env.SMA_TEST_TOKEN = 's3cret';
    const url = `http://127.0.0.1:${server.address().port}/openapi.json`;
    const spec = await fetchSpec(url, tmpdir(), { Authorization: 'Bearer ${SMA_TEST_TOKEN}' });
    assert.equal(spec.info.title, 'local');
    assert.equal(calls, 2);
    assert.equal(auth, 'Bearer s3cret');
  } finally {
    server.close();
  }
});
