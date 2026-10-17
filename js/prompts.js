// One prompt builder per LLM task. Each returns { system, user }.
// The payload always goes last, as compact JSON after a 'DATA:' line (mock-llm.js parses it).
// Short keys (i, s, t, r, ...) keep free-tier token use down; pipeline.js maps them back.
import { LOCALE_LABEL } from './schema.js';

export const lang = (loc) => (LOCALE_LABEL[loc] ? `${LOCALE_LABEL[loc]} (${loc})` : loc);

// Register defaults per locale (or language). The style guide always wins.
const REGISTER = {
  es: 'formal "usted" (not "tú") for safety warnings and instructions',
  fr: '"vous"',
  de: '"Sie"',
  it: 'formal "Lei" for safety warnings and instructions',
  nl: '"u" for safety warnings and instructions',
  ja: 'polite です/ます form',
  hi: '"आप"',
};

function registerRule(loc) {
  const r = REGISTER[loc] || REGISTER[String(loc).split('-')[0]] || 'the register usual on commercial websites in this locale';
  return `Register: ${r}, unless the style guide says otherwise.`;
}

const STYLE_CAP = 1200;
function styleBlock(styleGuide) {
  const sg = String(styleGuide || '').trim();
  if (!sg) return '';
  return `STYLE GUIDE (the client's; it overrides the defaults above):\n${sg.length > STYLE_CAP ? `${sg.slice(0, STYLE_CAP)}…` : sg}\n\n`;
}

const data = (obj) => `DATA:\n${JSON.stringify(obj)}`;

const TYPE_LEGEND = 'y is one of: safety (warnings, dosage, contraindications), legal (disclaimers, terms, warranty), '
  + 'regulated (a term a regulator defines, e.g. "medical device", "CE marked"), brand, product (product or part names), '
  + 'ui (buttons, menu items, form labels), commerce (price, payment, shipping, returns), category (catalogue sections), '
  + 'marketing (slogans, claims), generic (industry vocabulary not covered above), code (SKUs, model numbers, units).';

const JSON_ONLY = 'Reply with JSON only, no prose and no code fences, exactly this shape:';

// Shared rules for every drafting call (A, B, C and sibling), so the three phrasings differ only in framing.
function draftRules(loc) {
  return [
    'Rules:',
    '- Render the meaning the term has in its context sentences (x), not another sense of the word.',
    '- Keep codes, SKUs, units, model numbers and brand or product names exactly as in the source unless the style guide says otherwise.',
    `- Match the source's form: a noun stays a noun, a plural stays plural, a button label follows ${lang(loc)} interface conventions.`,
    `- ${registerRule(loc)}`,
    '- t is the term only: no quotes, notes or alternatives.',
  ].join('\n');
}

const CONCEPT_KEYS = 'c = concepts: i id, s English term, y type, v other forms seen on the site, x context sentences.';

export function extractPrompt({ title, labels, sentences }) {
  const system = [
    'You pick glossary terms from one page of a website that will be localised. A glossary term is a word or phrase a translator must render the same way every time.',
    'Include: product and brand names; UI labels (buttons, menu items, form fields); commerce, returns and payment wording; safety, dosage, warning and legal phrases; regulated or technical terms; category names; distinctive marketing phrases; codes, SKUs, model numbers and units.',
    'Exclude: ordinary words and phrases any translator handles without a glossary ("great", "our team", "learn more"), whole sentences, and people\'s names.',
    'Copy each term exactly as written on the page, without surrounding punctuation. Use the shortest form that keeps the meaning ("do not exceed the stated dose", not the whole sentence).',
    'At most 25 terms. If there are more, keep the ones where a mistranslation would mislead, harm or break the interface.',
    TYPE_LEGEND,
    's is the index of the sentence in S the term came from, or -1 if it came from a label in L.',
    JSON_ONLY,
    '{"terms":[{"t":"Add to cart","y":"ui","s":-1}]}',
  ].join('\n');
  const user = `ti = page title, L = UI labels, S = sentences (0-indexed).\n${data({ ti: title || '', L: labels, S: sentences })}`;
  return { system, user };
}

