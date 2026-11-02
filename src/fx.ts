// Layer-style (effects) data + pure maths (no DOM): exact Euclidean distance transform, spread/stroke coverage,
// gradient geometry and conversion to/from PSD effect records. Unit-tested in Node.
import type { Color, LayerEffectsInfo } from 'ag-psd';

import { contourLUT, fromPsdContour, mapContour, toPsdContour, type Contour } from './contour.ts';
export interface ShadowFx { on: boolean; color: string; opacity: number; blend: string; angle: number; distance: number; spread: number; size: number; contour?: Contour }
export interface GlowFx { on: boolean; color: string; opacity: number; blend: string; spread: number; size: number; contour?: Contour }
export interface StrokeFx { on: boolean; color: string; opacity: number; blend: string; size: number; position: 'outside' | 'inside' | 'center' }
export interface OverlayFx { on: boolean; color: string; opacity: number; blend: string }
export interface GradientStop { at: number; color: string; alpha: number }
/** `color1`→`color2` is the simple two-colour gradient; `stops` (when present) overrides it with a full multi-stop / per-stop-opacity gradient. */
export interface GradientFx {
  on: boolean; color1: string; color2: string; opacity: number; blend: string; angle: number; reverse: boolean;
  style?: 'linear' | 'radial' | 'angle' | 'reflected' | 'diamond'; scale?: number; stops?: GradientStop[];
}
export interface PatternFx { on: boolean; id: string; name: string; opacity: number; blend: string; scale: number; angle: number; phase: { x: number; y: number } }
export interface SatinFx { on: boolean; color: string; opacity: number; blend: string; angle: number; distance: number; size: number; invert: boolean; contour?: Contour }
export interface BevelFx {
  on: boolean;
  style: 'inner' | 'outer' | 'emboss' | 'pillow' | 'stroke';
  technique: 'smooth' | 'hard' | 'soft';
  /** Slope strength in percent (100 = a 45° face for a linear profile). */
  depth: number; direction: 'up' | 'down';
  size: number; soften: number; angle: number; altitude: number;
  hiColor: string; hiBlend: string; hiOpacity: number;
  shColor: string; shBlend: string; shOpacity: number;
  /** Shape contour (reshapes the bevel's profile) and gloss contour (reshapes the lighting). */
  contour?: Contour; glossContour?: Contour;
}
export interface LayerEffects {
  bevel?: BevelFx;
  dropShadow?: ShadowFx; innerShadow?: ShadowFx; outerGlow?: GlowFx; innerGlow?: GlowFx;
  colorOverlay?: OverlayFx; gradientOverlay?: GradientFx; patternOverlay?: PatternFx; satin?: SatinFx; stroke?: StrokeFx;
}
export type FxKind = keyof LayerEffects;
/** Stacking order, bottom → top, exactly as Photoshop composites them. */
export const FX_ORDER: FxKind[] = ['dropShadow', 'outerGlow', 'patternOverlay', 'gradientOverlay', 'colorOverlay', 'satin', 'innerGlow', 'innerShadow', 'bevel', 'stroke'];
/** Order shown in the Layer Style dialog (Photoshop lists them top-most first). */
export const FX_LABELS: Record<FxKind, string> = {
  stroke: 'Stroke', bevel: 'Bevel & Emboss', innerShadow: 'Inner Shadow', innerGlow: 'Inner Glow', colorOverlay: 'Color Overlay',
  gradientOverlay: 'Gradient Overlay', patternOverlay: 'Pattern Overlay', satin: 'Satin', outerGlow: 'Outer Glow', dropShadow: 'Drop Shadow',
};

