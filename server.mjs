// Local server for live mode: static files, a guarded page fetcher and an LLM proxy.
// Zero dependencies. The API key stays here and is never sent to the browser.
import http from 'node:http';
import dns from 'node:dns/promises';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const UA = 'GlossaryReviewBot/0.1 (+prototype)';
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_BODY = 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.csv': 'text/csv; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2'
};

// ---------- env ----------

export function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) {
      v = v.slice(1, -1);
    } else {
      v = v.replace(/\s+#.*$/, ''); // inline comment on unquoted values
    }
    out[m[1]] = v;
  }
  return out;
}

function loadEnv() {
  let fromFile = {};
  try { fromFile = parseEnv(fs.readFileSync(path.join(ROOT, '.env'), 'utf8')); } catch { /* no .env */ }
  return { ...fromFile, ...process.env };
}

function isLocalHost(h) {
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' || h.endsWith('.localhost');
}

function roleConfig(env, role) {
  const d = { base: env.LLM_BASE_URL || '', key: env.LLM_API_KEY || '', model: env.LLM_MODEL || '' };
  if (role !== 'judge') return d;
  const base = env.JUDGE_BASE_URL || d.base;
  // Do not send the drafter key to a different host just because the judge key is unset.
  const key = env.JUDGE_API_KEY || (base === d.base ? d.key : '');
  return { base, key, model: env.JUDGE_MODEL || d.model };
}

function hostOf(base) {
  try { return new URL(base).host; } catch { return null; }
}

function isLive(env) {
  if (env.LLM_PROVIDER === 'mock') return true;
  const c = roleConfig(env, 'drafter');
  if (!c.base || !c.model) return false;
  if (c.key) return true;
  const h = hostOf(c.base);
  return !!h && isLocalHost(h.replace(/:\d+$/, ''));
}

// ---------- IP guard ----------

function ipv4Blocked(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 127 || a === 0 || a === 10 || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

export function isBlockedIp(ip) {
  const fam = net.isIP(ip);
  if (fam === 4) return ipv4Blocked(ip);
  if (fam !== 6) return true;
  const s = ip.toLowerCase();
  if (s === '::1' || s === '::') return true;
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4Blocked(mapped[1]);
  const hex = s.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
    return ipv4Blocked(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const first = parseInt(s.split(':')[0] || '0', 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function assertPublicUrl(u) {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError(400, 'Only http and https URLs are allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); } catch { throw new HttpError(502, 'Could not resolve host'); }
  if (!addrs.length || addrs.some((a) => isBlockedIp(a.address))) throw new HttpError(400, 'This address is not allowed');
}

// ---------- guarded fetch ----------

async function guardedGet(startUrl, { accept, maxRedirects = 3 }) {
  let url = startUrl;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      await assertPublicUrl(url);
      let res;
      try {
        res = await fetch(url, { redirect: 'manual', signal: ctl.signal, headers: { 'User-Agent': UA, Accept: accept } });
      } catch (e) {
        if (e && e.name === 'AbortError') throw new HttpError(504, 'The site took too long to respond');
        throw new HttpError(502, 'Could not reach the site');
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        try { url = new URL(res.headers.get('location'), url); } catch { throw new HttpError(502, 'Bad redirect'); }
        try { await res.body?.cancel(); } catch { /* ignore */ }
        continue;
      }
      return { res, url, ctl, timer }; // caller clears the timer once the body is read
    }
    throw new HttpError(502, 'Too many redirects');
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

async function readCapped(res, timer) {
  const chunks = [];
  let total = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      chunks.push(value);
      if (total >= MAX_BYTES) { await reader.cancel(); break; }
    }
  } catch (e) {
    if (e && e.name === 'AbortError') throw new HttpError(504, 'The site took too long to respond');
    throw new HttpError(502, 'Failed reading the page');
  } finally {
    clearTimeout(timer);
  }
  return Buffer.concat(chunks).subarray(0, MAX_BYTES).toString('utf8');
}

// ---------- robots.txt ----------

const robotsCache = new Map();

function parseRobots(text) {
  const rules = [];
  let agents = [];
  let inRules = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const k = m[1].toLowerCase();
    if (k === 'user-agent') {
      if (inRules) { agents = []; inRules = false; }
      agents.push(m[2].trim().toLowerCase());
    } else if (k === 'disallow') {
      inRules = true;
      const applies = agents.some((a) => a === '*' || a === 'glossaryreviewbot');
      if (applies && m[2].trim()) rules.push(m[2].trim());
    } else if (k === 'allow') {
      inRules = true;
    }
  }
  return rules;
}

async function robotsAllows(url) {
  let rules = robotsCache.get(url.origin);
  if (!rules) {
    rules = [];
    try {
      const { res, timer } = await guardedGet(new URL('/robots.txt', url.origin), { accept: 'text/plain', maxRedirects: 3 });
      if (res.ok) rules = parseRobots(await readCapped(res, timer));
      else clearTimeout(timer);
    } catch { /* robots fetch failure: allow */ }
    robotsCache.set(url.origin, rules);
  }
  const p = url.pathname + url.search;
  return !rules.some((r) => p.startsWith(r.replace(/\*.*$/, '').replace(/\$$/, '')));
}

// ---------- HTML extraction ----------

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  hellip: '…', copy: '©', reg: '®', trade: '™', rsquo: '’', lsquo: '‘',
  rdquo: '”', ldquo: '“' };

function decodeEntities(s) {
  return s.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z]+));/g, (m, dec, hex, name) => {
    try {
      if (dec) return String.fromCodePoint(Number(dec));
      if (hex) return String.fromCodePoint(parseInt(hex, 16));
    } catch { return m; }
    return Object.hasOwn(ENT, name) ? ENT[name] : m;
  });
}

