// Layer-style (effects) data + pure maths (no DOM): exact Euclidean distance transform, spread/stroke coverage,
// gradient geometry and conversion to/from PSD effect records. Unit-tested in Node.
import type { Color, LayerEffectsInfo } from 'ag-psd';

export interface ShadowFx { on: boolean; color: string; opacity: number; blend: string; angle: number; distance: number; spread: number; size: number }
export interface GlowFx { on: boolean; color: string; opacity: number; blend: string; spread: number; size: number }
export interface StrokeFx { on: boolean; color: string; opacity: number; blend: string; size: number; position: 'outside' | 'inside' | 'center' }
export interface OverlayFx { on: boolean; color: string; opacity: number; blend: string }
export interface GradientFx { on: boolean; color1: string; color2: string; opacity: number; blend: string; angle: number; reverse: boolean }
export interface LayerEffects {
  dropShadow?: ShadowFx; innerShadow?: ShadowFx; outerGlow?: GlowFx; innerGlow?: GlowFx;
  colorOverlay?: OverlayFx; gradientOverlay?: GradientFx; stroke?: StrokeFx;
}
export type FxKind = keyof LayerEffects;
/** Stacking order, bottom → top, exactly as Photoshop composites them. */
export const FX_ORDER: FxKind[] = ['dropShadow', 'outerGlow', 'colorOverlay', 'gradientOverlay', 'innerGlow', 'innerShadow', 'stroke'];
/** Order shown in the Layer Style dialog (Photoshop lists them top-most first). */
export const FX_LABELS: Record<FxKind, string> = {
  stroke: 'Stroke', innerShadow: 'Inner Shadow', innerGlow: 'Inner Glow', colorOverlay: 'Color Overlay',
  gradientOverlay: 'Gradient Overlay', outerGlow: 'Outer Glow', dropShadow: 'Drop Shadow',
};

export function defaultFx<K extends FxKind>(kind: K): NonNullable<LayerEffects[K]> {
  const d: { [P in FxKind]: NonNullable<LayerEffects[P]> } = {
    dropShadow: { on: true, color: '#000000', opacity: 0.75, blend: 'multiply', angle: 120, distance: 5, spread: 0, size: 5 },
    innerShadow: { on: true, color: '#000000', opacity: 0.75, blend: 'multiply', angle: 120, distance: 5, spread: 0, size: 5 },
    outerGlow: { on: true, color: '#ffffbe', opacity: 0.75, blend: 'screen', spread: 0, size: 5 },
    innerGlow: { on: true, color: '#ffffbe', opacity: 0.75, blend: 'screen', spread: 0, size: 5 },
    colorOverlay: { on: true, color: '#ff0000', opacity: 1, blend: 'normal' },
    gradientOverlay: { on: true, color1: '#000000', color2: '#ffffff', opacity: 1, blend: 'normal', angle: 90, reverse: false },
    stroke: { on: true, color: '#ff0000', opacity: 1, blend: 'normal', size: 3, position: 'outside' },
  };
  return JSON.parse(JSON.stringify(d[kind]));
}
export const cloneFx = (e: LayerEffects | null): LayerEffects | null => (e ? JSON.parse(JSON.stringify(e)) : null);
export const hasEffects = (e: LayerEffects | null | undefined): e is LayerEffects => !!e && FX_ORDER.some((k) => (e[k] as { on: boolean } | undefined)?.on);
export const sameFx = (a: LayerEffects | null, b: LayerEffects | null) => JSON.stringify(a) === JSON.stringify(b);

/** How far (px) effects can reach beyond the layer's own pixels. */
export function fxMargin(e: LayerEffects): number {
  let m = 0;
  const on = <T extends { on: boolean }>(x?: T) => (x?.on ? x : null);
  const ds = on(e.dropShadow); if (ds) m = Math.max(m, ds.distance + ds.size * 1.3 + 2);
  const og = on(e.outerGlow); if (og) m = Math.max(m, og.size * 1.3 + 2);
  const st = on(e.stroke); if (st) m = Math.max(m, st.size + 2);
  const is = on(e.innerShadow); if (is) m = Math.max(m, is.distance + is.size * 1.3 + 2);
  const ig = on(e.innerGlow); if (ig) m = Math.max(m, ig.size * 1.3 + 2);
  return Math.ceil(m + 4);
}

