import { tileCanvas } from './patterns';
import { blendOp, ctxOf, makeCanvas, type Rect } from './doc';
import { bevelHeight, bevelShade, fxMargin, gradientEnds, growCoverage, hexToRgb, ringCoverage, shadowOffset, softEdge, type GradientFx, type LayerEffects } from './fx';

function alphaBox(c: HTMLCanvasElement): Rect | null {
  const { width: w, height: h } = c, d = ctxOf(c).getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 0) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** A canvas of solid `hex` whose alpha is the coverage map. */
function colored(cov: Float32Array, w: number, h: number, hex: string) {
  const c = makeCanvas(w, h), x = ctxOf(c), img = x.createImageData(w, h), [r, g, b] = hexToRgb(hex);
  for (let p = 0; p < cov.length; p++) { const i = p * 4; img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = Math.round(cov[p] * 255); }
  x.putImageData(img, 0, 0);
  return c;
}
function blurred(c: HTMLCanvasElement, sigma: number) {
  if (sigma < 0.3) return c;
  const o = makeCanvas(c.width, c.height), x = ctxOf(o);
  x.filter = `blur(${sigma}px)`; x.drawImage(c, 0, 0); x.filter = 'none';
  return o;
}
/** A soft shadow/glow of `cov` in `hex`: opaque at the edge, fading out over `size` px (see softEdge). */
function soft(cov: Float32Array, w: number, h: number, hex: string, size: number, spread: number, kind: 'shadow' | 'glow' = 'shadow') {
  const { grow, sigma } = softEdge(size, spread, kind);
  return blurred(colored(growCoverage(cov, w, h, grow), w, h, hex), sigma);
}

/**
 * Render a layer's styles. `shape` is the layer's (already masked) pixels at document size; the result is also
 * document-sized and contains the effects *and* the pixels (at `fill` opacity), ready to composite with the layer's
 * opacity / blend mode. Works inside the shape's bounding box + the effects' reach, so small layers stay cheap.
 */
/**
 * The canvas gradient for a Gradient Overlay inside `box` (layer bounds): style (linear / radial / angle / reflected),
 * angle, scale, reverse, multi-stop colours with per-stop opacity.
 */
function gradientFor(ctx: CanvasRenderingContext2D, g: GradientFx, box: { x: number; y: number; w: number; h: number }): CanvasGradient {
  let stops = (g.stops ?? [{ at: 0, color: g.color1, alpha: 1 }, { at: 1, color: g.color2, alpha: 1 }]).map((s) => ({ ...s, at: g.reverse ? 1 - s.at : s.at })).sort((p, q) => p.at - q.at);
  const style = g.style ?? 'linear', scale = g.scale ?? 1, cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  let grad: CanvasGradient;
  if (style === 'radial' || style === 'diamond') grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(1, (Math.min(box.w, box.h) / 2) * scale));
  else if (style === 'angle') grad = ctx.createConicGradient(-(g.angle * Math.PI) / 180, cx, cy);
  else {
    if (style === 'reflected') stops = [...stops.map((s) => ({ ...s, at: 0.5 - s.at / 2 })).reverse(), ...stops.map((s) => ({ ...s, at: 0.5 + s.at / 2 }))];
    const e = gradientEnds(box.x, box.y, box.w, box.h, g.angle, scale);
    grad = ctx.createLinearGradient(e.x0, e.y0, e.x1, e.y1);
  }
  for (const s of stops) { const [r, gg, b] = hexToRgb(s.color); grad.addColorStop(Math.min(1, Math.max(0, s.at)), `rgba(${r},${gg},${b},${s.alpha})`); }
  return grad;
}

/** A styled layer: shadows / outer glows (which blend with the backdrop) separately from the layer + its inner effects. Placed at (x, y). */
export interface Styled { x: number; y: number; main: HTMLCanvasElement; under: { canvas: HTMLCanvasElement; x: number; y: number; opacity: number; blend: string }[] }