export function clusterPrompt({ candidates, glossaryOnly }) {
  const system = [
    'You group glossary candidates that are the same concept written differently, so a translator renders them once.',
    'Merge only true variants of one meaning: spelling, hyphenation, case, singular/plural, abbreviation, or synonyms the site uses interchangeably for the same action or thing ("sign in" / "log in" / "login").',
    'Never merge different meanings, or a term with a broader or narrower one: "return" (send back) is not "return policy"; "cuff" is not "cuff size"; "shipping" is not "free shipping".',
    'Input c is [term, type] pairs, most frequent first. g are terms from the client\'s existing glossary that matched no candidate exactly.',
    'Output:',
    '- One group per set of 2+ candidates that should merge: c is the canonical form (the member listed first in the input), v the other members. Copy terms exactly.',
    '- Every g term: add it to v of the group or candidate it is a variant of, or return it as its own group with v [].',
    '- y is the group\'s type, from the input types; if any member is safety, legal or regulated, use that type.',
    'Candidates you leave out stay as their own concepts. Do not invent terms.',
    JSON_ONLY,
    '{"groups":[{"c":"sign in","v":["log in","login"],"y":"ui"}]}',
  ].join('\n');
  return { system, user: data({ c: candidates, g: glossaryOnly }) };
}

/** A: terminologist proposing the prescribed term, with a short reason. */
export function draftAPrompt({ target, styleGuide, concepts }) {
  const system = [
    `You are a terminologist building the ${lang(target)} glossary for a website. For each English term, propose the ${lang(target)} term the glossary should prescribe on this site.`,
    draftRules(target),
    'r: why this term, at most 15 words (the convention followed or the sense chosen).',
    `${JSON_ONLY} one item per input concept, same i:`,
    '{"items":[{"i":1,"t":"…","r":"…"}]}',
  ].join('\n');
  return { system, user: `${styleBlock(styleGuide)}${CONCEPT_KEYS}\n${data({ c: concepts })}` };
}

/** B: UI localiser; how the term actually ships on the localised site. */
export function draftBPrompt({ target, styleGuide, concepts }) {
  const system = [
    `You localise website interfaces into ${lang(target)}. For each English term, write exactly how it appears on the ${lang(target)} version of this site: the button, menu item, heading or phrase a native localiser would ship.`,
    draftRules(target),
    `${JSON_ONLY} one item per input concept, same i:`,
    '{"items":[{"i":1,"t":"…"}]}',
  ].join('\n');
  return { system, user: `${styleBlock(styleGuide)}${CONCEPT_KEYS}\n${data({ c: concepts })}` };
}

/** C: meaning first, then the term; catches drafts that picked the wrong sense. */
export function draftCPrompt({ target, styleGuide, concepts }) {
  const system = [
    `For each English term from a website, first write m: what it means on this site, at most 6 English words. Then give t: the ${lang(target)} term for that meaning.`,
    draftRules(target),
    `${JSON_ONLY} one item per input concept, same i:`,
    '{"items":[{"i":1,"m":"…","t":"…"}]}',
  ].join('\n');
  return { system, user: `${styleBlock(styleGuide)}${CONCEPT_KEYS}\n${data({ c: concepts })}` };
}

/** Sibling locale, drafted independently (it never sees the target proposal) so agreement means something. */
export function siblingPrompt({ sibling, styleGuide, concepts }) {
  const system = [
    `You localise website terms into ${lang(sibling)}. For each English term, give the term a ${lang(sibling)} website would use, with regional vocabulary where it differs from other varieties.`,
    draftRules(sibling),
    `${JSON_ONLY} one item per input concept, same i:`,
    '{"items":[{"i":1,"t":"…"}]}',
  ].join('\n');
  return { system, user: `${styleBlock(styleGuide)}${CONCEPT_KEYS}\n${data({ c: concepts })}` };
}