// ---------------------------------------------------------------- distance transform
const INF = 1e20;
/** Squared 1-D distance transform (Felzenszwalb & Huttenlocher). `f` holds 0 at sources, INF elsewhere. */
function dt1d(f: Float32Array, n: number, out: Float32Array, v: Int32Array, z: Float32Array) {
  let k = 0;
  v[0] = 0; z[0] = -INF; z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; out[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; }
}

/** Euclidean distance from every pixel to the nearest pixel where `target[p] === 1` (0 on targets; ~1e10 if none). */
export function distanceTo(target: Uint8Array, w: number, h: number): Float32Array {
  const n = Math.max(w, h), f = new Float32Array(n), d = new Float32Array(n), v = new Int32Array(n), z = new Float32Array(n + 1);
  const g = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) g[p] = target[p] ? 0 : INF;
  for (let x = 0; x < w; x++) {                     // columns
    for (let y = 0; y < h; y++) f[y] = g[y * w + x];
    dt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) g[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {                     // rows
    for (let x = 0; x < w; x++) f[x] = g[y * w + x];
    dt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) g[y * w + x] = Math.sqrt(d[x]);
  }
  return g;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const inside = (cov: Float32Array) => { const m = new Uint8Array(cov.length); for (let i = 0; i < cov.length; i++) m[i] = cov[i] >= 0.5 ? 1 : 0; return m; };

/** Dilate a coverage map (0-1) by `r` pixels, keeping anti-aliased edges. */
export function growCoverage(cov: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r <= 0) return cov.slice();
  const d = distanceTo(inside(cov), w, h), out = new Float32Array(cov.length);
  for (let i = 0; i < out.length; i++) out[i] = Math.max(cov[i], clamp01(r + 1 - d[i]));
  return out;
}

/** The outline band of a shape for a Stroke effect. */
export function ringCoverage(cov: Float32Array, w: number, h: number, size: number, position: 'outside' | 'inside' | 'center'): Float32Array {
  const m = inside(cov), dOut = distanceTo(m, w, h), inv = new Uint8Array(m.length);
  for (let i = 0; i < m.length; i++) inv[i] = m[i] ? 0 : 1;
  const dIn = distanceTo(inv, w, h), out = new Float32Array(cov.length);
  const so = position === 'inside' ? 0 : position === 'center' ? size / 2 : size, si = position === 'outside' ? 0 : position === 'center' ? size / 2 : size;
  for (let i = 0; i < out.length; i++) out[i] = m[i] ? (si > 0 ? clamp01(si + 1 - dIn[i]) : 0) : (so > 0 ? clamp01(so + 1 - dOut[i]) : 0);
  return out;
}

/**
 * Photoshop-style shadow/glow profile: fully opaque at the shape's edge (or `spread`% of `size` beyond it) fading to ~0 at
 * `size` px. Implemented as: grow the shape by `grow`, then Gaussian-blur by `sigma` (1-Φ gives that profile).
 */
export function softEdge(size: number, spread: number) {
  const s = Math.min(1, Math.max(0, spread / 100)), solid = size * s, trans = size * (1 - s);
  return { grow: solid + trans / 2, sigma: trans / 4 };
}

