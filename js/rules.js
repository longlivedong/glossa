// The design's decision rules as pure functions. No DOM, no network, no LLM.
// Source of truth: "Glossary Generation with Humans in the Loop", sections 3–6.

export const TIERS = ['critical', 'high', 'standard', 'low'];
export const TIER_LABEL = { critical: 'Critical', high: 'High', standard: 'Standard', low: 'Low / DNT' };
export const TIER_WEIGHT = { critical: 4, high: 3, standard: 2, low: 1 };

export const ENTRIES_PER_HOUR = 30;
export const DEFAULT_HOURS = 8;
export const LOW_CONFIDENCE = 0.6;
export const HIGH_SAMPLE_RATE = 0.1;
export const RANDOM_CHECK_RATE = 0.01;
export const BUDGET_SHARE = 240 / 3000; // 8 h × 30/h over a 3,000-concept site: the doc's 1 in 12

export const TERM_TYPES = ['safety', 'legal', 'regulated', 'brand', 'product', 'ui', 'commerce',
  'category', 'marketing', 'generic', 'code'];

// Tier comes from the kind of term, not the industry (doc §4).
export const TYPE_TO_TIER = {
  safety: 'critical', legal: 'critical', regulated: 'critical',
  brand: 'high', product: 'high', ui: 'high', commerce: 'high',
  category: 'standard', marketing: 'standard', generic: 'standard',
  code: 'low',
};

const TYPE_REASON = {
  safety: 'Safety or dosage wording; a wrong term can cause harm.',
  legal: 'Legal disclaimer; wording carries liability.',
  regulated: 'Term defined by a regulator; must match the official form.',
  brand: 'Brand name; must be consistent everywhere it appears.',
  product: 'Product name or part; customers search and order by it.',
  ui: 'Button or label; must match the interface exactly.',
  commerce: 'Price, payment or returns wording; consumer law applies.',
  category: 'Category name; affects navigation and search.',
  marketing: 'Marketing phrase; several good renderings may exist.',
  generic: 'Ordinary industry word.',
  code: 'Code, SKU or unit; keep as in the source.',
};

// Industry only shifts defaults upward, never down (doc §4).
export const INDUSTRIES = {
  general: { label: 'General', shifts: {} },
  retail: { label: 'Retail', shifts: {} },
  healthcare: { label: 'Healthcare', shifts: { generic: 'high' } },
  finance: { label: 'Finance', shifts: { commerce: 'critical' } },
};

const tierRank = (t) => TIERS.indexOf(t); // 0 = most severe

/** @returns {import('./schema.js').Tier} */
export function tierFor(termType, industry = 'general', forcedTier = null) {
  if (forcedTier && TIERS.includes(forcedTier)) return forcedTier;
  const base = TYPE_TO_TIER[termType] || 'standard';
  const shifted = INDUSTRIES[industry]?.shifts?.[termType];
  return shifted && tierRank(shifted) < tierRank(base) ? shifted : base;
}

export function tierReasonFor(termType, industry = 'general', forcedTier = null) {
  if (forcedTier) return `Set to ${TIER_LABEL[forcedTier]} by the client's imported glossary.`;
  const reason = TYPE_REASON[termType] || TYPE_REASON.generic;
  const shifted = tierFor(termType, industry) !== (TYPE_TO_TIER[termType] || 'standard');
  return shifted ? `${reason} Raised one tier for ${INDUSTRIES[industry].label.toLowerCase()}.` : reason;
}

/**
 * The judge is a model and tends to be overconfident; code decides how far to trust it (doc §2).
 * A failed check caps the score, and each further failure lowers the cap.
 */
export const CHECK_CAPS = {
  importedAgrees: 0.75, siblingAgrees: 0.85, styleFit: 0.7, selfConsistent: 0.7,
  blindAgrees: 0.7,   // the judge's own term, written before weighing the proposal, differs
  clearMeaning: 0.6,  // the judge found the source term ambiguous in its context
};

