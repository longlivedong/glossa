# Interfaces between server, pipeline and UI

The page talks only to the local `server.mjs` (live mode) or to nothing at all (demo mode on static hosting).
The API key lives in `.env` on the server and never reaches the browser.

## Server endpoints (owned by `server.mjs`)

### `GET /api/health`
```json
{ "live": true, "mock": false,
  "drafter": { "host": "generativelanguage.googleapis.com", "model": "gemini-2.0-flash" },
  "judge":   { "host": "generativelanguage.googleapis.com", "model": "gemini-2.0-flash" },
  "minGapMs": 4000 }
```
- `minGapMs` (from `LLM_MIN_GAP_MS`, default 4000): minimum gap between LLM requests, for free-tier rate limits.
- `live: false` when no key is configured (and not mock). Never includes the key.
- `mock: true` when `LLM_PROVIDER=mock`; then the browser answers LLM calls with `js/mock-llm.js` and never POSTs `/api/llm`.
- On static hosting this request fails → the app runs in demo mode.

### `GET /api/fetch?url=<absolute http(s) url>`
```json
{ "url": "...", "finalUrl": "...", "title": "...", "lang": "en",
  "text": "visible text, whitespace-collapsed",
  "sentences": ["prose sentences, 3+ words, deduped"],
  "labels": ["short UI strings from button, a, label, h1-h4, th, option, summary; 1-8 words, deduped"],
  "links": ["https://same-origin/absolute", "..."] }
```
Errors: `{ "error": "message" }` with HTTP 400 (bad/blocked URL), 403 (robots.txt), 502 (upstream), 504 (timeout).
Guards: http/https only; DNS-resolve and block loopback, private, link-local, CGNAT and metadata ranges (IPv4 + IPv6);
re-check after each redirect (max 3); 8 s timeout; 2 MB cap; `text/html` only; robots.txt honoured (cached per origin).

### `POST /api/llm`
Request:
```json
{ "role": "drafter" | "judge", "messages": [{ "role": "system", "content": "..." }, { "role": "user", "content": "..." }],
  "max_tokens": 1500, "temperature": 0.2, "json": true }
```
Server picks base URL / key / model for the role from `.env` (judge falls back to drafter settings), POSTs
`{base}/chat/completions` with `{model, messages, max_tokens, temperature, response_format: {type: "json_object"} if json}`.
If the provider rejects `response_format` (HTTP 400 mentioning it), retry once without it.
Response 200:
```json
{ "content": "<assistant message text>", "model": "...", "usage": { "prompt_tokens": 0, "completion_tokens": 0 } }
```
Errors: `{ "error": "message", "retryAfter": <seconds|null> }` with the provider's status (429 passes through).
Never log the key, the Authorization header, or full prompts.

## Browser modules (owned by the pipeline workstream)

```js
// js/llm.js
export async function getHealth()                // → health JSON or null (static hosting / server down); cached
export async function callLLM({ task, role, system, user, maxTokens, temperature = 0.2, signal })
// → parsed JSON object. `task` is one of: 'extract' | 'cluster' | 'draft_a' | 'draft_b' | 'draft_c'
//   | 'sibling' | 'judge' | 'translate' | 'translate_strict'. Uses mock-llm.js when health.mock.
// Rate-limit queue (default 1 request at a time, min gap from health or 4 s), backoff on 429 honouring retryAfter,
// strips ```json fences, one repair retry on invalid JSON. Tracks usage: getUsage() → {calls, promptTokens, completionTokens}.
export async function fetchPage(url)            // → /api/fetch JSON; throws Error(message) on error

// js/pipeline.js
export async function runPipeline(input, { onProgress, llm = callLLM, fetch = fetchPage, signal } = {})
// input: { url, maxPages = 10, importedCsvText = '', styleGuide = '', target = 'es-ES', sibling = 'es-MX' | null,
//          industry = 'general', hours = null /* null → defaultHoursFor(concepts) */, siteName = '' }
// → Run (mode 'live', totals null, buckets from rules.computeLine, enforcement from rules.defaultEnforcement)
// onProgress({ step, status, done, total, message, usage })
//   step: 'crawl' | 'extract' | 'cluster' | 'draft' | 'sibling' | 'judge' | 'line'
//   status: 'start' | 'progress' | 'done' | 'error'
// Caches each finished step in localStorage ('glossary-review:cache:<hash of input>') so a retry resumes.

export async function runPreview(run, { onProgress, llm = callLLM, max = 5 } = {})
// Step 8. Picks up to `max` crawled context sentences that contain published glossary terms
// (rules.publishedEntries), translates each with the glossary (hard = must use, guidance = preferred),
// checks with rules.checkTerms, retries once with task 'translate_strict' on a hard miss.
// → PreviewItem[]  (see schema.js). onProgress gets the same event shape with step 'preview'; errors throw.

export function parseGlossaryCsv(text)
// header row required: source,target[,tier][,notes] (case-insensitive, quoted fields allowed)
// → [{ source, target, tier: Tier|null, notes }]
```

## UI modules (one file per view)

Every view module exports:
```js
export function mount(el, store, ctx) // ctx = { mode: 'demo' | 'live', health, toast }
```
- `store` is `createStore()` from `js/state.js`; subscribe to it and re-render your own element.
- `ctx.toast(message, { actionLabel, onAction, timeout = 5000 })` shows a toast (e.g. "Accepted · Undo").
- Read `store.ui()` for `{ tab, selectedId, tierFilter, showRandom }`; change it only with `store.setUI(patch)`.
- Don't touch other views' DOM. Shared styles live in `css/app.css`; view-specific styles go in your own CSS file.
