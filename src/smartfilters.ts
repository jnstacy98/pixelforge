// Smart filters: non-destructive filters on smart objects. Pure pixel maths + PSD conversion (unit-tested).
import type { Filter } from 'ag-psd';

export type FilterKind = 'gaussian' | 'box' | 'motion' | 'unsharp' | 'noise' | 'mosaic' | 'invert' | 'brightness';
export interface SmartFilter { kind: FilterKind; p: Record<string, number>; on: boolean }

export interface ParamSpec { key: string; label: string; min: number; max: number; step: number }
export const FILTER_INFO: Record<FilterKind, { label: string; params: ParamSpec[]; defaults: Record<string, number> }> = {
  gaussian: { label: 'Gaussian Blur', params: [{ key: 'radius', label: 'Radius (px)', min: 0.1, max: 250, step: 0.1 }], defaults: { radius: 5 } },
  box: { label: 'Box Blur', params: [{ key: 'radius', label: 'Radius (px)', min: 1, max: 250, step: 1 }], defaults: { radius: 5 } },
  motion: { label: 'Motion Blur', params: [{ key: 'angle', label: 'Angle (°)', min: -90, max: 90, step: 1 }, { key: 'distance', label: 'Distance (px)', min: 1, max: 500, step: 1 }], defaults: { angle: 0, distance: 20 } },
  unsharp: { label: 'Unsharp Mask', params: [{ key: 'amount', label: 'Amount (%)', min: 1, max: 500, step: 1 }, { key: 'radius', label: 'Radius (px)', min: 0.1, max: 250, step: 0.1 }, { key: 'threshold', label: 'Threshold', min: 0, max: 255, step: 1 }], defaults: { amount: 100, radius: 2, threshold: 0 } },
  noise: { label: 'Add Noise', params: [{ key: 'amount', label: 'Amount (%)', min: 0.1, max: 400, step: 0.1 }, { key: 'gaussian', label: 'Gaussian (1) / Uniform (0)', min: 0, max: 1, step: 1 }, { key: 'mono', label: 'Monochromatic (1)', min: 0, max: 1, step: 1 }, { key: 'seed', label: 'Seed', min: 0, max: 99999, step: 1 }], defaults: { amount: 10, gaussian: 1, mono: 0, seed: 1 } },
  mosaic: { label: 'Mosaic', params: [{ key: 'cell', label: 'Cell size (px)', min: 2, max: 300, step: 1 }], defaults: { cell: 10 } },
  invert: { label: 'Invert', params: [], defaults: {} },
  brightness: { label: 'Brightness/Contrast', params: [{ key: 'b', label: 'Brightness', min: -100, max: 100, step: 1 }, { key: 'c', label: 'Contrast', min: -100, max: 100, step: 1 }], defaults: { b: 0, c: 0 } },
};
export const FILTER_KINDS = Object.keys(FILTER_INFO) as FilterKind[];
export const newFilter = (kind: FilterKind): SmartFilter => ({ kind, p: { ...FILTER_INFO[kind].defaults }, on: true });
export const cloneFilters = (f: SmartFilter[] | undefined) => f?.map((x) => ({ kind: x.kind, on: x.on, p: { ...x.p } }));
export const describeFilter = (f: SmartFilter) => `${FILTER_INFO[f.kind].label}${FILTER_INFO[f.kind].params.length ? ' — ' + FILTER_INFO[f.kind].params.slice(0, 3).map((s) => `${Math.round((f.p[s.key] ?? 0) * 10) / 10}`).join(', ') : ''}`;

