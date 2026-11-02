// Layer-style contours: tone curves that reshape an effect's falloff (pure; unit-tested).
export type CPt = [number, number];                    // x, y in 0…255 (Photoshop's contour editor range)
export interface Contour { name: string; pts?: CPt[]; /** Custom curves: straight segments between points instead of a smooth curve. */ corner?: boolean }

interface Preset { pts: CPt[]; smooth: boolean }
/** Photoshop's contour presets (approximations of the stock curves). */
export const CONTOUR_PRESETS: Record<string, Preset> = {
  'Linear': { pts: [[0, 0], [255, 255]], smooth: false },
  'Cone': { pts: [[0, 0], [128, 255], [255, 0]], smooth: false },
  'Cone - Inverted': { pts: [[0, 255], [128, 0], [255, 255]], smooth: false },
  'Cove - Deep': { pts: [[0, 0], [40, 130], [128, 215], [255, 255]], smooth: true },
  'Cove - Shallow': { pts: [[0, 0], [64, 110], [160, 200], [255, 255]], smooth: true },
  'Gaussian': { pts: [[0, 0], [60, 20], [128, 128], [196, 236], [255, 255]], smooth: true },
  'Half Round': { pts: [[0, 0], [16, 85], [64, 190], [128, 235], [255, 255]], smooth: true },
  'Ring': { pts: [[0, 0], [64, 255], [128, 0], [255, 0]], smooth: true },
  'Ring - Double': { pts: [[0, 0], [32, 255], [64, 0], [96, 255], [128, 0], [255, 0]], smooth: true },
  'Rolling Slope - Descending': { pts: [[0, 0], [64, 110], [128, 150], [192, 100], [255, 0]], smooth: true },
  'Rounded Steps': { pts: [[0, 0], [64, 0], [96, 85], [128, 85], [160, 170], [192, 170], [224, 255], [255, 255]], smooth: false },
  'Saw Tooth 1': { pts: [[0, 0], [84, 255], [85, 0], [169, 255], [170, 0], [255, 255]], smooth: false },
  'Saw Tooth 2': { pts: [[0, 0], [62, 255], [63, 0], [126, 255], [127, 0], [190, 255], [191, 0], [255, 255]], smooth: false },
};
export const CONTOUR_NAMES = Object.keys(CONTOUR_PRESETS);

/** 256-entry table (0…1 → 0…1) for a contour, or null when it is the identity. */
export function contourLUT(c: Contour | undefined | null): Float32Array | null {
  if (!c) return null;
  const preset = CONTOUR_PRESETS[c.name], pts = (c.pts ?? preset?.pts)?.slice().sort((a, b) => a[0] - b[0]);
  if (!pts || pts.length < 2 || c.name === 'Linear' && !c.pts) return null;
  const smooth = c.pts ? !c.corner && c.pts.length > 2 && !isStepped(pts) : preset?.smooth ?? false;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]), n = pts.length, lut = new Float32Array(256);
  // monotone cubic (Fritsch–Carlson) tangents for smooth curves
  const dx = xs.slice(1).map((x, i) => x - xs[i]), sl = ys.slice(1).map((y, i) => (dx[i] ? (y - ys[i]) / dx[i] : 0)), m = new Array<number>(n).fill(0);
  if (smooth && n > 2) {
    m[0] = sl[0]; m[n - 1] = sl[n - 2];
    for (let i = 1; i < n - 1; i++) m[i] = sl[i - 1] * sl[i] <= 0 ? 0 : (sl[i - 1] + sl[i]) / 2;
    for (let i = 0; i < n - 1; i++) { if (sl[i] === 0) { m[i] = m[i + 1] = 0; continue; } const a = m[i] / sl[i], b = m[i + 1] / sl[i], s = a * a + b * b; if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * sl[i]; m[i + 1] = t * b * sl[i]; } }
  }
  for (let v = 0; v < 256; v++) {
    let i = 0; while (i < n - 2 && v >= xs[i + 1]) i++;
    let y: number;
    if (v <= xs[0]) y = ys[0]; else if (v >= xs[n - 1]) y = ys[n - 1];
    else if (!smooth || !dx[i]) y = ys[i] + sl[i] * (v - xs[i]);
    else { const t = (v - xs[i]) / dx[i], t2 = t * t, t3 = t2 * t; y = (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * dx[i] * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * dx[i] * m[i + 1]; }
    lut[v] = Math.min(1, Math.max(0, y / 255));
  }
  return lut;
}
const isStepped = (pts: CPt[]) => pts.some((p, i) => i && p[0] - pts[i - 1][0] <= 1);
/** Apply a contour table to a 0…1 value. */
export const mapContour = (lut: Float32Array, v: number) => { const x = Math.min(255, Math.max(0, v * 255)), i = Math.floor(x), f = x - i; return lut[i] + (lut[Math.min(255, i + 1)] - lut[i]) * f; };
/** Remap a 0…1 field in place. */
export function remapField(a: Float32Array, lut: Float32Array) { for (let i = 0; i < a.length; i++) a[i] = mapContour(lut, a[i]); }

