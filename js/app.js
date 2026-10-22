// Boot: detect demo vs live mode, load the run, mount the header and views, route tabs.
import { createStore } from './state.js';
import { esc, fmtInt } from './ui/dom.js';
import { stagger } from './motion.js';

export const REPO_URL = 'https://github.com/longlivedong/glossa';

// `short` is the label at phone width (css/ux.css swaps it in at <=480px).
const VIEWS = [
  { id: 'setup', label: 'Run on a website', short: 'Run', module: './ui/setup.js', liveOnly: true },
  { id: 'queue', label: 'Queue', short: 'Queue', module: './ui/queue.js' },
  { id: 'auto', label: 'Auto-approved', short: 'Auto', module: './ui/auto.js' },
  { id: 'publish', label: 'Publish', short: 'Publish', module: './ui/publish.js' },
  { id: 'report', label: 'Report', short: 'Report', module: './ui/report.js' },
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

// Phones show the queue as a list, or one card in its place (detail). Detail lives in the URL hash, never in storage.
const narrow = window.matchMedia('(max-width: 819px)');
const qmode = { detail: false };
const NOTICE_KEY = 'glossa:notice-dismissed';
const noticeDismissed = () => { try { return sessionStorage.getItem(NOTICE_KEY) === '1'; } catch { return false; } };

const TOAST_MS = 8000;
const TOAST_MAX = 2; // keep the previous toast too, so its Undo isn't lost to the next decision

/** Toast with an optional action. Stays 8s, pauses while hovered or focused, and stacks at most two. */
function toast(message, { actionLabel, actionAria, onAction, timeout = TOAST_MS } = {}) {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span>${esc(message)}</span>`;
  let remaining = timeout;
  let startedAt = 0;
  let timer = null;
  let hovered = false;
  let focused = false;
  const close = () => { clearTimeout(timer); el.remove(); };
  const run = () => { if (!timer) { startedAt = Date.now(); timer = setTimeout(close, remaining); } };
  const hold = () => { if (timer) { clearTimeout(timer); timer = null; remaining = Math.max(1500, remaining - (Date.now() - startedAt)); } };
  const sync = () => (hovered || focused ? hold() : run());
  el.addEventListener('mouseenter', () => { hovered = true; sync(); });
  el.addEventListener('mouseleave', () => { hovered = false; sync(); });
  el.addEventListener('focusin', () => { focused = true; sync(); });
  el.addEventListener('focusout', (e) => { if (!el.contains(e.relatedTarget)) { focused = false; sync(); } });
  if (actionLabel && onAction) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = actionLabel;
    if (actionAria) b.setAttribute('aria-label', actionAria);
    b.addEventListener('click', () => { onAction(); close(); });
    el.append(b);
  }
  root.append(el);
  while (root.children.length > TOAST_MAX) root.firstElementChild.remove();
  run();
}

// Re-render chrome only when its markup changes, so focus and hover state survive store updates.
const setHtml = (el, html) => { if (el.dataset.html !== html) { el.dataset.html = html; el.innerHTML = html; } };

const shortDate = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};

function renderBanner(health, run) {
  const el = document.getElementById('banner');
  // Phones show the short line (aria-hidden) and keep the long one for screen readers; the × hides it for the session.
  const note = (icon, long, short, tail = '') => `<div class="notice" role="note"><div class="wrap notice-in"><span class="notice-icon" aria-hidden="true">${icon}</span><span class="notice-text"><span class="notice-long">${long}</span><span class="notice-short" aria-hidden="true">${short}</span>${tail}</span><button type="button" class="notice-x" data-dismiss-notice aria-label="Dismiss this notice">×</button></div></div>`;
  el.classList.toggle('is-dismissed', noticeDismissed());
  if (!health && run?.mode !== 'live') {
    setHtml(el, note('i', `You're viewing a sample run on a fictional site.<span class="notice-more"> To run it on your own: clone the repo, copy <code>.env.example</code> to <code>.env</code>, add a free API key, run <code>node server.mjs</code>.</span>`, 'Sample run on a fictional site.', ` <a href="${REPO_URL}" target="_blank" rel="noopener">How it works</a>`));
  } else if (health && !health.live) {
    setHtml(el, note('!', `The local server is running but no API key is configured, so you're seeing the sample run. Add <code>LLM_API_KEY</code> to <code>.env</code> and restart <code>node server.mjs</code>.`, 'No API key set: showing the sample.'));
  } else if (health && run?.mode === 'demo') {
    setHtml(el, note('i', `You're viewing the fictional sample.`, 'Fictional sample.', ` <button type="button" class="linklike notice-cta" data-new-run>Run Glossa on a website →</button>`));
  } else {
    setHtml(el, '');
  }
}