export function defaultFx<K extends FxKind>(kind: K): NonNullable<LayerEffects[K]> {
  const d: { [P in FxKind]: NonNullable<LayerEffects[P]> } = {
    dropShadow: { on: true, color: '#000000', opacity: 0.75, blend: 'multiply', angle: 120, distance: 5, spread: 0, size: 5 },
    innerShadow: { on: true, color: '#000000', opacity: 0.75, blend: 'multiply', angle: 120, distance: 5, spread: 0, size: 5 },
    outerGlow: { on: true, color: '#ffffbe', opacity: 0.75, blend: 'screen', spread: 0, size: 5 },
    innerGlow: { on: true, color: '#ffffbe', opacity: 0.75, blend: 'screen', spread: 0, size: 5 },
    colorOverlay: { on: true, color: '#ff0000', opacity: 1, blend: 'normal' },
    gradientOverlay: { on: true, color1: '#000000', color2: '#ffffff', opacity: 1, blend: 'normal', angle: 90, reverse: false },
    patternOverlay: { on: true, id: 'pf:checker', name: 'Checkerboard', opacity: 1, blend: 'normal', scale: 1, angle: 0, phase: { x: 0, y: 0 } },
    satin: { on: true, color: '#000000', opacity: 0.5, blend: 'multiply', angle: 19, distance: 11, size: 14, invert: true },
    stroke: { on: true, color: '#ff0000', opacity: 1, blend: 'normal', size: 3, position: 'outside' },
    bevel: { on: true, style: 'inner', technique: 'smooth', depth: 100, direction: 'up', size: 5, soften: 0, angle: 120, altitude: 30, hiColor: '#ffffff', hiBlend: 'screen', hiOpacity: 0.75, shColor: '#000000', shBlend: 'multiply', shOpacity: 0.75 },
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
  const bv = on(e.bevel); if (bv) m = Math.max(m, (bv.style === 'inner' || bv.style === 'stroke' ? 0 : bv.size) + bv.soften * 2 + bv.size * 0.3 + 4);
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
 * Calibration of the soft edge of shadows and glows against real Photoshop output (see tests/real-psd.mjs):
 * the blur's σ and an outward bias (both as a fraction of `size`), separately for shadows and glows.
 */
export const FX_TUNE = { shadow: { sigmaK: 0.4, growK: 0 }, glow: { sigmaK: 1 / 3, growK: 0.3 } };

/**
 * Shadow/glow edge profile: the shape is grown by `grow`, then Gaussian-blurred by `sigma`. `spread` (0-100 %) makes the
 * core opaque further out and the blur correspondingly narrower, like Photoshop's Spread / Choke.
 */
export function softEdge(size: number, spread: number, kind: 'shadow' | 'glow' = 'shadow') {
  const s = Math.min(0.99, Math.max(0, spread / 100)), k = FX_TUNE[kind];
  return { grow: size * (s + k.growK), sigma: k.sigmaK * size * (1 - s) };
}

/** Shadow offset for a light angle (degrees, Photoshop convention: 120° puts the shadow down-right). */
export const shadowOffset = (angle: number, distance: number) => ({ dx: -Math.cos((angle * Math.PI) / 180) * distance, dy: Math.sin((angle * Math.PI) / 180) * distance });
/** Start/end of a linear gradient across a w×h box at `angle` (90° = bottom → top, like Photoshop). */
export function gradientEnds(x: number, y: number, w: number, h: number, angle: number, scale = 1) {
  const a = (angle * Math.PI) / 180, dx = Math.cos(a), dy = -Math.sin(a), half = ((Math.abs(w * dx) + Math.abs(h * dy)) / 2) * scale, cx = x + w / 2, cy = y + h / 2;
  return { x0: cx - dx * half, y0: cy - dy * half, x1: cx + dx * half, y1: cy + dy * half };
}

// ---------------------------------------------------------------- bevel & emboss
/** Gaussian-like blur of a w×h float map (three box-blur passes, O(n) regardless of radius). */
export function blurMap(a: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma < 0.25) return a.slice();
  // three successive box blurs approximate a Gaussian (Kovesi): box width from sigma
  const n = 3, ideal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(ideal); if (wl % 2 === 0) wl--;
  const wu = wl + 2, m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  const widths = [0, 1, 2].map((i) => (i < m ? wl : wu));
  let cur = a.slice(), tmp = new Float32Array(a.length);
  const pass = (src: Float32Array, dst: Float32Array, r: number, horizontal: boolean) => {
    const len = horizontal ? w : h, lines = horizontal ? h : w, step = horizontal ? 1 : w, lineStep = horizontal ? w : 1, inv = 1 / (2 * r + 1);
    for (let l = 0; l < lines; l++) {
      const base = l * lineStep;
      let acc = 0;
      for (let i = -r; i <= r; i++) acc += src[base + Math.min(len - 1, Math.max(0, i)) * step];
      for (let i = 0; i < len; i++) {
        dst[base + i * step] = acc * inv;
        acc += src[base + Math.min(len - 1, i + r + 1) * step] - src[base + Math.max(0, i - r) * step];
      }
    }
  };
  for (const bw of widths) { const r = (bw - 1) >> 1; pass(cur, tmp, r, true); pass(tmp, cur, r, false); }
  return cur;
}

/**
 * The bevel's surface as a height map (px). `cov` is the layer's coverage; for the Stroke Emboss style `ring` is the stroke's
 * coverage instead (null → no surface). The edge profile spans `size` px: inner bevels rise inward, outer bevels rise
 * towards the shape, emboss straddles the edge, pillow emboss is a groove along it.
 */
export function bevelHeight(cov: Float32Array, w: number, h: number, b: BevelFx, ring: Float32Array | null = null): Float32Array {
  const shape = b.style === 'stroke' ? ring : cov, n = w * h;
  if (!shape) return new Float32Array(n);
  const m = inside(shape), inv = new Uint8Array(n);
  for (let i = 0; i < n; i++) inv[i] = m[i] ? 0 : 1;
  const dOut = distanceTo(m, w, h), dIn = distanceTo(inv, w, h);
  const size = Math.max(0.5, b.size);
  const profile = b.technique === 'smooth' ? (t: number) => t * t * (3 - 2 * t) : (t: number) => t;
  const cl = contourLUT(b.contour), shape2 = cl ? (t: number) => profile(mapContour(cl, t)) : profile;
  const out = new Float32Array(n), amp = (b.depth / 100) * size * (b.direction === 'down' ? -1 : 1);
  for (let i = 0; i < n; i++) {
    const s = m[i] ? dIn[i] - 0.5 : -(dOut[i] - 0.5);               // signed distance to the edge: + inside, − outside
    let t: number;
    switch (b.style) {
      case 'outer': t = s >= 0 ? 1 : clamp01(1 + s / size); break;
      case 'emboss': t = clamp01(0.5 + s / size); break;
      case 'pillow': t = clamp01(Math.abs(s) / (size / 2)); break;
      default: t = s > 0 ? clamp01(s / size) : 0;                    // inner / stroke emboss
    }
    out[i] = shape2(t) * amp;
  }
  // soften (+ a hair of anti-aliasing to hide the distance transform's pixel steps; chisel-soft is slightly rounder)
  const sigma = Math.hypot(b.soften, b.technique === 'soft' ? size * 0.12 : 0, 0.7);
  return blurMap(out, w, h, sigma);
}

/**
 * Light the height map. Returns per-pixel highlight and shadow strengths (0-1): how steeply the surface tilts towards /
 * away from the light. `angle` is the light's direction in the image plane (120° = from upper-left); `altitude` its height
 * above the surface (90° = straight down, which lights nothing). Uses the slope along the light direction with a smooth
 * saturation rather than Lambertian cosines, so strength grows monotonically with depth (like Photoshop's Depth slider)
 * instead of falling again once a face is steeper than the light.
 */
export function bevelShade(height: Float32Array, w: number, h: number, angle: number, altitude: number, gloss?: Contour) {
  const a = (angle * Math.PI) / 180, alt = (altitude * Math.PI) / 180;
  const lx = Math.cos(alt) * Math.cos(a), ly = -Math.cos(alt) * Math.sin(a), norm = Math.max(0.25, 1 - Math.sin(alt));
  const hi = new Float32Array(w * h), sh = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, xl = x > 0 ? i - 1 : i, xr = x < w - 1 ? i + 1 : i, yu = y > 0 ? i - w : i, yd = y < h - 1 ? i + w : i;
    const gx = (height[xr] - height[xl]) / (xr - xl || 1), gy = (height[yd] - height[yu]) / ((yd - yu) / w || 1);
    const d = -(gx * lx + gy * ly) / norm;                                 // + : the surface faces the light, − : faces away
    if (d > 0) hi[i] = 1 - Math.exp(-1.4 * d); else sh[i] = 1 - Math.exp(1.4 * d);
  }
  const gl = contourLUT(gloss);
  if (gl) for (let i = 0; i < hi.length; i++) { hi[i] = mapContour(gl, hi[i]); sh[i] = mapContour(gl, sh[i]); }
  return { hi, sh };
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
const BLENDS = new Set(['normal', 'darken', 'multiply', 'color burn', 'lighten', 'screen', 'color dodge', 'linear dodge', 'overlay', 'soft light', 'hard light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity', 'linear burn', 'darker color', 'lighter color', 'vivid light', 'linear light', 'pin light', 'hard mix', 'subtract', 'divide', 'dissolve']);
const blendIn = (b: string | undefined, d: string) => (b && BLENDS.has(b) ? b : b ? 'normal' : d);

const BEVEL_STYLE_OUT = { inner: 'inner bevel', outer: 'outer bevel', emboss: 'emboss', pillow: 'pillow emboss', stroke: 'stroke emboss' } as const;
const BEVEL_TECH_OUT = { smooth: 'smooth', hard: 'chisel hard', soft: 'chisel soft' } as const;
const invert = <T extends Record<string, string>>(o: T) => Object.fromEntries(Object.entries(o).map(([k, v]) => [v, k])) as Record<string, string>;
export function toPsdEffects(e: LayerEffects): LayerEffectsInfo {
  const out: LayerEffectsInfo = {};
  const cv = (c: Contour | undefined) => { const o = toPsdContour(c); return o ? { contour: o } : {}; };
  const shadow = (s: ShadowFx) => ({ present: true, showInDialog: true, enabled: s.on, size: px(s.size), angle: s.angle, distance: px(s.distance), color: toColor(s.color), blendMode: s.blend as never, opacity: s.opacity, useGlobalLight: false, antialiased: true, ...choke(s.spread), ...cv(s.contour) });
  const glow = (g: GlowFx) => ({ present: true, showInDialog: true, enabled: g.on, size: px(g.size), color: toColor(g.color), blendMode: g.blend as never, opacity: g.opacity, source: 'edge' as const, technique: 'softer' as never, antialiased: true, ...choke(g.spread), ...cv(g.contour) });
  if (e.dropShadow) out.dropShadow = [shadow(e.dropShadow)];
  if (e.innerShadow) out.innerShadow = [shadow(e.innerShadow)];
  if (e.outerGlow) out.outerGlow = glow(e.outerGlow);
  if (e.innerGlow) out.innerGlow = glow(e.innerGlow);
  if (e.colorOverlay) out.solidFill = [{ present: true, showInDialog: true, enabled: e.colorOverlay.on, blendMode: e.colorOverlay.blend as never, color: toColor(e.colorOverlay.color), opacity: e.colorOverlay.opacity }];
  if (e.bevel) {
    const v = e.bevel;
    out.bevel = { present: true, showInDialog: true, enabled: v.on, size: px(v.size), angle: v.angle, strength: v.depth / 100, highlightBlendMode: v.hiBlend as never, shadowBlendMode: v.shBlend as never,
      highlightColor: toColor(v.hiColor), shadowColor: toColor(v.shColor), style: BEVEL_STYLE_OUT[v.style], highlightOpacity: v.hiOpacity, shadowOpacity: v.shOpacity, soften: px(v.soften), useGlobalLight: false,
      altitude: v.altitude, technique: BEVEL_TECH_OUT[v.technique], direction: v.direction, antialiased: true, ...cv(v.glossContour), ...(v.contour ? { shapeContour: toPsdContour(v.contour) } : {}) };
  }
  if (e.stroke) out.stroke = [{ present: true, showInDialog: true, enabled: e.stroke.on, size: px(e.stroke.size), position: e.stroke.position, fillType: 'color', blendMode: e.stroke.blend as never, opacity: e.stroke.opacity, color: toColor(e.stroke.color) }];
  if (e.gradientOverlay) {
    const g = e.gradientOverlay, stops = g.stops ?? [{ at: 0, color: g.color1, alpha: 1 }, { at: 1, color: g.color2, alpha: 1 }];
    out.gradientOverlay = [{
      present: true, showInDialog: true, enabled: g.on, blendMode: g.blend, opacity: g.opacity, angle: g.angle, reverse: g.reverse, scale: g.scale ?? 1, type: g.style ?? 'linear', align: true,
      gradient: { name: 'Custom', type: 'solid', smoothness: 1, colorStops: stops.map((s) => ({ color: toColor(s.color), location: s.at, midpoint: 0.5 })), opacityStops: stops.map((s) => ({ opacity: s.alpha, location: s.at, midpoint: 0.5 })) },
    }];
  }
  if (e.patternOverlay) {
    const p = e.patternOverlay;
    out.patternOverlay = { present: true, showInDialog: true, enabled: p.on, blendMode: p.blend as never, opacity: p.opacity, scale: p.scale, angle: p.angle, pattern: { name: p.name, id: p.id }, phase: { ...p.phase } };
  }
  if (e.satin) {
    const s = e.satin;
    out.satin = { present: true, showInDialog: true, enabled: s.on, size: px(s.size), blendMode: s.blend as never, color: toColor(s.color), antialiased: true, opacity: s.opacity, distance: px(s.distance), angle: s.angle, invert: s.invert, ...cv(s.contour) };
  }
  return out;
}

/** Convert PSD effects. `unsupported` lists effect types that were dropped (noise gradients, textures...). */
export function fromPsdEffects(e: LayerEffectsInfo, globalLight?: { angle: number; altitude: number }): { fx: LayerEffects; unsupported: string[] } {
  const fx: LayerEffects = {}, unsupported: string[] = [];
  /** An effect flagged "use global light" follows the document's light angle, not the angle stored with the effect. */
  const ang = (own: number | undefined, glob: boolean | undefined, d: number) => (glob && globalLight ? globalLight.angle : own ?? d);
  const dis = !!e.disabled;
  const cin = (c: Parameters<typeof fromPsdContour>[0]) => { const o = fromPsdContour(c); return o ? { contour: o } : {}; };
  const shadow = (s: NonNullable<LayerEffectsInfo['dropShadow']>[number], k: 'dropShadow' | 'innerShadow') => {
    const d = defaultFx(k);
    return { ...d, on: !dis && s.enabled !== false, color: s.color ? fromColor(s.color) : d.color, opacity: s.opacity ?? d.opacity, blend: blendIn(s.blendMode, d.blend), angle: ang(s.angle, s.useGlobalLight, d.angle), distance: val(s.distance, d.distance), spread: val(s.choke, 0), size: val(s.size, d.size), ...cin(s.contour) };
  };
  const glow = (g: NonNullable<LayerEffectsInfo['outerGlow']>, k: 'outerGlow' | 'innerGlow') => {
    const d = defaultFx(k);
    if (g.source === 'center') unsupported.push('inner glow from center (drawn from edge)');
    return { ...d, on: !dis && g.enabled !== false, color: g.color ? fromColor(g.color) : d.color, opacity: g.opacity ?? d.opacity, blend: blendIn(g.blendMode, d.blend), spread: val(g.choke, 0), size: val(g.size, d.size), ...cin(g.contour) };
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
    const gr = go.gradient;
    if (gr && gr.type === 'solid' && gr.colorStops.length >= 2) {
      const cs = [...gr.colorStops].sort((p, q) => p.location - q.location), os = [...(gr.opacityStops ?? [])].sort((p, q) => p.location - q.location);
      const lerp = (at: number, pts: { l: number; v: number }[], d: number) => { if (!pts.length) return d; if (at <= pts[0].l) return pts[0].v; for (let i = 1; i < pts.length; i++) if (at <= pts[i].l) { const t = (at - pts[i - 1].l) / Math.max(1e-6, pts[i].l - pts[i - 1].l); return pts[i - 1].v + (pts[i].v - pts[i - 1].v) * t; } return pts[pts.length - 1].v; };
      const colorAt = (at: number) => { const rgb = cs.map((c) => ({ l: c.location, c: hexToRgb(fromColor(c.color)) })); const ch = (k: number) => lerp(at, rgb.map((r) => ({ l: r.l, v: r.c[k] })), 0); return rgbToHex(ch(0), ch(1), ch(2)); };
      const oPts = os.map((o) => ({ l: o.location, v: o.opacity }));
      const at = [...new Set([...cs.map((c) => c.location), ...os.map((o) => o.location)])].sort((p, q) => p - q);
      const stops = at.map((l) => ({ at: l, color: colorAt(l), alpha: lerp(l, oPts, 1) }));
      const simple = stops.length === 2 && stops[0].at === 0 && stops[1].at === 1 && stops.every((s) => s.alpha === 1);
      const style = (go.type ?? 'linear') as NonNullable<GradientFx['style']>;
      if (style === 'diamond') unsupported.push('diamond gradient overlay (drawn as radial)');
      fx.gradientOverlay = { on: !dis && go.enabled !== false, color1: stops[0].color, color2: stops[stops.length - 1].color, opacity: go.opacity ?? 1, blend: blendIn(go.blendMode, 'normal'), angle: go.angle ?? 90, reverse: !!go.reverse,
        ...(style !== 'linear' ? { style } : {}), ...(go.scale !== undefined && Math.abs(go.scale - 1) > 1e-6 ? { scale: go.scale } : {}), ...(simple ? {} : { stops }) };
    } else unsupported.push(gr?.type === 'noise' ? 'noise gradient overlay' : 'gradient overlay');
  }
  const sa = e.satin;
  if (sa) {
    const d = defaultFx('satin');
    fx.satin = { ...d, on: !dis && sa.enabled !== false, color: sa.color ? fromColor(sa.color) : d.color, opacity: sa.opacity ?? d.opacity, blend: blendIn(sa.blendMode, d.blend), angle: sa.angle ?? d.angle, distance: val(sa.distance, d.distance), size: val(sa.size, d.size), invert: sa.invert ?? d.invert, ...cin(sa.contour) };
  }
  if (e.bevel) {
    const v = e.bevel, d = defaultFx('bevel');
    fx.bevel = { ...d, on: !dis && v.enabled !== false, style: (invert(BEVEL_STYLE_OUT)[v.style ?? 'inner bevel'] ?? 'inner') as BevelFx['style'], technique: (invert(BEVEL_TECH_OUT)[v.technique ?? 'smooth'] ?? 'smooth') as BevelFx['technique'],
      depth: v.strength !== undefined ? Math.round(v.strength * 100) : d.depth, direction: v.direction === 'down' ? 'down' : 'up', size: val(v.size, d.size), soften: val(v.soften, 0), angle: ang(v.angle, v.useGlobalLight, d.angle), altitude: v.useGlobalLight && globalLight ? globalLight.altitude : v.altitude ?? d.altitude,
      hiColor: v.highlightColor ? fromColor(v.highlightColor) : d.hiColor, hiBlend: blendIn(v.highlightBlendMode, d.hiBlend), hiOpacity: v.highlightOpacity ?? d.hiOpacity,
      shColor: v.shadowColor ? fromColor(v.shadowColor) : d.shColor, shBlend: blendIn(v.shadowBlendMode, d.shBlend), shOpacity: v.shadowOpacity ?? d.shOpacity };
    if (v.useTexture) unsupported.push('bevel texture');
    const gc = fromPsdContour(v.contour), sc = fromPsdContour(v.shapeContour);
    if (gc) fx.bevel.glossContour = gc;
    if (sc) fx.bevel.contour = sc;
  }
  const po = e.patternOverlay;
  if (po) {
    const d = defaultFx('patternOverlay');
    fx.patternOverlay = { on: !dis && po.enabled !== false, id: po.pattern?.id ?? d.id, name: po.pattern?.name ?? d.name, opacity: po.opacity ?? 1, blend: blendIn(po.blendMode, 'normal'), scale: po.scale ?? 1, angle: po.angle ?? 0, phase: po.phase ? { x: po.phase.x ?? 0, y: po.phase.y ?? 0 } : { x: 0, y: 0 } };
  }
  return { fx, unsupported };
}
