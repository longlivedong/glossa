// The review card: everything a linguist needs for one entry, plus the four actions.
import { REJECT_REASONS, SCOPE_LABEL, LOCALE_LABEL } from '../schema.js';
import { importDisagrees } from '../rules.js';
import { esc, highlight, tierBadge, confBar, statusBadge, fmtInt } from './dom.js';

const q = (s) => `“${s}”`;
const TYPE_LABEL = (t) => (t || '').replace(/_/g, ' ');

function check(label, v) {
  const [cls, glyph, word] = v === true ? ['yes', '✓', 'yes'] : v === false ? ['no', '✗', 'no'] : ['na', '—', 'n/a'];
  return `<li class="chk chk-${cls}"><span class="chk-mark" aria-hidden="true">${glyph}</span><span class="chk-label">${esc(label)}</span><span class="chk-word">${v == null ? '—, n/a' : `<span class="visually-hidden">${word}</span>`}</span></li>`;
}

/**
 * @param {HTMLElement} el
 * @param {{ next: (id: string) => string|null, step: (id: string, d: number) => string|null }} nav
 */
export function createCard(el, store, ctx, nav) {
  let st = { id: null, mode: null, newText: '', reason: 'wrong_meaning', note: '', question: '' };
  let lastSig = '';

  const syncDraft = () => {
    const g = (sel) => el.querySelector(sel);
    if (g('[name="newText"]')) st.newText = g('[name="newText"]').value;
    if (g('[name="note"]')) st.note = g('[name="note"]').value;
    if (g('[name="question"]')) st.question = g('[name="question"]').value;
    const r = el.querySelector('[name="reason"]:checked');
    if (r) st.reason = r.value;
  };

  const setMode = (mode, c) => {
    syncDraft();
    st.mode = mode;
    if (mode === 'edit' && !st.newText) st.newText = c.proposal.text;
    if (mode === 'ask') st.question = `Should ${q(c.source)} stay in English for ${LOCALE_LABEL[store.get().locale.target] ?? store.get().locale.target}?`;
    if (mode === 'reject') { st.reason = 'wrong_meaning'; st.note = ''; }
    lastSig = '';
    render(c.id, true);
  };

  const finish = (c, action, payload, message) => {
    const id = c.id;
    const upcoming = nav.next(id);
    const escalate = c.tier === 'critical' && (action === 'edit' || action === 'reject');
    store.act(id, action, payload);
    st = { id: null, mode: null, newText: '', reason: 'wrong_meaning', note: '', question: '' };
    ctx.toast(escalate ? `Escalated ${q(c.source)}: second linguist, then locale lead` : message, {
      actionLabel: 'Undo',
      onAction: () => { store.undo(id); store.setUI({ selectedId: id }); },
    });
    if (upcoming) store.setUI({ selectedId: upcoming });
  };

  const doEdit = (c, applyToConcept) => {
    const newText = st.newText.trim();
    finish(c, 'edit', { newText, applyToConcept }, `Edited ${q(c.source)}`);
  };

  function decidedLine(c) {
    const d = c.decision || {};
    if (c.status === 'edited') return ` \u00B7 ${d.applyToConcept ? `applied to ${d.variantCount} forms` : 'this form only'}${d.previousText ? ` \u00B7 was ${q(d.previousText)}` : ''}`;
    if (c.status === 'rejected') return `: ${REJECT_REASONS.find((r) => r[0] === d.reason)?.[1] ?? d.reason ?? ''}${d.note ? ` \u00B7 ${d.note}` : ''}`;
    if (c.status === 'asked_client') return `: ${d.question || ''}`;
    if (c.status === 'escalated') return '. You overrode the drafter on a Critical term.';
    return '';
  }

  function actionArea(c) {
    if (c.status !== 'pending') {
      return `<div class="card-status" role="status">
        <div>${statusBadge(c.status)}<span class="card-status-detail">${esc(decidedLine(c))}</span></div>
        ${store.canUndo(c.id) ? '<button type="button" class="linklike" data-act="undo" data-fk="undo">Undo</button>' : ''}
      </div>`;
    }
    if (st.mode === 'edit') {
      return `<form class="card-form" data-form="edit">
        <label for="f-edit">Your rendering</label>
        <input type="text" id="f-edit" name="newText" value="${esc(st.newText)}" autocomplete="off" data-autofocus>
        <div class="row"><button type="submit" class="btn btn-primary btn-sm">Save</button><button type="button" class="btn btn-sm" data-act="cancel">Cancel</button></div>
      </form>`;
    }
    if (st.mode === 'apply') {
      const n = c.variants.length + 1;
      return `<div class="card-form" role="group" aria-label="Apply edit">
        <p>Apply to all ${n} forms of this concept?</p>
        <p class="subtle">${esc([c.source, ...c.variants].join(', '))}</p>
        <div class="row"><button type="button" class="btn btn-primary btn-sm" data-act="apply-yes" data-autofocus>Yes, all ${n}</button><button type="button" class="btn btn-sm" data-act="apply-no">No, just this form</button></div>
      </div>`;
    }
    if (st.mode === 'reject') {
      return `<form class="card-form" data-form="reject">
        <fieldset class="reasons"><legend>Why?</legend>
          ${REJECT_REASONS.map(([k, l], i) => `<label class="radio"><input type="radio" name="reason" value="${k}"${st.reason === k ? ' checked' : ''}${i === 0 ? ' data-autofocus' : ''}> ${esc(l)}</label>`).join('')}
        </fieldset>
        ${st.reason === 'other' ? `<input type="text" name="note" value="${esc(st.note)}" placeholder="Add a short note" aria-label="Note" autocomplete="off">` : ''}
        <div class="row"><button type="submit" class="btn btn-primary btn-sm">Confirm reject</button><button type="button" class="btn btn-sm" data-act="cancel">Cancel</button></div>
      </form>`;
    }
    if (st.mode === 'ask') {
      return `<form class="card-form" data-form="ask">
        <label for="f-ask">Question for the client</label>
        <input type="text" id="f-ask" name="question" value="${esc(st.question)}" autocomplete="off" data-autofocus>
        <div class="row"><button type="submit" class="btn btn-primary btn-sm">Send</button><button type="button" class="btn btn-sm" data-act="cancel">Cancel</button></div>
      </form>`;
    }
    return `<div class="card-actions" role="group" aria-label="Decide">
      <button type="button" class="btn btn-primary" data-act="accept" data-fk="a-accept">Accept <kbd>A</kbd></button>
      <button type="button" class="btn" data-act="edit" data-fk="a-edit">Edit <kbd>E</kbd></button>
      <button type="button" class="btn" data-act="reject" data-fk="a-reject">Reject <kbd>R</kbd></button>
      <button type="button" class="btn" data-act="ask" data-fk="a-ask">Ask client <kbd>C</kbd></button>
    </div>`;
  }

  function html(c) {
    const run = store.get();
    const terms = [c.source, ...c.variants];
    const sibLabel = c.sibling ? (LOCALE_LABEL[c.sibling.locale] ?? c.sibling.locale) : '';
    const dis = importDisagrees(c);
    const ck = c.judgeChecks;
    return `
    <article class="card panel" aria-label="Review ${esc(c.source)}">
      <header class="card-head">
        <div class="card-title">
          <h2 class="card-term">${esc(c.source)}</h2>
          ${c.variants.length ? `<p class="subtle">also: ${esc(c.variants.join(', '))}</p>` : ''}
        </div>
        <div class="card-meta">
          <span class="tip-wrap">${tierBadge(c.tier, c.tierReason)}${c.tierReason ? `<span class="tip" role="tooltip">${esc(c.tierReason)}</span>` : ''}</span>
          <span class="meta-item">${esc(TYPE_LABEL(c.termType))}</span>
          <span class="meta-item">×${fmtInt(c.frequency)} on the site</span>
        </div>
      </header>
      <div class="card-grid">
        <section class="card-propose" aria-label="Drafter proposal">
          <h3 class="section-title">Drafter proposes</h3>
          <p class="card-proposal">${esc(c.proposal.text)}</p>
          <p class="muted card-reason">${esc(c.proposal.reason)}</p>
          <p class="card-conf"><span class="subtle">Judge confidence</span> ${confBar(c.confidence)}</p>
        </section>
        <section class="card-judge" aria-label="Judge checks">
          <h3 class="section-title">Judge checks</h3>
          <ul class="checks">
            ${check('Import agrees', ck.importedAgrees)}${check('Sibling agrees', ck.siblingAgrees)}${check('Style fit', ck.styleFit)}${check('Self-consistent', ck.selfConsistent)}
          </ul>
          ${c.judgeOwn && ck.blindAgrees === false ? `<p class="card-note">Judge would write: <strong>${esc(c.judgeOwn)}</strong></p>` : ''}
          ${ck.clearMeaning === false ? `<p class="card-note">Judge: meaning is ambiguous in context</p>` : ''}
          ${c.judgeNote ? `<p class="muted card-note">${esc(c.judgeNote)}</p>` : ''}
        </section>
      </div>
      <section class="card-context" aria-label="Context">
        <h3 class="section-title">In context</h3>
        <ul>${c.context.slice(0, 3).map((s) => `<li>${highlight(s, terms)}</li>`).join('')}</ul>
      </section>
      ${c.sibling || c.imported ? `<div class="card-refs">
        ${c.sibling ? `<div class="ref"><span class="ref-label">${esc(sibLabel)} chose:</span> <strong>${esc(c.sibling.text)}</strong></div>` : ''}
        ${c.imported ? `<div class="ref${dis ? ' ref-warn' : ''}"><span class="ref-label">Imported glossary says:</span> <strong>${esc(c.imported.text)}</strong>${dis ? ' <span class="ref-flag">disagrees with the drafter</span>' : ''}</div>` : ''}
      </div>` : ''}
      <div class="card-enf row">
        <span class="subtle">Enforce as</span>
        <span class="segmented" role="group" aria-label="Enforcement">
          <button type="button" data-enf="hard" data-fk="enf-hard" aria-pressed="${c.enforcement === 'hard'}">Hard</button>
          <button type="button" data-enf="guidance" data-fk="enf-guidance" aria-pressed="${c.enforcement === 'guidance'}">Guidance</button>
        </span>
        <label class="visually-hidden" for="f-scope">Scope</label>
        <select id="f-scope" class="scope-select" data-fk="scope">
          ${Object.entries(SCOPE_LABEL).map(([k, l]) => `<option value="${k}"${c.scope === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}
        </select>
      </div>
      <div class="card-act">${actionArea(c)}</div>
    </article>`;
  }

  function render(id, force = false) {
    const c = id ? store.concept(id) : null;
    if (!c) {
      el.innerHTML = '<div class="panel card-empty"><h2>Queue clear</h2><p class="muted">Nothing left to review in this view. Check the Auto-approved tab, or clear a filter.</p></div>';
      lastSig = '';
      st.id = null;
      return;
    }
    if (st.id !== c.id) st = { id: c.id, mode: null, newText: '', reason: 'wrong_meaning', note: '', question: '' };
    else if (!force) syncDraft();
    const sig = JSON.stringify([c, st.mode, st.reason]);
    const inside = el.contains(document.activeElement) && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (sig === lastSig && inside) return;
    const fk = document.activeElement && el.contains(document.activeElement) ? document.activeElement.dataset.fk : null;
    lastSig = sig;
    el.innerHTML = html(c);
    const target = el.querySelector('[data-autofocus]') || (fk && el.querySelector(`[data-fk="${fk}"]`));
    if (target) {
      target.focus();
      if (target.matches('input[type="text"]')) target.setSelectionRange(target.value.length, target.value.length);
    }
  }

  el.addEventListener('click', (e) => {
    const c = store.concept(st.id);
    if (!c) return;
    const enf = e.target.closest('[data-enf]');
    if (enf) { store.setEnforcement(c.id, enf.dataset.enf); return; }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'accept') finish(c, 'accept', {}, `Accepted ${q(c.source)}`);
    else if (act === 'edit' || act === 'reject' || act === 'ask') setMode(act, c);
    else if (act === 'cancel') { st.mode = null; lastSig = ''; render(c.id, true); }
    else if (act === 'apply-yes') doEdit(c, true);
    else if (act === 'apply-no') doEdit(c, false);
    else if (act === 'undo') { store.undo(c.id); }
  });

  el.addEventListener('change', (e) => {
    const c = store.concept(st.id);
    if (!c) return;
    if (e.target.id === 'f-scope') store.setScope(c.id, e.target.value);
    else if (e.target.name === 'reason') { st.reason = e.target.value; syncDraft(); lastSig = ''; render(c.id, true); const n = el.querySelector('[name="note"]'); if (n && st.reason === 'other') n.focus(); }
  });

  el.addEventListener('submit', (e) => {
    e.preventDefault();
    const c = store.concept(st.id);
    if (!c) return;
    syncDraft();
    const kind = e.target.dataset.form;
    if (kind === 'edit') {
      if (!st.newText.trim()) return;
      if (c.variants.length) { st.mode = 'apply'; lastSig = ''; render(c.id, true); } else doEdit(c, false);
    } else if (kind === 'reject') {
      finish(c, 'reject', { reason: st.reason, note: st.reason === 'other' ? st.note : '' }, `Rejected ${q(c.source)}`);
    } else if (kind === 'ask') {
      if (!st.question.trim()) return;
      finish(c, 'ask_client', { question: st.question.trim() }, `Question sent to the client about ${q(c.source)}`);
    }
  });

  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && st.mode) { const c = store.concept(st.id); st.mode = null; lastSig = ''; if (c) render(c.id, true); }
  });

  /** Shortcut handler, called by the queue view. Returns true when the key was used. */
  function handleKey(e) {
    const c = store.concept(st.id);
    if (!c) return false;
    const k = e.key.toLowerCase();
    if (k === 'arrowright' || k === 'arrowleft') {
      const to = nav.step(c.id, k === 'arrowright' ? 1 : -1);
      if (to) store.setUI({ selectedId: to });
      return true;
    }
    if (c.status !== 'pending' || st.mode) return false;
    if (k === 'a') finish(c, 'accept', {}, `Accepted ${q(c.source)}`);
    else if (k === 'e') setMode('edit', c);
    else if (k === 'r') setMode('reject', c);
    else if (k === 'c') setMode('ask', c);
    else return false;
    return true;
  }

  return { render, handleKey };
}