export function judgePrompt({ target, sibling, styleGuide, concepts }) {
  const T = lang(target);
  const fields = `s English source, y type, x context, p proposed term, b and c the same term drafted independently under other instructions (left out when identical to p), m the client's existing glossary term (if present)${sibling ? `, sb the ${lang(sibling)} term (if present)` : ''}.`;
  const system = [
    `You review proposed ${T} glossary entries for a website. You did not write them. Be strict: an entry you pass may go live without human review.`,
    `Each concept has: ${fields}`,
    'For each concept return (leave out ia, sa and sc when their input is absent):',
    '- ia, only if m is present: true if p and m are the same term (ignore case, accents and articles); false if the wording differs.',
    ...(sibling ? ['- sa, only if sb is present: true if sb expresses the same concept as p (a legitimate regional variant, e.g. "ordenador"/"computadora", counts as agreement); false if it points to a different meaning.'] : []),
    `- sf: true if p follows the style guide and the ${T} register, and keeps codes, units and brand names as in the source.`,
    '- sc, only if b or c is present: true if p, b and c are the same term up to case, articles or inflection.',
    '- k: confidence 0 to 1 that p is the right entry:',
    '  0.9-1.0 every check passes and the meaning in context is clear;',
    '  0.6-0.85 one soft concern (a debatable word choice, a register doubt, b or c differ in wording but not meaning);',
    '  below 0.6 m disagrees, b or c point to a different term, the meaning is ambiguous, or p could mislead. Weigh this heavily for safety, legal and regulated terms.',
    '- n: the main concern, or "ok", at most 12 words.',
    `${registerRule(target)}`,
    `${JSON_ONLY} one item per input concept, same i:`,
    `{"items":[{"i":1,"sf":true,"k":0.92,"n":"ok"},{"i":2,"ia":false,${sibling ? '"sa":true,' : ''}"sf":true,"sc":true,"k":0.5,"n":"…"}]}`,
  ].join('\n');
  return { system, user: `${styleBlock(styleGuide)}${data({ c: concepts })}` };
}

export function translatePrompt({ target, sentences, glossary }) {
  const T = lang(target);
  const system = [
    `You translate English website sentences into ${T} using the client's glossary.`,
    `g lists glossary entries: s English term, t the ${T} term, h 1 = hard (use t exactly as written), h 0 = guidance (prefer t).`,
    'Translate each sentence completely and naturally. Wherever a glossary term\'s meaning appears, use its t. Keep codes, numbers and units as in the source.',
    registerRule(target),
    JSON_ONLY,
    '{"items":[{"i":0,"t":"…"}]}',
  ].join('\n');
  return { system, user: `s = sentences (i is the index).\n${data({ s: sentences, g: glossary })}` };
}

export function translateStrictPrompt({ target, items }) {
  const T = lang(target);
  const system = [
    `A previous ${T} translation left out required glossary terms.`,
    'Retranslate each sentence so that every term in must appears exactly as written (same spelling, accents and word order), and the terms in keep stay as they are. Rephrase the rest around them so the sentence stays natural and faithful to the source.',
    registerRule(target),
    JSON_ONLY,
    '{"items":[{"i":0,"t":"…"}]}',
  ].join('\n');
  return { system, user: `s = items: i index, s English sentence, prev previous translation, must and keep [English term, required ${T} term] pairs.\n${data({ s: items })}` };
}

// As small as is safe; truncated JSON costs a repair call, so leave some headroom.
const PER_ITEM = { draft_a: 45, draft_b: 22, draft_c: 34, sibling: 22, judge: 60, translate: 110, translate_strict: 110 };
export function maxTokensFor(task, n = 1) {
  if (task === 'extract') return 700; // 25 terms × ~14 tokens, with headroom
  if (task === 'cluster') return Math.min(3000, 300 + 8 * n);
  return Math.round(60 + (PER_ITEM[task] ?? 60) * n);
}