export function calibrateConfidence(confidence, checks = {}) {
  const failed = Object.keys(CHECK_CAPS).filter((k) => checks[k] === false);
  if (!failed.length) return confidence;
  const cap = Math.min(...failed.map((k) => CHECK_CAPS[k])) - 0.1 * (failed.length - 1);
  return Math.round(Math.max(0, Math.min(confidence, cap)) * 100) / 100;
}

const ARTICLES = /^(the|a|an|el|la|los|las|un|una|le|les|l'|der|die|das|il|lo|gli|o|os|as)\s+/;

/** Same term for agreement purposes: case, accents, leading articles and punctuation ignored; whole-word containment counts. */
export function looseTermEqual(a, b) {
  const n = (s) => normalizeTerm(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/["'«»“”()]/g, '').replace(ARTICLES, '').trim();
  const x = n(a), y = n(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const within = (short, long) => new RegExp(`(^|\\s)${short.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(long);
  return x.length < y.length ? within(x, y) : within(y, x);
}

/** Every draft kept the term exactly as in the source: a name, code or unit that is not translated. */
export function keptAsSource(c) {
  const src = normalizeTerm(c.source);
  const rs = (c.renderings || []).filter(Boolean).map(normalizeTerm);
  return rs.length >= 2 && rs.every((r) => r === src);
}

/**
 * Doc §4: "Low / do not translate: codes, SKUs, brand names kept in the source language".
 * Safety and legal wording never qualifies, and a tier set by the client's glossary is kept.
 */
export function applyDoNotTranslate(c) {
  if (c.tierForced || c.termType === 'safety' || c.termType === 'legal' || !keptAsSource(c)) return c;
  return { ...c, tier: 'low', tierReason: 'Every draft kept it exactly as in the source: do not translate.', doNotTranslate: true };
}

/** Critical and High → hard; Standard → guidance; Low → hard (keep as source). */
export function defaultEnforcement(tier) {
  return tier === 'standard' ? 'guidance' : 'hard';
}

export function capacityFor(hours) {
  return Math.round(hours * ENTRIES_PER_HOUR);
}

/** Hours that give the doc's 8% review share for a site of this size, at least 0.5 h. */
export function defaultHoursFor(conceptCount) {
  return Math.max(0.5, Math.round((conceptCount * BUDGET_SHARE / ENTRIES_PER_HOUR) * 2) / 2);
}

/** Priority = tier weight × (1 − confidence) × log(1 + frequency). */
export function priority(c) {
  return TIER_WEIGHT[c.tier] * (1 - c.confidence) * Math.log(1 + Math.max(0, c.frequency));
}

/** Deterministic value in [0, 1) for a string, so samples are stable across reloads. */
export function seededUnit(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // murmur3 finalizer: sequential ids like c_0001, c_0002 must not cluster
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Why a concept must be seen by a human regardless of priority, or null. */
export function floorFor(c, seed = '') {
  if (c.tier === 'critical') return 'critical';
  if (c.reopened) return 'reopened';
  // Replacing a term the client already uses is a decision a person makes, whatever the tier.
  if (importDisagrees(c)) return 'import_disagrees';
  if (c.tier === 'high' && c.confidence < LOW_CONFIDENCE) return 'high_low_conf';
  if (c.tier === 'high' && seededUnit(`hs:${seed}:${c.id}`) < HIGH_SAMPLE_RATE) return 'high_sample';
  if (c.tier === 'low' && c.confidence < LOW_CONFIDENCE) return 'low_low_conf';
  return null;
}

/**
 * Step 4: draw the line. Floors first, then priority until capacity is used.
 * Below the line is auto-approved; a seeded 1% (at least one) goes to the random check.
 * Concepts that already carry a decision keep the bucket they were decided in.
 * @param {import('./schema.js').Concept[]} concepts
 * @returns {{assign: Map<string, {bucket: import('./schema.js').Bucket, floor: import('./schema.js').Floor}>,
 *            capacity: number, used: number, floorCount: number, overBudget: number}}
 */
export function computeLine(concepts, { capacity, seed = '' }) {
  const assign = new Map();
  let used = 0;
  const open = [];
  for (const c of concepts) {
    if (c.decision) {
      assign.set(c.id, { bucket: c.decision.bucket, floor: c.floor ?? null });
      if (c.decision.bucket === 'queue') used++;
    } else {
      open.push(c);
    }
  }
  const rest = [];
  let floorCount = 0;
  for (const c of open) {
    const floor = floorFor(c, seed);
    if (floor) {
      assign.set(c.id, { bucket: 'queue', floor });
      used++;
      floorCount++;
    } else {
      rest.push(c);
    }
  }
  const overBudget = Math.max(0, used - capacity);
  rest.sort((a, b) => priority(b) - priority(a) || a.id.localeCompare(b.id));
  const below = [];
  for (const c of rest) {
    if (used < capacity) {
      assign.set(c.id, { bucket: 'queue', floor: null });
      used++;
    } else {
      below.push(c);
    }
  }
  const sampled = below.filter((c) => seededUnit(`rc:${seed}:${c.id}`) < RANDOM_CHECK_RATE);
  if (sampled.length === 0 && below.length > 0) {
    sampled.push(below.reduce((m, c) => (seededUnit(`rc:${seed}:${c.id}`) < seededUnit(`rc:${seed}:${m.id}`) ? c : m)));
  }
  const sampledIds = new Set(sampled.map((c) => c.id));
  for (const c of below) assign.set(c.id, { bucket: sampledIds.has(c.id) ? 'random_check' : 'auto', floor: null });
  return { assign, capacity, used, floorCount, overBudget };
}

/** Queue order: Critical first by confidence ascending, then everything else by priority. */
export function sortQueue(concepts) {
  return [...concepts].sort((a, b) => {
    const ac = a.tier === 'critical', bc = b.tier === 'critical';
    if (ac !== bc) return ac ? -1 : 1;
    if (ac) return a.confidence - b.confidence || a.id.localeCompare(b.id);
    return priority(b) - priority(a) || a.id.localeCompare(b.id);
  });
}

export function normalizeTerm(s) {
  return String(s ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!?,;:]+$/u, '')
    .trim();
}

export function importDisagrees(c) {
  return !!c.imported && normalizeTerm(c.imported.text) !== normalizeTerm(c.proposal.text);
}

/** One-word reason a concept is in the queue. Precedence per design. */
export function hint(c) {
  if (c.bucket === 'random_check') return { key: 'random_check', label: 'random check' };
  if (c.tier === 'critical') return { key: 'critical', label: 'critical' };
  if (c.reopened) return { key: 'reopened', label: 'reopened' };
  if (importDisagrees(c)) return { key: 'import_disagrees', label: 'import disagrees' };
  if (c.confidence < LOW_CONFIDENCE) return { key: 'low_confidence', label: 'low confidence' };
  if (c.floor === 'high_sample') return { key: 'high_sample', label: 'high-tier sample' };
  return { key: 'frequent', label: 'frequent' };
}

export const isDecided = (c) => c.status !== 'pending';
export const isOverride = (c) => !!c.decision && (c.decision.action === 'edit' || c.decision.action === 'reject');

/** About-hours label: rounds to the nearest half hour; minutes under one hour. */
export function formatHours(h) {
  if (h <= 0) return 'done';
  if (h < 1) return `about ${Math.max(5, Math.round((h * 60) / 5) * 5)} min`;
  const r = Math.round(h * 2) / 2;
  return `about ${r % 1 === 0 ? r.toFixed(0) : r.toFixed(1)} hour${r === 1 ? '' : 's'}`;
}

/**
 * Numbers for the persistent header. Demo runs scale the doc's whole-site totals by
 * what the user has done on the sample; live runs count the concepts directly.
 * @param {import('./schema.js').Run} run
 */
export function headerCounts(run) {
  const cs = run.concepts;
  const queueItems = cs.filter((c) => c.bucket === 'queue');
  const reviewed = queueItems.filter(isDecided).length;
  const reopened = cs.filter((c) => c.reopened).length;
  let total, auto, needYou, randomCheck;
  if (run.totals) {
    total = run.totals.concepts;
    auto = run.totals.auto - reopened;
    needYou = run.totals.queue + reopened - reviewed;
    randomCheck = run.totals.randomCheck;
  } else {
    total = cs.length;
    auto = cs.filter((c) => c.bucket !== 'queue').length; // random-check entries are auto-approved too, as in the demo totals
    needYou = queueItems.length - reviewed;
    randomCheck = cs.filter((c) => c.bucket === 'random_check').length;
  }
  const hours = needYou / (run.budget?.entriesPerHour || ENTRIES_PER_HOUR);
  return {
    total, auto, needYou, randomCheck,
    hours, hoursLabel: formatHours(hours),
    reviewed, queueSize: queueItems.length,
    progress: queueItems.length ? reviewed / queueItems.length : 0,
  };
}

/**
 * Step 7: what publishes, and how.
 * accepted/edited and auto-approved → published with their mode; awaiting client → guidance, flagged;
 * escalated → held for the locale lead; pending above the line → listed for the lead; rejected → not published.
 */
export function publishedEntries(run) {
  const published = [], awaitingClient = [], held = [], pendingForLead = [], rejected = [];
  for (const c of run.concepts) {
    if (c.status === 'accepted' || c.status === 'edited') published.push({ concept: c, mode: c.enforcement, flagged: false });
    else if (c.status === 'asked_client') { awaitingClient.push(c); published.push({ concept: c, mode: 'guidance', flagged: true }); }
    else if (c.status === 'escalated') held.push(c);
    else if (c.status === 'rejected') rejected.push(c);
    else if (c.bucket === 'queue') pendingForLead.push(c);
    else published.push({ concept: c, mode: c.enforcement, flagged: false }); // auto-approved / random check
  }
  return { published, awaitingClient, held, pendingForLead, rejected };
}

/** Step 8 check in code: is each glossary rendering present in the translation? */
export function checkTerms(translation, entries) {
  const t = normalizeTerm(translation);
  return entries.map((e) => ({ ...e, found: t.includes(normalizeTerm(e.expected)) }));
}

export const hardMisses = (terms) => terms.filter((t) => t.mode === 'hard' && !t.found);

/**
 * Learning loop: override rate per term type and per tier, judge confidence vs outcome,
 * and which way the auto-approve line should move next time.
 */
export function learningStats(concepts) {
  const decided = concepts.filter((c) => c.decision && c.decision.action !== 'ask_client');
  const group = (keyFn) => {
    const m = new Map();
    for (const c of decided) {
      const k = keyFn(c);
      const g = m.get(k) || { key: k, decided: 0, overrides: 0, confSum: 0, allCritical: true };
      g.decided++;
      if (c.tier !== 'critical') g.allCritical = false;
      g.confSum += c.confidence;
      if (isOverride(c)) g.overrides++;
      m.set(k, g);
    }
    return [...m.values()].map((g) => {
      const rate = g.overrides / g.decided;
      let move = 'hold';
      if (g.decided >= 3 && rate <= 0.1) move = 'lower';  // rarely overridden → auto-approve more
      else if (g.decided >= 3 && rate >= 0.3) move = 'raise'; // often overridden → review more
      if (move === 'lower' && g.allCritical) move = 'floor'; // Critical is always reviewed; the line never moves past it
      return { key: g.key, decided: g.decided, overrides: g.overrides, overrideRate: rate, avgConfidence: g.confSum / g.decided, move };
    }).sort((a, b) => b.decided - a.decided);
  };
  const avg = (xs) => (xs.length ? xs.reduce((s, c) => s + c.confidence, 0) / xs.length : null);
  return {
    decided: decided.length,
    overrides: decided.filter(isOverride).length,
    byTermType: group((c) => c.termType),
    byTier: group((c) => c.tier),
    avgConfidenceAccepted: avg(decided.filter((c) => !isOverride(c))),
    avgConfidenceOverridden: avg(decided.filter(isOverride)),
  };
}
