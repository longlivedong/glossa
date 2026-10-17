// Auto-approved entries: visible, reversible, one click from the queue.
import { TIERS, headerCounts } from '../rules.js';
import { esc, tierBadge, confBar, fmtInt } from './dom.js';

const CAP = 300;
const modeLabel = (m) => (m === 'hard' ? 'Hard' : 'Guidance');

export function mount(el, store, ctx) {
  const row = (c) => `
    <li class="a-row">
      <div class="a-main">
        <span class="a-pair"><span class="a-src">${esc(c.source)}</span><span class="a-arrow" aria-hidden="true">→</span><span class="a-tgt">${esc(c.proposal.text)}</span></span>
        <span class="a-meta">${tierBadge(c.tier, c.tierReason)}${confBar(c.confidence)}<span class="a-enf">${modeLabel(c.enforcement)}</span>${c.bucket === 'random_check' ? '<span class="hint-chip hint-random_check">in random check</span>' : ''}</span>
      </div>
      <button type="button" class="btn btn-sm" data-reopen="${esc(c.id)}" aria-label="Reopen ${esc(c.source)}">Reopen</button>
    </li>`;

  function render() {
    const run = store.get();
    if (!run) { el.innerHTML = ''; return; }
    const items = run.concepts.filter((c) => c.bucket !== 'queue');
    const rank = (c) => TIERS.indexOf(c.tier);
    items.sort((a, b) => rank(a) - rank(b) || a.confidence - b.confidence || a.id.localeCompare(b.id));
    const low = items.filter((c) => c.tier === 'low');
    const main = items.filter((c) => c.tier !== 'low');
    const h = headerCounts(run);
    const note = run.totals ? `Showing ${fmtInt(items.length)} of ${fmtInt(h.auto)} auto-approved` : `${fmtInt(items.length)} auto-approved`;
    const shown = main.slice(0, CAP);
    el.innerHTML = `
      <div class="a-wrap stack">
        <div>
          <h2 class="view-title">Auto-approved</h2>
          <p class="muted">Approved without a human. Visible, reversible, and 1% sampled for a random check.</p>
          <p class="subtle">${esc(note)}</p>
        </div>
        ${shown.length ? `<ul class="a-list panel">${shown.map(row).join('')}</ul>` : '<p class="empty panel">Nothing is auto-approved in this run.</p>'}
        ${main.length > CAP ? `<p class="subtle">Showing the first ${CAP} of ${fmtInt(main.length)}.</p>` : ''}
        ${low.length ? `<section class="a-dnt">
          <h3 class="section-title">Do-not-translate summary</h3>
          <p class="muted">Low-tier entries (names, codes, terms that stay as written) are summarised here rather than listed one by one.</p>
          <ul class="a-list panel">${low.slice(0, CAP).map(row).join('')}</ul>
        </section>` : ''}
      </div>`;
  }

  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-reopen]');
    if (!b) return;
    const id = b.dataset.reopen;
    const c = store.concept(id);
    if (!c) return;
    store.reopen(id);
    ctx.toast(`Reopened “${c.source}”: now in your queue`, {
      actionLabel: 'Undo',
      onAction: () => store.undo(id),
    });
  });

  store.subscribe(render);
  render();
}
