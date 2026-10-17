// Step 8: enforcement preview. Shows how hard vs guidance terms behave on real site sentences.
import { esc, highlight } from './dom.js';
import { publishedEntries } from '../rules.js';

export function mount(el, store, ctx) {
  let busy = false;
  let error = '';
  let progressMsg = '';

  const chip = (t) => {
    if (t.found) return `<span class="pv-chip pv-used">✓ used (${esc(t.mode)})</span>`;
    return t.mode === 'hard'
      ? `<span class="pv-chip pv-miss">✗ missed (hard)</span>`
      : `<span class="pv-chip pv-skip">○ not used (guidance)</span>`;
  };

  const itemHtml = (it) => {
    const terms = it.terms || [];
    const retried = it.retried
      ? `<div class="pv-retry"><strong>First attempt missed a hard term → retried</strong>
          ${it.firstAttempt ? `<details><summary>Show first attempt</summary><p class="pv-first">${highlight(it.firstAttempt, terms.map((t) => t.expected))}</p></details>` : ''}
        </div>`
      : '';
    return `
      <article class="panel pv-item">
        <div class="pv-pair">
          <div><div class="section-title">Source</div><p>${highlight(it.source, terms.map((t) => t.source))}</p></div>
          <div><div class="section-title">Translation</div><p>${highlight(it.translation, terms.map((t) => t.expected))}</p></div>
        </div>
        <ul class="pv-terms">
          ${terms.map((t) => `<li><span class="pv-term">${esc(t.source)} → ${esc(t.expected)}</span> ${chip(t)}</li>`).join('')}
        </ul>
        ${retried}
      </article>`;
  };

  const render = () => {
    const run = store.get();
    const items = run?.preview;
    const live = ctx.mode === 'live';
    const hasPublished = run ? publishedEntries(run).published.length > 0 : false;
    let body;
    if (items?.length) {
      body = `${!live || run.mode === 'demo' ? '<p class="subtle">Precomputed in the sample run</p>' : ''}
        <div class="pv-list">${items.map(itemHtml).join('')}</div>`;
    } else if (!hasPublished) {
      body = `<p class="empty">Nothing has been published yet. Accept a few entries or let auto-approved ones through, then come back.</p>`;
    } else {
      body = `<p class="empty">${live ? 'No preview yet. Run it to translate a few site sentences with this glossary.' : 'No preview in this sample run.'}</p>`;
    }
    const canRun = live && run && run.mode === 'live' && hasPublished;
    el.innerHTML = `
      <div class="view-pad stack">
        <div class="row pv-head">
          <p class="pv-lede">Hard terms must appear in the translation; a miss is rejected and retried. Guidance terms are preferred, not forced.</p>
          ${live ? `<button type="button" class="btn btn-primary" data-run ${busy || !canRun ? 'disabled' : ''}>${busy ? 'Running…' : 'Run enforcement preview'}</button>` : ''}
        </div>
        ${live && run && run.mode !== 'live' ? '<p class="subtle">Run the pipeline on a website first; the preview uses its crawled sentences.</p>' : ''}
        ${busy ? `<p class="subtle" role="status"><span class="spinner" aria-hidden="true"></span> ${esc(progressMsg || 'Translating sample sentences…')}</p>` : ''}
        ${error ? `<p class="inline-error" role="alert">${esc(error)}</p>` : ''}
        ${body}
      </div>`;
  };

  el.addEventListener('click', async (e) => {
    if (!e.target.closest('[data-run]') || busy) return;
    busy = true; error = ''; progressMsg = '';
    render();
    try {
      const { runPreview } = await import('../pipeline.js');
      const items = await runPreview(store.get(), {
        onProgress: (evt) => {
          progressMsg = evt?.message || progressMsg;
          const p = el.querySelector('[role="status"]');
          if (p) p.lastChild.textContent = ` ${progressMsg}`;
        },
      });
      store.setPreview(items);
    } catch (err) {
      error = err?.message || 'The preview failed.';
    }
    busy = false;
    render();
  });

  store.subscribe(() => { if (!busy) render(); });
  render();
}
