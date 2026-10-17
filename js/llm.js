// Browser-side LLM client. Talks only to the local server (api/llm, api/fetch); the key never reaches here.
// Free tiers allow ~10-15 requests/minute, so every call goes through one serial queue with a minimum gap.
import { mockLLM } from './mock-llm.js';
import { maxTokensFor } from './prompts.js';

const MAX_RETRIES = 3;
const DEFAULT_GAP_MS = 4000;

let healthPromise = null;
const usage = { calls: 0, promptTokens: 0, completionTokens: 0 };

export function getHealth() {
  if (!healthPromise) {
    healthPromise = (async () => {
      try {
        const res = await fetch('api/health');
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null; // static hosting or server down → demo mode
      }
    })();
  }
  return healthPromise;
}

export function getUsage() {
  return { ...usage };
}

export function resetUsage() {
  usage.calls = 0;
  usage.promptTokens = 0;
  usage.completionTokens = 0;
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason ?? new Error('Aborted'));
  const t = setTimeout(resolve, ms);
  signal?.addEventListener?.('abort', () => { clearTimeout(t); reject(signal.reason ?? new Error('Aborted')); }, { once: true });
});

// Serial queue: one request in flight; next one starts no sooner than minGap after the previous start.
// notBefore also lets a 429 pause every queued call, not just the one that hit it.
let chain = Promise.resolve();
let notBefore = 0;

async function inQueue(gapMs, fn, signal) {
  const prev = chain;
  let release;
  chain = new Promise((r) => { release = r; });
  try {
    await prev;
    const wait = notBefore - Date.now();
    if (wait > 0) await sleep(wait, signal);
    notBefore = Date.now() + gapMs;
    return await fn();
  } finally {
    release();
  }
}

/** Strip ```json fences and pull out the first complete JSON object or array. */
export function parseJsonLoose(text) {
  let s = String(text ?? '').trim();
  s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '');
  try { return JSON.parse(s); } catch { /* fall through to scanning */ }
  const start = s.search(/[{[]/);
  if (start < 0) throw new Error('No JSON found in model output');
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return JSON.parse(s.slice(start, i + 1));
  }
  throw new Error('Model output ended before the JSON was complete');
}

class LLMError extends Error {
  constructor(message, status, retryAfter) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

async function post(body, signal) {
  let res;
  try {
    res = await fetch('api/llm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new LLMError(`Network error reaching the local server: ${e.message}`, 0, null);
  }
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok) {
    throw new LLMError(json?.error || `HTTP ${res.status}`, res.status, json?.retryAfter ?? null);
  }
  return json;
}

const retryable = (e) => e instanceof LLMError && (e.status === 0 || e.status === 429 || e.status >= 500);

function friendly(e, task) {
  const s = e.status;
  if (s === 401 || s === 403) return `The provider rejected the API key (${s}) during ${task}. Check .env.`;
  if (s === 429) return `Rate limited during ${task} after ${MAX_RETRIES} retries. Wait a minute, or raise LLM_MIN_GAP_MS. (${e.message})`;
  if (s >= 500) return `The model provider failed during ${task} (${s}): ${e.message}`;
  return `LLM call failed during ${task}${s ? ` (${s})` : ''}: ${e.message}`;
}

async function requestWithRetry(body, gapMs, task, signal) {
  for (let attempt = 0; ; attempt++) {
    try {
      const out = await inQueue(gapMs, () => post(body, signal), signal);
      usage.calls++;
      usage.promptTokens += out?.usage?.prompt_tokens || 0;
      usage.completionTokens += out?.usage?.completion_tokens || 0;
      return out;
    } catch (e) {
      if (signal?.aborted) throw e;
      if (!retryable(e) || attempt >= MAX_RETRIES) throw new Error(friendly(e, task));
      const backoff = e.retryAfter ? e.retryAfter * 1000 : 2000 * 2 ** attempt;
      notBefore = Math.max(notBefore, Date.now() + backoff);
    }
  }
}

/**
 * @returns {Promise<any>} parsed JSON
 * `signal` aborts the in-flight request as well as anything still queued.
 */
export async function callLLM({ task, role = 'drafter', system, user, maxTokens, temperature = 0.2, signal } = {}) {
  const health = await getHealth();
  if (health?.mock) {
    await sleep(120, signal); // lets progress render in the UI; tests inject mockLLM directly
    usage.calls++;
    usage.promptTokens += Math.ceil((system.length + user.length) / 4);
    const out = await mockLLM({ task, system, user });
    usage.completionTokens += Math.ceil(JSON.stringify(out).length / 4);
    return out;
  }
  if (health && health.live === false) throw new Error('No API key configured on the server. Add one to .env and restart.');
  const gapMs = Number.isFinite(health?.minGapMs) ? health.minGapMs : DEFAULT_GAP_MS;
  const max = maxTokens ?? maxTokensFor(task);
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  const first = await requestWithRetry({ role, messages, max_tokens: max, temperature, json: true }, gapMs, task, signal);
  try {
    return parseJsonLoose(first.content);
  } catch {
    // One repair round: show the model its own output. More room in case it was truncated.
    const repair = [...messages,
      { role: 'assistant', content: String(first.content ?? '').slice(0, 6000) },
      { role: 'user', content: 'That was not valid or complete JSON. Reply again with the complete, valid JSON only, in the shape asked for. No prose, no code fences.' }];
    const second = await requestWithRetry({ role, messages: repair, max_tokens: Math.round(max * 1.5), temperature: 0, json: true }, gapMs, task, signal);
    try {
      return parseJsonLoose(second.content);
    } catch (e) {
      throw new Error(`The model returned invalid JSON twice during ${task}: ${e.message}`);
    }
  }
}

export async function fetchPage(url) {
  let res;
  try {
    res = await fetch(`api/fetch?url=${encodeURIComponent(url)}`);
  } catch (e) {
    throw new Error(`Could not reach the local server: ${e.message}`);
  }
  let json = null;
  try { json = await res.json(); } catch { /* fall through */ }
  if (!res.ok || !json || json.error) throw new Error(json?.error || `HTTP ${res.status}`);
  return json;
}
