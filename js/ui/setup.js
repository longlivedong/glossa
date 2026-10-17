// "Run on a website": the live-mode form, the progress view, and a summary of the current live run.
import { esc } from './dom.js';
import { createProgress } from './progress.js';
import { INDUSTRIES } from '../rules.js';
import { LOCALE_LABEL } from '../schema.js';

const DEFAULTS = {
  url: '', siteName: '', target: 'es-ES', sibling: 'es-MX', industry: 'general', maxPages: 10,
  csvText: '', csvName: '', styleGuide: '', hours: '',
};

export function mount(el, store, ctx) {
  const values = { ...DEFAULTS };
  let phase = 'form'; // 'form' | 'running' | 'error'
  let csvCount = null;
  let csvError = '';
  let ctrl = null;
  let lastInput = null;
  let forceForm = false;

  el.innerHTML = `<div class="view-pad stack"><div data-summary></div><div data-body></div></div>`;
  const summaryEl = el.querySelector('[data-summary]');
  const bodyEl = el.querySelector('[data-body]');

  const opt = (map, sel, skip) => Object.entries(map).filter(([k]) => k !== skip)
    .map(([k, v]) => `<option value="${esc(k)}"${k === sel ? ' selected' : ''}>${esc(typeof v === 'string' ? v : v.label)}</option>`).join('');

  const renderSummary = () => {
    const run = store.get();
    if (run?.mode !== 'live' || phase !== 'form' || forceForm) { summaryEl.innerHTML = ''; return; }
    const when = new Date(run.createdAt).toLocaleString();
    summaryEl.innerHTML = `
      <div class="panel setup-summary">
        <div>
          <div class="section-title">Current run</div>
          <p><strong>${esc(run.site.name || run.site.url)}</strong> · ${run.concepts.length} concepts · created ${esc(when)}</p>
        </div>
        <button type="button" class="btn" data-new>Start a new run</button>
      </div>`;
  };

  const modelLine = () => {
    const h = ctx.health;
    if (!h) return '';
    const d = h.drafter ? `${esc(h.drafter.model)} (${esc(h.drafter.host)})` : 'unknown';
    const j = h.judge ? esc(h.judge.model) : 'unknown';
    return `<p class="subtle">Drafter: ${d} · Judge: ${j}</p>${h.mock ? '<p class="subtle"><strong>Mock mode:</strong> canned answers, no API calls</p>' : ''}`;
  };

  const renderForm = () => {
    const v = values;
    bodyEl.innerHTML = `
      <form class="panel setup-form" novalidate>
        <h2>Run on a website</h2>
        <p class="muted">Paste a website. The Drafter extracts and drafts terms, the Judge scores them, code draws the line, and you review only what's above it.</p>
        ${modelLine()}
        <div class="setup-grid">
          <div class="field span-2"><label for="su-url">Website URL</label>
            <input id="su-url" name="url" type="url" required placeholder="https://example.com" value="${esc(v.url)}" autocomplete="off"></div>
          <div class="field"><label for="su-name">Site name <span class="subtle">(optional)</span></label>
            <input id="su-name" name="siteName" type="text" value="${esc(v.siteName)}"></div>
          <div class="field"><label for="su-pages">Max pages</label>
            <input id="su-pages" name="maxPages" type="number" min="1" max="10" value="${esc(v.maxPages)}"></div>
          <div class="field"><label for="su-target">Target locale</label>
            <select id="su-target" name="target">${opt(LOCALE_LABEL, v.target, 'en')}</select></div>
          <div class="field"><label for="su-sib">Sibling locale</label>
            <select id="su-sib" name="sibling"><option value="">None</option>${opt(LOCALE_LABEL, v.sibling, 'en')}</select>
            <div class="subtle">drafted too, so the judge can compare</div></div>
          <div class="field"><label for="su-ind">Industry</label>
            <select id="su-ind" name="industry">${opt(INDUSTRIES, v.industry)}</select>
            <div class="subtle">only shifts tier defaults</div></div>
          <div class="field"><label for="su-hours">Linguist hours <span class="subtle">(optional)</span></label>
            <input id="su-hours" name="hours" type="number" min="0.5" step="0.5" value="${esc(v.hours)}">
            <div class="subtle">blank = auto: about 8% of concepts, the design's 1-in-12 share</div></div>
          <div class="field span-2"><label for="su-csv">Old glossary CSV <span class="subtle">(optional)</span></label>
            <div class="row"><input id="su-file" type="file" accept=".csv,text/csv,text/plain" aria-label="Choose a CSV file">
              <a href="samples/template-glossary.csv" download>Download template</a></div>
            <textarea id="su-csv" name="csvText" rows="4" placeholder="source,target,tier,notes">${esc(v.csvText)}</textarea>
            <div class="subtle">columns: source,target[,tier][,notes]; imported entries are scored like drafts, never trusted blindly</div>
            <div class="subtle csv-status" role="status">${csvError ? `<span class="inline-error">${esc(csvError)}</span>` : csvCount != null ? `${csvCount} rows parsed${v.csvName ? ` from ${esc(v.csvName)}` : ''}` : ''}</div></div>
          <div class="field span-2"><label for="su-style">Style guide <span class="subtle">(optional)</span></label>
            <textarea id="su-style" name="styleGuide" rows="3" placeholder="Use usted in safety copy, tú in marketing. Keep model codes as in source.">${esc(v.styleGuide)}</textarea></div>
        </div>
        <p class="inline-error" data-formerr role="alert" hidden></p>
        <div class="row setup-actions">
          <button type="submit" class="btn btn-primary">Run pipeline</button>
          <span class="subtle">About 20–25 model calls for 10 pages; 2–3 minutes on a free tier.</span>
        </div>
      </form>`;
  };

  const showForm = () => { phase = 'form'; renderForm(); sync(); };

  async function parseCsv() {
    csvCount = null; csvError = '';
    if (values.csvText.trim()) {
      try {
        const { parseGlossaryCsv } = await import('../pipeline.js');
        csvCount = parseGlossaryCsv(values.csvText).length;
      } catch (e) {
        csvError = e?.message || 'Could not parse the CSV.';
      }
    }
    const s = bodyEl.querySelector('.csv-status');
    if (s) s.innerHTML = csvError ? `<span class="inline-error">${esc(csvError)}</span>` : csvCount != null ? `${csvCount} rows parsed${values.csvName ? ` from ${esc(values.csvName)}` : ''}` : '';
  }

  function buildInput() {
    const hours = Number(values.hours);
    return {
      url: values.url.trim(),
      siteName: values.siteName.trim(),
      maxPages: Math.min(10, Math.max(1, Number(values.maxPages) || 10)),
      importedCsvText: values.csvText,
      styleGuide: values.styleGuide.trim(),
      target: values.target,
      sibling: values.sibling && values.sibling !== values.target ? values.sibling : null,
      industry: values.industry,
      hours: values.hours !== '' && hours > 0 ? hours : null,
    };
  }

  async function start(input) {
    lastInput = input;
    phase = 'running';
    summaryEl.innerHTML = '';
    bodyEl.innerHTML = `
      <div class="panel setup-run">
        <div class="row setup-run-head"><h2>Running on ${esc(input.siteName || input.url)}</h2>
          <button type="button" class="btn btn-sm" data-cancel>Cancel</button></div>
        <div data-progress></div>
        <div class="row setup-fail" data-fail hidden>
          <button type="button" class="btn btn-primary" data-retry>Retry (resumes where it stopped)</button>
          <button type="button" class="btn" data-back>Back to form</button>
        </div>
      </div>`;
    const progress = createProgress(bodyEl.querySelector('[data-progress]'));
    const fail = bodyEl.querySelector('[data-fail]');
    ctrl = new AbortController();
    try {
      const { runPipeline } = await import('../pipeline.js');
      const run = await runPipeline(input, { onProgress: (evt) => progress.update(evt), signal: ctrl.signal });
      const need = run.concepts.filter((c) => c.bucket === 'queue').length;
      progress.done(`Run complete: ${run.concepts.length} concepts, ${need} need you`);
      forceForm = false;
      phase = 'form';
      store.loadRun(run);
      store.setUI({ tab: 'queue' });
      ctx.toast(`Run complete: ${run.concepts.length} concepts, ${need} need you`);
      renderForm();
      sync();
    } catch (err) {
      if (ctrl?.signal.aborted) {
        progress.error('Cancelled. Finished steps are cached, so a retry resumes.');
      } else {
        progress.error(err?.message || 'The run failed.');
      }
      phase = 'error';
      fail.hidden = false;
    }
  }

  bodyEl.addEventListener('input', (e) => {
    const t = e.target;
    if (t.name && t.name in values) {
      values[t.name] = t.value;
      if (t.name === 'csvText') { values.csvName = ''; parseCsv(); }
    }
  });
  bodyEl.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'su-file' && t.files?.[0]) {
      const f = t.files[0];
      f.text().then((text) => {
        values.csvText = text; values.csvName = f.name;
        const ta = bodyEl.querySelector('#su-csv');
        if (ta) ta.value = text;
        parseCsv();
      });
    } else if (t.name === 'target' || t.name === 'sibling' || t.name === 'industry') {
      values[t.name] = t.value;
    }
  });
  bodyEl.addEventListener('submit', (e) => {
    e.preventDefault();
    const err = bodyEl.querySelector('[data-formerr]');
    const url = values.url.trim();
    let ok = false;
    try { ok = /^https?:$/.test(new URL(url).protocol); } catch { ok = false; }
    if (!ok) {
      err.textContent = 'Enter a full website address starting with http:// or https://.';
      err.hidden = false;
      bodyEl.querySelector('#su-url').focus();
      return;
    }
    start(buildInput());
  });
  bodyEl.addEventListener('click', (e) => {
    if (e.target.closest('[data-cancel]')) ctrl?.abort();
    else if (e.target.closest('[data-retry]')) start(lastInput);
    else if (e.target.closest('[data-back]')) showForm();
  });
  summaryEl.addEventListener('click', (e) => {
    if (e.target.closest('[data-new]')) { forceForm = true; sync(); bodyEl.querySelector('#su-url')?.focus(); }
  });

  // Hide the form behind the summary until "Start a new run" is clicked.
  const sync = () => {
    const run = store.get();
    const showSummary = run?.mode === 'live' && phase === 'form' && !forceForm;
    bodyEl.hidden = showSummary;
    renderSummary();
  };
  store.subscribe(() => { if (phase === 'form') sync(); });
  renderForm();
  sync();
}