const squash = (s) => s.replace(/\s+/g, ' ').trim();
const ASSET_RE = /\.(pdf|jpe?g|png|gif|svg|zip|mp4|css|js)$/i;
const BLOCK_RE = /<\/?(?:p|div|br|li|ul|ol|h[1-6]|tr|table|thead|tbody|section|article|header|footer|nav|main|aside|form|blockquote|pre|hr|td|th|dt|dd|dl|figure|figcaption|option|select|button|summary|details|label)\b[^>]*>/gi;

export function extractPage(html, baseUrl) {
  let h = String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1\s*>/gi, ' ');

  const titleM = h.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleM ? squash(decodeEntities(titleM[1].replace(/<[^>]*>/g, ''))) : '';
  const langM = h.match(/<html\b[^>]*?\blang\s*=\s*["']?([A-Za-z0-9-]+)/i);
  const lang = langM ? langM[1] : '';

  const base = new URL(baseUrl);
  const links = [];
  const seenL = new Set();
  for (const m of h.matchAll(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const href = decodeEntities((m[1] ?? m[2] ?? m[3] ?? '').trim());
    if (!href || /^(mailto|tel|javascript):/i.test(href)) continue;
    let u;
    try { u = new URL(href, base); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || u.origin !== base.origin) continue;
    u.hash = '';
    if (ASSET_RE.test(u.pathname)) continue;
    if (!seenL.has(u.href)) { seenL.add(u.href); links.push(u.href); }
    if (links.length >= 200) break;
  }

  const labels = [];
  const seenB = new Set();
  for (const m of h.matchAll(/<(button|a|label|h[1-4]|th|option|summary)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)) {
    const t = squash(decodeEntities(m[2].replace(/<[^>]*>/g, ' ')));
    const n = t ? t.split(' ').length : 0;
    if (n < 1 || n > 8 || seenB.has(t)) continue;
    seenB.add(t);
    labels.push(t);
    if (labels.length >= 300) break;
  }

  const lines = decodeEntities(h.replace(BLOCK_RE, '\n').replace(/<[^>]*>/g, ''))
    .split('\n').map(squash).filter(Boolean);
  const text = lines.join('\n');

  const sentences = [];
  const seenS = new Set();
  outer: for (const line of lines) {
    for (const s of line.split(/(?<=[.!?])\s+(?=[A-Z0-9])/)) {
      const t = s.trim();
      const n = t.split(' ').length;
      if (n < 3 || n > 60 || seenS.has(t)) continue;
      seenS.add(t);
      sentences.push(t);
      if (sentences.length >= 400) break outer;
    }
  }
  return { title, lang, text, sentences, labels, links };
}

// ---------- handlers ----------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function health(env) {
  const mock = env.LLM_PROVIDER === 'mock';
  const live = isLive(env);
  const info = (role) => {
    if (mock) return { host: 'mock', model: 'mock' };
    const c = roleConfig(env, role);
    return { host: hostOf(c.base), model: c.model || null };
  };
  const gap = Number(env.LLM_MIN_GAP_MS);
  return { live, mock, drafter: info('drafter'), judge: info('judge'), minGapMs: Number.isFinite(gap) && gap >= 0 && env.LLM_MIN_GAP_MS !== '' && env.LLM_MIN_GAP_MS != null ? gap : 4000 };
}

async function handleFetch(req, res, query) {
  const raw = query.get('url');
  let u;
  try { u = new URL(raw); } catch { return sendJson(res, 400, { error: 'Enter a full URL starting with http:// or https://' }); }
  try {
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError(400, 'Only http and https URLs are allowed');
    if (!(await robotsAllows(u))) throw new HttpError(403, 'This site\'s robots.txt asks crawlers not to fetch this page');
    const { res: up, url: finalUrl, timer } = await guardedGet(u, { accept: 'text/html' });
    if (finalUrl.href !== u.href && !(await robotsAllows(finalUrl))) {
      clearTimeout(timer);
      throw new HttpError(403, 'This site\'s robots.txt asks crawlers not to fetch this page');
    }
    if (!up.ok) { clearTimeout(timer); throw new HttpError(502, `The site answered with HTTP ${up.status}`); }
    if (!/^text\/html\b/i.test(up.headers.get('content-type') || '')) {
      clearTimeout(timer);
      try { await up.body?.cancel(); } catch { /* ignore */ }
      throw new HttpError(400, 'Only text/html pages can be reviewed');
    }
    const html = await readCapped(up, timer);
    sendJson(res, 200, { url: u.href, finalUrl: finalUrl.href, ...extractPage(html, finalUrl.href) });
  } catch (e) {
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
    sendJson(res, 502, { error: 'Fetch failed' });
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > MAX_BODY) { reject(new HttpError(413, 'Request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function callUpstream(cfg, payload) {
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.key) headers.Authorization = `Bearer ${cfg.key}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 60000);
  try {
    return await fetch(`${cfg.base.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST', headers, body: JSON.stringify(payload), signal: ctl.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function handleLlm(req, res, env) {
  const t0 = Date.now();
  let role = '?';
  let status = 500;
  const done = (s, obj) => {
    status = s;
    sendJson(res, s, obj);
    if (!env.SERVER_QUIET) console.log(`llm role=${role} status=${status} ${Date.now() - t0}ms`);
  };
  try {
    if (env.LLM_PROVIDER === 'mock') return done(400, { error: 'mock mode: the browser answers LLM calls locally' });
    if (!isLive(env)) return done(503, { error: 'No LLM is configured. Set LLM_BASE_URL, LLM_MODEL and LLM_API_KEY in .env' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (e) {
      if (e instanceof HttpError) return done(e.status, { error: e.message });
      return done(400, { error: 'Invalid JSON body' });
    }
    role = body && body.role === 'judge' ? 'judge' : 'drafter';
    if (!body || !Array.isArray(body.messages) || !body.messages.length) return done(400, { error: 'messages is required' });
    const cfg = roleConfig(env, role);
    const payload = { model: cfg.model, messages: body.messages };
    if (body.max_tokens) payload.max_tokens = body.max_tokens;
    if (typeof body.temperature === 'number') payload.temperature = body.temperature;
    if (body.json) payload.response_format = { type: 'json_object' };

    let up;
    try {
      up = await callUpstream(cfg, payload);
      if (up.status === 400 && payload.response_format) {
        const peek = await up.text();
        if (/response_format/i.test(peek)) {
          delete payload.response_format;
          up = await callUpstream(cfg, payload);
        } else {
          up = new Response(peek, { status: 400, headers: up.headers });
        }
      }
    } catch (e) {
      return done(e && e.name === 'AbortError' ? 504 : 502, { error: e && e.name === 'AbortError' ? 'The LLM took too long to answer' : 'Could not reach the LLM provider', retryAfter: null });
    }
    const text = await up.text();
    let j = null;
    try { j = JSON.parse(text); } catch { /* non-JSON body */ }
    if (!up.ok) {
      const ra = parseFloat(up.headers.get('retry-after'));
      const msg = (j && ((j.error && j.error.message) || (typeof j.error === 'string' && j.error) || j.message)) || text.slice(0, 300) || `HTTP ${up.status}`;
      return done(up.status, { error: String(msg), retryAfter: Number.isFinite(ra) ? ra : null });
    }
    const content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (typeof content !== 'string') return done(502, { error: 'The LLM returned no message', retryAfter: null });
    const u = (j && j.usage) || {};
    done(200, { content, model: j.model || cfg.model, usage: { prompt_tokens: u.prompt_tokens || 0, completion_tokens: u.completion_tokens || 0 } });
  } catch {
    if (!res.headersSent) done(500, { error: 'Server error', retryAfter: null });
  }
}

function serveStatic(req, res, rawPath) {
  const notFound = () => { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); };
  let p;
  try { p = decodeURIComponent(rawPath); } catch { return notFound(); }
  if (p.includes('\0') || p.includes('\\')) return notFound();
  if (p === '/' || p === '') p = '/index.html';
  const segs = p.split('/').filter(Boolean);
  if (segs.some((s) => s.startsWith('.') || s === 'node_modules')) return notFound();
  if (segs.length === 1 && segs[0] === 'server.mjs') return notFound();
  const file = path.join(ROOT, ...segs);
  if (!file.startsWith(ROOT + path.sep)) return notFound();
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return notFound();
    const ext = path.extname(file).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    if (['.html', '.js', '.mjs', '.css'].includes(ext)) headers['Cache-Control'] = 'no-store';
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
}

export function createAppServer(env = {}) {
  return http.createServer((req, res) => {
    const [rawPath, qs = ''] = (req.url || '/').split('?');
    // Raw path on purpose: new URL() would normalize /../ away before we can reject it.
    if (rawPath === '/api/health' && req.method === 'GET') return sendJson(res, 200, health(env));
    if (rawPath === '/api/fetch' && req.method === 'GET') return handleFetch(req, res, new URLSearchParams(qs));
    if (rawPath === '/api/llm' && req.method === 'POST') return handleLlm(req, res, env);
    if (rawPath.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    serveStatic(req, res, rawPath);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = loadEnv();
  const port = Number(env.PORT) || 8787;
  const mode = env.LLM_PROVIDER === 'mock' ? 'mock' : isLive(env) ? 'live' : 'demo: no key';
  createAppServer(env).listen(port, '127.0.0.1', () => console.log(`Glossary review running at http://localhost:${port} (${mode})`));
}
