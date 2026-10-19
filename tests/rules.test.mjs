import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tierFor, defaultEnforcement, priority, floorFor, computeLine, sortQueue, hint,
  importDisagrees, headerCounts, formatHours, publishedEntries, checkTerms, hardMisses,
  learningStats, defaultHoursFor, capacityFor,
} from '../js/rules.js';
import { makeConcept, miniRun } from './fixtures/mini-run.js';

test('tier comes from term type; industry only raises it', () => {
  assert.equal(tierFor('safety'), 'critical');
  assert.equal(tierFor('ui'), 'high');
  assert.equal(tierFor('marketing'), 'standard');
  assert.equal(tierFor('code'), 'low');
  assert.equal(tierFor('generic', 'healthcare'), 'high');
  assert.equal(tierFor('commerce', 'finance'), 'critical');
  assert.equal(tierFor('marketing', 'healthcare'), 'standard');
  assert.equal(tierFor('marketing', 'general', 'critical'), 'critical');
});

test('default enforcement', () => {
  assert.equal(defaultEnforcement('critical'), 'hard');
  assert.equal(defaultEnforcement('high'), 'hard');
  assert.equal(defaultEnforcement('standard'), 'guidance');
  assert.equal(defaultEnforcement('low'), 'hard');
});

test('priority = weight × (1 − confidence) × ln(1 + frequency)', () => {
  const c = makeConcept({ termType: 'marketing', confidence: 0.25, frequency: 48 });
  assert.ok(Math.abs(priority(c) - 2 * 0.75 * Math.log(49)) < 1e-9);
});

test('floors: critical, reopened, low-confidence high, low-confidence low', () => {
  assert.equal(floorFor(makeConcept({ termType: 'safety', confidence: 0.99 })), 'critical');
  assert.equal(floorFor(makeConcept({ termType: 'marketing', reopened: true })), 'reopened');
  assert.equal(floorFor(makeConcept({ termType: 'ui', confidence: 0.5 })), 'high_low_conf');
  assert.equal(floorFor(makeConcept({ termType: 'code', confidence: 0.4 })), 'low_low_conf');
  assert.equal(floorFor(makeConcept({ termType: 'code', confidence: 0.95 })), null);
  assert.equal(floorFor(makeConcept({ termType: 'marketing', confidence: 0.1 })), null);
});

test('high-tier sample is about 10% and stable', () => {
  const highs = Array.from({ length: 2000 }, (_, i) => makeConcept({ id: `h${i}`, termType: 'ui', confidence: 0.9 }));
  const sampled = highs.filter((c) => floorFor(c, 's') === 'high_sample').length;
  assert.ok(sampled > 140 && sampled < 260, `sampled ${sampled}`);
  assert.equal(highs.filter((c) => floorFor(c, 's') === 'high_sample').length, sampled);
});

test('line: floors first, then priority until capacity; rest auto with a random check', () => {
  const run = miniRun();
  const { assign, overBudget } = computeLine(run.concepts, { capacity: 5, seed: 'x' });
  const b = (src) => assign.get(run.concepts.find((c) => c.source === src).id).bucket;
  assert.equal(b('maximum daily dose'), 'queue'); // critical, high confidence
  assert.equal(b('do not exceed'), 'queue');
  assert.equal(b('cuff'), 'queue');              // high, low confidence
  assert.equal(b('VeloCheck'), 'queue');         // low tier, low confidence
  assert.equal(b('peace of mind'), 'queue');     // fills the last slot by priority
  assert.equal(overBudget, 0);
  const below = [...assign.values()].filter((a) => a.bucket !== 'queue');
  assert.ok(below.some((a) => a.bucket === 'random_check'), 'at least one random check');
});

test('line: floors exceeding capacity are kept and reported over budget', () => {
  const run = miniRun();
  const { assign, overBudget } = computeLine(run.concepts, { capacity: 2, seed: 'x' });
  assert.equal([...assign.values()].filter((a) => a.bucket === 'queue').length, 4);
  assert.equal(overBudget, 2);
});

test('line: more hours moves more entries above the line', () => {
  const run = miniRun();
  const q = (cap) => [...computeLine(run.concepts, { capacity: cap }).assign.values()].filter((a) => a.bucket === 'queue').length;
  assert.ok(q(7) > q(5));
});

test('line: decided concepts keep their bucket', () => {
  const run = miniRun();
  const pom = run.concepts.find((c) => c.source === 'peace of mind');
  pom.decision = { action: 'accept', bucket: 'queue', at: '' };
  const { assign } = computeLine(run.concepts, { capacity: 0 });
  assert.equal(assign.get(pom.id).bucket, 'queue');
});

