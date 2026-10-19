// What it learned: override rates by tier and term type, judge calibration, and the loop in one line.
import { esc, pct } from './dom.js';
import { learningStats, TIER_LABEL } from '../rules.js';

const MOVE = {
  lower: (k) => `↓ lower the line: auto-approve more ${k} next time`,
  raise: (k) => `↑ raise the line: review more ${k}`,
  hold: () => 'Hold: not enough decisions yet',
  floor: () => 'Hold: Critical entries are always reviewed',
};

const table = (title, rows, labelOf) => `
  <div class="lr-block">
    <h4 class="lr-sub">${esc(title)}</h4>
    <div class="table-scroll">
      <table class="pt lr-t">
        <thead><tr><th scope="col">${esc(title.replace('By ', ''))}</th><th scope="col">Decided</th><th scope="col">Override rate</th><th scope="col">The move</th></tr></thead>
        <tbody>
          ${rows.map((r) => {
            const label = labelOf(r.key);
            return `<tr>
              <th scope="row">${esc(label)}</th>
              <td>${r.decided}</td>
              <td><span class="lr-rate"><span class="lr-bar"><span style="width:${pct(r.overrideRate)}"></span></span>${pct(r.overrideRate)}</span></td>
              <td class="lr-move lr-${esc(r.move)}">${esc(MOVE[r.move](label.toLowerCase()))}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
  </div>`;

function calibration(s) {
  const a = s.avgConfidenceAccepted;
  const o = s.avgConfidenceOverridden;
  if (a == null || o == null) return 'Judge calibration needs at least one accepted and one overridden entry to compare.';
  let reading = 'The judge was about equally sure about both groups.';
  if (a - o > 0.02) reading = 'The judge was less sure about the entries linguists changed.';
  else if (o - a > 0.02) reading = 'The judge was more sure about the entries linguists changed: it is overconfident here, so recalibrate.';
  return `Judge confidence averaged ${pct(a)} on accepted entries and ${pct(o)} on overridden ones. ${reading}`;
}

export function mount(el, store) {
  const render = () => {
    const run = store.get();
    const s = run ? learningStats(run.concepts) : null;
    if (!s || !s.decided) {
      el.innerHTML = `<p class="rp-empty">Review a few entries in the Queue and this section fills in.</p>`;
      return;
    }
    el.innerHTML = `
      <div class="stack">
        <p class="muted"><span class="sim-tag">Simulated from this session's decisions</span>
          <strong>${s.decided}</strong> decisions, <strong>${pct(s.overrides / s.decided)}</strong> edited or rejected.</p>
        ${table('By tier', s.byTier, (k) => TIER_LABEL[k] ?? k)}
        ${table('By term type', s.byTermType, (k) => k)}
        <p class="muted">${esc(calibration(s))}</p>
        <p class="subtle">Each accept, edit or reject is a labelled example: the judge is recalibrated per locale and term type, and the auto-approve line moves where linguists rarely or often override.</p>
      </div>`;
  };
  store.subscribe(render);
  render();
}
