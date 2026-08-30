// Generic structural diff over two resolved specs, emitting RFC-6901 JSON pointers.
// The rule engine explains what it can; whatever is left over goes to the LLM.
const esc = (key) => String(key).replace(/~/g, '~0').replace(/\//g, '~1');
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function diff(before, after, pointer = '') {
  if (before === after) return [];

  if (isObj(before) && isObj(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].flatMap((k) => {
      const p = `${pointer}/${esc(k)}`;
      if (!(k in after)) return [{ op: 'remove', pointer: p, before: before[k] }];
      if (!(k in before)) return [{ op: 'add', pointer: p, after: after[k] }];
      return diff(before[k], after[k], p);
    });
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    // Spec arrays (parameters, enums, required) are sets in practice, so compare
    // by value rather than by index — otherwise reordering reads as a change.
    const key = (v) => (isObj(v) && v.name ? v.name : JSON.stringify(v));
    const b = new Map(before.map((v) => [key(v), v]));
    const a = new Map(after.map((v) => [key(v), v]));
    const out = [];
    for (const [k, v] of b) {
      const p = `${pointer}/${esc(k)}`;
      if (!a.has(k)) out.push({ op: 'remove', pointer: p, before: v });
      else out.push(...diff(v, a.get(k), p));
    }
    for (const [k, v] of a) if (!b.has(k)) out.push({ op: 'add', pointer: `${pointer}/${esc(k)}`, after: v });
    return out;
  }

  return [{ op: 'change', pointer, before, after }];
}

// True when `pointer` sits at or below any of `prefixes`.
export function coveredBy(pointer, prefixes) {
  return prefixes.some((p) => pointer === p || pointer.startsWith(p + '/'));
}
