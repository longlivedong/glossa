// The hero: site and locale pair, one sentence with the budget numbers, and a slim bar. Built once, then updated in place.
import { LOCALE_LABEL } from '../schema.js';
import { headerCounts, computeLine } from '../rules.js';
import { fmtInt } from './dom.js';
import { growBar } from '../motion.js';

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function mount(el, store, ctx) {
  let built = false;
  let refs = {};

  const build = () => {
    el.innerHTML = `
      <div class="wrap hero">
        <p class="hero-id">
          <span class="hero-site" data-r="site"></span>
          <span class="run-tag is-sample" data-r="sampleTag">Fictional sample</span>
          <span class="hero-locale" data-r="locale"></span>
        </p>
        <p class="hero-line" data-r="budget">
          <span><strong data-r="auto"></strong> of <span data-r="total"></span> concepts approved automatically.</span>
          <span><strong class="hero-key" data-r="need"></strong> need you.</span>
          <span data-r="hours"></span>
        </p>
        <p class="hero-short" aria-hidden="true"><strong class="hero-key" data-r="needShort"></strong> need you<span data-r="hoursShort"></span></p>
        <div class="bb" role="img" data-r="bar">
          <span class="bb-seg bb-auto" data-r="segAuto"></span>
          <span class="bb-seg bb-need" data-r="segNeed"><span class="bb-done" data-r="segDone"></span></span>
        </div>
        <div class="hdr-live" data-r="live" hidden>
          <label for="hdr-hours">Linguist hours</label>
          <input type="range" id="hdr-hours" min="0.5" max="16" step="0.5" data-r="slider">
          <output for="hdr-hours" data-r="hoursOut"></output>
        </div>
        <p class="hdr-warn" role="status" data-r="warn" hidden></p>
      </div>`;
    refs = {};
    el.querySelectorAll('[data-r]').forEach((n) => { refs[n.dataset.r] = n; });
    refs.slider.addEventListener('input', () => store.setHours(Number(refs.slider.value)));
    built = true;
  };

  const render = () => {
    const run = store.get();
    if (!run) { el.innerHTML = ''; built = false; return; }
    if (!built) {
      build();
      // Grow the budget bar once, after this render has set the segment sizes.
      queueMicrotask(() => { growBar(refs.segAuto); growBar(refs.segNeed, { delay: 0.08 }); });
    }
    const h = headerCounts(run);
    const live = run.mode === 'live' || !run.totals;
    refs.site.textContent = run.site?.name || 'Your site';
    refs.sampleTag.hidden = !(run.mode === 'demo' && ctx?.mode === 'live'); // live server, sample still showing
    refs.locale.textContent = `${LOCALE_LABEL[run.locale.source] ?? run.locale.source} → ${LOCALE_LABEL[run.locale.target] ?? run.locale.target}`;
    refs.auto.textContent = fmtInt(h.auto);
    refs.total.textContent = fmtInt(h.total);
    refs.need.textContent = fmtInt(h.needYou);
    refs.hours.textContent = h.hours > 0 ? `${cap(h.hoursLabel)} at your pace.` : 'Nothing left above the line.';
    // Phones: one line; the full sentence above stays for screen readers (and is what desktop shows).
    refs.needShort.textContent = fmtInt(h.needYou);
    refs.hoursShort.textContent = h.hours > 0 ? ` · ${h.hoursLabel.replace(/ hours?$/, ' h')}` : '';

    // Slim bar: auto-approved vs needs you; the reviewed part of "needs you" fills in.
    const queueAll = h.needYou + h.reviewed;
    refs.segAuto.style.flexGrow = String(h.auto);
    refs.segNeed.style.flexGrow = String(queueAll);
    refs.segAuto.hidden = h.auto === 0;
    refs.segNeed.hidden = queueAll === 0;
    refs.segDone.style.width = `${queueAll ? Math.round((h.reviewed / queueAll) * 100) : 0}%`;
    refs.bar.setAttribute('aria-label', `${fmtInt(h.auto)} approved automatically, ${fmtInt(queueAll)} for a linguist, ${fmtInt(h.reviewed)} of them reviewed`);

    refs.live.hidden = !live;
    refs.warn.hidden = true;
    if (live) {
      const hours = run.budget.hours;
      if (document.activeElement !== refs.slider || Number(refs.slider.value) !== hours) refs.slider.value = String(hours);
      refs.hoursOut.textContent = `${hours} h = ${fmtInt(run.budget.capacity)} entries`;
      refs.slider.setAttribute('aria-valuetext', `${hours} ${hours === 1 ? 'hour' : 'hours'}, ${fmtInt(run.budget.capacity)} entries`);
      const over = computeLine(run.concepts, { capacity: run.budget.capacity, seed: run.id }).overBudget;
      refs.warn.hidden = !(over > 0);
      if (over > 0) refs.warn.textContent = `${fmtInt(over)} must-review ${over === 1 ? 'entry is' : 'entries are'} over this budget; they stay in the queue.`;
    }
  };

  store.subscribe(render);
  render();
}
