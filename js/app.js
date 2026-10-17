// Boot: detect demo vs live mode, load the run, mount the header and views, route tabs.
import { createStore } from './state.js';
import { esc } from './ui/dom.js';

export const REPO_URL = 'https://github.com/longlivedong/glossary-review';

const VIEWS = [
  { id: 'setup', label: 'Run on a website', module: './ui/setup.js', liveOnly: true },
  { id: 'queue', label: 'Queue', module: './ui/queue.js' },
  { id: 'auto', label: 'Auto-approved', module: './ui/auto.js' },
  { id: 'publish', label: 'Publish', module: './ui/publish.js' },
  { id: 'preview', label: 'Enforcement preview', module: './ui/preview.js' },
  { id: 'learning', label: 'What it learned', module: './ui/learning.js' },
];

async function detectHealth() {
  // Static hosts have no API; skipping the probe keeps their console free of a 404.
  if (location.protocol === 'file:' || location.hostname.endsWith('.github.io')) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch('api/health', { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(timer);
    if (!res.ok) return null;
    const json = await res.json();
    return typeof json?.live === 'boolean' ? json : null;
  } catch {
    return null;
  }
}

function toast(message, { actionLabel, onAction, timeout = 5000 } = {}) {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span>${esc(message)}</span>`;
  if (actionLabel && onAction) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = actionLabel;
    b.addEventListener('click', () => { onAction(); el.remove(); });
    el.append(b);
  }
  root.replaceChildren(el);
  setTimeout(() => el.remove(), timeout);
}

function renderBanner(health) {
  const el = document.getElementById('banner');
  const steps = `clone the repo, copy <code>.env.example</code> to <code>.env</code>, add a free API key, run <code>node server.mjs</code>`;
  if (!health) {
    el.innerHTML = `<div class="banner" role="note"><span aria-hidden="true">ℹ️</span><span>A sample run on a fictional site. To run it on your own: ${steps}. <a href="${REPO_URL}" target="_blank" rel="noopener">How it works</a></span></div>`;
  } else if (!health.live) {
    el.innerHTML = `<div class="banner" role="note"><span aria-hidden="true">🔑</span><span>The local server is running but no API key is configured, so you're seeing the sample run. Add <code>LLM_API_KEY</code> to <code>.env</code> and restart <code>node server.mjs</code>.</span></div>`;
  } else {
    el.innerHTML = '';
  }
}

async function main() {
  const health = await detectHealth();
  const live = !!health?.live;
  const ctx = { mode: live ? 'live' : 'demo', health, toast };
  const store = createStore();

  document.getElementById('repo-link').href = REPO_URL;
  renderBanner(health);

  const loadDemo = async () => {
    const { DEMO_RUN } = await import('./demo-data.js');
    store.loadRun(DEMO_RUN);
  };
  if (!store.get()) {
    await loadDemo().catch((e) => console.error('demo data failed to load', e));
    if (live) store.setUI({ tab: 'setup' });
  }

  const views = VIEWS.filter((v) => live || !v.liveOnly);
  const tabbar = document.querySelector('#tabs .tabbar');

  const header = await import('./ui/header.js').catch((e) => (console.error(e), null));
  header?.mount(document.getElementById('app-header'), store, ctx);

  for (const v of views) {
    const el = document.getElementById(`view-${v.id}`);
    import(v.module)
      .then((m) => m.mount(el, store, ctx))
      .catch((e) => {
        console.error(`${v.module} failed`, e);
        el.innerHTML = `<p class="empty">This view isn't available yet.</p>`;
      });
  }

  const renderTabs = () => {
    const ui = store.ui();
    const run = store.get();
    const active = views.some((v) => v.id === ui.tab) ? ui.tab : 'queue';
    const pending = run ? run.concepts.filter((c) => c.bucket === 'queue' && c.status === 'pending').length : 0;
    const counts = { queue: pending };
    tabbar.innerHTML = views.map((v) => `
      <button class="tab" role="tab" type="button" id="tab-${v.id}" aria-controls="view-${v.id}"
        aria-selected="${v.id === active}" data-tab="${v.id}">${esc(v.label)}${counts[v.id] != null ? `<span class="count">${counts[v.id]}</span>` : ''}</button>`).join('');
    for (const v of VIEWS) {
      const el = document.getElementById(`view-${v.id}`);
      el.hidden = v.id !== active;
      el.setAttribute('aria-labelledby', `tab-${v.id}`);
    }
  };
  tabbar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) store.setUI({ tab: b.dataset.tab });
  });
  store.subscribe(renderTabs);
  renderTabs();

  document.getElementById('reset-demo').addEventListener('click', async () => {
    store.reset();
    await loadDemo();
    store.setUI({ tab: live ? 'setup' : 'queue' });
    toast('Demo reset');
  });
}

main();
