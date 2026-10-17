// The hero: site, locale pair, and the one-sentence budget line. Built once, then updated in place.
import { LOCALE_LABEL } from '../schema.js';
import { headerCounts, computeLine } from '../rules.js';
import { fmtInt } from './dom.js';

export function mount(el, store, ctx) {
  let built = false;
  let refs = {};

  const build = () => {
    el.innerHTML = `
      <div class="wrap hdr">
        <div class="hdr-top">
          <h1 class="hdr-site" data-r="site"></h1>
          <p class="hdr-locale" data-r="locale"></p>
        </div>
        <div class="hdr-budget" role="group" data-r="budget">
          <div class="hdr-stat"><span class="hdr-num" data-r="auto"></span><span class="hdr-cap" data-r="autoCap"></span></div>
          <span class="hdr-sep" aria-hidden="true">·</span>
          <div class="hdr-stat hdr-stat-key"><span class="hdr-num" data-r="need"></span><span class="hdr-cap">need you</span></div>
          <span class="hdr-sep" aria-hidden="true">·</span>
          <div class="hdr-stat"><span class="hdr-num hdr-num-sm" data-r="rc"></span><span class="hdr-cap">in the random check</span></div>
          <span class="hdr-sep" aria-hidden="true">·</span>
          <div class="hdr-stat"><span class="hdr-num hdr-num-sm" data-r="hours"></span><span class="hdr-cap" data-r="hoursCap"></span></div>
        </div>
        <div class="hdr-progress">
          <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" data-r="bar"><span></span></div>
          <p class="subtle" data-r="progLabel"></p>
        </div>
        <div class="hdr-live" data-r="live" hidden>
          <div class="hdr-slider">
            <label for="hdr-hours">Linguist hours for this locale</label>
            <div class="row hdr-slider-row">
              <input type="range" id="hdr-hours" min="0.5" max="16" step="0.5" data-r="slider">
              <output for="hdr-hours" data-r="hoursOut"></output>
            </div>
          </div>
          <p class="hdr-warn" role="status" data-r="warn" hidden></p>
          <p class="subtle" data-r="models"></p>
        </div>
      </div>`;
    refs = {};
    el.querySelectorAll('[data-r]').forEach((n) => { refs[n.dataset.r] = n; });
    refs.slider.addEventListener('input', () => store.setHours(Number(refs.slider.value)));
    built = true;
  };

  const render = () => {
    const run = store.get();
    if (!run) { el.innerHTML = ''; built = false; return; }
    if (!built) build();
    const h = headerCounts(run);
    const live = run.mode === 'live' || !run.totals;
    refs.site.textContent = run.site?.name || 'Your site';
    refs.locale.textContent = `${LOCALE_LABEL[run.locale.source] ?? run.locale.source} → ${LOCALE_LABEL[run.locale.target] ?? run.locale.target}`;
    refs.auto.textContent = fmtInt(h.auto);
    refs.autoCap.textContent = `of ${fmtInt(h.total)} concepts approved automatically`;
    refs.need.textContent = fmtInt(h.needYou);
    refs.rc.textContent = fmtInt(h.randomCheck);
    const lbl = h.hoursLabel;
    refs.hours.textContent = lbl;
    refs.hoursCap.textContent = h.hours > 0 ? 'at your pace' : 'above the line';
    const pctDone = Math.round(h.progress * 100);
    refs.bar.setAttribute('aria-valuenow', String(pctDone));
    refs.bar.setAttribute('aria-label', 'Queue reviewed');
    refs.bar.firstElementChild.style.width = `${pctDone}%`;
    if (live) {
      refs.progLabel.textContent = `${h.reviewed} of ${h.queueSize} reviewed`;
    } else {
      const cap = run.budget.capacity || run.budget.hours * run.budget.entriesPerHour;
      refs.progLabel.textContent = `Top of queue: ${h.reviewed} of ${h.queueSize} reviewed · budget ${run.budget.hours} h per locale = ${fmtInt(cap)} entries`;
    }

    refs.live.hidden = !live;
    if (live) {
      const hours = run.budget.hours;
      if (document.activeElement !== refs.slider || Number(refs.slider.value) !== hours) refs.slider.value = String(hours);
      refs.hoursOut.textContent = `${hours} h = ${fmtInt(run.budget.capacity)} entries`;
      const over = computeLine(run.concepts, { capacity: run.budget.capacity, seed: run.id }).overBudget;
      refs.warn.hidden = !(over > 0);
      if (over > 0) refs.warn.textContent = `Critical and other must-review entries exceed the budget by ${fmtInt(over)}; they are still listed.`;
      refs.models.textContent = run.models ? `Drafter: ${run.models.drafter} · Judge: ${run.models.judge}` : '';
      refs.models.hidden = !run.models;
    }
    refs.budget.setAttribute('aria-label', `${fmtInt(h.auto)} of ${fmtInt(h.total)} concepts approved automatically, ${fmtInt(h.needYou)} need you, ${fmtInt(h.randomCheck)} in the random check, ${lbl} at your pace`);
  };

  store.subscribe(render);
  render();
}
