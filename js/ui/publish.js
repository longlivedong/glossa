// Step 7: what publishes, what is held, and the two exports.
import { publishedEntries } from '../rules.js';
import { LOCALE_LABEL, STATUS_LABEL } from '../schema.js';
import { esc, fmtInt, download } from './dom.js';

const today = () => new Date().toISOString().slice(0, 10);
const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // keep spreadsheets from reading a term as a formula
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function mount(el, store, ctx) {
  const counts = (run) => {
    const n = (s) => run.concepts.filter((c) => c.status === s).length;
    return { accepted: n('accepted'), edited: n('edited'), rejected: n('rejected'), asked: n('asked_client'), escalated: n('escalated') };
  };

  const list = (title, sub, items, fmt) => items.length ? `
    <section class="p-group panel">
      <h3>${esc(title)}</h3>
      <p class="muted">${esc(sub)}</p>
      <ul class="p-list">${items.slice(0, 50).map(fmt).join('')}</ul>
      ${items.length > 50 ? `<p class="subtle">and ${fmtInt(items.length - 50)} more</p>` : ''}
    </section>` : '';

  function render() {
    const run = store.get();
    if (!run) { el.innerHTML = ''; return; }
    const pub = publishedEntries(run);
    const k = counts(run);
    const hard = pub.published.filter((p) => p.mode === 'hard').length;
    const soft = pub.published.length - hard;
    const tile = (n, label) => `<div class="p-tile panel"><span class="p-n">${fmtInt(n)}</span><span class="p-l">${esc(label)}</span></div>`;
    el.innerHTML = `
      <div class="p-wrap stack">
        <div>
          <h2 class="view-title">Publish</h2>
          <p class="muted"><strong>${fmtInt(pub.published.length)}</strong> entries publish: ${fmtInt(hard)} hard, ${fmtInt(soft)} guidance</p>
          ${run.totals ? `<p class="subtle">Counts cover the ${fmtInt(run.concepts.length)}-entry sample in this demo.</p>` : ''}
        </div>
        <div class="p-tiles">
          ${tile(k.accepted, 'Accepted')}${tile(k.edited, 'Edited')}${tile(k.rejected, 'Rejected')}${tile(k.asked, 'Awaiting client')}${tile(k.escalated, 'Escalated')}${tile(pub.pendingForLead.length, 'Still pending above the line')}
        </div>
        ${list('Still pending: will not publish silently; listed for the lead', 'These sit above the line and have no decision yet.', pub.pendingForLead, (c) => `<li><strong>${esc(c.source)}</strong> <span class="muted">→ ${esc(c.proposal.text)}</span></li>`)}
        ${list('Awaiting client: ships as guidance, flagged, until the client replies', 'The question is on file with each entry.', pub.awaitingClient, (c) => `<li><strong>${esc(c.source)}</strong> <span class="muted">${esc(c.decision?.question || '')}</span></li>`)}
        ${list('Escalated: held for the locale lead', STATUS_LABEL.escalated + '.', pub.held, (c) => `<li><strong>${esc(c.source)}</strong> <span class="muted">drafter: ${esc(c.decision?.previousText || c.proposal.text)}${c.decision?.newText ? ` · linguist: ${esc(c.decision.newText)}` : ''}</span></li>`)}
        <div class="row p-actions">
          <button type="button" class="btn btn-primary" data-export="json">Export glossary (JSON)</button>
          <button type="button" class="btn" data-export="csv">Export CSV</button>
        </div>
      </div>`;
  }

  const target = (run) => run.locale.target;

  function exportJson() {
    const run = store.get();
    const pub = publishedEntries(run);
    const k = counts(run);
    const doc = {
      meta: {
        site: run.site?.name, url: run.site?.url, locale: run.locale, exportedAt: new Date().toISOString(),
        summary: { ...k, pendingAboveLine: pub.pendingForLead.length, publishing: pub.published.length, concepts: run.concepts.length },
      },
      // What ships and how: the mode here already applies the publish rules (awaiting client → guidance, flagged).
      published: pub.published.map(({ concept: c, mode, flagged }) => ({
        id: c.id, source: c.source, variants: c.variants, target: c.proposal.text, mode, scope: c.scope, tier: c.tier,
        status: c.status === 'pending' ? 'auto_approved' : c.status, flagged,
      })),
      held: pub.held.map((c) => c.id),
      pendingAboveLine: pub.pendingForLead.map((c) => c.id),
      concepts: run.concepts,
    };
    download(`glossary-${target(run)}-${today()}.json`, JSON.stringify(doc, null, 2));
    ctx.toast(`Exported ${fmtInt(run.concepts.length)} concepts for ${LOCALE_LABEL[target(run)] ?? target(run)}`);
  }

  function exportCsv() {
    const run = store.get();
    const { published } = publishedEntries(run);
    const lines = ['source,target,mode,scope,tier,status,flagged'];
    for (const { concept: c, mode, flagged } of published) {
      const status = c.status === 'pending' ? 'auto_approved' : c.status;
      lines.push([c.source, c.proposal.text, mode, c.scope, c.tier, status, flagged].map(csvCell).join(','));
    }
    download(`glossary-${target(run)}-${today()}.csv`, lines.join('\n') + '\n', 'text/csv');
    ctx.toast(`Exported ${fmtInt(published.length)} published entries`);
  }

  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-export]');
    if (!b || !store.get()) return;
    if (b.dataset.export === 'json') exportJson(); else exportCsv();
  });

  store.subscribe(render);
  render();
}
