// Rules first, LLM second. The rule engine explains what it can; only the leftover
// deltas cost a token. Low-confidence verdicts are reported, never auto-patched.
import Anthropic from '@anthropic-ai/sdk';
import { diff, coveredBy } from './diff.mjs';
import { applyRules } from './rules.mjs';

export const MODEL = process.env.SMA_MODEL || 'claude-opus-5';
export const CONFIDENCE_FLOOR = 0.7;

// Noise the rules deliberately don't model: docs prose, and the components block
// (already inlined into every operation by resolveRefs, so it would double-report).
const IGNORED = [
  /^\/info(\/|$)/,
  /^\/servers(\/|$)/,
  /^\/components\/schemas(\/|$)/,
  /(^|\/)(description|summary|example|examples|title|operationId|tags)(\/|$)/,
];

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          pointer: { type: 'string' },
          severity: { type: 'string', enum: ['breaking', 'warning', 'safe'] },
          reason: { type: 'string' },
          confidence: { type: 'number' },
        },
        required: ['pointer', 'severity', 'reason', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdicts'],
  additionalProperties: false,
};

export function unexplainedDeltas(before, after, hits) {
  const covered = hits.flatMap((h) => h.pointers);
  return diff(before, after).filter(
    (d) => !IGNORED.some((re) => re.test(d.pointer)) && !coveredBy(d.pointer, covered),
  );
}

async function askClaude(apiName, deltas) {
  const client = new Anthropic();
  const prompt = [
    `The OpenAPI spec for "${apiName}" changed. My deterministic rule engine already`,
    'classified everything it recognises. Below are the leftover changes it has no rule for.',
    'For each one decide whether it could break existing client code.',
    '',
    'breaking = existing correct client code can now fail or silently misbehave.',
    'warning  = still works, but signals upcoming removal (deprecation, sunset notice).',
    'safe     = purely additive or cosmetic.',
    '',
    'Return one verdict per pointer, with confidence 0-1. If you are unsure, say so with a',
    'low confidence rather than guessing "breaking".',
    '',
    JSON.stringify(deltas, null, 2),
  ].join('\n');

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    output_config: { format: { type: 'json_schema', schema: VERDICT_SCHEMA } },
    messages: [{ role: 'user', content: prompt }],
  });

  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse(text).verdicts;
}

export async function classify(before, after, { apiName, useLlm = true } = {}) {
  const hits = applyRules(before, after);
  const leftovers = unexplainedDeltas(before, after, hits);

  if (!leftovers.length) return { changes: hits, reviewed: 0, skipped: 0 };

  if (!useLlm || !process.env.ANTHROPIC_API_KEY) {
    // No key, no guessing. Surface them as unknown so they show up in the report.
    for (const d of leftovers) {
      hits.push({
        rule: 'UNCLASSIFIED',
        severity: 'unknown',
        path: null,
        method: null,
        detail: { pointer: d.pointer, op: d.op },
        reason: `no rule covers ${d.pointer} and no LLM review was run`,
        pointers: [d.pointer],
        source: 'none',
      });
    }
    return { changes: hits, reviewed: 0, skipped: leftovers.length };
  }

  const verdicts = await askClaude(apiName, leftovers);
  for (const v of verdicts) {
    const confident = v.confidence >= CONFIDENCE_FLOOR;
    hits.push({
      rule: 'LLM_REVIEWED',
      // Below the floor we keep the finding but strip its teeth — it gets reported,
      // never repaired.
      severity: confident ? v.severity : 'unknown',
      path: null,
      method: null,
      detail: { pointer: v.pointer, confidence: v.confidence, claimed: v.severity },
      reason: confident ? v.reason : `${v.reason} (low confidence ${v.confidence}, not auto-patched)`,
      pointers: [v.pointer],
      source: 'llm',
    });
  }
  return { changes: hits, reviewed: verdicts.length, skipped: 0 };
}
