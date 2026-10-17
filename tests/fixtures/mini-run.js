// Small live-style run for tests and for UI work before demo-data.js exists.
import { defaultEnforcement, tierFor, tierReasonFor } from '../../js/rules.js';

let n = 0;
export function makeConcept(over = {}) {
  n++;
  const termType = over.termType ?? 'generic';
  const tier = over.tier ?? tierFor(termType);
  return {
    id: over.id ?? `c_${String(n).padStart(4, '0')}`,
    source: over.source ?? `term ${n}`,
    variants: over.variants ?? [],
    termType,
    tier,
    tierReason: over.tierReason ?? tierReasonFor(termType),
    frequency: over.frequency ?? 10,
    pages: over.pages ?? ['/'],
    proposal: over.proposal ?? { text: `término ${n}`, reason: 'Common es-ES rendering.' },
    renderings: over.renderings ?? [`término ${n}`, `término ${n}`, `término ${n}`],
    confidence: over.confidence ?? 0.8,
    judgeChecks: over.judgeChecks ?? { importedAgrees: null, siblingAgrees: true, styleFit: true, selfConsistent: true },
    judgeNote: over.judgeNote ?? '',
    imported: over.imported ?? null,
    sibling: over.sibling ?? { locale: 'es-MX', text: `término ${n}` },
    context: over.context ?? [`A sentence with term ${n}.`, `Another sentence with term ${n}.`],
    enforcement: over.enforcement ?? defaultEnforcement(tier),
    scope: over.scope ?? 'all',
    bucket: over.bucket ?? 'auto',
    floor: over.floor ?? null,
    reopened: over.reopened ?? false,
    status: over.status ?? 'pending',
    decision: over.decision ?? null,
  };
}

export function miniRun() {
  n = 0;
  return {
    id: 'run_test',
    mode: 'live',
    createdAt: '2026-10-17T00:00:00.000Z',
    locale: { source: 'en', target: 'es-ES', sibling: 'es-MX' },
    site: { name: 'Test site', url: 'https://example.test', industry: 'general', pages: [{ url: 'https://example.test/', title: 'Home' }] },
    budget: { entriesPerHour: 30, hours: 0.5, capacity: 15 },
    totals: null,
    styleGuide: '',
    models: null,
    usage: null,
    preview: null,
    concepts: [
      makeConcept({ source: 'maximum daily dose', termType: 'safety', confidence: 0.94, frequency: 14 }),
      makeConcept({ source: 'do not exceed', termType: 'safety', confidence: 0.4, frequency: 20 }),
      makeConcept({ source: 'cuff', termType: 'product', confidence: 0.5, frequency: 40,
        imported: { text: 'manguito', sourceName: 'Old glossary' }, proposal: { text: 'brazalete', reason: '' } }),
      makeConcept({ source: 'checkout', termType: 'ui', confidence: 0.95, frequency: 150 }),
      makeConcept({ source: 'peace of mind', termType: 'marketing', confidence: 0.2, frequency: 30 }),
      makeConcept({ source: 'accessories', termType: 'category', confidence: 0.97, frequency: 50 }),
      makeConcept({ source: 'BP-220', termType: 'code', confidence: 0.99, frequency: 8, proposal: { text: 'BP-220', reason: 'Model code.' } }),
      makeConcept({ source: 'VeloCheck', termType: 'code', confidence: 0.35, frequency: 6 }),
    ],
  };
}
