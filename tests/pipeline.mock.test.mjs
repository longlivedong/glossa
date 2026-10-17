import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPipeline, runPreview, parseGlossaryCsv, STEPS } from '../js/pipeline.js';
import { mockLLM } from '../js/mock-llm.js';
import { TIERS, TERM_TYPES } from '../js/rules.js';

// A small fictional medical-device shop, already in /api/fetch shape.
const page = (url, title, labels, sentences, links) => ({
  url, finalUrl: url, title, lang: 'en', labels, sentences, links,
  text: [...labels, ...sentences].join(' '),
});

const PAGES = {
  'https://shop.example/': page('https://shop.example/', 'Pulsewise Home Monitors',
    ['Sign in', 'Cart', 'Shop monitors', 'Returns', 'Add to cart'],
    ['The Pulsewise Arm Monitor gives clinically validated blood pressure readings at home.',
      'Model BP-220 includes a soft cuff that fits most adult arms.',
      'Do not exceed three measurements in a row without resting for five minutes.',
      'Free returns within 30 days on every order.'],
    ['https://shop.example/products/arm-monitor', 'https://shop.example/returns/', 'https://shop.example/broken',
      'https://elsewhere.example/page', 'https://shop.example/#top']),
  'https://shop.example/products/arm-monitor': page('https://shop.example/products/arm-monitor', 'Pulsewise Arm Monitor BP-220',
    ['Log in', 'Add to cart', 'Cuff', 'Specifications'],
    ['Log in to track your readings and orders in one place.',
      'The Pulsewise Arm Monitor BP-220 stores 120 readings for two users.',
      'Warning: do not use the cuff on an arm with an IV line or an injury.',
      'Do not exceed three measurements in a row without resting.'],
    ['https://shop.example/', 'https://shop.example/returns']),
  'https://shop.example/returns': page('https://shop.example/returns', 'Returns',
    ['Sign in', 'Returns', 'Cart'],
    ['Free returns are available within 30 days of delivery for unused items.',
      'Sign in to start a return from your order history.',
      'Refunds go back to the original payment method within 5 days.'],
    ['https://shop.example/']),
};

const fakeFetch = async (url) => {
  if (PAGES[url]) return PAGES[url];
  throw new Error('HTTP 404');
};

const CSV = 'Source,Target,Tier\n"Sign in","Iniciar sesión",\ncuff,brazalete,high\n';

async function run(extra = {}) {
  const events = [];
  const result = await runPipeline(
    { url: 'https://shop.example', importedCsvText: CSV, industry: 'healthcare', siteName: 'Pulsewise', ...extra },
    { llm: mockLLM, fetch: fakeFetch, onProgress: (e) => events.push(e) },
  );
  return { result, events };
}