/** Shadow offset for a light angle (degrees, Photoshop convention: 120° puts the shadow down-right). */
export const shadowOffset = (angle: number, distance: number) => ({ dx: -Math.cos((angle * Math.PI) / 180) * distance, dy: Math.sin((angle * Math.PI) / 180) * distance });
/** Start/end of a linear gradient across a w×h box at `angle` (90° = bottom → top, like Photoshop). */
export function gradientEnds(x: number, y: number, w: number, h: number, angle: number) {
  const a = (angle * Math.PI) / 180, dx = Math.cos(a), dy = -Math.sin(a), half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2, cx = x + w / 2, cy = y + h / 2;
  return { x0: cx - dx * half, y0: cy - dy * half, x1: cx + dx * half, y1: cy + dy * half };
}

export const hexToRgb = (h: string): [number, number, number] => { const n = parseInt(h.replace('#', '').padEnd(6, '0').slice(0, 6), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const rgbToHex = (r: number, g: number, b: number) => '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

// ---------------------------------------------------------------- PSD conversion
const toColor = (hex: string): Color => { const [r, g, b] = hexToRgb(hex); return { r, g, b }; };
function fromColor(c: unknown): string {
  const o = (c ?? {}) as Record<string, number>;
  if ('r' in o) return rgbToHex(o.r, o.g, o.b);
  if ('fr' in o) return rgbToHex(o.fr * 255, o.fg * 255, o.fb * 255);
  return '#000000';
}
const px = (v: number) => ({ units: 'Pixels' as const, value: v });
/** ag-psd's writer only accepts length units for choke/spread; Photoshop's own files use percent (we read any unit). */
const choke = (v: number) => (v > 0 ? { choke: { units: 'Pixels' as const, value: v } } : {});
const val = (u: { value?: number } | undefined, d: number) => (typeof u?.value === 'number' ? u.value : d);
const BLENDS = new Set(['normal', 'darken', 'multiply', 'color burn', 'lighten', 'screen', 'color dodge', 'linear dodge', 'overlay', 'soft light', 'hard light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity']);
const blendIn = (b: string | undefined, d: string) => (b && BLENDS.has(b) ? b : b ? 'normal' : d);

export function toPsdEffects(e: LayerEffects): LayerEffectsInfo {
  const out: LayerEffectsInfo = {};
  const shadow = (s: ShadowFx) => ({ present: true, showInDialog: true, enabled: s.on, size: px(s.size), angle: s.angle, distance: px(s.distance), color: toColor(s.color), blendMode: s.blend as never, opacity: s.opacity, useGlobalLight: false, antialiased: true, ...choke(s.spread) });
  const glow = (g: GlowFx) => ({ present: true, showInDialog: true, enabled: g.on, size: px(g.size), color: toColor(g.color), blendMode: g.blend as never, opacity: g.opacity, source: 'edge' as const, technique: 'softer' as never, antialiased: true, ...choke(g.spread) });
  if (e.dropShadow) out.dropShadow = [shadow(e.dropShadow)];
  if (e.innerShadow) out.innerShadow = [shadow(e.innerShadow)];
  if (e.outerGlow) out.outerGlow = glow(e.outerGlow);
  if (e.innerGlow) out.innerGlow = glow(e.innerGlow);
  if (e.colorOverlay) out.solidFill = [{ present: true, showInDialog: true, enabled: e.colorOverlay.on, blendMode: e.colorOverlay.blend as never, color: toColor(e.colorOverlay.color), opacity: e.colorOverlay.opacity }];
  if (e.stroke) out.stroke = [{ present: true, showInDialog: true, enabled: e.stroke.on, size: px(e.stroke.size), position: e.stroke.position, fillType: 'color', blendMode: e.stroke.blend as never, opacity: e.stroke.opacity, color: toColor(e.stroke.color) }];
  if (e.gradientOverlay) {
    const g = e.gradientOverlay;
    out.gradientOverlay = [{
      present: true, showInDialog: true, enabled: g.on, blendMode: g.blend, opacity: g.opacity, angle: g.angle, reverse: g.reverse, scale: 1, type: 'linear', align: true,
      gradient: { name: 'Custom', type: 'solid', smoothness: 1, colorStops: [{ color: toColor(g.color1), location: 0, midpoint: 0.5 }, { color: toColor(g.color2), location: 1, midpoint: 0.5 }], opacityStops: [{ opacity: 1, location: 0, midpoint: 0.5 }, { opacity: 1, location: 1, midpoint: 0.5 }] },
    }];
  }
  return out;
}

/** Convert PSD effects. `unsupported` lists effect types that were dropped (bevel, satin, pattern overlay, non-linear gradients...). */
export function fromPsdEffects(e: LayerEffectsInfo): { fx: LayerEffects; unsupported: string[] } {
  const fx: LayerEffects = {}, unsupported: string[] = [];
  const dis = !!e.disabled;
  const shadow = (s: NonNullable<LayerEffectsInfo['dropShadow']>[number], k: 'dropShadow' | 'innerShadow') => {
    const d = defaultFx(k);
    return { ...d, on: !dis && s.enabled !== false, color: s.color ? fromColor(s.color) : d.color, opacity: s.opacity ?? d.opacity, blend: blendIn(s.blendMode, d.blend), angle: s.angle ?? d.angle, distance: val(s.distance, d.distance), spread: val(s.choke, 0), size: val(s.size, d.size) };
  };
  const glow = (g: NonNullable<LayerEffectsInfo['outerGlow']>, k: 'outerGlow' | 'innerGlow') => {
    const d = defaultFx(k);
    if (g.source === 'center') unsupported.push('inner glow from center (drawn from edge)');
    return { ...d, on: !dis && g.enabled !== false, color: g.color ? fromColor(g.color) : d.color, opacity: g.opacity ?? d.opacity, blend: blendIn(g.blendMode, d.blend), spread: val(g.choke, 0), size: val(g.size, d.size) };
  };
  if (e.dropShadow?.[0]) fx.dropShadow = shadow(e.dropShadow[0], 'dropShadow');
  if (e.innerShadow?.[0]) fx.innerShadow = shadow(e.innerShadow[0], 'innerShadow');
  if (e.outerGlow) fx.outerGlow = glow(e.outerGlow, 'outerGlow');
  if (e.innerGlow) fx.innerGlow = glow(e.innerGlow, 'innerGlow');
  const sf = e.solidFill?.[0];
  if (sf) fx.colorOverlay = { on: !dis && sf.enabled !== false, color: sf.color ? fromColor(sf.color) : '#ff0000', opacity: sf.opacity ?? 1, blend: blendIn(sf.blendMode, 'normal') };
  const st = e.stroke?.[0];
  if (st) {
    if (st.fillType && st.fillType !== 'color') unsupported.push(`${st.fillType} stroke (drawn as a colour)`);
    fx.stroke = { on: !dis && st.enabled !== false, color: st.color ? fromColor(st.color) : '#000000', opacity: st.opacity ?? 1, blend: blendIn(st.blendMode, 'normal'), size: val(st.size, 3), position: st.position ?? 'outside' };
  }
  const go = e.gradientOverlay?.[0];
  if (go) {
    const stops = go.gradient && go.gradient.type === 'solid' ? go.gradient.colorStops : null;
    if (stops && stops.length >= 2) {
      if (go.type && go.type !== 'linear') unsupported.push(`${go.type} gradient overlay (drawn as linear)`);
      fx.gradientOverlay = { on: !dis && go.enabled !== false, color1: fromColor(stops[0].color), color2: fromColor(stops[stops.length - 1].color), opacity: go.opacity ?? 1, blend: blendIn(go.blendMode, 'normal'), angle: go.angle ?? 90, reverse: !!go.reverse };
    } else unsupported.push('gradient overlay');
  }
  if (e.bevel?.enabled !== false && e.bevel) unsupported.push('bevel & emboss');
  if (e.satin?.enabled !== false && e.satin) unsupported.push('satin');
  if (e.patternOverlay?.enabled !== false && e.patternOverlay) unsupported.push('pattern overlay');
  return { fx, unsupported };
}
