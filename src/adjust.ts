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

// ---------------------------------------------------------------- adjustment-layer data
export type AdjustmentData =
  | { type: 'levels'; P: Record<Channel, LevelsParams> }
  | { type: 'curves'; P: Record<Channel, CurvePoint[]> }
  | { type: 'invert' }
  | { type: 'brightness'; b: number; c: number }   // both -100..100
  | { type: 'hue'; h: number; s: number }          // hue -180..180 deg, saturation -100..100
  | { type: 'posterize'; levels: number }          // 2..255
  | { type: 'threshold'; level: number }           // 1..255
  | { type: 'exposure'; exposure: number; offset: number; gamma: number }
  | { type: 'vibrance'; vibrance: number; saturation: number }   // -100..100
  | { type: 'bw'; w: number[]; tint: RGB | null }                // weights: reds, yellows, greens, cyans, blues, magentas (%)
  | { type: 'photo'; color: RGB; density: number; lum: boolean } // density 0..100
  | { type: 'balance'; shadows: Tri; mids: Tri; highs: Tri; lum: boolean }   // each -100..100 (cyan-red, magenta-green, yellow-blue)
  | { type: 'mixer'; mono: boolean; rows: number[][] }           // rows: out R,G,B (or gray) -> [r,g,b,const] in %
  | { type: 'gradmap'; stops: GradStop[]; reverse: boolean }
  | { type: 'lookup'; name: string; size: number; data: number[] }   // 3D LUT, red varies fastest, values 0..1
  | { type: 'selective'; relative: boolean; r: number[][] };     // 9 ranges (SELECTIVE_RANGES) × [c, m, y, k] in -100..100
export function identityCube(size: number): number[] {
  const out: number[] = [];
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) out.push(r / (size - 1), g / (size - 1), b / (size - 1));
  return out;
}
/** Parses an Adobe/Resolve .cube 3D LUT (red index varies fastest). Throws on malformed input. */
export function parseCube(text: string): { name: string; size: number; data: number[] } {
  let size = 0, name = '', lo = [0, 0, 0], hi = [1, 1, 1];
  const data: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const t = line.split(/\s+/);
    if (t[0] === 'TITLE') name = line.slice(5).trim().replace(/^"|"$/g, '');
    else if (t[0] === 'LUT_3D_SIZE') size = parseInt(t[1], 10);
    else if (t[0] === 'DOMAIN_MIN') lo = t.slice(1, 4).map(Number);
    else if (t[0] === 'DOMAIN_MAX') hi = t.slice(1, 4).map(Number);
    else if (t[0] === 'LUT_1D_SIZE') throw new Error('1D LUTs are not supported');
    else if (/^[-+\d.]/.test(t[0]) && t.length >= 3) data.push(...t.slice(0, 3).map((v, i) => (Number(v) - lo[i]) / ((hi[i] - lo[i]) || 1)));
  }
  if (!(size >= 2 && size <= 256)) throw new Error('missing or invalid LUT_3D_SIZE');
  if (data.length !== size ** 3 * 3 || data.some((v) => !Number.isFinite(v))) throw new Error('LUT data does not match its size');
  return { name, size, data };
}
export function cubeText(a: { name: string; size: number; data: number[] }): string {
  const rows: string[] = [`TITLE "${a.name.replace(/"/g, '')}"`, `LUT_3D_SIZE ${a.size}`, 'DOMAIN_MIN 0.0 0.0 0.0', 'DOMAIN_MAX 1.0 1.0 1.0'];
  for (let i = 0; i < a.data.length; i += 3) rows.push(`${a.data[i].toFixed(6)} ${a.data[i + 1].toFixed(6)} ${a.data[i + 2].toFixed(6)}`);
  return rows.join('\n') + '\n';
}
export const SELECTIVE_RANGES = ['Reds', 'Yellows', 'Greens', 'Cyans', 'Blues', 'Magentas', 'Whites', 'Neutrals', 'Blacks'];
export type RGB = [number, number, number];
export type Tri = [number, number, number];
export interface GradStop { x: number; c: RGB; a: number }
export type AdjustmentType = AdjustmentData['type'];

