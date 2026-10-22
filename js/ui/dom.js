// Small shared render helpers so every view draws badges and bars the same way.
import { TIER_LABEL, LOW_CONFIDENCE } from '../rules.js';
import { STATUS_LABEL } from '../schema.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ESC[ch]);

export const pct = (x) => `${Math.round(x * 100)}%`;
export const fmtInt = (n) => Number(n).toLocaleString('en-US');

/**
 * Tier badge. With `tipId` (the card) the badge is focusable and described by the custom tooltip of that id, so the
 * reason shows on hover and on keyboard focus with no native title. Without it (lists) the badge is not a Tab stop;
 * a reason, if given, is only a hover hint.
 */
export function tierBadge(tier, reason = '', tipId = '') {
  const label = TIER_LABEL[tier] ?? tier;
  const tip = reason && tipId ? ` tabindex="0" aria-describedby="${esc(tipId)}"` : reason ? ` title="${esc(reason)}"` : '';
  return `<span class="tier-badge tier-${esc(tier)}"${tip}>${esc(label)}</span>`;
}

/**
 * Scope sentence for the demo, whose views hold a 40-entry sample of a 3,000-entry site (the hero speaks for the
 * whole site). Returns '' for live runs: every number there comes from the run itself.
 * kind: 'queue' | 'all'
 */
export function sampleScope(run, kind = 'all') {
  if (!run?.totals) return '';
  const reopened = run.concepts.filter((c) => c.reopened).length;
  if (kind === 'queue') {
    const n = run.concepts.filter((c) => c.bucket === 'queue').length;
    return `Sample of ${fmtInt(n)} from the ${fmtInt(run.totals.queue + reopened)} that need you`;
  }
  return `Sample of ${fmtInt(run.concepts.length)} from the site's ${fmtInt(run.totals.concepts)} entries`;
}

export function confBar(confidence) {
  const band = confidence < LOW_CONFIDENCE ? 'low' : confidence < 0.9 ? 'mid' : 'high';
  return `<span class="conf conf-${band}" title="Judge confidence"><span class="conf-bar"><span style="width:${pct(confidence)}"></span></span>${pct(confidence)}</span>`;
}

export function statusBadge(status) {
  if (!status || status === 'pending') return '';
  return `<span class="status-badge status-${esc(status)}">${esc(STATUS_LABEL[status] ?? status)}</span>`;
}

const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Escape a sentence and wrap every occurrence of any term (case-insensitive, longest first) in <mark>. */
export function highlight(sentence, terms) {
  const list = [...new Set(terms.filter(Boolean))].sort((a, b) => b.length - a.length).map(reEscape);
  if (!list.length) return esc(sentence);
  const re = new RegExp(`(${list.join('|')})`, 'giu');
  return String(sentence).split(re).map((part, i) => (i % 2 ? `<mark>${esc(part)}</mark>` : esc(part))).join('');
}

/** Turn an HTML string into a DocumentFragment. */
export function frag(html) {
  const t = document.createElement('template');
  t.innerHTML = html;
  return t.content;
}

/** Trigger a file download from a string (works on any static host). */
export function download(filename, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
