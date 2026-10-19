// The single store: current run, per-concept undo stacks, UI state. Persists to localStorage.
import { capacityFor, computeLine } from './rules.js';

const STORAGE_KEY = 'glossa:v1';
const DEFAULT_UI = { tab: 'queue', selectedId: null, tierFilter: 'all', showRandom: false };

function readStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeStorage(data) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // storage blocked or full: the demo still works for this session
  }
}

const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));

const SNAPSHOT_FIELDS = ['status', 'decision', 'proposal', 'enforcement', 'scope', 'bucket', 'floor', 'reopened'];
const snapshot = (c) => Object.fromEntries(SNAPSHOT_FIELDS.map((k) => [k, clone(c[k])]));

/**
 * @returns {{
 *   get: () => import('./schema.js').Run|null, ui: () => typeof DEFAULT_UI,
 *   subscribe: (fn: () => void) => () => void,
 *   loadRun: (run: import('./schema.js').Run) => void,
 *   concept: (id: string) => import('./schema.js').Concept|undefined,
 *   act: (id: string, action: 'accept'|'edit'|'reject'|'ask_client', payload?: object) => void,
 *   undo: (id: string) => boolean, canUndo: (id: string) => boolean,
 *   reopen: (id: string) => void,
 *   setEnforcement: (id: string, mode: 'hard'|'guidance') => void,
 *   setScope: (id: string, scope: 'all'|'legal_safety'|'marketing') => void,
 *   setHours: (hours: number) => void,
 *   setPreview: (items: import('./schema.js').PreviewItem[]|null) => void,
 *   setUI: (patch: Partial<typeof DEFAULT_UI>) => void,
 *   lastAction: () => {id: string, action: string}|null,
 *   reset: () => void,
 * }}
 */
export function createStore() {
  const saved = readStorage();
  let run = saved?.run ?? null;
  let undo = saved?.undo ?? {};
  let ui = { ...DEFAULT_UI, ...(saved?.ui ?? {}) };
  let last = null;
  const listeners = new Set();

  const persist = () => writeStorage({ run, undo, ui });
  const emit = () => {
    persist();
    for (const fn of listeners) fn();
  };
  const find = (id) => run?.concepts.find((c) => c.id === id);
  const pushUndo = (c) => {
    (undo[c.id] ||= []).push(snapshot(c));
  };

  /** Live runs: redraw the line after anything that changes who is above it. */
  const relayout = () => {
    if (!run || run.totals) return; // demo buckets are precomputed against the doc's whole-site totals
    const { assign } = computeLine(run.concepts, { capacity: run.budget.capacity, seed: run.id });
    for (const c of run.concepts) {
      const a = assign.get(c.id);
      if (a) { c.bucket = a.bucket; c.floor = a.floor; }
    }
  };

  return {
    get: () => run,
    ui: () => ui,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    loadRun(next) {
      run = clone(next);
      undo = {};
      last = null;
      ui = { ...DEFAULT_UI };
      relayout();
      emit();
    },
    concept: find,
    act(id, action, payload = {}) {
      const c = find(id);
      if (!c) return;
      pushUndo(c);
      const at = new Date().toISOString();
      const decision = { action, bucket: c.bucket, at };
      if (action === 'accept') {
        c.status = 'accepted';
      } else if (action === 'edit') {
        const newText = String(payload.newText ?? '').trim();
        if (!newText) { undo[id].pop(); return; }
        decision.previousText = c.proposal.text;
        decision.newText = newText;
        decision.applyToConcept = !!payload.applyToConcept;
        decision.variantCount = payload.applyToConcept ? c.variants.length + 1 : 1;
        c.proposal = { ...c.proposal, text: newText };
        c.status = 'edited';
      } else if (action === 'reject') {
        decision.reason = payload.reason || 'other';
        if (payload.note) decision.note = String(payload.note);
        c.status = 'rejected';
      } else if (action === 'ask_client') {
        decision.question = String(payload.question ?? '').trim();
        c.status = 'asked_client';
      } else {
        undo[id].pop();
        return;
      }
      // Overriding the drafter on a Critical entry goes to a second linguist, then the locale lead (doc §6).
      if (c.tier === 'critical' && (action === 'edit' || action === 'reject')) c.status = 'escalated';
      c.decision = decision;
      last = { id, action };
      emit();
    },
    canUndo: (id) => !!undo[id]?.length,
    undo(id) {
      const c = find(id);
      const snap = undo[id]?.pop();
      if (!c || !snap) return false;
      Object.assign(c, snap);
      last = null;
      relayout();
      emit();
      return true;
    },
    reopen(id) {
      const c = find(id);
      if (!c || c.bucket === 'queue') return;
      pushUndo(c);
      c.bucket = 'queue';
      c.floor = 'reopened';
      c.reopened = true;
      c.status = 'pending';
      c.decision = null;
      last = { id, action: 'reopen' };
      relayout();
      emit();
    },
    setEnforcement(id, mode) {
      const c = find(id);
      if (!c || (mode !== 'hard' && mode !== 'guidance')) return;
      c.enforcement = mode;
      emit();
    },
    setScope(id, scope) {
      const c = find(id);
      if (!c) return;
      c.scope = scope;
      emit();
    },
    setHours(hours) {
      if (!run) return;
      const h = Math.max(0.5, Number(hours) || 0.5);
      run.budget = { ...run.budget, hours: h, capacity: capacityFor(h) };
      relayout();
      emit();
    },
    setPreview(items) {
      if (!run) return;
      run.preview = items;
      emit();
    },
    setUI(patch) {
      ui = { ...ui, ...patch };
      emit();
    },
    lastAction: () => last,
    reset() {
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
      run = null;
      undo = {};
      ui = { ...DEFAULT_UI };
      last = null;
      for (const fn of listeners) fn();
    },
  };
}
