// Custom brush tips: alpha masks used instead of the round soft brush. Pure data + a tiny registry (unit-tested);
// user-defined tips are remembered in localStorage.
export interface Tip { id: string; name: string; w: number; h: number; alpha: Uint8ClampedArray }

const tips = new Map<string, Tip>();
export const getTip = (id: string | undefined) => (id && id !== 'round' ? tips.get(id) : undefined);
export const allTips = () => [...tips.values()];
export const ROUND = 'round';

function make(id: string, name: string, n: number, f: (x: number, y: number, n: number) => number): Tip {
  const alpha = new Uint8ClampedArray(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) alpha[y * n + x] = Math.round(255 * Math.min(1, Math.max(0, f(x + 0.5, y + 0.5, n))));
  return { id, name, w: n, h: n, alpha };
}
const hash = (x: number, y: number) => ((((x | 0) * 73856093) ^ ((y | 0) * 19349663)) >>> 0) % 256 / 255;
const edge = (d: number) => Math.min(1, Math.max(0, d));          // 1px-ish antialias helper
for (const t of [
  make('tip:square', 'Square', 48, () => 1),
  make('tip:diamond', 'Diamond', 48, (x, y, n) => edge((n / 2 - (Math.abs(x - n / 2) + Math.abs(y - n / 2))) * 1.2)),
  make('tip:star', 'Star', 64, (x, y, n) => {
    const dx = x - n / 2, dy = y - n / 2, r = Math.hypot(dx, dy) / (n / 2), a = Math.atan2(dy, dx);
    const lim = 0.45 + 0.55 * Math.pow(Math.abs(Math.cos(2.5 * a + Math.PI * 0.5)), 1.4);
    return edge((lim - r) * 14);
  }),
  make('tip:chalk', 'Chalk', 64, (x, y, n) => { const r = Math.hypot(x - n / 2, y - n / 2) / (n / 2); return r > 1 ? 0 : (0.35 + 0.65 * hash(x, y)) * edge((1 - r) * 5); }),
  make('tip:splatter', 'Splatter', 64, (x, y, n) => {
    let v = 0;
    for (let k = 0; k < 9; k++) { const cx = n * (0.15 + 0.7 * hash(k * 7, 3)), cy = n * (0.15 + 0.7 * hash(5, k * 11)), r = n * (0.05 + 0.1 * hash(k, k)); v = Math.max(v, edge((r - Math.hypot(x - cx, y - cy)) * 1.5)); }
    return v;
  }),
  make('tip:bristle', 'Bristles', 64, (x, y, n) => { const r = Math.hypot(x - n / 2, y - n / 2) / (n / 2); return r > 1 ? 0 : (hash(Math.floor(x / 2), 0) > 0.35 ? 1 : 0.15) * edge((1 - r) * 6); }),
]) tips.set(t.id, t);

/**
 * Tip alpha from pixels: where the pixels are semi-transparent that alpha is used, otherwise darkness (black = paint,
 * white = nothing), as in Photoshop. The result is stretched to full range. Returns null when it would be empty.
 */
export function tipFromPixels(rgba: Uint8ClampedArray, w: number, h: number): Uint8ClampedArray | null {
  const out = new Uint8ClampedArray(w * h);
  let transparent = false;
  for (let p = 0; p < w * h; p++) if (rgba[p * 4 + 3] < 250) { transparent = true; break; }
  let mx = 0;
  for (let p = 0; p < w * h; p++) {
    const i = p * 4, a = rgba[i + 3] / 255, dark = 1 - (0.3 * rgba[i] + 0.59 * rgba[i + 1] + 0.11 * rgba[i + 2]) / 255;
    const v = transparent ? a : a * dark;                                           // any see-through pixels: the alpha is the shape
    out[p] = Math.round(v * 255); if (out[p] > mx) mx = out[p];
  }
  if (mx < 8) return null;
  const k = 255 / mx;
  for (let p = 0; p < out.length; p++) out[p] = Math.min(255, Math.round(out[p] * k));
  return out;
}

let seq = 0;
export function defineTip(name: string, w: number, h: number, alpha: Uint8ClampedArray, persist = true): Tip {
  const t: Tip = { id: `tip:user-${Date.now().toString(36)}-${seq++}`, name, w, h, alpha: new Uint8ClampedArray(alpha) };
  tips.set(t.id, t);
  if (persist) save();
  return t;
}
export function removeTip(id: string) { if (id.startsWith('tip:user')) { tips.delete(id); save(); } }

const KEY = 'pixelforge.brushTips';
const b64 = (a: Uint8ClampedArray) => { let s = ''; for (let i = 0; i < a.length; i += 8192) s += String.fromCharCode(...a.subarray(i, i + 8192)); return btoa(s); };
const unb64 = (s: string) => Uint8ClampedArray.from(atob(s), (c) => c.charCodeAt(0));
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(allTips().filter((t) => t.id.startsWith('tip:user')).map((t) => ({ id: t.id, name: t.name, w: t.w, h: t.h, d: b64(t.alpha) })))); } catch { /* storage unavailable */ }
}
export function loadSavedTips() {
  try {
    for (const t of JSON.parse(localStorage.getItem(KEY) ?? '[]')) {
      const a = unb64(t.d);
      if (typeof t.id === 'string' && t.w > 0 && t.h > 0 && a.length === t.w * t.h) tips.set(t.id, { id: t.id, name: String(t.name), w: t.w, h: t.h, alpha: a });
    }
  } catch { /* ignore */ }
}
