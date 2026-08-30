// Fetch a spec, flatten it, and compare against the last snapshot we saw.
import { existsSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import * as store from './store.mjs';

// `fetch` reports every network problem as the same two words, so unwrap the cause
// — "fetch failed" tells you nothing about which spec, or why.
async function fetchOverHttp(url) {
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    const code = err.cause?.code ?? err.message;
    const hint =
      code === 'ECONNREFUSED' && /localhost|127\.0\.0\.1/.test(url)
        ? ' — is the server running? (`node demo/petstore/server.mjs`)'
        : '';
    throw new Error(`could not fetch ${url}: ${code}${hint}`);
  }
  if (!res.ok) throw new Error(`could not fetch ${url}: HTTP ${res.status} ${res.statusText}`);
  return res.text();
}

export async function fetchSpec(location) {
  const raw = /^https?:\/\//.test(location) ? await fetchOverHttp(location) : store.readText(location);
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

export function hasSnapshot(name) {
  return loadSnapshot(name) !== null;
}
