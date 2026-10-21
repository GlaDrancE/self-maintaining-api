// The breaking-change rule table. Deterministic, no LLM. This is the core of the project.
const esc = (k) => String(k).replace(/~/g, '~0').replace(/\//g, '~1');
const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'];

export const SEVERITY = {
  PATH_REMOVED: 'breaking',
  METHOD_REMOVED: 'breaking',
  REQUIRED_PARAM_ADDED: 'breaking',
  PARAM_REMOVED: 'breaking',
  PARAM_RENAMED: 'breaking',
  PARAM_TYPE_CHANGED: 'breaking',
  PARAM_MADE_REQUIRED: 'breaking',
  RESPONSE_FIELD_REMOVED: 'breaking',
  RESPONSE_FIELD_TYPE_CHANGED: 'breaking',
  ENUM_VALUE_REMOVED: 'breaking',
  AUTH_SCHEME_CHANGED: 'breaking',
  PATH_DEPRECATED: 'warning',
  PATH_ADDED: 'safe',
  METHOD_ADDED: 'safe',
  OPTIONAL_PARAM_ADDED: 'safe',
  RESPONSE_FIELD_ADDED: 'safe',
  ENUM_VALUE_ADDED: 'safe',
};

// --- spec readers -----------------------------------------------------------

const unwrapArray = (schema) => {
  let s = schema;
  while (s?.type === 'array' && s.items) s = s.items;
  return s;
};

function jsonSchemaOf(container) {
  const content = container?.content ?? {};
  const key = Object.keys(content).find((k) => k.includes('json')) ?? Object.keys(content)[0];
  return unwrapArray(content[key]?.schema);
}

function successResponse(op) {
  const codes = Object.keys(op.responses ?? {}).filter((c) => /^2\d\d$/.test(c)).sort();
  return codes.length ? { code: codes[0], schema: jsonSchemaOf(op.responses[codes[0]]) } : null;
}

// OpenAPI 3.1 allows `type: ["string", "null"]`. Arrays compare by reference, so
// without this every such field read as "changed type" on every run.
const typeOf = (t) => (Array.isArray(t) ? [...t].sort().join(',') : t);

// Every parameter and body property normalised into one shape, so the rules below
// only ever deal with { name, in, type, required, enum }.
function fieldsOf(op, pathItem) {
  const out = new Map();
  for (const p of [...(pathItem.parameters ?? []), ...(op.parameters ?? [])]) {
    out.set(`${p.in}:${p.name}`, {
      name: p.name,
      in: p.in,
      type: typeOf(p.schema?.type ?? p.type),
      required: !!p.required,
      enum: p.schema?.enum,
    });
  }
  const body = jsonSchemaOf(op.requestBody);
  for (const [name, schema] of Object.entries(body?.properties ?? {})) {
    out.set(`body:${name}`, {
      name,
      in: 'body',
      type: typeOf(schema.type),
      required: (body.required ?? []).includes(name),
      enum: schema.enum,
    });
  }
  return out;
}

function responseFieldsOf(op) {
  const res = successResponse(op);
  const out = new Map();
  for (const [name, schema] of Object.entries(res?.schema?.properties ?? {})) {
    out.set(name, { name, type: typeOf(schema.type), enum: schema.enum, code: res.code });
  }
  return out;
}

// --- rule engine ------------------------------------------------------------

export function applyRules(before, after) {
  const hits = [];
  const at = (path, method, rule, detail, reason, pointers) =>
    hits.push({ rule, severity: SEVERITY[rule], path, method, detail, reason, pointers, source: 'rule' });

  const oldPaths = before.paths ?? {};
  const newPaths = after.paths ?? {};

  for (const path of Object.keys(oldPaths)) {
    if (!(path in newPaths)) {
      at(path, null, 'PATH_REMOVED', {}, `endpoint ${path} no longer exists`, [`/paths/${esc(path)}`]);
      continue;
    }
    for (const method of METHODS) {
      const oldOp = oldPaths[path][method];
      const newOp = newPaths[path][method];
      if (!oldOp) continue;
      const at2 = (rule, detail, reason) =>
        at(path, method.toUpperCase(), rule, detail, reason, [`/paths/${esc(path)}/${method}`]);

      if (!newOp) {
        at2('METHOD_REMOVED', {}, `${method.toUpperCase()} ${path} was removed`);
        continue;
      }
      if (newOp.deprecated && !oldOp.deprecated) {
        at2('PATH_DEPRECATED', {}, `${method.toUpperCase()} ${path} is now deprecated`);
      }
      compareFields(oldOp, oldPaths[path], newOp, newPaths[path], at2);
      compareResponses(oldOp, newOp, at2);
    }
  }

  for (const path of Object.keys(newPaths)) {
    if (!(path in oldPaths)) {
      at(path, null, 'PATH_ADDED', {}, `new endpoint ${path}`, [`/paths/${esc(path)}`]);
      continue;
    }
    for (const method of METHODS) {
      if (newPaths[path][method] && !oldPaths[path][method]) {
        at(path, method.toUpperCase(), 'METHOD_ADDED', {}, `new operation ${method.toUpperCase()} ${path}`, [
          `/paths/${esc(path)}/${method}`,
        ]);
      }
    }
  }

  compareAuth(before, after, hits);
  return hits;
}

function compareFields(oldOp, oldPathItem, newOp, newPathItem, at2) {
  const oldF = fieldsOf(oldOp, oldPathItem);
  const newF = fieldsOf(newOp, newPathItem);
  const removed = [...oldF.keys()].filter((k) => !newF.has(k));
  const added = [...newF.keys()].filter((k) => !oldF.has(k));

  // ponytail: a rename is inferred from "exactly one out, exactly one in, same
  // location and same type". Structural, not lexical -- `limit` and `pageSize`
  // share no letters. Swap in a real rename map if an API ever publishes one.
  if (removed.length === 1 && added.length === 1) {
    const from = oldF.get(removed[0]);
    const to = newF.get(added[0]);
    if (from.in === to.in && from.type === to.type) {
      at2(
        'PARAM_RENAMED',
        { from: from.name, to: to.name, in: from.in },
        `${from.in} parameter '${from.name}' was renamed to '${to.name}'`,
      );
      return compareCommonFields(oldF, newF, at2);
    }
  }

  for (const k of removed) {
    const f = oldF.get(k);
    at2('PARAM_REMOVED', { name: f.name, in: f.in }, `${f.in} parameter '${f.name}' was removed`);
  }
  for (const k of added) {
    const f = newF.get(k);
    if (f.required) {
      at2(
        'REQUIRED_PARAM_ADDED',
        { name: f.name, in: f.in, type: f.type },
        `new required ${f.in} parameter '${f.name}'`,
      );
    } else {
      at2('OPTIONAL_PARAM_ADDED', { name: f.name, in: f.in }, `new optional ${f.in} parameter '${f.name}'`);
    }
  }
  compareCommonFields(oldF, newF, at2);
}

function compareCommonFields(oldF, newF, at2) {
  for (const [k, from] of oldF) {
    const to = newF.get(k);
    if (!to) continue;
    if (from.type !== to.type) {
      at2(
        'PARAM_TYPE_CHANGED',
        { name: from.name, in: from.in, from: from.type, to: to.type },
        `${from.in} parameter '${from.name}' changed type from ${from.type} to ${to.type}`,
      );
    }
    if (!from.required && to.required) {
      at2('PARAM_MADE_REQUIRED', { name: from.name, in: from.in }, `${from.in} parameter '${from.name}' is now required`);
    }
    enumDelta(from, to, at2, `${from.in} parameter '${from.name}'`, { name: from.name, in: from.in });
  }
}

function compareResponses(oldOp, newOp, at2) {
  const oldR = responseFieldsOf(oldOp);
  const newR = responseFieldsOf(newOp);
  for (const [name, from] of oldR) {
    const to = newR.get(name);
    if (!to) {
      at2('RESPONSE_FIELD_REMOVED', { field: name, code: from.code }, `response field '${name}' was removed`);
      continue;
    }
    if (from.type !== to.type) {
      at2(
        'RESPONSE_FIELD_TYPE_CHANGED',
        { field: name, from: from.type, to: to.type },
        `response field '${name}' changed type from ${from.type} to ${to.type}`,
      );
    }
    enumDelta(from, to, at2, `response field '${name}'`, { field: name });
  }
  for (const [name] of newR) {
    if (!oldR.has(name)) at2('RESPONSE_FIELD_ADDED', { field: name }, `new response field '${name}'`);
  }
}

function enumDelta(from, to, at2, label, detail) {
  if (!Array.isArray(from.enum) || !Array.isArray(to.enum)) return;
  const gone = from.enum.filter((v) => !to.enum.includes(v));
  const fresh = to.enum.filter((v) => !from.enum.includes(v));
  if (gone.length) {
    at2('ENUM_VALUE_REMOVED', { ...detail, values: gone }, `${label} no longer accepts ${gone.join(', ')}`);
  }
  if (fresh.length) {
    at2('ENUM_VALUE_ADDED', { ...detail, values: fresh }, `${label} accepts new values ${fresh.join(', ')}`);
  }
}

function compareAuth(before, after, hits) {
  const a = before.components?.securitySchemes ?? {};
  const b = after.components?.securitySchemes ?? {};
  for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (JSON.stringify(a[name]) === JSON.stringify(b[name])) continue;
    // A scheme that did not exist before is an added option, not a changed contract.
    // This rule is the only whole-spec one, so every hit claims every call site of
    // the API and becomes repairable — an additive scheme used to open a PR
    // rewriting auth everywhere. Removal and modification are still breaking.
    if (a[name] === undefined) continue;
    hits.push({
      rule: 'AUTH_SCHEME_CHANGED',
      severity: SEVERITY.AUTH_SCHEME_CHANGED,
      path: null,
      method: null,
      detail: { scheme: name, before: a[name] ?? null, after: b[name] ?? null },
      reason: `authentication scheme '${name}' changed`,
      pointers: [`/components/securitySchemes/${esc(name)}`],
      source: 'rule',
    });
  }
}
