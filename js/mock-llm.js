// Deterministic stand-in for the LLM (LLM_PROVIDER=mock, and tests). Reads the DATA block that every
// prompt ends with and returns the same short-key JSON a real model is asked for.
import { seededUnit, normalizeTerm } from './rules.js';

function readData(user) {
  const i = String(user).lastIndexOf('DATA:');
  if (i < 0) return {};
  try { return JSON.parse(user.slice(i + 5).trim()); } catch { return {}; }
}

const SAFETY = ['do not exceed', 'do not use', 'warning', 'caution', 'maximum daily dose', 'consult your doctor', 'keep out of reach of children'];
const COMMERCE = ['free returns', 'free shipping', 'add to cart', 'checkout', 'refund', 'returns', 'cart', 'shipping', 'warranty'];
const SYNONYM = { 'log in': 'sign in', login: 'sign in', 'log-in': 'sign in', 'sign-in': 'sign in', signin: 'sign in' };

const DICT = {
  'sign in': 'Iniciar sesión', 'log in': 'Iniciar sesión', cart: 'Cesta', 'add to cart': 'Añadir a la cesta',
  returns: 'Devoluciones', 'free returns': 'Devoluciones gratuitas', checkout: 'Finalizar compra', cuff: 'manguito',
  warning: 'Advertencia', caution: 'Precaución', 'do not exceed': 'no supere', 'do not use': 'no utilice',
  shipping: 'Envío', 'free shipping': 'Envío gratuito', refund: 'Reembolso', warranty: 'Garantía',
  specifications: 'Especificaciones', 'shop monitors': 'Comprar monitores', 'blood pressure': 'presión arterial',
  monitor: 'monitor', readings: 'lecturas', account: 'cuenta', help: 'Ayuda', search: 'Buscar',
};

const CODE_RE = /\b[A-Z]{1,5}-?\d{2,}[A-Z0-9-]*\b/g;
const KEEP_TYPES = new Set(['code', 'brand', 'product']);

const h = (s) => seededUnit(`mock:${s}`);

function guessType(term, fromLabel) {
  const low = term.toLowerCase();
  if (/^[A-Z]{1,5}-?\d{2,}/.test(term)) return 'code';
  if (SAFETY.some((p) => low.includes(p))) return 'safety';
  if (COMMERCE.some((p) => low === p || low.includes(p))) return 'commerce';
  if (/[A-Z][a-z]+[A-Z]|™|®/.test(term) || /^[A-Z][a-z]+(\s[A-Z][a-z]+){1,3}$/.test(term) && !fromLabel) return 'product';
  if (fromLabel) return 'ui';
  return 'marketing';
}

function extract({ L = [], S = [] }) {
  const terms = [];
  const seen = new Set();
  const add = (t, fromLabel) => {
    const k = normalizeTerm(t);
    if (!k || seen.has(k) || terms.length >= 25) return;
    seen.add(k);
    const s = S.findIndex((x) => x.toLowerCase().includes(t.toLowerCase()));
    terms.push({ t, y: guessType(t, fromLabel), s: fromLabel && s < 0 ? -1 : s });
  };
  for (const l of L) if (l.split(/\s+/).length <= 4) add(l, true);
  const text = S.join(' ');
  for (const p of SAFETY) if (text.toLowerCase().includes(p)) add(p, false);
  for (const m of text.match(CODE_RE) || []) add(m, false);
  // capitalised multi-word phrases, minus a leading article
  for (const m of text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z0-9]+)+\b/g) || []) add(m.replace(/^(The|A|An|Our|Your)\s+/, ''), false);
  return { terms };
}

const lemma = (t) => {
  const k = normalizeTerm(t);
  return SYNONYM[k] || k.replace(/s$/, '');
};

function cluster({ c = [], g = [] }) {
  const byLemma = new Map();
  for (const [t, y] of c) {
    const k = lemma(t);
    const grp = byLemma.get(k) || { c: t, v: [], y };
    if (grp.c !== t) grp.v.push(t);
    byLemma.set(k, grp);
  }
  for (const t of g) {
    const grp = byLemma.get(lemma(t));
    if (grp) grp.v.push(t);
    else byLemma.set(lemma(t), { c: t, v: [], y: guessType(t, false), glossaryOnly: true });
  }
  return { groups: [...byLemma.values()].filter((x) => x.v.length || x.glossaryOnly).map(({ c: cc, v, y }) => ({ c: cc, v, y })) };
}