export const ADJUSTMENT_LABELS: Record<AdjustmentType, string> = {
  levels: 'Levels', curves: 'Curves', invert: 'Invert', brightness: 'Brightness/Contrast', hue: 'Hue/Saturation',
  posterize: 'Posterize', threshold: 'Threshold', exposure: 'Exposure', vibrance: 'Vibrance', bw: 'Black & White',
  photo: 'Photo Filter', lookup: 'Color Lookup', selective: 'Selective Color', balance: 'Color Balance', mixer: 'Channel Mixer', gradmap: 'Gradient Map',
};
export const CHANNELS_ALL: Channel[] = ['rgb', 'r', 'g', 'b'];

export function defaultAdjustment(type: AdjustmentType): AdjustmentData {
  switch (type) {
    case 'levels': return { type, P: { rgb: identityLevels(), r: identityLevels(), g: identityLevels(), b: identityLevels() } };
    case 'curves': return { type, P: { rgb: identityCurve(), r: identityCurve(), g: identityCurve(), b: identityCurve() } };
    case 'invert': return { type };
    case 'brightness': return { type, b: 0, c: 0 };
    case 'hue': return { type, h: 0, s: 0 };
    case 'posterize': return { type, levels: 4 };
    case 'threshold': return { type, level: 128 };
    case 'exposure': return { type, exposure: 0, offset: 0, gamma: 1 };
    case 'vibrance': return { type, vibrance: 0, saturation: 0 };
    case 'bw': return { type, w: [40, 60, 40, 60, 20, 80], tint: null };
    case 'photo': return { type, color: [236, 138, 0], density: 25, lum: true };
    case 'balance': return { type, shadows: [0, 0, 0], mids: [0, 0, 0], highs: [0, 0, 0], lum: true };
    case 'mixer': return { type, mono: false, rows: [[100, 0, 0, 0], [0, 100, 0, 0], [0, 0, 100, 0]] };
    case 'lookup': return { type, name: '', size: 2, data: identityCube(2) };
    case 'selective': return { type, relative: true, r: SELECTIVE_RANGES.map(() => [0, 0, 0, 0]) };
    case 'gradmap': return { type, stops: [{ x: 0, c: [0, 0, 0], a: 1 }, { x: 1, c: [255, 255, 255], a: 1 }], reverse: false };
  }
}
export const cloneAdjustment = (a: AdjustmentData): AdjustmentData => JSON.parse(JSON.stringify(a));
export const sameAdjustment = (a: AdjustmentData, b: AdjustmentData) => JSON.stringify(a) === JSON.stringify(b);

/** Per-channel tables for LUT-based adjustments; null for ones rendered with a CSS filter. */
export function lutsFor(a: AdjustmentData): RGBLUTs | null {
  switch (a.type) {
    case 'levels': return combineLUTs(levelsLUT(a.P.rgb), levelsLUT(a.P.r), levelsLUT(a.P.g), levelsLUT(a.P.b));
    case 'curves': return combineLUTs(curveLUT(a.P.rgb), curveLUT(a.P.r), curveLUT(a.P.g), curveLUT(a.P.b));
    case 'invert': { const t = new Uint8ClampedArray(256).map((_, i) => 255 - i); return { r: t, g: t, b: t }; }
    default: return null;
  }
}
/** CSS filter for filter-based adjustments. */
export function filterFor(a: AdjustmentData): string | null {
  if (a.type === 'brightness') return `brightness(${1 + a.b / 100}) contrast(${1 + a.c / 100})`;
  if (a.type === 'hue') return `hue-rotate(${a.h}deg) saturate(${Math.max(0, 1 + a.s / 100)})`;
  return null;
}

// ---------------------------------------------------------------- per-pixel adjustments
const lum255 = (r: number, g: number, b: number) => 0.3 * r + 0.59 * g + 0.11 * b;
const toLin = (v: number) => Math.pow(v / 255, 2.2), fromLin = (v: number) => 255 * Math.pow(Math.max(0, v), 1 / 2.2);

/** CIE Lab (D50, as Photoshop stores it) -> sRGB 0..255. */
export function labToRgb(L: number, a: number, b: number): RGB {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const f = (t: number) => (t * t * t > 0.008856 ? t * t * t : (t - 16 / 116) / 7.787);
  const X = 0.9642 * f(fx), Y = f(fy), Z = 0.8249 * f(fz);       // D50 white
  const rl = 3.1338561 * X - 1.6168667 * Y - 0.4906146 * Z;       // XYZ(D50) -> linear sRGB (Bradford-adapted)
  const gl = -0.9787684 * X + 1.9161415 * Y + 0.0334540 * Z;
  const bl = 0.0719453 * X - 0.2289914 * Y + 1.4052427 * Z;
  const gm = (c: number) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055);
  return [clamp255(gm(rl)), clamp255(gm(gl)), clamp255(gm(bl))];
}

