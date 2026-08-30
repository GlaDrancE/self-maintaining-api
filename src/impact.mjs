// Join detected changes against the call-site inventory. A change with no call
// sites is reported as not-affected rather than dropped — that's what shows the
// mapper is matching, not guessing.
import { shape } from './inventory.mjs';

// A change with no endpoint only reaches every call site if it really is global.
// An UNCLASSIFIED delta (a version-string bump, a vendor extension) does not, and
// claiming all of them would drown the report in false impact.
const WHOLE_SPEC_RULES = new Set(['AUTH_SCHEME_CHANGED']);

export function operationIdFor(spec, change) {
  if (!change.path || !change.method) return null;
  return spec?.paths?.[change.path]?.[change.method.toLowerCase()]?.operationId ?? null;
}

function matches(change, site, opId) {
  if (site.api !== change.api) return false;

  // `caller` sites carry the method/path of the request they wrap, so they match
  // the same way — they just live one hop away from the actual fetch.
  if (site.kind === 'http' || site.kind === 'caller') {
    if (!change.path) return WHOLE_SPEC_RULES.has(change.rule);
    if (shape(site.path) !== shape(change.path)) return false;
    return !change.method || site.method === change.method;
  }

  // ponytail: SDK matching is operationId-in-the-method-chain. Fine for SDKs
  // generated from the spec; hand-written SDKs need a name map.
  if (site.kind === 'sdk') {
    if (!change.path) return WHOLE_SPEC_RULES.has(change.rule);
    if (!opId) return false;
    return site.symbol.toLowerCase().includes(opId.toLowerCase());
  }
  return false;
}

export function buildImpact(changes, sites, spec) {
  return changes.map((change) => {
    const opId = operationIdFor(spec, change);
    const hits = sites.filter((s) => matches(change, s, opId));
    return { ...change, api: change.api, operationId: opId, sites: hits, affected: hits.length > 0 };
  });
}

// Only these get handed to the repair agent: genuinely breaking, and actually used.
// One upstream change often hits several operations (a removed field on a shared
// schema), so they're grouped into a single repair rather than one PR each.
export function repairable(impacts) {
  const groups = new Map();
  for (const i of impacts.filter((x) => x.severity === 'breaking' && x.affected)) {
    const subject = i.detail.field ?? i.detail.name ?? i.detail.from ?? i.detail.scheme ?? i.path ?? '';
    const key = `${i.api}:${i.rule}:${subject}`;
    const endpoint = [i.method, i.path].filter(Boolean).join(' ') || '(whole spec)';
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { ...i, endpoints: [endpoint] });
      continue;
    }
    existing.endpoints.push(endpoint);
    for (const site of i.sites) {
      if (!existing.sites.some((s) => s.file === site.file && s.line === site.line)) existing.sites.push(site);
    }
  }
  return [...groups.values()];
}

export function report(impacts) {
  const order = { breaking: 0, unknown: 1, warning: 2, safe: 3 };
  const lines = [];
  for (const i of [...impacts].sort((a, b) => order[a.severity] - order[b.severity])) {
    const where = [i.method, i.path].filter(Boolean).join(' ') || '(whole spec)';
    lines.push(`[${i.severity}] ${i.rule}  ${where}`);
    lines.push(`    ${i.reason}`);
    if (i.affected) for (const s of i.sites) lines.push(`    -> ${s.file}:${s.line}  ${s.snippet}`);
    else lines.push('    -> not affected (no call sites in this repo)');
  }
  return lines.join('\n');
}
