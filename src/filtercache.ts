// Smart-filter masks: the unfiltered and filtered renders of a smart object are kept so that painting on the filter mask
// can re-blend them instantly (and show the stroke live) instead of re-running the filters.
import { ctxOf, grayToAlpha, makeCanvas, type Layer } from './doc';

export interface FilterCache { key: string; U: HTMLCanvasElement; F: HTMLCanvasElement }
const caches = new WeakMap<Layer, FilterCache>();
export const cacheKey = (l: Layer) => JSON.stringify([l.smart?.placed.id, l.smart?.placed.transform, l.smart?.placed.width, l.smart?.placed.height, l.smart?.filters]);
export const setCache = (l: Layer, U: HTMLCanvasElement, F: HTMLCanvasElement) => caches.set(l, { key: cacheKey(l), U, F });
export const getCache = (l: Layer): FilterCache | null => { const c = caches.get(l); return c && c.key === cacheKey(l) ? c : null; };

const scratchA = makeCanvas(1, 1), scratchB = makeCanvas(1, 1);
const fit = (c: HTMLCanvasElement, w: number, h: number) => { if (c.width !== w || c.height !== h) { c.width = w; c.height = h; } return c; };

/** out = U·(1 − m) + F·m, where white in `mask` means "filtered". Draws into `dst`. */
export function blendFiltered(dst: CanvasRenderingContext2D, U: HTMLCanvasElement, F: HTMLCanvasElement, mask: HTMLCanvasElement) {
  const w = U.width, h = U.height, a = grayToAlpha(mask, fit(scratchA, w, h)), t = ctxOf(fit(scratchB, w, h));
  dst.save(); dst.setTransform(1, 0, 0, 1, 0, 0); dst.globalAlpha = 1; dst.globalCompositeOperation = 'source-over'; dst.clearRect(0, 0, w, h);
  t.globalCompositeOperation = 'source-over'; t.clearRect(0, 0, w, h); t.drawImage(U, 0, 0); t.globalCompositeOperation = 'destination-out'; t.drawImage(a, 0, 0);
  dst.drawImage(scratchB, 0, 0);
  t.globalCompositeOperation = 'source-over'; t.clearRect(0, 0, w, h); t.drawImage(F, 0, 0); t.globalCompositeOperation = 'destination-in'; t.drawImage(a, 0, 0);
  dst.globalCompositeOperation = 'lighter'; dst.drawImage(scratchB, 0, 0);
  dst.restore();
}
/** Re-blend the layer from its cached renders (after the filter mask changed). Returns false if there is no valid cache. */
export function recomposite(l: Layer): boolean {
  const c = getCache(l), fm = l.smart?.filterMask;
  if (!c || !fm) return false;
  blendFiltered(l.ctx, c.U, c.F, fm);
  l.touchMask();
  return true;
}
