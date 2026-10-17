// Pipeline progress: a vertical step list showing which steps are code and which are model calls.
import { esc, fmtInt } from './dom.js';

const STEPS = [
  { id: 'crawl', label: 'Crawl pages', who: 'Code', kind: 'code' },
  { id: 'extract', label: 'Extract terms', who: 'LLM: Drafter', kind: 'llm' },
  { id: 'cluster', label: 'Cluster variants', who: 'LLM: Drafter', kind: 'llm' },
  { id: 'draft', label: 'Draft renderings ×3', who: 'LLM: Drafter', kind: 'llm' },
  { id: 'sibling', label: 'Draft sibling locale', who: 'LLM: Drafter', kind: 'llm' },
  { id: 'judge', label: 'Judge confidence', who: 'LLM: Judge', kind: 'llm' },
  { id: 'line', label: 'Draw the line', who: 'Code', kind: 'code' },
];

const STATUS_TEXT = { waiting: 'Waiting', running: 'Running', done: 'Done ✓', error: 'Error ✗' };

export function createProgress(el) {
  const state = Object.fromEntries(STEPS.map((s) => [s.id, { status: 'waiting', done: 0, total: 0, message: '' }]));
  let usage = null;
  let banner = '';

  el.classList.add('progress-view');
  el.innerHTML = `
    <ol class="steps" aria-label="Pipeline steps">
      ${STEPS.map((s) => `
        <li class="step" data-step="${s.id}" data-status="waiting">
          <span class="step-dot" aria-hidden="true"></span>
          <div class="step-body">
            <div class="step-head">
              <span class="step-label">${esc(s.label)}</span>
              <span class="who who-${s.kind}">${esc(s.who)}</span>
              <span class="step-status"></span>
            </div>
            <div class="step-bar" hidden><div class="progress"><span></span></div></div>
            <div class="step-msg subtle"></div>
          </div>
        </li>`).join('')}
    </ol>
    <div class="progress-banner" role="status" aria-live="polite" hidden></div>
    <div class="progress-foot subtle" aria-live="off"></div>
    <p class="subtle progress-caption">A fixed pipeline: each model call does one job; code decides who sees what.</p>`;

  const paintStep = (id) => {
    const s = state[id];
    const li = el.querySelector(`[data-step="${id}"]`);
    if (!li) return;
    li.dataset.status = s.status;
    let text = STATUS_TEXT[s.status];
    if (s.status === 'running' && s.total) text += ` ${fmtInt(s.done)}/${fmtInt(s.total)}`;
    li.querySelector('.step-status').textContent = text;
    li.querySelector('.step-msg').textContent = s.message || '';
    const bar = li.querySelector('.step-bar');
    bar.hidden = !(s.status === 'running' && s.total);
    if (!bar.hidden) bar.firstElementChild.firstElementChild.style.width = `${Math.min(100, Math.round((s.done / s.total) * 100))}%`;
  };

  const paintFoot = () => {
    const foot = el.querySelector('.progress-foot');
    if (!usage) { foot.textContent = ''; return; }
    const tokens = (usage.promptTokens || 0) + (usage.completionTokens || 0);
    foot.textContent = `${fmtInt(usage.calls || 0)} model calls · ${fmtInt(tokens)} tokens`;
  };

  const paintBanner = (text, cls) => {
    const b = el.querySelector('.progress-banner');
    b.hidden = !text;
    b.className = `progress-banner ${cls || ''}`;
    b.textContent = text || '';
  };

  STEPS.forEach((s) => paintStep(s.id));

  return {
    update(evt) {
      const s = state[evt?.step];
      if (!s) return;
      if (evt.usage) usage = evt.usage;
      // Earlier steps that never reported (e.g. skipped sibling or resumed from cache) count as finished.
      const idx = STEPS.findIndex((x) => x.id === evt.step);
      STEPS.slice(0, idx).forEach((p) => {
        if (state[p.id].status === 'waiting' || state[p.id].status === 'running') { state[p.id].status = 'done'; paintStep(p.id); }
      });
      s.status = evt.status === 'done' ? 'done' : evt.status === 'error' ? 'error' : 'running';
      if (evt.total != null) s.total = evt.total;
      if (evt.done != null) s.done = evt.done;
      if (evt.status === 'done' && s.total) s.done = s.total;
      if (evt.message != null) s.message = evt.message;
      paintStep(evt.step);
      paintFoot();
    },
    done(summary) {
      STEPS.forEach((s) => { if (state[s.id].status !== 'error') { state[s.id].status = 'done'; paintStep(s.id); } });
      paintBanner(summary || 'Run complete.', 'is-ok');
    },
    error(message) {
      STEPS.forEach((s) => {
        if (state[s.id].status === 'running') { state[s.id].status = 'error'; paintStep(s.id); }
      });
      paintBanner(message || 'Something went wrong.', 'is-error');
    },
  };
}
