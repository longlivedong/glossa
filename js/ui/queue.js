// The review queue: filterable list on the left, the review card on the right.
import { TIERS, TIER_LABEL, sortQueue, hint } from '../rules.js';
import { esc, tierBadge, confBar, statusBadge, fmtInt } from './dom.js';
import { createCard } from './card.js';

const WHY = 'Critical terms always come first, lowest confidence first. Everything else is ranked by tier weight × (1 − judge confidence) × log(1 + frequency on the site). You work down the list until the hours run out; below the line entries are auto-approved, stay visible, and 1% are sampled for a random check.';

export function mount(el, store, ctx) {
  el.innerHTML = `
    <div class="q-layout">
      <div class="q-list-col"><div class="q-list-inner" data-r="list"></div></div>
      <div class="q-card-col" data-r="card"></div>
    </div>`;
  const listEl = el.querySelector('[data-r="list"]');
  const cardEl = el.querySelector('[data-r="card"]');
  let whyOpen = false;
  let lastSelected = null;
  let order = [];

  const nav = {
    next(id) {
      const i = order.findIndex((c) => c.id === id);
      const rest = [...order.slice(i + 1), ...order.slice(0, Math.max(i, 0))];
      return rest.find((c) => c.status === 'pending' && c.id !== id)?.id ?? null;
    },
    step(id, d) {
      const i = order.findIndex((c) => c.id === id);
      return order[i + d]?.id ?? null;
    },
  };
  const card = createCard(cardEl, store, ctx, nav);

  const visible = () => {
    const run = store.get();
    const { tierFilter, showRandom } = store.ui();
    const keep = (c) => tierFilter === 'all' || c.tier === tierFilter;
    const main = sortQueue(run.concepts.filter((c) => c.bucket === 'queue' && keep(c)));
    const rc = showRandom ? sortQueue(run.concepts.filter((c) => c.bucket === 'random_check' && keep(c))) : [];
    return { main, rc };
  };

  const row = (c, sel) => `
    <li><button type="button" class="q-row" data-id="${esc(c.id)}" data-fk="row-${esc(c.id)}"${sel === c.id ? ' aria-current="true"' : ''}>
      <span class="q-row-top"><span class="q-term">${esc(c.source)}</span>${statusBadge(c.status) ? `<span class="q-status">${statusBadge(c.status)}</span>` : ''}</span>
      <span class="q-row-meta">${tierBadge(c.tier)}${confBar(c.confidence)}<span class="q-freq" title="Occurrences on the site">×${fmtInt(c.frequency)}</span>${(() => { const h = hint(c); return `<span class="hint-chip hint-${esc(h.key)}">${esc(h.label)}</span>`; })()}</span>
    </button></li>`;

  function render() {
    const run = store.get();
    if (!run) { listEl.innerHTML = ''; cardEl.innerHTML = ''; return; }
    const ui = store.ui();
    const { main, rc } = visible();
    order = [...main, ...rc];
    let sel = ui.selectedId;
    if (!order.some((c) => c.id === sel)) {
      sel = (order.find((c) => c.status === 'pending') || order[0])?.id ?? null;
      if (sel && sel !== ui.selectedId) { store.setUI({ selectedId: sel }); return; }
    }

    const act = document.activeElement;
    const fk = act && listEl.contains(act) ? act.dataset.fk : null;
    const pending = main.filter((c) => c.status === 'pending').length;
    listEl.innerHTML = `
      <div class="q-toolbar">
        <div class="q-chips" role="group" aria-label="Filter by tier">
          ${['all', ...TIERS].map((t) => `<button type="button" class="chip" data-tier="${t}" data-fk="tier-${t}" aria-pressed="${ui.tierFilter === t}">${t === 'all' ? 'All' : esc(TIER_LABEL[t].replace(' / DNT', ''))}</button>`).join('')}
        </div>
        <div class="q-tools row">
          <label class="q-toggle"><input type="checkbox" data-rc data-fk="rc"${ui.showRandom ? ' checked' : ''}> Show random check</label>
          <span class="q-why">
            <button type="button" class="linklike" data-why data-fk="why" aria-expanded="${whyOpen}" aria-controls="q-why-pop">Why this order?</button>
            <div class="popover" id="q-why-pop" role="dialog" aria-label="Why this order?"${whyOpen ? '' : ' hidden'}>${esc(WHY)}</div>
          </span>
        </div>
        <p class="subtle">${fmtInt(pending)} pending${ui.tierFilter !== 'all' ? ` · ${esc(TIER_LABEL[ui.tierFilter])} only` : ''}</p>
      </div>
      ${main.length ? `<ul class="q-rows">${main.map((c) => row(c, sel)).join('')}</ul>` : '<p class="empty">No entries match this filter.</p>'}
      ${ui.showRandom ? `<h3 class="q-section">Random check · sampled from auto-approved</h3>
        ${rc.length ? `<ul class="q-rows q-rows-rc">${rc.map((c) => row(c, sel)).join('')}</ul>` : '<p class="subtle q-empty-rc">No random-check items for this filter.</p>'}` : ''}`;
    if (fk) listEl.querySelector(`[data-fk="${fk}"]`)?.focus({ preventScroll: true });
    if (sel !== lastSelected) {
      listEl.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
      lastSelected = sel;
    }
    card.render(sel);
  }

  listEl.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tier]');
    if (t) { store.setUI({ tierFilter: t.dataset.tier }); return; }
    if (e.target.closest('[data-why]')) { whyOpen = !whyOpen; render(); return; }
    const r = e.target.closest('[data-id]');
    if (r) {
      store.setUI({ selectedId: r.dataset.id });
      if (window.matchMedia('(max-width: 819px)').matches) cardEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
  listEl.addEventListener('change', (e) => {
    if (e.target.matches('[data-rc]')) store.setUI({ showRandom: e.target.checked });
  });
  document.addEventListener('click', (e) => {
    if (whyOpen && !e.target.closest('.q-why')) { whyOpen = false; render(); }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && whyOpen) { whyOpen = false; render(); return; }
    if (store.ui().tab !== 'queue' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    const tag = e.target?.tagName;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || e.target?.isContentEditable) return;
    if (card.handleKey(e)) e.preventDefault();
  });

  store.subscribe(render);
  render();
}
