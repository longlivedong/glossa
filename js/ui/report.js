// Report: what this run did, the enforcement preview, and what the reviews taught it.
import { headerCounts, importDisagrees } from '../rules.js';
import { LOCALE_LABEL } from '../schema.js';
import { esc, fmtInt, sampleScope } from './dom.js';

const fmtMs = (ms) => {
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
};

function summary(run) {
  const h = headerCounts(run);
  const stat = (n, label) => `<div class="rp-stat"><span class="rp-value">${n}</span><span class="rp-label">${esc(label)}</span></div>`;
  const items = [
    stat(fmtInt(run.site?.pages?.length ?? 0), 'pages crawled'),
    stat(fmtInt(h.total), 'terms found'),
    stat(fmtInt(h.needYou + h.reviewed), 'need review'),
  ];
  if (run.stats?.durationMs) items.push(stat(esc(fmtMs(run.stats.durationMs)), 'run time'));
  else if (run.usage?.calls) items.push(stat(fmtInt(run.usage.calls), 'LLM calls'));
  return `<div class="rp-summary panel">${items.join('')}</div>`;
}

function whereWent(run) {
  const h = headerCounts(run);
  const parts = [
    { label: 'Needs review', n: h.needYou + h.reviewed, cls: 'sw-need' },
    { label: 'Random check', n: h.randomCheck, cls: 'sw-rc' },
    { label: 'Auto-approved', n: Math.max(0, h.auto - h.randomCheck), cls: 'sw-auto' },
  ];
  const segs = parts.filter((p) => p.n > 0).map((p) => `<span class="sb-seg ${p.cls}" style="flex-grow:${p.n}"></span>`).join('');
  return `
    <section class="rp-section">
      <h3 class="h-section">Where entries went</h3>
      <div class="sb" role="img" aria-label="${esc(parts.map((p) => `${p.label} ${p.n}`).join(', '))}">${segs}</div>
      <ul class="sb-legend">${parts.map((p) => `<li><i class="sw ${p.cls}"></i>${esc(p.label)} <b>${fmtInt(p.n)}</b></li>`).join('')}</ul>
    </section>`;
}

function imported(run) {
  const matched = run.concepts.filter((c) => c.imported);
  const body = (() => {
    if (!matched.length) return '<p class="muted">No existing glossary was imported for this run.</p>';
    const dis = matched.filter(importDisagrees);
    const list = dis.length ? `
      <div class="table-scroll"><table class="pt">
        <thead><tr><th scope="col">Term</th><th scope="col">Drafted</th><th scope="col">Imported glossary</th><th scope="col">Where</th></tr></thead>
        <tbody>${dis.map((c) => `<tr><th scope="row"><span class="pt-src">${esc(c.source)}</span></th><td class="pt-tgt">${esc(c.proposal.text)}</td><td>${esc(c.imported.text)}</td><td class="pt-note">${c.bucket === 'queue' ? 'In your queue' : c.bucket === 'random_check' ? 'Random check' : 'Auto-approved'}</td></tr>`).join('')}</tbody>
      </table></div>` : '';
    return `<p class="muted"><strong>${fmtInt(matched.length)}</strong> imported entries matched a term: <strong>${fmtInt(matched.length - dis.length)}</strong> agree, <strong>${fmtInt(dis.length)}</strong> disagree.</p>${list}`;
  })();
  return `<section class="rp-section"><h3 class="h-section">Imported glossary</h3>${body}</section>`;
}

function pages(run) {
  const list = run.site?.pages || [];
  if (!list.length) return '<p class="muted">No pages recorded.</p>';
  const demo = run.mode === 'demo';
  const item = (p) => {
    let path = p.url;
    try { const u = new URL(p.url); path = u.hostname + (u.pathname === '/' ? '' : u.pathname); } catch { /* keep raw */ }
    const title = esc(p.title || path);
    return demo
      ? `<li><span class="rp-page-title">${title}</span> <span class="rp-page-url">${esc(path)}</span></li>`
      : `<li><a class="rp-page-title" href="${esc(p.url)}" target="_blank" rel="noopener">${title}</a> <span class="rp-page-url">${esc(path)}</span></li>`;
  };
  return `<ul class="rp-pages">${list.map(item).join('')}</ul>${demo ? '<p class="subtle">Fictional addresses, so they are not linked.</p>' : ''}`;
}

export function mount(el, store, ctx) {
  el.innerHTML = `
    <div class="rp stack-lg">
      <div data-top></div>
      <section class="panel rp-panel">
        <h3 class="h-section">Enforcement preview</h3>
        <div data-preview></div>
      </section>
      <section class="panel rp-panel">
        <h3 class="h-section">What it learned</h3>
        <div data-learning></div>
      </section>
      <section class="panel rp-panel">
        <h3 class="h-section">Crawled pages</h3>
        <div data-pages></div>
      </section>
    </div>`;
  const top = el.querySelector('[data-top]');
  const pagesEl = el.querySelector('[data-pages]');

  // The preview and learning views keep their own state and behaviour; they just live inside the report now.
  import('./preview.js').then((m) => m.mount(el.querySelector('[data-preview]'), store, ctx)).catch((e) => console.error('preview failed', e));
  import('./learning.js').then((m) => m.mount(el.querySelector('[data-learning]'), store, ctx)).catch((e) => console.error('learning failed', e));

  function render() {
    const run = store.get();
    if (!run) { top.innerHTML = ''; pagesEl.innerHTML = ''; return; }
    const demo = run.mode === 'demo';
    const when = run.createdAt ? new Date(run.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    top.innerHTML = `
      <div class="stack-lg">
        <div class="view-head">
          <div>
            <h2 class="view-title">Report</h2>
            <p class="muted">${esc(run.site?.name || 'Your site')} · ${esc(LOCALE_LABEL[run.locale.source] ?? run.locale.source)} → ${esc(LOCALE_LABEL[run.locale.target] ?? run.locale.target)}${when ? ` · ${esc(when)}` : ''}</p>
          </div>
          <span class="run-tag ${demo ? 'is-sample' : 'is-live'}">${demo ? 'Sample run · fictional data' : 'Live run'}</span>
        </div>
        ${run.totals ? `<p class="subtle rp-scope">Whole-site figures, as in the header. The Queue, Auto-approved and Publish tabs work on a ${esc(sampleScope(run).replace(/^Sample/, 'sample'))}.</p>` : ''}
        ${summary(run)}
        <div class="panel rp-panel">${whereWent(run)}</div>
        <div class="panel rp-panel">${imported(run)}</div>
      </div>`;
    pagesEl.innerHTML = pages(run);
  }

  store.subscribe(render);
  render();
}