/** Colour from a PSD descriptor colour (RGB 0..255, or Lab with normalised a/b). */
export function psdColorToRgb(c: any): RGB {
  if (!c) return [0, 0, 0];
  if ('l' in c) return labToRgb(c.l * 100, c.a < 0 ? c.a * 128 : c.a * 127, c.b < 0 ? c.b * 128 : c.b * 127);
  if ('r' in c) return [clamp255(c.r), clamp255(c.g), clamp255(c.b)];
  if ('h' in c) {                                                  // HSB 0..360, 0..100, 0..100 (ag-psd units: h 0..1?)
    const h = (c.h > 1 ? c.h / 360 : c.h) * 6, s = c.s > 1 ? c.s / 100 : c.s, v = c.b > 1 ? c.b / 100 : c.b;
    const i = Math.floor(h) % 6, f = h - Math.floor(h), p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    const [r, g, bb] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i];
    return [r * 255, g * 255, bb * 255];
  }
  if ('k' in c && !('c' in c)) { const g = 255 * (1 - c.k / 255); return [g, g, g]; }
  return [0, 0, 0];
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 0) h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, mx === 0 ? 0 : d / mx, mx / 255];
}

/** Interpolated colour+alpha of a gradient-map ramp, as a 256-entry table (rgba). */
export function gradientRamp(stops: GradStop[], reverse: boolean): Uint8ClampedArray {
  const st = [...stops].sort((p, q) => p.x - q.x), out = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = reverse ? 1 - i / 255 : i / 255;
    let k = 0;
    while (k < st.length - 1 && t > st[k + 1].x) k++;
    const A = st[k], B = st[Math.min(k + 1, st.length - 1)];
    const u = B.x > A.x ? Math.min(1, Math.max(0, (t - A.x) / (B.x - A.x))) : 0;
    for (let c = 0; c < 3; c++) out[i * 4 + c] = A.c[c] + (B.c[c] - A.c[c]) * u;
    out[i * 4 + 3] = 255 * (A.a + (B.a - A.a) * u);
  }
  return out;
}

/** Black & White: grey = min + Σ(weight of the hue segments)·(max−min), the formula Photoshop documents. */
export function bwGray(r: number, g: number, b: number, w: number[]): number {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (d === 0) return mn;
  const [h] = rgbToHsv(r, g, b);
  const seg = Math.floor(h / 60) % 6, f = (h - seg * 60) / 60;
  const wt = (w[seg] * (1 - f) + w[(seg + 1) % 6] * f) / 100;
  return mn + d * wt;
}

function balanceWeights(l: number): Tri {      // l: 0..1 luminance -> shadow, mid, highlight weights (sum to 1)
  return [Math.max(0, 1 - 2 * l), 1 - Math.abs(2 * l - 1), Math.max(0, 2 * l - 1)];
}

