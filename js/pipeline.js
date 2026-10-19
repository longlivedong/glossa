// The fixed pipeline: code runs a sequence of narrow LLM calls (JSON in, JSON out) and decides everything else.
// Not an agent: the model never chooses what happens next.
import {
  TERM_TYPES, TIERS, ENTRIES_PER_HOUR, tierFor, tierReasonFor, defaultEnforcement, capacityFor,
  defaultHoursFor, computeLine, calibrateConfidence, looseTermEqual, applyDoNotTranslate, normalizeTerm, seededUnit, publishedEntries, checkTerms, hardMisses,
} from './rules.js';
import { callLLM, fetchPage, getHealth, getUsage } from './llm.js';
import {
  extractPrompt, clusterPrompt, draftAPrompt, draftBPrompt, draftCPrompt, siblingPrompt, judgePrompt,
  translatePrompt, translateStrictPrompt, maxTokensFor,
} from './prompts.js';

export const STEPS = ['crawl', 'extract', 'cluster', 'draft', 'sibling', 'judge', 'line'];
// Up to 50 concepts per call, split evenly (100 → 2 × 50, 60 → 2 × 30). The largest request (judge, 50 concepts)
// stays near 8k tokens including max_tokens, inside free-tier per-request limits.
const BATCH = 50;
const CTX_CHARS = 160;
const PAGE_CHARS = 5000;
const LABEL_CHARS = 2500;
const MAX_CANDIDATES = 300;
const MAX_CONCEPTS = 150;
const MAX_TERMS_PER_PAGE = 20;
const BOILERPLATE = /official website|url of this page|here'?s how you know|all rights reserved|^copyright\b|^©|skip to (main )?content|cookie (settings|preferences)/i;
const CRITICAL_TYPES = new Set(['safety', 'legal', 'regulated']);
const IMPORT_SOURCE = 'Imported glossary (CSV)';
const CACHE_PREFIX = 'glossa:cache:';

// ---------- small helpers ----------

const hashStr = (s) => Math.floor(seededUnit(s) * 4294967296).toString(36);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const wordCount = (s) => s.trim().split(/\s+/).length;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const asArray = (x) => (Array.isArray(x) ? x : []);
const str = (x) => (typeof x === 'string' ? x.trim() : x == null ? '' : String(x).trim());