// ---- PSD
export const toPsdContour = (c: Contour | undefined) => {
  if (!c) return undefined;
  const pts = c.pts ?? CONTOUR_PRESETS[c.name]?.pts;
  return pts ? { name: c.name, curve: pts.map(([x, y]) => ({ x, y })) } : undefined;
};
export function fromPsdContour(c: { name: string; curve: { x: number; y: number }[] } | undefined): Contour | undefined {
  if (!c?.curve?.length) return undefined;
  const pts = c.curve.map((p) => [p.x, p.y] as CPt), preset = CONTOUR_PRESETS[c.name];
  if (/^linear$/i.test(c.name) || (pts.length === 2 && pts[0][0] === 0 && pts[0][1] === 0 && pts[1][0] === 255 && pts[1][1] === 255)) return undefined;
  const same = preset && preset.pts.length === pts.length && preset.pts.every((p, i) => p[0] === pts[i][0] && p[1] === pts[i][1]);
  return same ? { name: c.name } : { name: c.name || 'Custom', pts };
}

// ---- editing helpers (for the contour editor)
const clampv = (v: number) => Math.min(255, Math.max(0, Math.round(v)));
/** The editable points of a contour (a preset's own points, or the linear default). */
export function contourPoints(c: Contour | undefined): { pts: CPt[]; corner: boolean } {
  if (c?.pts) return { pts: c.pts.map((p) => [...p] as CPt), corner: !!c.corner };
  const p = CONTOUR_PRESETS[c?.name ?? 'Linear'] ?? CONTOUR_PRESETS['Linear'];
  return { pts: p.pts.map((q) => [...q] as CPt), corner: !p.smooth };
}
/** Index of the point within `r` of (x, y), or −1. */
export const hitPoint = (pts: CPt[], x: number, y: number, r = 8) => pts.findIndex((p) => Math.hypot(p[0] - x, p[1] - y) <= r);
/** Add a point (kept sorted by x; refused if one is already within a unit of that x or there are 32 points). */
export function addPoint(pts: CPt[], x: number, y: number): { pts: CPt[]; index: number } {
  x = clampv(x); y = clampv(y);
  if (pts.length >= 32 || pts.some((p) => Math.abs(p[0] - x) < 1)) return { pts, index: -1 };
  const out = [...pts.map((p) => [...p] as CPt), [x, y] as CPt].sort((a, b) => a[0] - b[0]);
  return { pts: out, index: out.findIndex((p) => p[0] === x && p[1] === y) };
}
/** Move point `i` (end points slide only vertically; inner points stay between their neighbours). */
export function movePoint(pts: CPt[], i: number, x: number, y: number): CPt[] {
  const out = pts.map((p) => [...p] as CPt), last = out.length - 1;
  out[i][1] = clampv(y);
  if (i > 0 && i < last) out[i][0] = Math.min(out[i + 1][0] - 1, Math.max(out[i - 1][0] + 1, clampv(x)));
  return out;
}
/** Remove an inner point (the two end points stay). */
export const removePoint = (pts: CPt[], i: number): CPt[] => (i > 0 && i < pts.length - 1 ? pts.filter((_, k) => k !== i).map((p) => [...p] as CPt) : pts);
/** The Contour for edited points: undefined if it is just the straight identity line. */
export function contourFromPoints(pts: CPt[], corner: boolean): Contour | undefined {
  if (pts.length === 2 && pts[0][0] === 0 && pts[0][1] === 0 && pts[1][0] === 255 && pts[1][1] === 255) return undefined;
  return { name: 'Custom', pts: pts.map((p) => [...p] as CPt), ...(corner ? { corner: true } : {}) };
}
