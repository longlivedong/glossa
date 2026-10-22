// The review queue: filterable list on the left, the review card on the right.
// Phones show the list, or one card in its place with a slim back / position / previous-next bar (ctx.isDetail).
import { TIERS, TIER_LABEL, sortQueue, hint, headerCounts } from '../rules.js';
import { esc, tierBadge, statusBadge, fmtInt, pct, sampleScope } from './dom.js';
import { createCard } from './card.js';

const WHY_PLAIN = 'Critical terms come first. After them come the entries most likely to be wrong and most often seen on the site. You work down the list until your hours run out. Everything below that line is approved automatically, stays visible in Auto-approved, and 1% of it is sampled for a random check.';
const WHY_FORMULA = 'The ranking: tier weight × (1 − judge confidence) × log(1 + frequency on the site). Critical terms are sorted lowest confidence first.';

export function mount(el, store, ctx) {
  el.innerHTML = `
    <h2 class="visually-hidden">Review queue</h2>
    <div class="q-layout">
      <div class="q-list-col"><div class="q-list-inner" data-r="list"></div></div>
      <div class="q-card-col">
        <div class="q-dbar" data-r="dbar">
          <button type="button" class="q-back" data-back aria-label="Back to the queue"><span aria-hidden="true">←</span> Queue</button>
          <span class="q-pos" data-r="pos"></span>
          <span class="q-steps">
            <button type="button" class="q-step" data-step="-1" aria-label="Previous entry"><svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false"><path d="M12.5 4.5 7 10l5.5 5.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
            <button type="button" class="q-step" data-step="1" aria-label="Next entry"><svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false"><path d="M7.5 4.5 13 10l-5.5 5.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
          </span>
        </div>
        <div data-r="card"></div>
      </div>
    </div>`;
  const layoutEl = el.querySelector('.q-layout');
  const listEl = el.querySelector('[data-r="list"]');
  const cardEl = el.querySelector('[data-r="card"]');
  const dbarEl = el.querySelector('[data-r="dbar"]');
  const posEl = el.querySelector('[data-r="pos"]');
  let whyOpen = false;
  let lastSelected = null;
  let order = [];
  let listScroll = 0;
  let detailSel = null;
  const isDetail = () => !!ctx.isDetail?.() && store.ui().tab === 'queue';

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

  // Roving tabindex: only the selected row is a Tab stop; ↑/↓ (and J/K) move the selection.
  const row = (c, sel, lang) => `
    <li><button type="button" class="q-row" data-id="${esc(c.id)}" data-fk="row-${esc(c.id)}" tabindex="${sel === c.id ? 0 : -1}"${sel === c.id ? ' aria-current="true"' : ''}>
      <span class="q-row-top"><span class="q-term">${esc(c.source)}</span><span class="q-row-end">${statusBadge(c.status) ? `<span class="q-status">${statusBadge(c.status)}</span>` : ''}<span class="q-row-conf"><span class="visually-hidden">judge confidence </span>${pct(c.confidence)}</span></span></span>
      <span class="q-row-proposal" lang="${esc(lang)}">${esc(c.proposal.text)}</span>
      <span class="q-row-meta">${tierBadge(c.tier)}${(() => { const h = hint(c); return h.key === 'critical' ? '' : `<span class="hint-chip hint-${esc(h.key)}">${esc(h.label)}</span>`; })()}</span>
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
    const chipsScroll = listEl.querySelector('.q-chips')?.scrollLeft || 0;
    const onRow = !!fk && act.classList.contains('q-row');
    const pending = main.filter((c) => c.status === 'pending').length;
    const scope = sampleScope(run, 'queue');
    const lang = run.locale?.target || '';
    listEl.innerHTML = `
      <div class="q-toolbar">
        <div class="q-chips" role="group" aria-label="Filter by tier">
          ${['all', ...TIERS].map((t) => `<button type="button" class="chip" data-tier="${t}" data-fk="tier-${t}" aria-pressed="${ui.tierFilter === t}">${t === 'all' ? 'All' : esc(TIER_LABEL[t].replace(' / DNT', ''))}</button>`).join('')}
        </div>
        <div class="q-tools row">
          <label class="q-toggle"><input type="checkbox" data-rc data-fk="rc"${ui.showRandom ? ' checked' : ''}> Show random check</label>
          <span class="q-why">
            <button type="button" class="linklike" data-why data-fk="why" aria-expanded="${whyOpen}" aria-controls="q-why-pop">Why this order?</button>
            <div class="popover q-why-pop" id="q-why-pop" role="dialog" aria-label="Why this order?" aria-describedby="q-why-text"${whyOpen ? '' : ' hidden'}>
              <div id="q-why-text"><p>${esc(WHY_PLAIN)}</p><p class="q-why-formula">${esc(WHY_FORMULA)}</p></div>
              <button type="button" class="btn btn-sm q-why-close" data-why-close data-fk="why-close">Close</button>
            </div>
          </span>
        </div>
        <p class="subtle q-scope">${fmtInt(pending)} pending${scope ? ` · a sample of the ${fmtInt(headerCounts(run).needYou)} that need you` : ''}${ui.tierFilter !== 'all' ? ` · ${esc(TIER_LABEL[ui.tierFilter])} only` : ''}</p>
      </div>
      ${main.length ? `<ul class="q-rows">${main.map((c) => row(c, sel, lang)).join('')}</ul>` : '<p class="empty">No entries match this filter.</p>'}
      ${ui.showRandom ? `<h3 class="q-section">Random check · sampled from auto-approved</h3>
        ${rc.length ? `<ul class="q-rows q-rows-rc">${rc.map((c) => row(c, sel, lang)).join('')}</ul>` : '<p class="subtle q-empty-rc">No random-check items for this filter.</p>'}` : ''}`;
    // Focus follows the selection when it was on a row, so the two never drift apart (A, ↑/↓, click).
    const chips = listEl.querySelector('.q-chips');
    chips.scrollLeft = chipsScroll;
    fadeChips(chips);

    const detail = isDetail() && !!sel;
    const wasDetail = layoutEl.classList.contains('is-detail');
    layoutEl.classList.toggle('is-detail', detail);
    document.body.classList.toggle('q-detail-on', detail);
    const selRow = listEl.querySelector('.q-row[aria-current="true"]');
    if (onRow && selRow && !detail) selRow.focus({ preventScroll: true });
    else if (fk && !detail) listEl.querySelector(`[data-fk="${fk}"]`)?.focus({ preventScroll: true });
    if (sel !== lastSelected) {
      // Phones scroll the page, not the list: don't jump down to a stored selection on first load.
      if (!detail && !(ctx.narrow?.matches && lastSelected === null)) selRow?.scrollIntoView({ block: 'nearest' });
      lastSelected = sel;
    }
    card.render(sel);

    if (detail) {
      const i = order.findIndex((c) => c.id === sel);
      posEl.textContent = `${fmtInt(i + 1)} of ${fmtInt(order.length)}`;
      dbarEl.querySelector('[data-step="-1"]').setAttribute('aria-disabled', String(i <= 0));
      dbarEl.querySelector('[data-step="1"]').setAttribute('aria-disabled', String(i >= order.length - 1));
      // The bar is sticky, so scroll its column (the card's top) to the top of the screen.
      if (!wasDetail || sel !== detailSel) window.scrollTo(0, Math.max(0, dbarEl.parentElement.getBoundingClientRect().top + window.scrollY - 10));
      if (!wasDetail && (onRow || !el.contains(document.activeElement))) dbarEl.querySelector('[data-back]').focus({ preventScroll: true });
      detailSel = sel;
    } else if (wasDetail && store.ui().tab === 'queue') {
      // Back to the list where it was, with focus on the entry just reviewed.
      window.scrollTo(0, listScroll);
      if (selRow) {
        selRow.focus({ preventScroll: true });
        const r = selRow.getBoundingClientRect();
        if (r.top < 56 || r.bottom > window.innerHeight) selRow.scrollIntoView({ block: 'center' });
      }
      detailSel = null;
    } else detailSel = null;
  }

  // Phone filter chips scroll sideways; fade the right edge only while more chips are off-screen.
  const fadeChips = (chips) => {
    if (!chips) return;
    chips.classList.toggle('is-clipped', chips.scrollWidth - chips.clientWidth - chips.scrollLeft > 2);
  };
  listEl.addEventListener('scroll', (e) => { if (e.target.matches?.('.q-chips')) fadeChips(e.target); }, true);
  window.addEventListener('resize', () => fadeChips(listEl.querySelector('.q-chips')));

  dbarEl.addEventListener('click', (e) => {
    if (e.target.closest('[data-back]')) { ctx.closeDetail?.(); return; }
    const b = e.target.closest('[data-step]');
    if (!b || b.getAttribute('aria-disabled') === 'true') return;
    const to = nav.step(store.ui().selectedId, Number(b.dataset.step));
    if (to) store.setUI({ selectedId: to });
  });

  listEl.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tier]');
    if (t) { store.setUI({ tierFilter: t.dataset.tier }); return; }
    if (e.target.closest('[data-why-close]')) { closeWhy(true); return; }
    if (e.target.closest('[data-why]')) { if (whyOpen) closeWhy(true); else openWhy(); return; }
    const r = e.target.closest('[data-id]');
    if (r) {
      if (ctx.narrow?.matches && ctx.openDetail) { listScroll = window.scrollY; ctx.openDetail(r.dataset.id); }
      else store.setUI({ selectedId: r.dataset.id });
    }
  });
  listEl.addEventListener('change', (e) => {
    if (e.target.matches('[data-rc]')) store.setUI({ showRandom: e.target.checked });
  });
  function openWhy() {
    whyOpen = true;
    render();
    listEl.querySelector('[data-why-close]')?.focus();
  }
  function closeWhy(returnFocus) {
    whyOpen = false;
    render();
    if (returnFocus) listEl.querySelector('[data-why]')?.focus();
  }

  document.addEventListener('click', (e) => {
    if (whyOpen && !e.target.closest('.q-why')) closeWhy(false);
  });

  // Home/End jump within the list when a row has focus.
  listEl.addEventListener('keydown', (e) => {
    if (!e.target.closest?.('.q-row') || (e.key !== 'Home' && e.key !== 'End')) return;
    const to = (e.key === 'Home' ? order[0] : order[order.length - 1])?.id;
    if (to) { e.preventDefault(); store.setUI({ selectedId: to }); }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && whyOpen) { closeWhy(!!e.target.closest?.('.q-why')); return; }
    if (e.defaultPrevented || store.ui().tab !== 'queue' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    const tag = e.target?.tagName;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || e.target?.isContentEditable) return;
    if (e.target.closest?.('[role="tablist"], .popover, footer')) return;
    if (e.key === 'Escape' && isDetail()) { e.preventDefault(); ctx.closeDetail(); return; }
    // Phone list: the card is out of sight, so only moving and undo work; Enter on a row opens it.
    if (ctx.narrow?.matches && !isDetail() && /^[aerc]$/i.test(e.key)) return;
    if (card.handleKey(e)) e.preventDefault();
  });

  store.subscribe(render);
  render();
}
