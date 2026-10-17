import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_RUN } from '../js/demo-data.js';
import {
  tierFor, tierReasonFor, defaultEnforcement, sortQueue, importDisagrees, headerCounts, checkTerms, normalizeTerm,
} from '../js/rules.js';

const cs = DEMO_RUN.concepts;
const words = (s) => s.trim().split(/\s+/).length;
const FIELDS = ['id', 'source', 'variants', 'termType', 'tier', 'tierReason', 'frequency', 'pages', 'proposal', 'renderings',
  'confidence', 'judgeChecks', 'judgeNote', 'imported', 'sibling', 'context', 'enforcement', 'scope', 'bucket', 'floor',
  'reopened', 'status', 'decision'];

test('run header fields', () => {
  assert.equal(DEMO_RUN.mode, 'demo');
  assert.equal(DEMO_RUN.id, 'demo_veloma');
  assert.deepEqual(DEMO_RUN.totals, { concepts: 3000, auto: 2860, queue: 140, randomCheck: 29 });
  assert.deepEqual(DEMO_RUN.budget, { entriesPerHour: 30, hours: 8, capacity: 240 });
  assert.ok(DEMO_RUN.site.pages.length >= 5 && DEMO_RUN.site.pages.length <= 6);
  assert.equal(DEMO_RUN.usage, null);
  assert.ok(!Number.isNaN(Date.parse(DEMO_RUN.createdAt)));
});

test('bucket counts and unique ids', () => {
  const n = (b) => cs.filter((c) => c.bucket === b).length;
  assert.equal(n('queue'), 30);
  assert.equal(n('random_check'), 5);
  assert.equal(n('auto'), 5);
  assert.equal(new Set(cs.map((c) => c.id)).size, cs.length);
});

test('every concept has every field and rule-derived values', () => {
  for (const c of cs) {
    for (const f of FIELDS) assert.ok(f in c, `${c.id} missing ${f}`);
    assert.equal(c.tier, tierFor(c.termType, 'healthcare'), c.id);
    assert.equal(c.tierReason, tierReasonFor(c.termType, 'healthcare'), c.id);
    assert.equal(c.enforcement, defaultEnforcement(c.tier), c.id);
    assert.equal(c.status, 'pending');
    assert.equal(c.decision, null);
    assert.equal(c.reopened, false);
    assert.ok(c.pages.every((p) => p.startsWith('https://veloma.example')));
  }
});

test('judge checks are consistent with imported and sibling', () => {
  for (const c of cs) {
    assert.equal(c.judgeChecks.importedAgrees === null, c.imported === null, c.id);
    assert.equal(c.judgeChecks.siblingAgrees === null, c.sibling === null, c.id);
    if (c.imported) assert.equal(c.judgeChecks.importedAgrees, !importDisagrees(c), c.id);
    if (c.sibling) assert.equal(c.judgeChecks.siblingAgrees, normalizeTerm(c.sibling.text) === normalizeTerm(c.proposal.text), c.id);
    assert.equal(c.judgeChecks.selfConsistent, new Set(c.renderings).size === 1, c.id);
  }
});

test('exactly 8 imported: 5 agree, 3 disagree, all disagreements queued', () => {
  const imp = cs.filter((c) => c.imported);
  assert.equal(imp.length, 8);
  assert.equal(imp.filter((c) => !importDisagrees(c)).length, 5);
  const dis = imp.filter(importDisagrees);
  assert.equal(dis.length, 3);
  assert.ok(dis.every((c) => c.bucket === 'queue'));
});

test('floors and buckets follow the rules', () => {
  for (const c of cs) {
    if (c.tier === 'critical' || (c.tier !== 'standard' && c.confidence < 0.6)) assert.equal(c.bucket, 'queue', c.id);
    if (c.bucket !== 'queue') {
      assert.ok(c.confidence >= 0.9, c.id);
      assert.notEqual(c.tier, 'critical');
      assert.equal(c.floor, null);
    }
    if (c.tier === 'critical') assert.equal(c.floor, 'critical');
    else if (c.tier === 'high' && c.confidence < 0.6) assert.equal(c.floor, 'high_low_conf');
    else if (c.tier === 'low' && c.confidence < 0.6) assert.equal(c.floor, 'low_low_conf');
    else if (c.floor) assert.equal(c.floor, 'high_sample');
  }
  const sampled = cs.filter((c) => c.floor === 'high_sample');
  assert.equal(sampled.length, 1);
  assert.equal(sampled[0].tier, 'high');
  assert.ok(cs.filter((c) => c.tier === 'critical' && c.confidence > 0.9).length >= 2);
});

test('two lowest-confidence Standard items outrank most High items', () => {
  const sorted = sortQueue(cs.filter((c) => c.bucket === 'queue'));
  const highs = sorted.filter((c) => c.tier === 'high');
  const lowest = cs.filter((c) => c.tier === 'standard').sort((a, b) => a.confidence - b.confidence).slice(0, 2);
  for (const s of lowest) {
    const below = highs.filter((h) => sorted.indexOf(h) > sorted.indexOf(s)).length;
    assert.ok(below > highs.length / 2, `${s.source}: only ${below} of ${highs.length} Highs below`);
  }
});

test('context, renderings and wording limits', () => {
  for (const c of cs) {
    assert.ok(c.context.length >= 2 && c.context.length <= 3, c.id);
    const forms = [c.source, ...c.variants].map((s) => s.toLowerCase());
    for (const s of c.context) assert.ok(forms.some((f) => s.toLowerCase().includes(f)), `${c.id}: "${s}"`);
    assert.equal(c.renderings.length, 3);
    assert.equal(c.renderings[0], c.proposal.text);
    if (c.confidence < 0.6) assert.ok(new Set(c.renderings).size > 1, `${c.id} renderings should differ`);
    assert.ok(words(c.proposal.reason) <= 15, `${c.id} reason`);
    assert.ok(words(c.judgeNote) <= 15, `${c.id} note`);
    if (c.tier === 'low' && c.source !== 'VeloCheck') assert.equal(c.proposal.text, c.source);
  }
  assert.notEqual(cs.find((c) => c.source === 'VeloCheck').proposal.text, 'VeloCheck');
});

test('header counts match the design doc example', () => {
  const h = headerCounts(DEMO_RUN);
  assert.equal(h.auto, 2860);
  assert.equal(h.needYou, 140);
  assert.equal(h.hoursLabel, 'about 4.5 hours');
});

test('preview items', () => {
  const p = DEMO_RUN.preview;
  assert.equal(p.length, 5);
  assert.equal(p.filter((i) => i.retried).length, 1);
  for (const item of p) {
    const again = checkTerms(item.translation, item.terms);
    assert.deepEqual(item.terms.map((t) => t.found), again.map((t) => t.found));
    for (const t of item.terms) {
      const c = cs.find((x) => x.id === t.conceptId);
      assert.equal(t.expected, c.proposal.text);
      assert.equal(t.mode, c.enforcement);
    }
    if (item.retried) {
      const first = checkTerms(item.firstAttempt, item.terms);
      assert.ok(first.some((t) => t.mode === 'hard' && !t.found));
      assert.ok(item.terms.filter((t) => t.mode === 'hard').every((t) => t.found));
    } else {
      assert.equal(item.firstAttempt, null);
    }
  }
});

test('no real brands or drug names', () => {
  const text = JSON.stringify(DEMO_RUN).toLowerCase();
  for (const bad of ['omron', 'accu-chek', 'ventolin', 'paracetamol', 'ibuprofen', 'insulin', 'google', 'amazon', 'walgreens'])
    assert.ok(!text.includes(bad), bad);
});
