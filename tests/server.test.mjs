import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createAppServer, extractPage, parseEnv } from '../server.mjs';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function withApp(env, fn) {
  const server = createAppServer({ SERVER_QUIET: '1', ...env });
  const port = await listen(server);
  try { return await fn(`http://127.0.0.1:${port}`, port); } finally { server.close(); server.closeAllConnections?.(); }
}

// Raw request so paths like /../x reach the server un-normalized.
function raw(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
}

test('parseEnv handles comments, quotes and blanks', () => {
  assert.deepEqual(parseEnv('# c\n\nA=1\nB="two words"\nC=\'x\'\nexport D=4\n'), { A: '1', B: 'two words', C: 'x', D: '4' });
});

test('health shape and key secrecy', async () => {
  await withApp({ LLM_BASE_URL: 'https://api.example.com/v1', LLM_MODEL: 'm1', LLM_API_KEY: 'sk-test-SECRET-123' }, async (base) => {
    const text = await (await fetch(`${base}/api/health`)).text();
    assert.ok(!text.includes('sk-test-SECRET-123'));
    const j = JSON.parse(text);
    assert.equal(j.live, true);
    assert.equal(j.mock, false);
    assert.deepEqual(j.drafter, { host: 'api.example.com', model: 'm1' });
    assert.deepEqual(j.judge, { host: 'api.example.com', model: 'm1' });
    assert.equal(j.minGapMs, 4000);
  });
  await withApp({ LLM_PROVIDER: 'mock' }, async (base) => {
    const j = await (await fetch(`${base}/api/health`)).json();
    assert.equal(j.mock, true);
    assert.equal(j.live, true);
  });
  await withApp({}, async (base) => {
    const j = await (await fetch(`${base}/api/health`)).json();
    assert.equal(j.live, false);
    assert.equal(j.mock, false);
  });
});