/** Applies a non-LUT, non-CSS-filter adjustment in place. Returns false when `a` is not a per-pixel adjustment. */
export function applyPixelAdjustment(a: AdjustmentData, d: Uint8ClampedArray): boolean {
  const n = d.length;
  switch (a.type) {
    case 'posterize': {
      const N = Math.max(2, Math.min(255, Math.round(a.levels))), t = new Uint8ClampedArray(256);
      for (let v = 0; v < 256; v++) t[v] = Math.round(Math.floor(v / 256 * N) * 255 / (N - 1));
      for (let i = 0; i < n; i += 4) { d[i] = t[d[i]]; d[i + 1] = t[d[i + 1]]; d[i + 2] = t[d[i + 2]]; }
      return true;
    }
    case 'threshold':
      for (let i = 0; i < n; i += 4) { const v = lum255(d[i], d[i + 1], d[i + 2]) >= a.level ? 255 : 0; d[i] = d[i + 1] = d[i + 2] = v; }
      return true;
    case 'exposure': {
      const k = Math.pow(2, a.exposure), t = new Uint8ClampedArray(256), ig = 1 / Math.max(0.01, a.gamma);
      for (let v = 0; v < 256; v++) {
        const lin = toLin(v) * k + a.offset;
        t[v] = fromLin(Math.pow(Math.max(0, Math.min(1, lin)), ig));
      }
      for (let i = 0; i < n; i += 4) { d[i] = t[d[i]]; d[i + 1] = t[d[i + 1]]; d[i + 2] = t[d[i + 2]]; }
      return true;
    }
    case 'vibrance': {
      const vb = a.vibrance / 100, sa = a.saturation / 100;
      for (let i = 0; i < n; i += 4) {
        let r = d[i], g = d[i + 1], b = d[i + 2];
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b), sat = mx === 0 ? 0 : (mx - mn) / mx, avg = (r + g + b) / 3;
        const f = Math.max(0, 1 + sa + vb * (1 - sat));                    // vibrance acts mostly on muted colours
        r = avg + (r - avg) * f; g = avg + (g - avg) * f; b = avg + (b - avg) * f;
        d[i] = clamp255(r); d[i + 1] = clamp255(g); d[i + 2] = clamp255(b);
      }
      return true;
    }
    case 'bw': {
      const tint = a.tint;
      for (let i = 0; i < n; i += 4) {
        const gv = clamp255(bwGray(d[i], d[i + 1], d[i + 2], a.w));
        if (tint) {                                                       // tint ramp: black -> tint colour at its own luminance -> white
          const lt = Math.max(1, Math.min(254, lum255(tint[0], tint[1], tint[2]))), lo = gv <= lt, m = gv / lt, u = (gv - lt) / (255 - lt);
          for (let c = 0; c < 3; c++) d[i + c] = clamp255(lo ? tint[c] * m : tint[c] + (255 - tint[c]) * u);
        } else d[i] = d[i + 1] = d[i + 2] = gv;
      }
      return true;
    }
    case 'photo': {
      const dn = a.density / 100, [fr, fg, fb] = a.color;
      for (let i = 0; i < n; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        let nr = r + (r * fr / 255 - r) * dn, ng = g + (g * fg / 255 - g) * dn, nb = b + (b * fb / 255 - b) * dn;
        if (a.lum) {
          const l0 = lum255(r, g, b), l1 = lum255(nr, ng, nb);
          if (l1 > 0) { const k = l0 / l1; nr *= k; ng *= k; nb *= k; } else { nr = ng = nb = l0; }
        }
        d[i] = clamp255(nr); d[i + 1] = clamp255(ng); d[i + 2] = clamp255(nb);
      }
      return true;
    }
    case 'balance': {
      for (let i = 0; i < n; i += 4) {
        const r0 = d[i], g0 = d[i + 1], b0 = d[i + 2], l = lum255(r0, g0, b0) / 255;
        const [ws, wm, wh] = balanceWeights(l);
        const dr = (a.shadows[0] * ws + a.mids[0] * wm + a.highs[0] * wh) / 100;
        const dg = (a.shadows[1] * ws + a.mids[1] * wm + a.highs[1] * wh) / 100;
        const db = (a.shadows[2] * ws + a.mids[2] * wm + a.highs[2] * wh) / 100;
        let r = r0 + 127 * dr, g = g0 + 127 * dg, b = b0 + 127 * db;
        if (a.lum) {
          const l1 = lum255(r, g, b);
          if (l1 > 0) { const k = lum255(r0, g0, b0) / l1; r *= k; g *= k; b *= k; }
        }
        d[i] = clamp255(r); d[i + 1] = clamp255(g); d[i + 2] = clamp255(b);
      }
      return true;
    }
    case 'mixer': {
      const R = a.rows;
      for (let i = 0; i < n; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const f = (row: number[]) => clamp255((row[0] * r + row[1] * g + row[2] * b) / 100 + row[3] * 2.55);
        if (a.mono) { const v = f(R[0]); d[i] = d[i + 1] = d[i + 2] = v; }
        else { d[i] = f(R[0]); d[i + 1] = f(R[1]); d[i + 2] = f(R[2]); }
      }
      return true;
    }
    case 'lookup': {
      const N = a.size, L = a.data, m = N - 1, s2 = N * N;
      for (let i = 0; i < n; i += 4) {
        const fr = d[i] / 255 * m, fg = d[i + 1] / 255 * m, fb = d[i + 2] / 255 * m;
        const r0 = Math.min(m - 1, Math.floor(fr)), g0 = Math.min(m - 1, Math.floor(fg)), b0 = Math.min(m - 1, Math.floor(fb));
        const tr = fr - r0, tg = fg - g0, tb = fb - b0, base = (b0 * s2 + g0 * N + r0) * 3;
        for (let c = 0; c < 3; c++) {
          const at = (dr: number, dg: number, db: number) => L[base + (db * s2 + dg * N + dr) * 3 + c];
          const c00 = at(0, 0, 0) * (1 - tr) + at(1, 0, 0) * tr, c10 = at(0, 1, 0) * (1 - tr) + at(1, 1, 0) * tr;
          const c01 = at(0, 0, 1) * (1 - tr) + at(1, 0, 1) * tr, c11 = at(0, 1, 1) * (1 - tr) + at(1, 1, 1) * tr;
          const v = (c00 * (1 - tg) + c10 * tg) * (1 - tb) + (c01 * (1 - tg) + c11 * tg) * tb;
          d[i + c] = clamp255(v * 255);
        }
      }
      return true;
    }
    case 'selective': {
      if (a.r.every((q) => q.every((v) => v === 0))) return true;
      for (let i = 0; i < n; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        const w = new Array<number>(9).fill(0), chroma = (mx - mn) / 255;
        if (mx > mn) {
          const [h] = rgbToHsv(r, g, b);
          for (let k = 0; k < 6; k++) { let dh = Math.abs(h - k * 60); if (dh > 180) dh = 360 - dh; w[k] = Math.max(0, 1 - dh / 60) * chroma; }
        }
        w[6] = Math.max(0, (mn - 128) / 127);                                   // whites
        w[8] = Math.max(0, (128 - mx) / 128);                                   // blacks
        w[7] = Math.max(0, 1 - (Math.abs(mx - 128) + Math.abs(mn - 128)) / 255) * (1 - chroma); // neutrals
        const k0 = 1 - mx / 255, ik = 1 - k0;                                   // RGB -> CMYK (max-channel black)
        const c = ik > 0 ? 1 - r / 255 / ik : 0, m = ik > 0 ? 1 - g / 255 / ik : 0, y = ik > 0 ? 1 - b / 255 / ik : 0;
        let dc = 0, dm = 0, dy = 0, dk = 0;
        for (let j = 0; j < 9; j++) {
          if (!w[j]) continue;
          const q = a.r[j], f = w[j] / 100;
          if (a.relative) { dc += q[0] * f * c; dm += q[1] * f * m; dy += q[2] * f * y; dk += q[3] * f * k0; }
          else { dc += q[0] * f; dm += q[1] * f; dy += q[2] * f; dk += q[3] * f; }
        }
        const cc = Math.min(1, Math.max(0, c + dc)), mm = Math.min(1, Math.max(0, m + dm)), yy = Math.min(1, Math.max(0, y + dy)), kk = Math.min(1, Math.max(0, k0 + dk));
        d[i] = 255 * (1 - cc) * (1 - kk); d[i + 1] = 255 * (1 - mm) * (1 - kk); d[i + 2] = 255 * (1 - yy) * (1 - kk);
      }
      return true;
    }
    case 'gradmap': {
      const ramp = gradientRamp(a.stops, a.reverse);
      for (let i = 0; i < n; i += 4) {
        const k = Math.round(clamp255(lum255(d[i], d[i + 1], d[i + 2]))) * 4, al = ramp[k + 3] / 255;
        d[i] = d[i] + (ramp[k] - d[i]) * al; d[i + 1] = d[i + 1] + (ramp[k + 1] - d[i + 1]) * al; d[i + 2] = d[i + 2] + (ramp[k + 2] - d[i + 2]) * al;
      }
      return true;
    }
    default: return false;
  }
}
/** Applies any adjustment that works on pixel data (LUT or per-pixel). False means it needs the CSS-filter path. */
export function applyAdjustmentData(a: AdjustmentData, d: Uint8ClampedArray): boolean {
  const luts = lutsFor(a);
  if (luts) { applyLUTs(d, d, luts); return true; }
  return applyPixelAdjustment(a, d);
}
export const isPixelAdjustment = (a: AdjustmentData) => a.type !== 'brightness' && a.type !== 'hue';