/** Spanish-looking rendering: dictionary first, otherwise a recognisable fake. */
function toSpanish(s, y) {
  if (KEEP_TYPES.has(y)) return s;
  const d = DICT[normalizeTerm(s)];
  if (d) return d;
  return s.split(/\s+/).map((w) => (w.length > 3 ? `${w.replace(/(e|y|s)$/i, '')}ción` : w)).join(' ');
}

function draft(task, { c = [] }) {
  return {
    items: c.map((x) => {
      let t = toSpanish(x.s, x.y);
      // B and C sometimes drift, so the self-consistency check has something to catch
      if (task === 'draft_b' && h(`b:${x.s}`) < 0.2) t = `el ${t.toLowerCase()}`;
      if (task === 'draft_c' && h(`c:${x.s}`) < 0.15) t = `${t} (variante)`;
      if (task === 'sibling' && h(`sb:${x.s}`) < 0.2) t = `${t} (MX)`;
      const it = { i: x.i, t };
      if (task === 'draft_a') it.r = KEEP_TYPES.has(x.y) ? 'Name or code kept as in the source.' : 'Usual es-ES website term.';
      if (task === 'draft_c') it.m = `${x.y} term on this site`;
      return it;
    }),
  };
}

function judge({ c = [] }) {
  const same = (a, b) => normalizeTerm(a) === normalizeTerm(b);
  return {
    items: c.map((x) => {
      const ia = x.m === undefined ? null : same(x.m, x.p);
      const sa = x.sb === undefined ? null : h(`sa:${x.s}`) > 0.1;
      // b and c are left out of the payload when identical to p
      const sc = same(x.p, x.b ?? x.p) && same(x.p, x.c ?? x.p);
      const sf = h(`sf:${x.s}`) > 0.08;
      // spread scores by hash so every tier lands in every bucket
      let k = 0.35 + 0.63 * h(`k:${x.s}`);
      if (ia === false) k = Math.min(k, 0.5);
      if (!sc) k -= 0.15;
      if (!sf) k -= 0.1;
      const n = ia === false ? 'Differs from the imported glossary.' : !sc ? 'Phrasings disagree.' : !sf ? 'Possible style guide mismatch.' : 'ok';
      return { i: x.i, ia, sa, sf, sc, k: Math.round(Math.max(0.05, k) * 100) / 100, n };
    }),
  };
}

function replaceTerms(sentence, pairs) {
  let out = sentence;
  // longest first, so "Add to cart" wins over "cart"
  for (const [s, t] of [...pairs].sort((a, b) => b[0].length - a[0].length)) {
    const re = new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    out = out.replace(re, t);
  }
  return out;
}

function translate({ s = [], g = [] }) {
  let omitted = false;
  return {
    items: s.map((sentence, i) => {
      const pairs = g.filter((e) => sentence.toLowerCase().includes(e.s.toLowerCase())).filter((e) => {
        // deliberately drop one hard term so the strict retry path runs
        if (!omitted && e.h === 1 && normalizeTerm(e.t) !== normalizeTerm(e.s)) { omitted = true; return false; }
        return true;
      }).map((e) => [e.s, e.t]);
      return { i, t: `[es] ${replaceTerms(sentence, pairs)}` };
    }),
  };
}

function translateStrict({ s = [] }) {
  return { items: s.map((x) => ({ i: x.i, t: `[es] ${replaceTerms(x.s, [...(x.must || []), ...(x.keep || [])])}` })) };
}

export async function mockLLM({ task, system, user } = {}) {
  const d = readData(user);
  switch (task) {
    case 'extract': return extract(d);
    case 'cluster': return cluster(d);
    case 'draft_a': case 'draft_b': case 'draft_c': case 'sibling': return draft(task, d);
    case 'judge': return judge(d);
    case 'translate': return translate(d);
    case 'translate_strict': return translateStrict(d);
    default: throw new Error(`mockLLM: unknown task ${task} (${String(system).slice(0, 40)})`);
  }
}