test('runPipeline builds a complete live Run with the mock LLM', async () => {
  const { result: r, events } = await run();
  for (const k of ['id', 'mode', 'createdAt', 'locale', 'site', 'budget', 'totals', 'styleGuide', 'models', 'usage', 'concepts', 'preview']) {
    assert.ok(k in r, `run.${k}`);
  }
  assert.equal(r.mode, 'live');
  assert.equal(r.totals, null);
  assert.equal(r.preview, null);
  assert.deepEqual(r.locale, { source: 'en', target: 'es-ES', sibling: 'es-MX' });
  assert.equal(r.site.pages.length, 3, 'broken and off-site links skipped, trailing slash deduped');
  assert.ok(r.budget.capacity > 0);
  assert.ok(r.concepts.length > 5);

  for (const c of r.concepts) {
    assert.match(c.id, /^c_\d{4}$/);
    assert.ok(TERM_TYPES.includes(c.termType), c.termType);
    assert.ok(TIERS.includes(c.tier));
    assert.ok(['queue', 'random_check', 'auto'].includes(c.bucket), `${c.source} has a bucket`);
    assert.ok(c.confidence >= 0 && c.confidence <= 1);
    assert.equal(c.renderings.length, 3);
    assert.equal(typeof c.proposal.text, 'string');
    assert.ok(Array.isArray(c.context) && Array.isArray(c.pages) && Array.isArray(c.variants));
    assert.equal(c.status, 'pending');
    assert.equal(c.decision, null);
    assert.equal(c.scope, 'all');
    assert.equal(c.enforcement, c.tier === 'standard' ? 'guidance' : 'hard');
    if (!c.imported) assert.equal(c.judgeChecks.importedAgrees, null);
    if (c.tier === 'critical') assert.equal(c.bucket, 'queue', `${c.source} is critical and queued`);
  }
  assert.ok(r.concepts.some((c) => c.tier === 'critical'), 'safety wording found');

  const signIn = r.concepts.find((c) => [c.source, ...c.variants].map((s) => s.toLowerCase()).includes('sign in'));
  assert.ok(signIn, 'sign in concept');
  assert.ok([signIn.source, ...signIn.variants].some((s) => s.toLowerCase() === 'log in'), 'log in clustered with sign in');
  assert.ok(signIn.frequency >= 4);
  assert.equal(signIn.imported?.sourceName, 'Imported glossary (CSV)');
  assert.equal(signIn.judgeChecks.importedAgrees, true);

  const cuff = r.concepts.find((c) => c.source.toLowerCase() === 'cuff');
  assert.ok(cuff?.imported, 'cuff matched the CSV');
  assert.equal(cuff.judgeChecks.importedAgrees, false);
  assert.equal(cuff.tier, 'high');
  assert.equal(cuff.tierForced, true);

  const code = r.concepts.find((c) => c.source === 'BP-220');
  assert.equal(code?.proposal.text, 'BP-220');

  // progress: every step starts in order, and nothing errored
  const starts = events.filter((e) => e.status === 'start').map((e) => e.step);
  assert.deepEqual(starts, STEPS);
  assert.ok(events.some((e) => e.step === 'crawl' && /Skipped/.test(e.message)), 'failed page reported');
  assert.ok(!events.some((e) => e.status === 'error'));
});

test('first page failing throws a clear error', async () => {
  const events = [];
  await assert.rejects(
    runPipeline({ url: 'https://shop.example/broken' }, { llm: mockLLM, fetch: fakeFetch, onProgress: (e) => events.push(e) }),
    /start page/,
  );
  assert.equal(events.at(-1).status, 'error');
});

test('no sibling locale → siblingAgrees null everywhere', async () => {
  const { result: r } = await run({ sibling: null });
  assert.ok(r.concepts.every((c) => c.sibling === null && c.judgeChecks.siblingAgrees === null));
});

test('parseGlossaryCsv: quotes, commas in quotes, missing tier column', () => {
  const rows = parseGlossaryCsv('source,target,tier,notes\n"Add to cart","Añadir a la cesta",High,"buttons, everywhere"\n'
    + '"He said ""hi""",dijo,,\nBP-220,BP-220,Low / DNT,\r\n');
  assert.deepEqual(rows[0], { source: 'Add to cart', target: 'Añadir a la cesta', tier: 'high', notes: 'buttons, everywhere' });
  assert.equal(rows[1].source, 'He said "hi"');
  assert.equal(rows[1].tier, null);
  assert.equal(rows[2].tier, 'low');
  const noTier = parseGlossaryCsv('Source,Target\n"Cart, small",Cesta\n');
  assert.deepEqual(noTier, [{ source: 'Cart, small', target: 'Cesta', tier: null, notes: '' }]);
  assert.throws(() => parseGlossaryCsv('term,translation\na,b'), /source/);
});

test('runPreview hits the strict retry path', async () => {
  const { result: r } = await run();
  r.concepts.forEach((c) => { c.status = 'accepted'; });
  const events = [];
  const items = await runPreview(r, { llm: mockLLM, onProgress: (e) => events.push(e) });
  assert.ok(items.length > 0 && items.length <= 5);
  for (const it of items) {
    assert.equal(typeof it.source, 'string');
    assert.equal(typeof it.translation, 'string');
    assert.ok(Array.isArray(it.terms) && it.terms.length > 0);
    for (const t of it.terms) assert.ok('conceptId' in t && 'expected' in t && 'mode' in t && 'found' in t);
    if (!it.retried) assert.equal(it.firstAttempt, null);
  }
  const retried = items.filter((it) => it.retried);
  assert.ok(retried.length >= 1);
  assert.ok(retried.every((it) => it.firstAttempt && it.terms.every((t) => t.mode !== 'hard' || t.found)));
});