function renderBrand(run, live) {
  const el = document.getElementById('brand-right');
  let pill = '';
  if (run?.mode === 'demo') {
    pill = `<span class="run-pill is-sample"><span class="run-dot" aria-hidden="true"></span><span class="pill-long">Sample run · fictional data</span><span class="pill-short" aria-hidden="true">Sample</span></span>`;
  } else if (run) {
    const when = shortDate(run.createdAt);
    pill = `<span class="run-pill is-live" title="${esc(run.site?.url || '')}"><span class="run-dot" aria-hidden="true"></span><span class="pill-long">Live run${when ? ` · ${esc(when)}` : ''}</span><span class="pill-short" aria-hidden="true">Live</span></span>`;
  }
  setHtml(el, `${pill}${live ? '<button type="button" class="btn btn-primary btn-sm brand-new" data-new-run>New run</button>' : ''}`);
}

async function main() {
  const health = await detectHealth();
  const live = !!health?.live;
  const ctx = { mode: live ? 'live' : 'demo', health, toast, narrow, isDetail: () => narrow.matches && qmode.detail };
  const store = createStore();

  document.getElementById('repo-link').href = REPO_URL;
  const renderChrome = () => { renderBanner(health, store.get()); renderBrand(store.get(), live); };
  store.subscribe(renderChrome);
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-dismiss-notice]')) {
      try { sessionStorage.setItem(NOTICE_KEY, '1'); } catch { /* storage blocked: hide it for this page only */ }
      document.getElementById('banner').classList.add('is-dismissed');
      document.querySelector('#tabs [aria-selected="true"]')?.focus();
      return;
    }
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

  // Tabs are built once; store updates only touch aria-selected, tabindex, the count and the panels' hidden flag,
  // so focus stays on the tab that was activated. Roving tabindex with Left/Right/Home/End inside the tablist.
  tabbar.innerHTML = views.map((v) => `
    <button class="tab" role="tab" type="button" id="tab-${v.id}" aria-controls="view-${v.id}" aria-selected="false" tabindex="-1"
      data-tab="${v.id}"${v.short !== v.label ? ` data-short="${esc(v.short)}"` : ''}><span class="tab-label">${esc(v.label)}</span>${v.id === 'queue' ? '<span class="count"><span aria-hidden="true" data-count></span><span class="visually-hidden" data-count-label></span></span>' : ''}</button>`).join('');
  const tabEls = [...tabbar.querySelectorAll('[role="tab"]')];
  let shownTab = null;

  const scrollTabIntoView = (b) => {
    const d = b.getBoundingClientRect().left - tabbar.getBoundingClientRect().left;
    const target = tabbar.scrollLeft + d - (tabbar.clientWidth - b.offsetWidth) / 2;
    tabbar.scrollTo({ left: Math.max(0, target), behavior: 'auto' });
  };

  const renderTabs = () => {
    const footNote = document.getElementById('footer-note');
    if (footNote) footNote.textContent = store.get()?.mode === 'live'
      ? 'Live run on a public website. Drafts are machine-generated and need linguist review.'
      : 'All names and data in the sample run are fictional.';
    const ui = store.ui();
    const run = store.get();
    const active = views.some((v) => v.id === ui.tab) ? ui.tab : 'queue';
    const pending = run ? run.concepts.filter((c) => c.bucket === 'queue' && c.status === 'pending').length : 0;
    for (const b of tabEls) {
      const on = b.dataset.tab === active;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    const n = tabbar.querySelector('[data-count]');
    if (n) {
      n.textContent = fmtInt(pending);
      tabbar.querySelector('[data-count-label]').textContent = `, ${fmtInt(pending)} pending${run?.totals ? ' in this sample' : ''}`;
    }
    for (const v of VIEWS) {
      const el = document.getElementById(`view-${v.id}`);
      el.hidden = v.id !== active;
      el.setAttribute('aria-labelledby', `tab-${v.id}`);
    }
    if (active !== shownTab) {
      shownTab = active;
      const b = tabEls.find((t) => t.dataset.tab === active);
      if (b) scrollTabIntoView(b);
      // Motion only when a view appears, never on the re-renders that follow a decision. Deferred to a microtask:
      // the view's own subscriber re-renders it on this same update, after this one, and before the next paint.
      queueMicrotask(() => stagger(document.getElementById(`view-${active}`)?.children, { y: 6, each: 0.04, max: 6 }));
    }
  };
  tabbar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    // On a phone, the Queue tab inside a card goes back to the list.
    if (b.dataset.tab === 'queue' && store.ui().tab === 'queue' && ctx.isDetail()) ctx.closeDetail();
    else store.setUI({ tab: b.dataset.tab });
  });
  tabbar.addEventListener('keydown', (e) => {
    const i = tabEls.indexOf(e.target);
    if (i < 0 || e.ctrlKey || e.metaKey || e.altKey) return;
    const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabEls.length - 1 }[e.key];
    if (to == null) return;
    e.preventDefault();
    const b = tabEls[(to + tabEls.length) % tabEls.length];
    b.focus();
    store.setUI({ tab: b.dataset.tab });
  });
  store.subscribe(renderTabs);
  renderTabs();

  // Location hash mirrors the tab and the selected entry (#queue/c_0007, #publish).
  // A tab change adds a history entry, so Back moves between tabs; a new selection replaces the current one.
  const tabIds = new Set(views.map((v) => v.id));
  const parseHash = () => {
    const [tab, id] = decodeURIComponent(location.hash.slice(1)).split('/');
    return tabIds.has(tab) ? { tab, id: id || null } : null;
  };
  // Phones: the list is #queue and a card is #queue/c_0007, so browser Back from a card returns to the list.
  const wantHash = () => {
    const { tab, selectedId } = store.ui();
    const t = tabIds.has(tab) ? tab : 'queue';
    return t === 'queue' && selectedId && (!narrow.matches || qmode.detail) ? `#queue/${encodeURIComponent(selectedId)}` : `#${t}`;
  };
  const applyHash = () => {
    const h = parseHash();
    if (!h) return;
    const ui = store.ui();
    const patch = {};
    if (h.tab !== ui.tab) patch.tab = h.tab;
    if (h.tab === 'queue' && h.id && h.id !== ui.selectedId && store.concept(h.id)) patch.selectedId = h.id;
    const detail = h.tab === 'queue' && !!h.id && !!store.concept(h.id);
    const flip = detail !== qmode.detail;
    qmode.detail = detail;
    if (Object.keys(patch).length || flip) store.setUI(patch);
  };
  ctx.openDetail = (id) => {
    if (!qmode.detail) {
      qmode.detail = true;
      try { history.pushState({ glossaDetail: true }, '', `#queue/${encodeURIComponent(id)}`); } catch { /* syncHash replaces it */ }
    }
    store.setUI({ selectedId: id });
  };
  ctx.closeDetail = () => {
    if (history.state?.glossaDetail) { history.back(); return; } // hashchange closes it
    qmode.detail = false;
    store.setUI({});
  };
  const syncHash = () => {
    if (store.ui().tab !== 'queue') qmode.detail = false;
    const want = wantHash();
    if (location.hash === want) return;
    const cur = parseHash();
    if (cur && cur.tab !== want.slice(1).split('/')[0]) { location.hash = want; return; }
    try { history.replaceState(history.state, '', want); } catch { location.replace(want); }
  };
  applyHash();
  // A deep link straight to a card on a phone gets a list entry underneath it, so Back still lands on the list.
  if (ctx.isDetail() && !history.state?.glossaDetail) {
    try {
      const at = location.hash;
      history.replaceState(null, '', '#queue');
      history.pushState({ glossaDetail: true }, '', at);
    } catch { /* keep the single entry */ }
  }
  store.subscribe(syncHash);
  syncHash();
  window.addEventListener('hashchange', applyHash);
  narrow.addEventListener('change', () => store.setUI({}));

  // Reset is a two-step flow: the first click only asks. Live runs say plainly that the run itself goes.
  const resetBtn = document.getElementById('reset-demo');
  const confirmBox = document.getElementById('reset-confirm');
  const confirmText = document.getElementById('reset-confirm-text');
  const confirmYes = document.getElementById('reset-yes');
  const confirmNo = document.getElementById('reset-cancel');
  const syncResetLabel = () => { resetBtn.textContent = store.get()?.mode === 'live' ? 'Reset to sample run' : 'Reset demo'; };
  store.subscribe(syncResetLabel);
  syncResetLabel();
  const closeConfirm = (focusBack = true) => {
    confirmBox.hidden = true;
    resetBtn.hidden = false;
    if (focusBack) resetBtn.focus();
  };
  resetBtn.addEventListener('click', () => {
    const run = store.get();
    const decided = run ? run.concepts.filter((c) => c.status !== 'pending' || c.reopened).length : 0;
    const lost = decided ? ` ${fmtInt(decided)} decision${decided === 1 ? '' : 's'} will be lost.` : '';
    confirmText.textContent = run?.mode === 'live'
      ? `Delete the live run on ${run.site?.name || run.site?.url || 'this site'} and load the sample?${lost}`
      : `Reset everything?${lost}`;
    confirmYes.textContent = run?.mode === 'live' ? 'Yes, delete the live run' : 'Yes, reset';
    resetBtn.hidden = true;
    confirmBox.hidden = false;
    confirmNo.focus();
  });
  confirmNo.addEventListener('click', () => closeConfirm());
  confirmBox.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeConfirm(); } });
  confirmYes.addEventListener('click', async () => {
    const wasLive = store.get()?.mode === 'live';
    closeConfirm();
    store.reset();
    await loadDemo();
    store.setUI({ tab: live ? 'setup' : 'queue' });
    toast(wasLive ? 'Live run deleted; the sample run is loaded' : 'Demo reset');
  });
}

main();
