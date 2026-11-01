// Pure tone-adjustment maths (no DOM / app imports) so it can be unit-tested in Node.

export interface LevelsParams { ib: number; gamma: number; iw: number; ob: number; ow: number }
export const identityLevels = (): LevelsParams => ({ ib: 0, gamma: 1, iw: 255, ob: 0, ow: 255 });
export const isIdentityLevels = (p: LevelsParams) => p.ib === 0 && p.iw === 255 && p.ob === 0 && p.ow === 255 && Math.abs(p.gamma - 1) < 1e-3;

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/** Photoshop-style Levels: input black/white, midtone gamma, output black/white. */
export function levelsLUT(p: LevelsParams): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256);
  const range = Math.max(1, p.iw - p.ib), inv = 1 / Math.max(0.01, p.gamma);
  for (let v = 0; v < 256; v++) {
    const t = Math.min(1, Math.max(0, (v - p.ib) / range));
    lut[v] = clamp255(p.ob + Math.pow(t, inv) * (p.ow - p.ob));
  }
  return lut;
}

/** x position (0-255 input value) where the gamma handle sits for the given params. */
export const gammaHandleX = (p: LevelsParams) => p.ib + (p.iw - p.ib) * Math.pow(0.5, p.gamma);
/** Inverse of gammaHandleX: gamma that places the handle at x. */
export function gammaFromHandle(ib: number, iw: number, x: number) {
  const t = Math.min(0.99, Math.max(0.01, (x - ib) / Math.max(1, iw - ib)));
  return Math.min(9.99, Math.max(0.1, Math.log(t) / Math.log(0.5)));
}

export interface CurvePoint { x: number; y: number }
export const identityCurve = (): CurvePoint[] => [{ x: 0, y: 0 }, { x: 255, y: 255 }];

/** Smooth, overshoot-free (monotone cubic / Fritsch–Carlson) curve through the points. */
export function curveLUT(points: CurvePoint[]): Uint8ClampedArray {
  const pts = [...points].sort((a, b) => a.x - b.x).filter((p, i, a) => i === 0 || p.x > a[i - 1].x);
  const lut = new Uint8ClampedArray(256), n = pts.length;
  if (n === 0) { for (let i = 0; i < 256; i++) lut[i] = i; return lut; }
  if (n === 1) { lut.fill(clamp255(pts[0].y)); return lut; }
  const h: number[] = [], d: number[] = [], m: number[] = new Array(n).fill(0);
  for (let k = 0; k < n - 1; k++) { h[k] = pts[k + 1].x - pts[k].x; d[k] = (pts[k + 1].y - pts[k].y) / h[k]; }
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let k = 1; k < n - 1; k++) m[k] = d[k - 1] * d[k] <= 0 ? 0 : (d[k - 1] + d[k]) / 2;
  for (let k = 0; k < n - 1; k++) {
    if (d[k] === 0) { m[k] = 0; m[k + 1] = 0; continue; }
    const a = m[k] / d[k], b = m[k + 1] / d[k], s = a * a + b * b;
    if (s > 9) { const tau = 3 / Math.sqrt(s); m[k] = tau * a * d[k]; m[k + 1] = tau * b * d[k]; }
  }
  let seg = 0;
  for (let x = 0; x < 256; x++) {
    if (x <= pts[0].x) { lut[x] = clamp255(pts[0].y); continue; }
    if (x >= pts[n - 1].x) { lut[x] = clamp255(pts[n - 1].y); continue; }
    while (seg < n - 2 && x > pts[seg + 1].x) seg++;
    const t = (x - pts[seg].x) / h[seg], t2 = t * t, t3 = t2 * t;
    const y = (2 * t3 - 3 * t2 + 1) * pts[seg].y + (t3 - 2 * t2 + t) * h[seg] * m[seg] + (-2 * t3 + 3 * t2) * pts[seg + 1].y + (t3 - t2) * h[seg] * m[seg + 1];
    lut[x] = clamp255(y);
  }
  return lut;
}

export type Channel = 'rgb' | 'r' | 'g' | 'b';
export interface RGBLUTs { r: Uint8ClampedArray; g: Uint8ClampedArray; b: Uint8ClampedArray }

/** Final per-channel tables: the master (RGB) curve is applied after each channel's own curve. */
export function combineLUTs(master: Uint8ClampedArray, r: Uint8ClampedArray, g: Uint8ClampedArray, b: Uint8ClampedArray): RGBLUTs {
  const out: RGBLUTs = { r: new Uint8ClampedArray(256), g: new Uint8ClampedArray(256), b: new Uint8ClampedArray(256) };
  for (let v = 0; v < 256; v++) { out.r[v] = master[r[v]]; out.g[v] = master[g[v]]; out.b[v] = master[b[v]]; }
  return out;
}

/** Apply tables to RGBA pixels (alpha untouched). `src` and `dst` may be the same array. */
export function applyLUTs(src: Uint8ClampedArray, dst: Uint8ClampedArray, l: RGBLUTs) {
  for (let i = 0; i < src.length; i += 4) {
    dst[i] = l.r[src[i]]; dst[i + 1] = l.g[src[i + 1]]; dst[i + 2] = l.b[src[i + 2]]; dst[i + 3] = src[i + 3];
  }
}

/** 256-bin histogram over non-transparent pixels. 'rgb' uses luminance. */
export function histogramOf(data: Uint8ClampedArray, ch: Channel): Uint32Array {
  const h = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const v = ch === 'r' ? data[i] : ch === 'g' ? data[i + 1] : ch === 'b' ? data[i + 2] : (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
    h[v]++;
  }
  return h;
}

/** Input black/white points that clip `clip` (fraction) of pixels from each end. */
export function autoPoints(hist: Uint32Array, clip = 0.005): { ib: number; iw: number } {
  let total = 0;
  for (const c of hist) total += c;
  if (!total) return { ib: 0, iw: 255 };
  const limit = total * clip;
  let ib = 0, acc = 0;
  while (ib < 255 && acc + hist[ib] <= limit) acc += hist[ib++];
  let iw = 255; acc = 0;
  while (iw > 0 && acc + hist[iw] <= limit) acc += hist[iw--];
  if (iw - ib < 2) return { ib: 0, iw: 255 };
  return { ib, iw };
}