// ---------------------------------------------------------------- pixel maths
const clamp = (v: number, lo = 0, hi = 255) => (v < lo ? lo : v > hi ? hi : v);
function toPre(d: Uint8ClampedArray): Float32Array {
  const o = new Float32Array(d.length);
  for (let i = 0; i < d.length; i += 4) { const a = d[i + 3] / 255; o[i] = d[i] * a; o[i + 1] = d[i + 1] * a; o[i + 2] = d[i + 2] * a; o[i + 3] = d[i + 3]; }
  return o;
}
function fromPre(p: Float32Array, d: Uint8ClampedArray) {
  for (let i = 0; i < d.length; i += 4) {
    const a = p[i + 3];
    if (a <= 0.001) { d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0; continue; }
    const k = 255 / a; d[i] = clamp(p[i] * k); d[i + 1] = clamp(p[i + 1] * k); d[i + 2] = clamp(p[i + 2] * k); d[i + 3] = clamp(a);   // (the clamped array rounds)
  }
}
/** One box-blur pass of integer radius r along rows (horizontal) or columns (edge pixels replicate beyond the canvas). */
function boxPass(src: Float32Array, dst: Float32Array, w: number, h: number, r: number, horizontal: boolean) {
  const len = horizontal ? w : h, lines = horizontal ? h : w, stride = horizontal ? 4 : w * 4, lineStride = horizontal ? w * 4 : 4, inv = 1 / (2 * r + 1);
  for (let l = 0; l < lines; l++) {
    const base = l * lineStride;
    for (let c = 0; c < 4; c++) {
      let sum = src[base + c] * (r + 1);                                   // edges replicate (the canvas border doesn't fade the picture)
      for (let i = 1; i <= r; i++) sum += src[base + Math.min(i, len - 1) * stride + c];
      for (let i = 0; i < len; i++) {
        dst[base + i * stride + c] = sum * inv;
        sum += src[base + Math.min(i + r + 1, len - 1) * stride + c] - src[base + Math.max(i - r, 0) * stride + c];
      }
    }
  }
}
export function boxBlurPre(p: Float32Array, w: number, h: number, r: number) {
  r = Math.round(r); if (r < 1) return;
  const t = new Float32Array(p.length); boxPass(p, t, w, h, r, true); boxPass(t, p, w, h, r, false);
}
/** Gaussian blur ≈ three box blurs (Kovesi / Ivan Kutskir). */
export function gaussianBlurPre(p: Float32Array, w: number, h: number, sigma: number) {
  if (sigma < 0.3) return;
  const n = 3, wi = Math.sqrt((12 * sigma * sigma) / n + 1); let wl = Math.floor(wi); if (wl % 2 === 0) wl--;
  const wu = wl + 2, m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  for (let i = 0; i < n; i++) boxBlurPre(p, w, h, ((i < m ? wl : wu) - 1) / 2);
}
function motionBlur(d: Uint8ClampedArray, w: number, h: number, angleDeg: number, dist: number) {
  const p = toPre(d), o = new Float32Array(p.length), n = Math.max(1, Math.round(dist)), a = (angleDeg * Math.PI) / 180, dx = Math.cos(a), dy = -Math.sin(a);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0, al = 0;
    for (let k = 0; k < n; k++) {
      const t = k - (n - 1) / 2, sx = Math.round(x + dx * t), sy = Math.round(y + dy * t);
      const i = (Math.min(h - 1, Math.max(0, sy)) * w + Math.min(w - 1, Math.max(0, sx))) * 4; r += p[i]; g += p[i + 1]; b += p[i + 2]; al += p[i + 3];
    }
    const i = (y * w + x) * 4; o[i] = r / n; o[i + 1] = g / n; o[i + 2] = b / n; o[i + 3] = al / n;
  }
  fromPre(o, d);
}
function unsharp(d: Uint8ClampedArray, w: number, h: number, amount: number, radius: number, threshold: number) {
  const src = toPre(d), blur = Float32Array.from(src); gaussianBlurPre(blur, w, h, radius);
  const k = amount / 100;
  for (let i = 0; i < src.length; i += 4) for (let c = 0; c < 3; c++) {
    const diff = src[i + c] - blur[i + c];
    if (Math.abs(diff) >= threshold) src[i + c] = clamp(src[i + c] + k * diff, 0, src[i + 3]);
  }
  fromPre(src, d);
}
function mulberry32(a: number) { return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function addNoise(d: Uint8ClampedArray, amount: number, gaussian: boolean, mono: boolean, seed: number) {
  const rnd = mulberry32(seed | 0), k = (amount / 100) * 255;
  const draw = () => (gaussian ? (Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd())) * k * 0.4 : (rnd() * 2 - 1) * k);
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    const n = draw();
    d[i] = clamp(d[i] + (mono ? n : draw())); d[i + 1] = clamp(d[i + 1] + (mono ? n : draw())); d[i + 2] = clamp(d[i + 2] + (mono ? n : draw()));
  }
}
function mosaic(d: Uint8ClampedArray, w: number, h: number, cell: number) {
  const s = Math.max(2, Math.round(cell)), p = toPre(d);
  for (let by = 0; by < h; by += s) for (let bx = 0; bx < w; bx += s) {
    const x1 = Math.min(w, bx + s), y1 = Math.min(h, by + s); let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (let y = by; y < y1; y++) for (let x = bx; x < x1; x++) { const i = (y * w + x) * 4; r += p[i]; g += p[i + 1]; b += p[i + 2]; a += p[i + 3]; n++; }
    r /= n; g /= n; b /= n; a /= n;
    for (let y = by; y < y1; y++) for (let x = bx; x < x1; x++) { const i = (y * w + x) * 4; p[i] = r; p[i + 1] = g; p[i + 2] = b; p[i + 3] = a; }
  }
  fromPre(p, d);
}
/** Run one smart filter over RGBA pixels in place. */
export function applySmartFilter(f: SmartFilter, d: Uint8ClampedArray, w: number, h: number) {
  const p = f.p;
  switch (f.kind) {
    case 'gaussian': { const q = toPre(d); gaussianBlurPre(q, w, h, p.radius); fromPre(q, d); break; }
    case 'box': { const q = toPre(d); boxBlurPre(q, w, h, p.radius); fromPre(q, d); break; }
    case 'motion': motionBlur(d, w, h, p.angle, p.distance); break;
    case 'unsharp': unsharp(d, w, h, p.amount, p.radius, p.threshold); break;
    case 'noise': addNoise(d, p.amount, !!p.gaussian, !!p.mono, p.seed); break;
    case 'mosaic': mosaic(d, w, h, p.cell); break;
    case 'invert': for (let i = 0; i < d.length; i += 4) if (d[i + 3]) { d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2]; } break;
    case 'brightness': {
      const bk = 1 + p.b / 100, ck = 1 + p.c / 100;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3]) for (let c = 0; c < 3; c++) d[i + c] = clamp((d[i + c] * bk - 127.5) * ck + 127.5);
      break;
    }
  }
}
export function applySmartFilters(list: SmartFilter[] | undefined, d: Uint8ClampedArray, w: number, h: number) { for (const f of list ?? []) if (f.on) applySmartFilter(f, d, w, h); }

