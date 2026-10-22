// Subtle, optional motion on top of a fully working static UI.
// GSAP core is vendored in js/vendor/ (no CDN) and loaded by a deferred classic <script> before app.js.
// Every function here is a no-op when GSAP is missing or the user prefers reduced motion,
// and clears its inline styles when done, so nothing depends on an animation having run.

// Read at call time, so script load order can never leave motion half-initialised.
const gs = () => (typeof window !== 'undefined' ? window.gsap : undefined);

const EASE = 'power1.out'; // design system: Subtle tier, 200–400 ms, small offsets
const reduceQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

/** True when animations should run. Checked on every call, so a settings change applies at once. */
export const motionOn = () => !!gs() && !reduceQuery?.matches;

// Opacity only, never visibility: a hidden subtree drops keyboard focus (the card's Accept during fast A-A-A).
const done = 'transform,opacity';

/** Fade an element in with a small rise. For a view, panel or card appearing; not for every re-render. */
export function enter(el, { y = 8, duration = 0.28, delay = 0 } = {}) {
  if (!el || !motionOn()) return;
  const g = gs();
  g.killTweensOf(el);
  g.fromTo(el, { opacity: 0, y }, { opacity: 1, y: 0, duration, delay, ease: EASE, clearProps: done });
}

/** Fade a list of siblings in one after another (rows, tiles). Capped so long lists stay fast. */
export function stagger(els, { y = 6, duration = 0.24, each = 0.03, max = 12 } = {}) {
  if (!motionOn()) return;
  const list = [...(els || [])].slice(0, max);
  if (!list.length) return;
  const g = gs();
  g.killTweensOf(list);
  g.fromTo(list, { opacity: 0, y }, { opacity: 1, y: 0, duration, ease: EASE, stagger: each, clearProps: done });
}

/** Grow a bar segment from its left edge, for the budget and distribution bars. */
export function growBar(el, { duration = 0.4, delay = 0 } = {}) {
  if (!el || !motionOn()) return;
  gs().fromTo(el, { scaleX: 0, transformOrigin: 'left center' }, { scaleX: 1, duration, delay, ease: EASE, clearProps: 'transform,transformOrigin' });
}