export function renderStyled(shape: HTMLCanvasElement, fx: LayerEffects, fill: number): Styled {
  const W = shape.width, H = shape.height, b = alphaBox(shape);
  if (!b) return { x: 0, y: 0, main: makeCanvas(1, 1), under: [] };
  const m = fxMargin(fx);
  const x0 = Math.max(b.x - m, -m), y0 = Math.max(b.y - m, -m), x1 = Math.min(b.x + b.w + m, W + m), y1 = Math.min(b.y + b.h + m, H + m);
  const R = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, w = R.w, h = R.h;
  const S = makeCanvas(w, h);
  ctxOf(S).drawImage(shape, -R.x, -R.y);
  const sd = ctxOf(S).getImageData(0, 0, w, h).data, A = new Float32Array(w * h), B = new Float32Array(w * h);
  for (let p = 0; p < A.length; p++) { A[p] = sd[p * 4 + 3] / 255; B[p] = 1 - A[p]; }
  const O = makeCanvas(w, h), ox = ctxOf(O), under: Styled['under'] = [];
  const put = (c: HTMLCanvasElement, opacity: number, blend: string, dx = 0, dy = 0) => {
    ox.globalAlpha = opacity; ox.globalCompositeOperation = blendOp(blend);
    ox.drawImage(c, dx, dy);
    ox.globalAlpha = 1; ox.globalCompositeOperation = 'source-over';
  };
  const clip = (c: HTMLCanvasElement, how: 'destination-in' | 'destination-out') => { const x = ctxOf(c); x.globalCompositeOperation = how; x.drawImage(S, 0, 0); x.globalCompositeOperation = 'source-over'; return c; };
  const knock = (c: HTMLCanvasElement, dx: number, dy: number) => { const k = makeCanvas(w, h); ctxOf(k).drawImage(c, dx, dy); return clip(k, 'destination-out'); };

  // Drop shadow and outer glow go *under* the layer and blend with the layers beneath it (e.g. a Screen glow vanishes on white).
  const ds = fx.dropShadow;
  if (ds?.on) {
    const { dx, dy } = shadowOffset(ds.angle, ds.distance), k = makeCanvas(w, h);
    ctxOf(k).drawImage(soft(A, w, h, ds.color, ds.size, ds.spread), dx, dy);
    if (fill < 1) clip(k, 'destination-out');                                  // "layer knocks out drop shadow"
    under.push({ canvas: k, x: R.x, y: R.y, opacity: ds.opacity, blend: ds.blend });
  }
  const og = fx.outerGlow;
  if (og?.on) under.push({ canvas: knock(soft(A, w, h, og.color, og.size, og.spread, 'glow'), 0, 0), x: R.x, y: R.y, opacity: og.opacity, blend: og.blend });
  ox.globalAlpha = fill; ox.drawImage(S, 0, 0); ox.globalAlpha = 1;                       // the layer's own pixels
  const po = fx.patternOverlay;
  if (po?.on) {
    const tile = tileCanvas(po.id);
    if (tile) {
      const g = makeCanvas(w, h), gx = ctxOf(g), pat = gx.createPattern(tile, 'repeat')!;
      pat.setTransform(new DOMMatrix().translate(po.phase.x - R.x, po.phase.y - R.y).rotate(po.angle).scale(Math.max(0.01, po.scale)));
      gx.fillStyle = pat; gx.fillRect(0, 0, w, h);
      put(clip(g, 'destination-in'), po.opacity, po.blend);
    }
  }
  const go = fx.gradientOverlay;
  if (go?.on) {
    const g = makeCanvas(w, h), gx = ctxOf(g), box = { x: b.x - R.x, y: b.y - R.y, w: b.w, h: b.h };
    gx.fillStyle = gradientFor(gx, go, box); gx.fillRect(0, 0, w, h);
    put(clip(g, 'destination-in'), go.opacity, go.blend);
  }
  const co = fx.colorOverlay;
  if (co?.on) put(colored(A, w, h, co.color), co.opacity, co.blend);
  // Satin: two blurred, offset copies of the shape subtracted from one another gives the soft, silky interior shading
  const sa = fx.satin;
  if (sa?.on) {
    const { dx, dy } = shadowOffset(sa.angle, sa.distance), sigma = Math.max(0.5, sa.size / 3);
    const one = (sx: number, sy: number) => { const c = makeCanvas(w, h), cx = ctxOf(c); cx.filter = `blur(${sigma}px)`; cx.drawImage(S, sx, sy); return cx.getImageData(0, 0, w, h).data; };
    const p1 = one(dx, dy), p2 = one(-dx, -dy), v = new Float32Array(w * h);
    for (let i = 0; i < v.length; i++) { const d = Math.abs(p1[i * 4 + 3] - p2[i * 4 + 3]) / 255; v[i] = (sa.invert ? 1 - d : d) * A[i]; }
    put(colored(v, w, h, sa.color), sa.opacity, sa.blend);
  }
  const ig = fx.innerGlow;
  if (ig?.on) put(clip(soft(B, w, h, ig.color, ig.size, ig.spread, 'glow'), 'destination-in'), ig.opacity, ig.blend);
  const is = fx.innerShadow;
  if (is?.on) { const { dx, dy } = shadowOffset(is.angle, is.distance), s = soft(B, w, h, is.color, is.size, is.spread), sh = makeCanvas(w, h); ctxOf(sh).drawImage(s, dx, dy); put(clip(sh, 'destination-in'), is.opacity, is.blend); }
  // Bevel & Emboss: light a height map made from the shape's edge (highlights where it faces the light, shadows where it faces away)
  const bv = fx.bevel, st = fx.stroke;
  const drawBevel = () => {
    if (!bv?.on) return;
    const ring = bv.style === 'stroke' && st?.on ? ringCoverage(A, w, h, st.size, st.position) : null;
    const { hi, sh } = bevelShade(bevelHeight(A, w, h, bv, ring), w, h, bv.angle, bv.altitude);
    const region = bv.style === 'inner' ? A : bv.style === 'outer' ? B : bv.style === 'stroke' ? ring : null;      // emboss / pillow shade both sides of the edge
    if (bv.style === 'stroke' && !ring) return;
    if (region) for (let p = 0; p < hi.length; p++) { hi[p] *= region[p]; sh[p] *= region[p]; }
    put(colored(hi, w, h, bv.hiColor), bv.hiOpacity, bv.hiBlend);
    put(colored(sh, w, h, bv.shColor), bv.shOpacity, bv.shBlend);
  };
  if (bv?.style !== 'stroke') drawBevel();
  if (st?.on) put(colored(ringCoverage(A, w, h, st.size, st.position), w, h, st.color), st.opacity, st.blend);
  if (bv?.style === 'stroke') drawBevel();                                                                             // Stroke Emboss lights the stroke itself, so it goes on top of it

  return { x: R.x, y: R.y, main: O, under };
}
