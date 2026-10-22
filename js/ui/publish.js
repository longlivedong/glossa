// Step 7: what publishes, what is held, and the two exports.
import { publishedEntries } from '../rules.js';
import { LOCALE_LABEL, STATUS_LABEL, REJECT_REASONS } from '../schema.js';
import { esc, fmtInt, download, tierBadge, statusBadge, sampleScope } from './dom.js';

const REJECT_LABEL = Object.fromEntries(REJECT_REASONS);

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
  // What ships leads; the pending list repeats the queue, so it starts collapsed with its count in the summary.
  const open = { published: true, client: true, held: true, pending: false, rejected: false };

  const MAX_ROWS = 50;
  const modeChip = (mode, flagged) => `<span class="mode-chip mode-${esc(mode)}">${mode === 'hard' ? 'Hard' : 'Guidance'}</span>${flagged ? ' <span class="flag-chip">flagged</span>' : ''}`;
  const statusText = (c) => {
    if (c.status !== 'pending') return statusBadge(c.status);
    return `<span class="status-badge status-auto">${c.bucket === 'random_check' ? 'Random check' : c.bucket === 'queue' ? 'Pending' : 'Auto-approved'}</span>`;
  };
  const term = (c) => `<th scope="row"><span class="pt-src">${esc(c.source)}</span></th>`;

  const group = (key, title, sub, items, head, rowFn, tone = '') => {
    if (!items.length) return '';
    const more = items.length > MAX_ROWS ? `<p class="subtle pt-more">and ${fmtInt(items.length - MAX_ROWS)} more in the export</p>` : '';
    return `
    <details class="panel p-group ${tone}" data-group="${key}"${open[key] ? ' open' : ''}>
      <summary><span class="p-sum-title">${esc(title)}</span><span class="p-count">${fmtInt(items.length)}</span></summary>
      <div class="p-body">
        <p class="muted">${esc(sub)}</p>
        <div class="table-scroll"><table class="pt">
          <thead><tr>${head.map((h) => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead>
          <tbody>${items.slice(0, MAX_ROWS).map(rowFn).join('')}</tbody>
        </table></div>
        ${more}
      </div>
    </details>`;
  };

  function render() {
    const run = store.get();
    if (!run) { el.innerHTML = ''; return; }
    const pub = publishedEntries(run);
    const k = counts(run);
    const hard = pub.published.filter((p) => p.mode === 'hard').length;
    const soft = pub.published.length - hard;
    const decided = run.concepts.filter((c) => c.status !== 'pending').length;
    const tile = (n, label, cls) => `<div class="p-tile panel ${n > 0 ? cls : 't-zero'}"><span class="p-n">${fmtInt(n)}</span><span class="p-l">${esc(label)}</span></div>`;
    const scope = sampleScope(run);
    const nPending = pub.pendingForLead.length;
    el.innerHTML = `
      <div class="p-wrap stack-lg">
        <div class="view-head">
          <div>
            <h2 class="view-title">Publish</h2>
            <p class="muted"><strong>${fmtInt(pub.published.length)}</strong> entries publish: ${fmtInt(hard)} hard, ${fmtInt(soft)} guidance</p>
            ${scope ? `<p class="subtle">${esc(scope)}. Every count on this tab covers the sample.</p>` : ''}
          </div>
          <div class="p-actions-col">
            <div class="row p-actions">
              <button type="button" class="btn btn-primary" data-export="json">Export glossary (JSON)</button>
              <button type="button" class="btn" data-export="csv">Export CSV</button>
            </div>
            ${nPending ? `<p class="subtle p-export-note">${fmtInt(nPending)} still pending won't be published.</p>` : ''}
          </div>
        </div>
        <div class="p-tiles">
          ${tile(decided, 'Decided', 't-ok')}${tile(k.asked, 'Awaiting client', 't-warn')}
        </div>
        ${group('published', 'Publishing', 'What ships, with the enforcement mode the translation step will apply.',
          pub.published, ['Term', 'Rendering', 'Tier', 'Mode', 'Status'],
          ({ concept: c, mode, flagged }) => `<tr>${term(c)}<td class="pt-tgt">${esc(c.proposal.text)}</td><td>${tierBadge(c.tier)}</td><td>${modeChip(mode, flagged)}</td><td>${statusText(c)}</td></tr>`)}
        ${group('client', 'Awaiting client', 'Ships as guidance, flagged, until the client replies. The question is on file with each entry.',
          pub.awaitingClient, ['Term', 'Rendering', 'Question to the client', 'Tier'],
          (c) => `<tr>${term(c)}<td class="pt-tgt">${esc(c.proposal.text)}</td><td class="pt-note">${esc(c.decision?.question || '')}</td><td>${tierBadge(c.tier)}</td></tr>`, 'is-warn')}
        ${group('held', 'Held for the locale lead', STATUS_LABEL.escalated + '.',
          pub.held, ['Term', 'Drafter', 'Linguist', 'Tier'],
          (c) => `<tr>${term(c)}<td class="pt-tgt">${esc(c.decision?.previousText || c.proposal.text)}</td><td class="pt-tgt">${esc(c.decision?.newText || '—')}</td><td>${tierBadge(c.tier)}</td></tr>`, 'is-bad')}
        ${group('pending', 'Still pending', 'No decision yet. These won\'t publish silently; they are listed for the lead.',
          pub.pendingForLead, ['Term', 'Drafter rendering', 'Tier', 'Mode'],
          (c) => `<tr>${term(c)}<td class="pt-tgt">${esc(c.proposal.text)}</td><td>${tierBadge(c.tier)}</td><td>${modeChip(c.enforcement)}</td></tr>`, 'is-pending')}
        ${group('rejected', 'Rejected', 'Won\'t publish. The linguist rejected the drafter\'s rendering; the reason stays on file.',
          pub.rejected, ['Term', 'Drafter rendering', 'Reason', 'Tier'],
          (c) => `<tr>${term(c)}<td class="pt-tgt">${esc(c.proposal.text)}</td><td class="pt-note">${esc((REJECT_LABEL[c.decision?.reason] || '') + (c.decision?.note ? `: ${c.decision.note}` : ''))}</td><td>${tierBadge(c.tier)}</td></tr>`)}
      </div>`;
    // Column names on every cell, so the stacked phone layout (review.css) can show them as labels.
    for (const t of el.querySelectorAll('table.pt')) {
      const head = [...t.querySelectorAll('thead th')].map((th) => th.textContent);
      for (const tr of t.querySelectorAll('tbody tr')) [...tr.children].forEach((cell, i) => { if (head[i]) cell.dataset.label = head[i]; });
    }
  }

  el.addEventListener('toggle', (e) => {
    const d = e.target.closest?.('[data-group]');
    if (d) open[d.dataset.group] = d.open;
  }, true);

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