test('static serving and blocked paths', async () => {
  await withApp({}, async (base, port) => {
    const r = await fetch(`${base}/`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.match(await r.text(), /<html/i);
    for (const p of ['/.env', '/../package.json', '/server.mjs', '/%2e%2e/x', '/node_modules/x', '/nope.txt']) {
      assert.equal(await raw(port, p), 404, p);
    }
  });
});

test('/api/fetch rejects blocked and non-http URLs', async () => {
  await withApp({}, async (base) => {
    for (const u of ['http://localhost/', 'http://127.0.0.1/', 'http://169.254.169.254/', 'http://[::1]/', 'file:///etc/passwd', 'ftp://x']) {
      const r = await fetch(`${base}/api/fetch?url=${encodeURIComponent(u)}`);
      assert.equal(r.status, 400, u);
      assert.ok((await r.json()).error);
    }
  });
});

test('extractPage', () => {
  const html = `<!doctype html><html lang="en-GB"><head><title>Acme &amp; Co</title>
    <script>var secret = "SCRIPTTEXT";</script><style>.x{}</style></head><body>
    <!-- hidden comment -->
    <nav><a href="/pricing#top">Pricing</a> <a href="https://other.com/x">Other</a> <a href="/file.pdf">PDF</a>
    <a href="/pricing">Pricing again</a> <a href="mailto:a@b.c">Mail</a></nav>
    <h1>Welcome home</h1>
    <p>Our team &mdash; the best. Pay with your card&nbsp;today! 42 plans exist. Ok.</p>
    <p>Quote &ldquo;this&rdquo; &#169; &#x2122;</p>
    <button class="b">Add to cart</button>
    </body></html>`;
  const r = extractPage(html, 'https://acme.test/start');
  assert.equal(r.title, 'Acme & Co');
  assert.equal(r.lang, 'en-GB');
  assert.deepEqual(r.links, ['https://acme.test/pricing']);
  assert.ok(r.labels.includes('Add to cart'));
  assert.ok(r.labels.includes('Welcome home'));
  assert.ok(!r.text.includes('SCRIPTTEXT') && !r.text.includes('hidden comment'));
  assert.ok(r.text.includes('Our team — the best.'));
  assert.ok(r.text.includes('“this” © ™'));
  assert.ok(r.sentences.includes('Our team — the best.'));
  assert.ok(r.sentences.includes('Pay with your card today!'));
  assert.ok(r.sentences.includes('42 plans exist.'));
  assert.ok(!r.sentences.includes('Ok.'));
});

test('/api/llm forwards auth and model, normalizes, falls back, passes 429', async () => {
  const seen = [];
  let mode = 'ok';
  const upstream = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const body = JSON.parse(b);
      seen.push({ url: req.url, auth: req.headers.authorization, body });
      if (mode === 'rate') {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '7' });
        return res.end(JSON.stringify({ error: { message: 'slow down' } }));
      }
      if (mode === 'fmt' && body.response_format) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'response_format is not supported' } }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'm-real', choices: [{ message: { content: '{"a":1}' } }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }));
    });
  });
  const up = await listen(upstream);
  const env = { LLM_BASE_URL: `http://127.0.0.1:${up}/v1/`, LLM_MODEL: 'drafter-m', LLM_API_KEY: 'sk-test-SECRET-123', JUDGE_MODEL: 'judge-m' };
  const post = (base, role) => fetch(`${base}/api/llm`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role, messages: [{ role: 'user', content: 'hi' }], max_tokens: 50, temperature: 0.2, json: true })
  });
  try {
    await withApp(env, async (base) => {
      let r = await post(base, 'judge');
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { content: '{"a":1}', finish: null, model: 'm-real', usage: { prompt_tokens: 3, completion_tokens: 4 } });
      assert.equal(seen[0].url, '/v1/chat/completions');
      assert.equal(seen[0].auth, 'Bearer sk-test-SECRET-123');
      assert.equal(seen[0].body.model, 'judge-m');
      assert.deepEqual(seen[0].body.response_format, { type: 'json_object' });

      mode = 'fmt';
      seen.length = 0;
      r = await post(base, 'drafter');
      assert.equal(r.status, 200);
      assert.equal(seen.length, 2);
      assert.ok(seen[0].body.response_format);
      assert.ok(!('response_format' in seen[1].body));
      assert.equal(seen[1].body.model, 'drafter-m');

      mode = 'rate';
      r = await post(base, 'drafter');
      assert.equal(r.status, 429);
      assert.deepEqual(await r.json(), { error: 'slow down', retryAfter: 7 });
    });
    await withApp({ LLM_PROVIDER: 'mock' }, async (base) => {
      const r = await post(base, 'drafter');
      assert.equal(r.status, 400);
      assert.match((await r.json()).error, /mock mode/);
    });
  } finally {
    upstream.close();
    upstream.closeAllConnections?.();
  }
});

test('hosted proxy only forwards Glossa prompts', async () => {
  const { hostedRejects } = await import('../server.mjs');
  const { judgePrompt, extractPrompt } = await import('../js/prompts.js');
  const j = judgePrompt({ target: 'es-ES', sibling: 'es-MX', styleGuide: '', concepts: [] });
  const e = extractPrompt({ title: 't', labels: [], sentences: [] });
  const ok = (p) => ({ messages: [{ role: 'system', content: p.system }, { role: 'user', content: p.user }] });
  assert.equal(hostedRejects(ok(j)), null);
  assert.equal(hostedRejects(ok(e)), null);
  assert.equal(hostedRejects({ messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: 'Write my essay' }] }), 'This endpoint only serves Glossa runs');
  assert.equal(hostedRejects({ messages: [{ role: 'user', content: 'hi' }] }), 'This endpoint only serves Glossa runs');
  assert.equal(hostedRejects({ messages: [{ role: 'system', content: j.system }, { role: 'user', content: 'x'.repeat(90000) }] }), 'Request too large');
});