test('queue order: critical by confidence ascending, then priority', () => {
  const run = miniRun();
  const sorted = sortQueue(run.concepts).map((c) => c.source);
  assert.deepEqual(sorted.slice(0, 2), ['do not exceed', 'maximum daily dose']);
  assert.ok(sorted.indexOf('peace of mind') < sorted.indexOf('checkout'));
});

test('hint precedence', () => {
  const run = miniRun();
  const by = (s) => run.concepts.find((c) => c.source === s);
  assert.equal(hint(by('maximum daily dose')).label, 'critical');
  assert.equal(hint(by('cuff')).label, 'import disagrees');
  assert.equal(hint(by('peace of mind')).label, 'low confidence');
  assert.equal(hint({ ...by('peace of mind'), reopened: true }).label, 'reopened');
  assert.equal(hint(by('checkout')).label, 'frequent');
});

test('import disagreement follows the current proposal', () => {
  const c = makeConcept({ proposal: { text: 'brazalete', reason: '' }, imported: { text: 'Manguito', sourceName: 'x' } });
  assert.equal(importDisagrees(c), true);
  c.proposal.text = 'manguito';
  assert.equal(importDisagrees(c), false);
});

test('header: demo totals reproduce the doc (2,860 / 140 / about 4.5 hours)', () => {
  const run = miniRun();
  run.totals = { concepts: 3000, auto: 2860, queue: 140, randomCheck: 29 };
  run.concepts.forEach((c, i) => { c.bucket = i < 5 ? 'queue' : 'auto'; });
  let h = headerCounts(run);
  assert.equal(h.auto, 2860);
  assert.equal(h.needYou, 140);
  assert.equal(h.hoursLabel, 'about 4.5 hours');
  run.concepts[0].status = 'accepted';
  run.concepts[6].reopened = true;
  run.concepts[6].bucket = 'queue';
  h = headerCounts(run);
  assert.equal(h.auto, 2859);
  assert.equal(h.needYou, 140);
  assert.equal(h.reviewed, 1);
});

test('formatHours', () => {
  assert.equal(formatHours(8), 'about 8 hours');
  assert.equal(formatHours(1), 'about 1 hour');
  assert.equal(formatHours(0.3), 'about 20 min');
  assert.equal(formatHours(0), 'done');
});

test('budget helpers keep the 8% share', () => {
  assert.equal(defaultHoursFor(3000), 8);
  assert.equal(capacityFor(8), 240);
  assert.equal(defaultHoursFor(100), 0.5);
});

test('publish: pending above the line is held for the lead, ask-client ships as flagged guidance', () => {
  const run = miniRun();
  const [a, b, c, d] = run.concepts;
  a.bucket = 'queue'; a.status = 'accepted';
  b.bucket = 'queue'; b.status = 'pending';
  c.bucket = 'queue'; c.status = 'asked_client'; c.enforcement = 'hard';
  d.bucket = 'queue'; d.status = 'escalated';
  const p = publishedEntries(run);
  assert.ok(p.pendingForLead.includes(b));
  assert.ok(p.held.includes(d));
  const flagged = p.published.find((e) => e.concept === c);
  assert.equal(flagged.mode, 'guidance');
  assert.equal(flagged.flagged, true);
  assert.ok(!p.published.some((e) => e.concept === b));
});

test('enforcement check flags hard misses only', () => {
  const terms = checkTerms('Consulte a su médico antes de usar el manguito.', [
    { conceptId: '1', source: 'cuff', expected: 'manguito', mode: 'hard' },
    { conceptId: '2', source: 'consult your doctor', expected: 'consulte a su médico', mode: 'hard' },
    { conceptId: '3', source: 'monitor', expected: 'tensiómetro', mode: 'guidance' },
    { conceptId: '4', source: 'dose', expected: 'dosis', mode: 'hard' },
  ]);
  assert.deepEqual(hardMisses(terms).map((t) => t.conceptId), ['4']);
});

test('learning stats: override rate and line movement', () => {
  const cs = Array.from({ length: 4 }, (_, i) => makeConcept({ termType: 'ui', confidence: 0.9,
    decision: { action: i === 0 ? 'edit' : 'accept', bucket: 'queue', at: '' } }))
    .concat(Array.from({ length: 3 }, () => makeConcept({ termType: 'marketing', confidence: 0.5,
      decision: { action: 'reject', bucket: 'queue', at: '' } })));
  const s = learningStats(cs);
  const ui = s.byTermType.find((g) => g.key === 'ui');
  const mk = s.byTermType.find((g) => g.key === 'marketing');
  assert.equal(ui.overrideRate, 0.25);
  assert.equal(ui.move, 'hold');
  assert.equal(mk.move, 'raise');
  assert.equal(s.overrides, 4);
});