/** Case-insensitive whole-word matcher for any of the forms; longest first so overlaps are not double-counted. */
function termRegex(forms) {
  const alts = [...new Set(forms.map((f) => f.trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length).map((f) => escapeRe(f).replace(/\s+/g, '\\s+'));
  if (!alts.length) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts.join('|')})(?![\\p{L}\\p{N}])`, 'giu');
}

function countIn(re, text) {
  if (!re) return 0;
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(text)) n++;
  return n;
}

function testIn(re, text) {
  if (!re) return false;
  re.lastIndex = 0;
  return re.test(text);
}

export function normalizeUrl(u, base) {
  try {
    const url = new URL(u, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    let s = url.href;
    if (url.pathname !== '/' && s.endsWith('/') && !url.search) s = s.slice(0, -1);
    return s;
  } catch {
    return null;
  }
}

const SKIP_EXT = /\.(pdf|jpe?g|png|gif|webp|svg|ico|zip|gz|mp4|mp3|webm|css|js|json|xml|txt|docx?|xlsx?)$/i;

// ---------- cache (localStorage, guarded) ----------

function cacheGet(key) {
  if (typeof localStorage === 'undefined') return {};
  try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch { return {}; }
}

function cacheSet(key, value) {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota or private mode: run without resume */ }
}

export function clearPipelineCache(input) {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.removeItem(cacheKeyFor(input)); } catch { /* ignore */ }
}

function normInput(input) {
  return {
    url: input.url, maxPages: Math.min(10, Math.max(1, input.maxPages ?? 10)),
    urls: (Array.isArray(input.urls) ? input.urls : String(input.urls || '').split(/\s+/)).map((u) => u.trim()).filter(Boolean),
    importedCsvText: input.importedCsvText || '', styleGuide: input.styleGuide || '',
    target: input.target || 'es-ES', sibling: input.sibling === undefined ? 'es-MX' : input.sibling,
    industry: input.industry || 'general', hours: input.hours ?? null, siteName: input.siteName || '',
  };
}

function cacheKeyFor(input) {
  const n = normInput(input);
  // hours only affects the line, which is recomputed in code, so it is left out of the key
  return CACHE_PREFIX + hashStr(JSON.stringify({ ...n, hours: null }));
}

// ---------- CSV ----------

function parseCsvRows(text) {
  const src = String(text ?? '').replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] || '';
  // Spreadsheet exports in some locales use ; or tabs
  const delim = firstLine.includes(',') ? ',' : firstLine.includes(';') ? ';' : firstLine.includes('\t') ? '\t' : ',';
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQ) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

function parseTier(v) {
  const t = str(v).toLowerCase();
  if (!t) return null;
  if (TIERS.includes(t)) return t;
  if (t.includes('dnt') || t.startsWith('low')) return 'low';
  return null;
}

export function parseGlossaryCsv(text) {
  const rows = parseCsvRows(text);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name) => header.indexOf(name);
  const si = col('source'), ti = col('target'), tri = col('tier'), ni = col('notes');
  if (si < 0 || ti < 0) throw new Error('The glossary CSV needs a header row with "source" and "target" columns.');
  const out = [];
  for (const r of rows.slice(1)) {
    const source = str(r[si]), target = str(r[ti]);
    if (!source || !target) continue;
    out.push({ source, target, tier: tri >= 0 ? parseTier(r[tri]) : null, notes: ni >= 0 ? str(r[ni]) : '' });
  }
  return out;
}

// ---------- step 1: crawl ----------

async function crawl(input, fetchFn, emit, signal) {
  const start = normalizeUrl(input.url);
  if (!start) throw new Error(`Not a valid http(s) URL: ${input.url}`);
  const origin = new URL(start).origin;
  const max = input.maxPages;
  // Frontier entries remember how often and how early they were linked: nav links repeat on every page and come first.
  const frontier = new Map([[start, { url: start, inbound: 1, firstIdx: 0, seed: 0 }]]);
  // Pages the user listed come right after the start page, in their order, before anything discovered by links.
  input.urls.forEach((raw, i) => {
    const u = normalizeUrl(raw, start);
    if (u && new URL(u).origin === origin && !frontier.has(u)) frontier.set(u, { url: u, inbound: 1, firstIdx: 0, seed: i + 1 });
  });
  const visited = new Set();
  const pages = [];
  let order = 0;
  const segments = (u) => new URL(u).pathname.split('/').filter(Boolean).length;
  while (frontier.size && pages.length < max) {
    signal?.throwIfAborted?.();
    const next = [...frontier.values()].sort((a, b) =>
      (a.seed ?? Infinity) - (b.seed ?? Infinity) ||
      segments(a.url) - segments(b.url) || b.inbound - a.inbound || a.firstIdx - b.firstIdx)[0];
    frontier.delete(next.url);
    visited.add(next.url);
    let p;
    try {
      p = await fetchFn(next.url);
    } catch (e) {
      if (next.url === start) throw new Error(`Could not fetch the start page ${start}: ${e.message}`);
      emit('progress', pages.length, max, `Skipped ${next.url}: ${e.message}`);
      continue;
    }
    const finalUrl = normalizeUrl(p.finalUrl || p.url || next.url) || next.url;
    visited.add(finalUrl);
    if (pages.some((x) => x.url === finalUrl)) continue;
    const labels = asArray(p.labels).map(str).filter(Boolean);
    const sentences = asArray(p.sentences).map(str).filter(Boolean);
    pages.push({
      url: finalUrl,
      title: str(p.title) || finalUrl,
      labels,
      sentences,
      // full text is only used for counting; capped so the cache fits in localStorage
      text: clip(str(p.text) || [...labels, ...sentences].join('\n'), 60000),
    });
    emit('progress', pages.length, max, `Fetched ${finalUrl}`);
    asArray(p.links).forEach((l, idx) => {
      const u = normalizeUrl(l, finalUrl);
      if (!u || visited.has(u) || SKIP_EXT.test(new URL(u).pathname)) return;
      if (new URL(u).origin !== origin) return;
      const f = frontier.get(u);
      if (f) f.inbound++;
      else frontier.set(u, { url: u, inbound: 1, firstIdx: order * 1000 + idx });
    });
    order++;
  }
  return pages;
}

// ---------- step 2: extract ----------

/**
 * What one extract call sees. `seen` holds labels and sentences already sent for earlier pages: navigation,
 * footer and boilerplate repeat on every page, so they are sent once and the budget goes to new text.
 * (Frequency is counted in code over the full text, so skipping repeats loses nothing.)
 */
function pagePayload(page, seen = new Set()) {
  const labels = [];
  let used = 0;
  for (const l of page.labels) {
    const s = clip(l, 80);
    const k = `l:${normalizeTerm(s)}`;
    if (seen.has(k)) continue;
    if (used + s.length > LABEL_CHARS) break;
    seen.add(k);
    labels.push(s);
    used += s.length + 3;
  }
  const sentences = [];
  for (const sRaw of page.sentences) {
    const s = clip(sRaw, 300);
    const k = `s:${normalizeTerm(s)}`;
    if (seen.has(k)) continue;
    if (used + s.length > PAGE_CHARS) break;
    seen.add(k);
    sentences.push(s);
    used += s.length + 3;
  }
  return { title: clip(page.title, 120), labels, sentences };
}

function parseExtract(out, payload, page) {
  const hay = `${page.text}\n${payload.labels.join('\n')}`;
  const terms = [];
  const seen = new Set();
  for (const it of asArray(out?.terms)) {
    const t = str(it?.t).replace(/^["'“”‘’]+|["'“”‘’.,;:!?]+$/g, '').trim();
    if (t.length < 2 || t.length > 80 || wordCount(t) > 8) continue;
    // site chrome and non-terms the prompt asks the model to skip, caught again in code
    if (BOILERPLATE.test(t) || /^[\d\s.,:/$€£%+-]+$/.test(t)) continue;
    const key = normalizeTerm(t);
    if (key === normalizeTerm(page.title) || key === normalizeTerm(payload.title)) continue;
    if (seen.has(key)) continue;
    // drop anything the model invented: the term must occur on the page
    if (!testIn(termRegex([t]), hay)) continue;
    seen.add(key);
    const idx = Number(it?.s);
    const sentence = Number.isInteger(idx) && idx >= 0 ? payload.sentences[idx] ?? null : null;
    terms.push({ t, y: TERM_TYPES.includes(it?.y) ? it.y : 'generic', sentence });
    if (terms.length >= MAX_TERMS_PER_PAGE) break;
  }
  return terms;
}

// ---------- step 3: cluster (LLM groups, code counts) ----------

function aggregateCandidates(extracted, pages) {
  const byKey = new Map();
  extracted.forEach((terms, pi) => {
    for (const term of terms) {
      const key = normalizeTerm(term.t);
      const c = byKey.get(key) || { key, forms: new Map(), types: new Map(), pages: new Set() };
      c.forms.set(term.t, (c.forms.get(term.t) || 0) + 1);
      c.types.set(term.y, (c.types.get(term.y) || 0) + 1);
      c.pages.add(pi);
      byKey.set(key, c);
    }
  });
  const allText = pages.map((p) => p.text).join('\n');
  return [...byKey.values()].map((c) => {
    const term = [...c.forms.entries()].sort((a, b) => b[1] - a[1])[0][0];
    return { key: c.key, term, type: pickType([...c.types.entries()]), freq: countIn(termRegex([term]), allText) };
  }).sort((a, b) => b.freq - a.freq || a.term.localeCompare(b.term));
}

/** Most-voted type, but a safety/legal/regulated vote is never outvoted: under-tiering is the costly error. */
function pickType(votes) {
  const sum = new Map();
  for (const [t, n] of votes) sum.set(t, (sum.get(t) || 0) + n);
  const ranked = [...sum.entries()].sort((a, b) => b[1] - a[1]);
  return (ranked.find(([t]) => CRITICAL_TYPES.has(t)) || ranked[0])?.[0] || 'generic';
}

function pickContext(re, pages) {
  const perPage = pages.map((p) => p.sentences.filter((s) => testIn(re, s))
    .sort((a, b) => {
      const ok = (s) => (wordCount(s) >= 6 && wordCount(s) <= 30 ? 0 : 1);
      return ok(a) - ok(b) || Math.abs(wordCount(a) - 15) - Math.abs(wordCount(b) - 15);
    }));
  const out = [];
  // round-robin across pages so the drafter sees different uses of the term
  for (let round = 0; out.length < 3 && perPage.some((l) => l.length > round); round++) {
    for (const list of perPage) {
      if (out.length >= 3) break;
      const s = list[round];
      if (s && !out.includes(s)) out.push(s);
    }
  }
  if (!out.length) {
    // UI strings often appear only as labels; a label is still better context than nothing
    for (const p of pages) {
      for (const l of p.labels) if (out.length < 2 && testIn(re, l) && !out.includes(l)) out.push(l);
    }
  }
  return out;
}

function buildConcepts(groups, csvRows, pages, input) {
  const allText = pages.map((p) => p.text).join('\n');
  const csvByKey = new Map(csvRows.map((r) => [normalizeTerm(r.source), r]));
  const concepts = groups.map((g) => {
    const forms = [g.canonical, ...g.variants];
    const keys = new Set(forms.map(normalizeTerm));
    const re = termRegex(forms);
    const row = [...keys].map((k) => csvByKey.get(k)).find(Boolean) || null;
    const type = g.type;
    const csvTier = row?.tier || null;
    return {
      source: g.canonical,
      variants: g.variants,
      termType: type,
      tier: tierFor(type, input.industry, csvTier),
      tierReason: tierReasonFor(type, input.industry, csvTier),
      ...(csvTier ? { tierForced: true } : {}),
      frequency: countIn(re, allText),
      pages: pages.filter((p) => testIn(re, p.text)).map((p) => p.url),
      context: pickContext(re, pages),
      imported: row ? { text: row.target, sourceName: IMPORT_SOURCE } : null,
    };
  });
  const mustKeep = (c) => c.imported || CRITICAL_TYPES.has(c.termType);
  const byFreq = (a, b) => b.frequency - a.frequency || a.source.localeCompare(b.source);
  const keep = concepts.filter(mustKeep);
  const rest = concepts.filter((c) => !mustKeep(c)).sort(byFreq);
  const kept = [...keep, ...rest.slice(0, Math.max(0, MAX_CONCEPTS - keep.length))].sort(byFreq);
  return kept.map((c, i) => ({ id: `c_${String(i + 1).padStart(4, '0')}`, ...c }));
}

/** Turn the model's groups into a partition of the candidates; anything unknown or duplicated is dropped. */
function applyGroups(out, candidates, glossaryOnly) {
  const known = new Map();
  candidates.forEach((c) => known.set(c.key, { term: c.term, type: c.type, freq: c.freq }));
  glossaryOnly.forEach((t) => {
    const k = normalizeTerm(t);
    if (!known.has(k)) known.set(k, { term: t, type: null, freq: -1 });
  });
  const assigned = new Set();
  const groups = [];
  for (const g of asArray(out?.groups)) {
    const members = [str(g?.c), ...asArray(g?.v).map(str)]
      .map((t) => normalizeTerm(t)).filter((k) => known.has(k) && !assigned.has(k));
    const uniq = [...new Set(members)];
    if (!uniq.length) continue;
    uniq.forEach((k) => assigned.add(k));
    // canonical = the form the site uses most, whatever the model picked
    const sorted = uniq.map((k) => ({ k, ...known.get(k) })).sort((a, b) => b.freq - a.freq);
    const votes = sorted.filter((m) => m.type).map((m) => [m.type, 1]);
    if (TERM_TYPES.includes(g?.y)) votes.push([g.y, 2]);
    groups.push({ canonical: sorted[0].term, variants: sorted.slice(1).map((m) => m.term), type: pickType(votes) });
  }
  for (const [k, v] of known) {
    if (!assigned.has(k)) groups.push({ canonical: v.term, variants: [], type: v.type || 'generic' });
  }
  return groups;
}

// ---------- batched LLM steps ----------

const num = (id) => Number(String(id).replace(/\D/g, ''));
/** A context sentence cut to a window around the term, so a long sentence never loses the term itself. */
function around(sentence, re) {
  if (sentence.length <= CTX_CHARS) return sentence;
  let at = 0, len = 0;
  if (re) {
    re.lastIndex = 0;
    const m = re.exec(sentence);
    if (m) { at = m.index; len = m[0].length; }
  }
  let start = Math.max(0, Math.min(at - Math.floor((CTX_CHARS - len) / 2), sentence.length - CTX_CHARS));
  if (start > 0) {
    const sp = sentence.indexOf(' ', start);
    if (sp >= 0 && sp < at) start = sp + 1;
  }
  const end = Math.min(sentence.length, start + CTX_CHARS);
  return `${start > 0 ? '…' : ''}${sentence.slice(start, end).trim()}${end < sentence.length ? '…' : ''}`;
}
const ctxFor = (c, n = 2) => {
  const re = termRegex([c.source, ...c.variants]);
  return c.context.slice(0, n).map((s) => around(s, re));
};

function conceptPayload(c, nCtx = 2) {
  const o = { i: num(c.id), s: c.source, y: c.termType };
  if (c.variants.length) o.v = c.variants.slice(0, 3);
  if (c.context.length && nCtx) o.x = ctxFor(c, nCtx);
  return o;
}

const batchSize = (n) => Math.ceil(n / Math.max(1, Math.ceil(n / BATCH)));

// ---------- runPipeline ----------

export async function runPipeline(rawInput, { onProgress, llm = callLLM, fetch: fetchFn = fetchPage, signal } = {}) {
  const input = normInput(rawInput);
  const cacheKey = cacheKeyFor(input);
  const cache = cacheGet(cacheKey);
  cache.partial = cache.partial || {};
  const save = () => cacheSet(cacheKey, cache);
  let step = 'crawl';
  const emit = (status, done, total, message = '') => {
    try { onProgress?.({ step, status, done, total, message, usage: getUsage() }); } catch { /* UI errors must not kill the run */ }
  };
  const resumed = (n) => { emit('start', 0, n, 'Resuming.'); emit('done', n, n, 'Resumed from cache.'); };
  const call = async (args) => {
    signal?.throwIfAborted?.();
    return llm({ ...args, signal });
  };

  /**
   * Runs one task over concepts in batches of 25, caching each finished batch so a retry resumes mid-step.
   * Items the model skipped are asked for once more in a single follow-up call.
   */
  const batched = async (task, role, concepts, build, temperature, label, tick) => {
    const partial = cache.partial[task] || (cache.partial[task] = {});
    const results = new Map(Object.entries(partial).map(([k, v]) => [Number(k), v]));
    const pending = concepts.filter((c) => !results.has(num(c.id)));
    const size = batchSize(concepts.length);
    for (let b = 0; b < pending.length; b += size) {
      const slice = pending.slice(b, b + size);
      const ask = async (items) => {
        const out = await call({ task, role, ...build(items), maxTokens: maxTokensFor(task, items.length), temperature });
        for (const it of asArray(out?.items)) {
          const id = Number(it?.i);
          if (items.some((c) => num(c.id) === id)) { results.set(id, it); partial[id] = it; }
        }
      };
      await ask(slice);
      const missing = slice.filter((c) => !results.has(num(c.id)));
      if (missing.length) await ask(missing);
      save();
      tick(`${label} ${Math.min(results.size, concepts.length)} of ${concepts.length}`);
    }
    return results;
  };

  // Per-step timing and token use for the run report, measured from the shared usage counter.
  const t0 = Date.now();
  const stats = { durationMs: 0, candidates: 0, steps: {} };
  const runStep = async (name, fn) => {
    step = name;
    const start = Date.now();
    const before = getUsage();
    try {
      return await fn();
    } catch (e) {
      const aborted = signal?.aborted;
      emit('error', 0, 0, aborted ? 'Cancelled.' : e.message);
      throw e;
    } finally {
      const after = getUsage();
      stats.steps[name] = {
        ms: Date.now() - start,
        calls: after.calls - before.calls,
        promptTokens: after.promptTokens - before.promptTokens,
        completionTokens: after.completionTokens - before.completionTokens,
      };
    }
  };

  // 1. crawl
  const pages = await runStep('crawl', async () => {
    if (cache.crawl) { resumed(cache.crawl.length); return cache.crawl; }
    emit('start', 0, input.maxPages, `Crawling ${input.url}`);
    const p = await crawl(input, fetchFn, emit, signal);
    cache.crawl = p; save();
    emit('done', p.length, p.length, `${p.length} page${p.length === 1 ? '' : 's'} fetched.`);
    return p;
  });

  // 2. extract, one call per page
  const extracted = await runStep('extract', async () => {
    if (cache.extract) { resumed(pages.length); return cache.extract; }
    const partial = cache.partial.extract || (cache.partial.extract = {});
    emit('start', 0, pages.length, 'Finding glossary terms on each page.');
    const all = [];
    const seen = new Set();
    for (let i = 0; i < pages.length; i++) {
      const payload = pagePayload(pages[i], seen); // built even when cached, so `seen` matches a fresh run
      if (!partial[i]) {
        const out = await call({ task: 'extract', role: 'drafter', ...extractPrompt(payload), maxTokens: maxTokensFor('extract'), temperature: 0.2 });
        partial[i] = parseExtract(out, payload, pages[i]);
        save();
      }
      all.push(partial[i]);
      emit('progress', i + 1, pages.length, `${pages[i].title}: ${partial[i].length} terms`);
    }
    cache.extract = all; save();
    emit('done', pages.length, pages.length, `${all.reduce((s, t) => s + t.length, 0)} candidate terms.`);
    return all;
  });

  stats.candidates = Math.min(MAX_CANDIDATES, new Set(extracted.flat().map((t) => normalizeTerm(t.t))).size);
  const csvRows = input.importedCsvText ? parseGlossaryCsv(input.importedCsvText) : [];

  // 3. cluster: the model groups variants; code counts, finds context and matches the import
  let concepts = await runStep('cluster', async () => {
    if (cache.cluster) { resumed(cache.cluster.length); return cache.cluster; }
    emit('start', 0, 1, 'Grouping variants of the same term.');
    const candidates = aggregateCandidates(extracted, pages).slice(0, MAX_CANDIDATES);
    const candKeys = new Set(candidates.map((c) => c.key));
    const glossaryOnly = csvRows.map((r) => r.source).filter((s) => !candKeys.has(normalizeTerm(s)));
    let groups;
    if (candidates.length + glossaryOnly.length < 2) {
      groups = applyGroups({ groups: [] }, candidates, glossaryOnly);
    } else {
      const out = await call({
        task: 'cluster', role: 'drafter',
        ...clusterPrompt({ candidates: candidates.map((c) => [c.term, c.type]), glossaryOnly }),
        maxTokens: maxTokensFor('cluster', candidates.length + glossaryOnly.length), temperature: 0.1,
      });
      groups = applyGroups(out, candidates, glossaryOnly);
    }
    const built = buildConcepts(groups, csvRows, pages, input);
    if (!built.length) throw new Error('No glossary terms were found on the crawled pages.');
    cache.cluster = built; save();
    emit('done', 1, 1, `${built.length} concepts.`);
    return built;
  });

  // 4. tier is assigned in code inside buildConcepts (rules.tierFor / tierReasonFor)

  const nb = Math.ceil(concepts.length / batchSize(concepts.length));
  const common = { target: input.target, styleGuide: input.styleGuide };

  // 5. draft: three independent phrasings; the judge compares them
  const drafts = await runStep('draft', async () => {
    if (cache.draft) { resumed(3 * nb); return cache.draft; }
    let done = 0;
    emit('start', 0, 3 * nb, `Drafting ${concepts.length} entries in ${input.target}.`);
    const tick = (m) => emit('progress', ++done, 3 * nb, m);
    // The imported glossary is deliberately not sent: the judge's import check must be independent.
    const a = await batched('draft_a', 'drafter', concepts, (cs) => draftAPrompt({ ...common, concepts: cs.map((c) => conceptPayload(c)) }), 0.2, 'Proposals', tick);
    const b = await batched('draft_b', 'drafter', concepts, (cs) => draftBPrompt({ ...common, concepts: cs.map((c) => conceptPayload(c)) }), 0.7, 'Phrasing B', tick);
    // Phrasing C comes from the judge's model, which never sees A or B: agreement is a blind second opinion.
    const c = await batched('draft_c', 'judge', concepts, (cs) => draftCPrompt({ ...common, concepts: cs.map((c2) => conceptPayload(c2)) }), 0.7, 'Phrasing C', tick);
    const out = {};
    for (const con of concepts) {
      const id = num(con.id);
      const ta = str(a.get(id)?.t), tb = str(b.get(id)?.t), tc = str(c.get(id)?.t);
      const text = ta || tb || tc || con.source;
      out[con.id] = {
        proposal: { text, reason: clip(str(a.get(id)?.r) || (ta ? '' : 'No proposal returned; used another phrasing.'), 140) },
        renderings: [text, tb, tc],
      };
    }
    cache.draft = out; save();
    emit('done', 3 * nb, 3 * nb, 'Drafts ready.');
    return out;
  });

  // 6. sibling locale (independent of the target drafts)
  const siblings = await runStep('sibling', async () => {
    if (!input.sibling) { emit('start', 0, 0, 'No sibling locale.'); emit('done', 0, 0, 'Skipped: no sibling locale.'); return {}; }
    if (cache.sibling) { resumed(nb); return cache.sibling; }
    let done = 0;
    emit('start', 0, nb, `Drafting ${input.sibling} for comparison.`);
    const res = await batched('sibling', 'drafter', concepts,
      (cs) => siblingPrompt({ sibling: input.sibling, styleGuide: input.styleGuide, concepts: cs.map((c) => conceptPayload(c, 1)) }),
      0.2, input.sibling, (m) => emit('progress', ++done, nb, m));
    const out = {};
    for (const c of concepts) {
      const t = str(res.get(num(c.id))?.t);
      out[c.id] = t ? { locale: input.sibling, text: t } : null;
    }
    cache.sibling = out; save();
    emit('done', nb, nb, 'Sibling drafts ready.');
    return out;
  });

  // 7. judge (separate role, may be a different model)
  const judged = await runStep('judge', async () => {
    if (cache.judge) { resumed(nb); return cache.judge; }
    let done = 0;
    emit('start', 0, nb, 'Scoring confidence.');
    const payload = (c) => {
      const d = drafts[c.id];
      const o = { i: num(c.id), s: c.source, y: c.termType };
      if (c.context.length) o.x = ctxFor(c);
      // The drafter's reason is not sent: the judge forms its own view from the context.
      // B and C are sent only when they differ from p; identical phrasings are self-consistent by definition.
      o.p = d.proposal.text;
      const same = (t) => normalizeTerm(t) === normalizeTerm(o.p);
      if (!same(d.renderings[1])) o.b = d.renderings[1] || '';
      if (!same(d.renderings[2])) o.c = d.renderings[2] || '';
      if (c.imported) o.m = c.imported.text;
      if (siblings[c.id]) o.sb = siblings[c.id].text;
      return o;
    };
    const res = await batched('judge', 'judge', concepts,
      (cs) => judgePrompt({ ...common, sibling: input.sibling, concepts: cs.map(payload) }),
      0.1, 'Scored', (m) => emit('progress', ++done, nb, m));
    const bool = (v) => (typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : null);
    const out = {};
    for (const c of concepts) {
      const j = res.get(num(c.id)) || {};
      const r = drafts[c.id].renderings.map(normalizeTerm);
      let k = Number(j.k ?? j.confidence);
      if (!Number.isFinite(k)) k = 0.5; // no score means a human should look
      if (k > 1 && k <= 100) k /= 100; // some models answer in percent
      out[c.id] = {
        confidence: Math.round(Math.min(1, Math.max(0, k)) * 100) / 100,
        judgeChecks: {
          // if the model skipped ia, fall back to an exact comparison rather than showing n/a
          importedAgrees: c.imported ? bool(j.ia) ?? normalizeTerm(c.imported.text) === r[0] : null,
          siblingAgrees: siblings[c.id] ? bool(j.sa) : null,
          styleFit: bool(j.sf) ?? true,
          selfConsistent: r[0] && r[0] === r[1] && r[1] === r[2] ? true : bool(j.sc) ?? false,
          // the judge's own term, written before weighing the proposal; compared in code
          blindAgrees: str(j.o) ? looseTermEqual(j.o, drafts[c.id].proposal.text) : null,
          clearMeaning: bool(j.amb) === true ? false : true,
        },
        judgeOwn: clip(str(j.o), 120) || null,
        judgeNote: clip(str(j.n) || (res.has(num(c.id)) ? '' : 'Judge returned no score.'), 140),
      };
    }
    cache.judge = out; save();
    emit('done', nb, nb, 'Confidence scored.');
    return out;
  });

  // 8. draw the line, in code
  const finished = await runStep('line', async () => {
    emit('start', 0, 1, 'Drawing the review line.');
    const hours = input.hours ?? defaultHoursFor(concepts.length);
    const capacity = capacityFor(hours);
    const runId = `run_${hashStr(cacheKey)}${Date.now().toString(36)}`;
    concepts = concepts.map((c) => ({
      ...c,
      proposal: drafts[c.id].proposal,
      renderings: drafts[c.id].renderings,
      ...judged[c.id],
      judgeConfidence: judged[c.id].confidence,
      confidence: calibrateConfidence(judged[c.id].confidence, judged[c.id].judgeChecks),
      sibling: siblings[c.id] || null,
      enforcement: defaultEnforcement(c.tier),
      scope: 'all',
      bucket: 'auto',
      floor: null,
      reopened: false,
      status: 'pending',
      decision: null,
    }));
    // Doc §4: names, codes and units every draft kept as in the source are Low / do not translate.
    concepts = concepts.map((c) => {
      const d = applyDoNotTranslate(c);
      return d === c ? c : { ...d, enforcement: defaultEnforcement(d.tier) };
    });
    const line = computeLine(concepts, { capacity, seed: runId });
    for (const c of concepts) Object.assign(c, line.assign.get(c.id));
    const health = await getHealth();
    const model = (r) => (health?.mock ? 'mock' : health?.[r]?.model || 'unknown');
    const run = {
      id: runId,
      mode: 'live',
      createdAt: new Date().toISOString(),
      locale: { source: 'en', target: input.target, sibling: input.sibling },
      site: {
        name: input.siteName || pages[0].title || new URL(pages[0].url).hostname,
        url: pages[0].url,
        industry: input.industry,
        pages: pages.map((p) => ({ url: p.url, title: p.title })),
      },
      budget: { entriesPerHour: ENTRIES_PER_HOUR, hours, capacity },
      totals: null,
      styleGuide: input.styleGuide,
      models: { drafter: model('drafter'), judge: model('judge') },
      usage: getUsage(),
      stats,
      concepts,
      preview: null,
    };
    const q = concepts.filter((c) => c.bucket === 'queue').length;
    emit('done', 1, 1, `${q} of ${concepts.length} need a linguist; the rest are auto-approved.`);
    return run;
  });
  stats.durationMs = Date.now() - t0;
  return finished;
}

// ---------- step 8 preview ----------

/**
 * Progress events use step 'preview'; runPreview throws an Error with a readable message on failure.
 */
export async function runPreview(run, { onProgress, llm = callLLM, max = 5 } = {}) {
  const emit = (status, done, total, message = '') => {
    try { onProgress?.({ step: 'preview', status, done, total, message, usage: getUsage() }); } catch { /* ignore */ }
  };
  const entries = publishedEntries(run).published.map(({ concept, mode }) => ({
    concept, mode, re: termRegex([concept.source, ...concept.variants]),
  }));
  const target = run.locale.target;
  // Greedy pick: sentences that cover the most not-yet-covered terms, hard terms counting double.
  const pool = [...new Set(run.concepts.flatMap((c) => c.context))].map((s) => ({
    s, hits: entries.filter((e) => testIn(e.re, s)),
  })).filter((x) => x.hits.length);
  const picked = [];
  const covered = new Set();
  while (picked.length < max && pool.length) {
    const gain = (x) => x.hits.reduce((g, e) => g + (covered.has(e.concept.id) ? 0.1 : e.mode === 'hard' ? 2 : 1), 0);
    pool.sort((a, b) => gain(b) - gain(a));
    const best = pool.shift();
    picked.push(best);
    best.hits.forEach((e) => covered.add(e.concept.id));
  }
  if (!picked.length) return [];
  emit('start', 0, 2, `Translating ${picked.length} sentences with the glossary.`);
  const termsFor = (x) => x.hits.map((e) => ({ conceptId: e.concept.id, source: e.concept.source, expected: e.concept.proposal.text, mode: e.mode }));
  // Prompts name the form actually in the sentence ("Log in"), not just the canonical ("Sign in").
  const formIn = (id, sentence) => {
    const e = entries.find((x) => x.concept.id === id);
    e.re.lastIndex = 0;
    return e.re.exec(sentence)?.[0] || e.concept.source;
  };
  const glossary = [...new Map(picked.flatMap((x) => x.hits.map((e) => [`${e.concept.id}|${formIn(e.concept.id, x.s).toLowerCase()}`,
    { s: formIn(e.concept.id, x.s), t: e.concept.proposal.text, h: e.mode === 'hard' ? 1 : 0 }]))).values()];
  try {
    const out = await llm({
      task: 'translate', role: 'drafter',
      ...translatePrompt({ target, sentences: picked.map((x) => x.s), glossary }),
      maxTokens: maxTokensFor('translate', picked.length), temperature: 0.2,
    });
    const tr = new Map(asArray(out?.items).map((it) => [Number(it?.i), str(it?.t)]));
    const items = picked.map((x, i) => {
      const translation = tr.get(i) || '';
      return { source: x.s, translation, terms: checkTerms(translation, termsFor(x)), retried: false, firstAttempt: null };
    });
    emit('progress', 1, 2, 'Checking glossary terms in code.');
    const retry = items.map((it, i) => ({ it, i, miss: hardMisses(it.terms) })).filter((x) => x.miss.length);
    if (retry.length) {
      const out2 = await llm({
        task: 'translate_strict', role: 'drafter',
        ...translateStrictPrompt({
          target,
          items: retry.map(({ it, i, miss }) => {
            const o = { i, s: it.source, prev: it.translation, must: miss.map((m) => [formIn(m.conceptId, it.source), m.expected]) };
            // terms the first attempt got right must survive the rephrasing
            const keep = it.terms.filter((t) => t.found).map((t) => [formIn(t.conceptId, it.source), t.expected]);
            if (keep.length) o.keep = keep;
            return o;
          }),
        }),
        maxTokens: maxTokensFor('translate_strict', retry.length), temperature: 0,
      });
      const tr2 = new Map(asArray(out2?.items).map((it) => [Number(it?.i), str(it?.t)]));
      for (const { it, i } of retry) {
        const t2 = tr2.get(i);
        if (!t2) continue;
        it.firstAttempt = it.translation;
        it.translation = t2;
        it.retried = true;
        it.terms = checkTerms(t2, it.terms.map(({ found, ...rest }) => rest));
      }
    }
    emit('done', 2, 2, retry.length ? `${retry.length} sentence(s) retried for missing hard terms.` : 'All hard terms used.');
    return items;
  } catch (e) {
    emit('error', 0, 2, e.message);
    throw e;
  }
}
