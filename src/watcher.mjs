// Fetch a spec, flatten it, and compare against the last snapshot we saw.
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import * as store from './store.mjs';

const TIMEOUT_MS = 60_000;
const ATTEMPTS = 3;

// A spec URL can carry a token (`?api_key=...`), and it gets printed on failure and
// written into PR bodies. Mask the value of anything that looks like a credential.
export const redact = (s) =>
  String(s).replace(/([?&](?:[^=&]*(?:key|token|secret|sig|signature|auth|password)[^=&]*)=)[^&#\s]+/gi, '$1***');

// `${VAR}` in a header value is read from the environment, so a private spec can be
// watched from CI without the token ever being written into watch.yaml or .sma/.
export function expandHeaders(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [
      k,
      String(v).replace(/\$\{(\w+)\}/g, (_, name) => {
        if (process.env[name] === undefined) throw new Error(`header ${k} needs $${name}, which is not set`);
        return process.env[name];
      }),
    ]),
  );
}

// `fetch` reports every network problem as the same two words, so unwrap the cause
// — "fetch failed" tells you nothing about which spec, or why. A hung server fails
// after TIMEOUT_MS instead of hanging the CI job; 429 and 5xx are retried.
async function fetchOverHttp(url, headers) {
  const shown = redact(url);
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      const code = err.name === 'TimeoutError' ? `no response after ${TIMEOUT_MS / 1000}s` : (err.cause?.code ?? err.message);
      const hint =
        code === 'ECONNREFUSED' && /localhost|127\.0\.0\.1/.test(url)
          ? ' — is the server running? (`node demo/petstore/server.mjs`)'
          : '';
      throw new Error(`could not fetch ${shown}: ${code}${hint}`);
    }
    if (res.ok) return res.text();
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === ATTEMPTS) {
      throw new Error(`could not fetch ${shown}: HTTP ${res.status} ${res.statusText}`);
    }
    const wait = Math.min(Number(res.headers.get('retry-after')) || 2 ** attempt, 30);
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
}

// A local `spec:` path is resolved against the config file, not the cwd — the same
// rule `repo:` already follows. Without this, `--config ../watch.yaml` looks for the
// spec relative to wherever you happened to be standing and fails with ENOENT.
export async function fetchSpec(location, base = store.ROOT, headers) {
  const raw = /^https?:\/\//.test(location)
    ? await fetchOverHttp(location, expandHeaders(headers))
    : store.readText(resolve(base, location));
  // YAML is a superset of JSON, so one parser handles both.
  return parseYaml(raw);
}

// Inline local $refs so the rules never have to chase pointers. Cyclic refs are
// left as-is rather than expanded forever.
export function resolveRefs(spec) {
  const at = (pointer) =>
    pointer
      .slice(2)
      .split('/')
      .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'))
      .reduce((node, key) => node?.[key], spec);

  const walk = (node, seen) => {
    if (Array.isArray(node)) return node.map((n) => walk(n, seen));
    if (!node || typeof node !== 'object') return node;
    const ref = node.$ref;
    if (typeof ref === 'string' && ref.startsWith('#/')) {
      if (seen.has(ref)) return { $ref: ref, $circular: true };
      const target = at(ref);
      if (target === undefined) return node;
      return walk(target, new Set([...seen, ref]));
    }
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v, seen)]));
  };

  return walk(spec, new Set());
}

const snapshotPath = (name) => `specs/${name}.json`;

export function loadSnapshot(name) {
  return store.read(snapshotPath(name));
}

export function saveSnapshot(name, spec) {
  return store.write(snapshotPath(name), spec);
}