// ---------------------------------------------------------------- PSD conversion
const px = (v: number) => ({ units: 'Pixels' as const, value: v });
const val = (u: { value: number } | number | undefined, d: number) => (typeof u === 'number' ? u : u?.value ?? d);
export function toPsdFilters(list: SmartFilter[]): Filter[] {
  const base = (name: string, on: boolean) => ({ name, opacity: 1, blendMode: 'normal' as const, enabled: on, hasOptions: true, foregroundColor: { r: 0, g: 0, b: 0 }, backgroundColor: { r: 255, g: 255, b: 255 } });
  return list.map((f): Filter => {
    const b = base(FILTER_INFO[f.kind].label, f.on), p = f.p;
    switch (f.kind) {
      case 'gaussian': return { ...b, type: 'gaussian blur', filter: { radius: px(p.radius) } };
      case 'box': return { ...b, type: 'box blur', filter: { radius: px(p.radius) } };
      case 'motion': return { ...b, type: 'motion blur', filter: { angle: p.angle, distance: px(p.distance) } };
      case 'unsharp': return { ...b, type: 'unsharp mask', filter: { amount: p.amount, radius: px(p.radius), threshold: p.threshold } };
      case 'noise': return { ...b, type: 'add noise', filter: { amount: p.amount, distribution: p.gaussian ? 'gaussian' : 'uniform', monochromatic: !!p.mono, randomSeed: p.seed } };
      case 'mosaic': return { ...b, type: 'mosaic', filter: { cellSize: px(p.cell) } };
      case 'invert': return { ...b, type: 'invert' };
      case 'brightness': return { ...b, type: 'brightness/contrast', filter: { brightness: Math.round(clamp(p.b * 1.5, -150, 150)), contrast: Math.round(clamp(p.c, -50, 100)), useLegacy: true } };
    }
  });
}
/** Filters PixelForge understands, plus the ones it only carries along (so saving doesn't lose them). */
export function fromPsdFilters(list: Filter[] | undefined): { filters: SmartFilter[]; unsupported: Filter[] } {
  const filters: SmartFilter[] = [], unsupported: Filter[] = [];
  for (const f of list ?? []) {
    const on = f.enabled !== false;
    switch (f.type) {
      case 'gaussian blur': filters.push({ kind: 'gaussian', on, p: { radius: val(f.filter.radius, 5) } }); break;
      case 'box blur': filters.push({ kind: 'box', on, p: { radius: val(f.filter.radius, 5) } }); break;
      case 'motion blur': filters.push({ kind: 'motion', on, p: { angle: f.filter.angle ?? 0, distance: val(f.filter.distance, 20) } }); break;
      case 'unsharp mask': filters.push({ kind: 'unsharp', on, p: { amount: f.filter.amount, radius: val(f.filter.radius, 2), threshold: f.filter.threshold ?? 0 } }); break;
      case 'add noise': filters.push({ kind: 'noise', on, p: { amount: f.filter.amount, gaussian: f.filter.distribution === 'gaussian' ? 1 : 0, mono: f.filter.monochromatic ? 1 : 0, seed: f.filter.randomSeed ?? 1 } }); break;
      case 'mosaic': filters.push({ kind: 'mosaic', on, p: { cell: val(f.filter.cellSize, 10) } }); break;
      case 'invert': filters.push({ kind: 'invert', on, p: {} }); break;
      case 'brightness/contrast': filters.push({ kind: 'brightness', on, p: { b: clamp(f.filter.brightness / 1.5, -100, 100), c: clamp(f.filter.contrast, -100, 100) } }); break;
      default: unsupported.push(f);
    }
  }
  return { filters, unsupported };
}
