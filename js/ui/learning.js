// What it learned: override rates by term type and tier, judge calibration, and the loop in words.
import { esc, pct } from './dom.js';
import { learningStats, TIER_LABEL } from '../rules.js';

const MOVE = {
  lower: (k) => `↓ lower the line: auto-approve more ${k} next time`,
  raise: (k) => `↑ raise the line: review more ${k}`,
  hold: () => 'Hold: not enough decisions yet',
  floor: () => 'Hold: Critical entries are always reviewed',
};

const table = (title, rows, labelOf) => `
  <section class="panel lr-table">
    <h3>${esc(title)}</h3>
    <div class="table-scroll">
      <table>
        <thead><tr><th scope="col">${esc(title.replace('By ', ''))}</th><th scope="col">Decided</th><th scope="col">Overrides</th>
          <th scope="col">Override rate</th><th scope="col">Avg. judge confidence</th><th scope="col">The move</th></tr></thead>
        <tbody>
          ${rows.map((r) => {
            const label = labelOf(r.key);
            return `<tr>
              <th scope="row">${esc(label)}</th>
              <td>${r.decided}</td><td>${r.overrides}</td>
              <td><span class="lr-rate"><span class="lr-bar"><span style="width:${pct(r.overrideRate)}"></span></span>${pct(r.overrideRate)}</span></td>
              <td>${pct(r.avgConfidence)}</td>
              <td class="lr-move lr-${esc(r.move)}">${esc(MOVE[r.move](label.toLowerCase()))}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
  </section>`;

function calibration(s) {
  const a = s.avgConfidenceAccepted;
  const o = s.avgConfidenceOverridden;
  if (a == null || o == null) return '<p class="muted">Needs at least one accepted and one overridden entry to compare.</p>';
  let reading = 'The judge was about equally sure about both groups.';
  if (a - o > 0.02) reading = 'The judge was less sure about the entries linguists changed.';
  else if (o - a > 0.02) reading = 'The judge was more sure about the entries linguists changed: it is overconfident here, so recalibrate.';
  return `
    <div class="lr-cal">
      <div><div class="lr-big">${pct(a)}</div><div class="subtle">avg. confidence, accepted</div></div>
      <div><div class="lr-big">${pct(o)}</div><div class="subtle">avg. confidence, overridden</div></div>
    </div>
    <p>${esc(reading)}</p>`;
}

export function mount(el, store) {
  const render = () => {
    const run = store.get();
    const s = run ? learningStats(run.concepts) : null;
    if (!s || !s.decided) {
      el.innerHTML = `<div class="view-pad"><p class="empty">Review a few entries in the Queue and this panel fills in.</p></div>`;
      return;
    }
    el.innerHTML = `
      <div class="view-pad stack">
        <div class="row lr-head">
          <h2>What it learned</h2>
          <span class="sim-tag">Simulated from this session's decisions</span>
        </div>
        <div class="lr-summary">
          <div class="panel lr-stat"><div class="lr-big">${s.decided}</div><div class="subtle">decisions</div></div>
          <div class="panel lr-stat"><div class="lr-big">${pct(s.overrides / s.decided)}</div><div class="subtle">override rate (${s.overrides} of ${s.decided} edited or rejected)</div></div>
        </div>
        ${table('By term type', s.byTermType, (k) => k)}
        ${table('By tier', s.byTier, (k) => TIER_LABEL[k] ?? k)}
        <section class="panel lr-table"><h3>Judge calibration</h3>${calibration(s)}</section>
        <section class="panel lr-table">
          <h3>How the loop works</h3>
          <ul class="lr-loop">
            <li>Each accept, edit or reject is a labelled example.</li>
            <li>The judge is recalibrated per locale and term type.</li>
            <li>The auto-approve line moves where linguists rarely or often override.</li>
            <li>Trust is tracked per reviewer <span class="subtle">(not simulated here)</span>.</li>
            <li>An LQA error always reopens its entry <span class="subtle">(not simulated here)</span>.</li>
          </ul>
        </section>
      </div>`;
  };
  store.subscribe(render);
  render();
}
