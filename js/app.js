// Boot: detect demo vs live mode, load the run, mount the header and views, route tabs.
import { createStore } from './state.js';
import { esc } from './ui/dom.js';

export const REPO_URL = 'https://github.com/longlivedong/glossa';

const VIEWS = [
  { id: 'setup', label: 'Run on a website', module: './ui/setup.js', liveOnly: true },
  { id: 'queue', label: 'Queue', module: './ui/queue.js' },
  { id: 'auto', label: 'Auto-approved', module: './ui/auto.js' },
  { id: 'publish', label: 'Publish', module: './ui/publish.js' },
  { id: 'report', label: 'Report', module: './ui/report.js' },
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

// Re-render chrome only when its markup changes, so focus and hover state survive store updates.
const setHtml = (el, html) => { if (el.dataset.html !== html) { el.dataset.html = html; el.innerHTML = html; } };

const shortDate = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};

function renderBanner(health, run) {
  const el = document.getElementById('banner');
  const note = (icon, html) => `<div class="notice" role="note"><div class="wrap notice-in"><span class="notice-icon" aria-hidden="true">${icon}</span><span>${html}</span></div></div>`;
  if (!health && run?.mode !== 'live') {
    setHtml(el, note('i', `You're viewing a sample run on a fictional site.<span class="notice-more"> To run it on your own: clone the repo, copy <code>.env.example</code> to <code>.env</code>, add a free API key, run <code>node server.mjs</code>.</span> <a href="${REPO_URL}" target="_blank" rel="noopener">How it works</a>`));
  } else if (health && !health.live) {
    setHtml(el, note('!', `The local server is running but no API key is configured, so you're seeing the sample run. Add <code>LLM_API_KEY</code> to <code>.env</code> and restart <code>node server.mjs</code>.`));
  } else if (health && run?.mode === 'demo') {
    setHtml(el, note('i', `You're viewing the fictional sample. <button type="button" class="linklike notice-cta" data-new-run>Run Glossa on a website →</button>`));
  } else {
    setHtml(el, '');
  }
}

function renderBrand(run, live) {
  const el = document.getElementById('brand-right');
  let pill = '';
  if (run?.mode === 'demo') {
    pill = `<span class="run-pill is-sample"><span class="run-dot" aria-hidden="true"></span>Sample run · fictional data</span>`;
  } else if (run) {
    const when = shortDate(run.createdAt);
    pill = `<span class="run-pill is-live" title="${esc(run.site?.url || '')}"><span class="run-dot" aria-hidden="true"></span>Live run · <span class="run-site">${esc(run.site?.name || run.site?.url || 'site')}</span>${when ? ` · ${esc(when)}` : ''}</span>`;
  }
  setHtml(el, `${pill}${live ? '<button type="button" class="btn btn-primary btn-sm" data-new-run>New run</button>' : ''}`);
}

async function main() {
  const health = await detectHealth();
  const live = !!health?.live;
  const ctx = { mode: live ? 'live' : 'demo', health, toast };
  const store = createStore();

  document.getElementById('repo-link').href = REPO_URL;
  const renderChrome = () => { renderBanner(health, store.get()); renderBrand(store.get(), live); };
  store.subscribe(renderChrome);
  document.addEventListener('click', (e) => {
    if (!e.target.closest('[data-new-run]')) return;
    store.setUI({ tab: 'setup' });
    window.dispatchEvent(new CustomEvent('glossa:new-run'));
  });

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
  renderChrome();

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
    const footNote = document.getElementById('footer-note');
    if (footNote) footNote.textContent = store.get()?.mode === 'live'
      ? 'Live run on a public website. Drafts are machine-generated and need linguist review.'
      : 'All names and data in the sample run are fictional.';
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