test('learning stats: never suggests auto-approving Critical', () => {
  const cs = Array.from({ length: 4 }, () => makeConcept({ termType: 'safety', tier: 'critical', confidence: 0.9,
    decision: { action: 'accept', bucket: 'queue', at: '' } }));
  const s = learningStats(cs);
  assert.equal(s.byTier.find((g) => g.key === 'critical').move, 'floor');
  assert.equal(s.byTermType.find((g) => g.key === 'safety').move, 'floor');
});

test('header: live auto count includes the random check, so auto + need you = total', () => {
  const concepts = [
    makeConcept({ id: 'a', bucket: 'queue' }), makeConcept({ id: 'b', bucket: 'auto' }),
    makeConcept({ id: 'c', bucket: 'random_check' }),
  ];
  const h = headerCounts({ concepts, totals: null, budget: { entriesPerHour: 30 } });
  assert.equal(h.auto + h.needYou, h.total);
  assert.equal(h.randomCheck, 1);
});

test('confidence calibration: failed checks cap the judge score', async () => {
  const { calibrateConfidence } = await import('../js/rules.js');
  assert.equal(calibrateConfidence(0.97, { importedAgrees: true, siblingAgrees: true, styleFit: true, selfConsistent: true }), 0.97);
  assert.equal(calibrateConfidence(0.95, { importedAgrees: false, siblingAgrees: true, styleFit: true, selfConsistent: true }), 0.75);
  assert.equal(calibrateConfidence(0.95, { importedAgrees: false, selfConsistent: false }), 0.6);
  assert.equal(calibrateConfidence(0.5, { siblingAgrees: false }), 0.5);
  assert.equal(calibrateConfidence(0.9, { importedAgrees: null, siblingAgrees: null, styleFit: true, selfConsistent: true }), 0.9);
});

test('seeded sample is roughly uniform over sequential ids', async () => {
  const { seededUnit } = await import('../js/rules.js');
  const xs = Array.from({ length: 1000 }, (_, i) => seededUnit(`hs:run_x:c_${String(i + 1).padStart(4, '0')}`));
  for (let d = 0; d < 10; d++) {
    const n = xs.filter((x) => x >= d / 10 && x < (d + 1) / 10).length;
    assert.ok(n > 65 && n < 135, `decile ${d}: ${n}`);
  }
});

test('loose term equality for agreement checks', async () => {
  const { looseTermEqual } = await import('../js/rules.js');
  assert.equal(looseTermEqual('el comprimido masticable', 'Comprimido masticable'), true);
  assert.equal(looseTermEqual('médico', 'medico'), true);
  assert.equal(looseTermEqual('de liberación prolongada', 'comprimido de liberación prolongada'), true);
  assert.equal(looseTermEqual('brazalete', 'manguito'), false);
  assert.equal(looseTermEqual('', 'x'), false);
});

test('do-not-translate: kept as source by every draft becomes Low, safety never', async () => {
  const { applyDoNotTranslate } = await import('../js/rules.js');
  const brand = makeConcept({ source: 'Aleve', termType: 'brand', renderings: ['Aleve', 'Aleve', 'aleve'] });
  assert.equal(applyDoNotTranslate(brand).tier, 'low');
  const inn = makeConcept({ source: 'naproxen', termType: 'regulated', renderings: ['naproxeno', 'naproxeno', 'naproxeno'] });
  assert.equal(applyDoNotTranslate(inn).tier, 'critical');
  const safety = makeConcept({ source: 'STOP', termType: 'safety', renderings: ['STOP', 'STOP', 'STOP'] });
  assert.equal(applyDoNotTranslate(safety).tier, 'critical');
  const forced = { ...makeConcept({ source: 'Veloma', termType: 'brand', tier: 'critical', renderings: ['Veloma', 'Veloma', 'Veloma'] }), tierForced: true };
  assert.equal(applyDoNotTranslate(forced).tier, 'critical');
});

test('calibration caps for blind disagreement and unclear meaning', async () => {
  const { calibrateConfidence } = await import('../js/rules.js');
  assert.equal(calibrateConfidence(0.95, { blindAgrees: false }), 0.7);
  assert.equal(calibrateConfidence(0.95, { clearMeaning: false }), 0.6);
  assert.equal(calibrateConfidence(0.95, { blindAgrees: true, clearMeaning: true }), 0.95);
});

test('an old-glossary disagreement is always reviewed', () => {
  const c = makeConcept({ termType: 'category', confidence: 0.95, imported: { text: 'tableta masticable', sourceName: 'x' }, proposal: { text: 'comprimido masticable', reason: '' } });
  assert.equal(floorFor(c), 'import_disagrees');
  assert.equal(floorFor({ ...c, imported: { text: 'Comprimido masticable', sourceName: 'x' } }), null);
});
