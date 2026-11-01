import { blendOp, ctxOf, makeCanvas, type Rect } from './doc';
import { fxMargin, gradientEnds, growCoverage, hexToRgb, ringCoverage, shadowOffset, softEdge, type LayerEffects } from './fx';

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
function soft(cov: Float32Array, w: number, h: number, hex: string, size: number, spread: number) {
  const { grow, sigma } = softEdge(size, spread);
  return blurred(colored(growCoverage(cov, w, h, grow), w, h, hex), sigma);
}

/**
 * Render a layer's styles. `shape` is the layer's (already masked) pixels at document size; the result is also
 * document-sized and contains the effects *and* the pixels (at `fill` opacity), ready to composite with the layer's
 * opacity / blend mode. Works inside the shape's bounding box + the effects' reach, so small layers stay cheap.
 */
export function renderStyled(shape: HTMLCanvasElement, fx: LayerEffects, fill: number): HTMLCanvasElement {
  const W = shape.width, H = shape.height, result = makeCanvas(W, H), b = alphaBox(shape);
  if (!b) return result;
  const m = fxMargin(fx);
  const x0 = Math.max(b.x - m, -m), y0 = Math.max(b.y - m, -m), x1 = Math.min(b.x + b.w + m, W + m), y1 = Math.min(b.y + b.h + m, H + m);
  const R = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, w = R.w, h = R.h;
  const S = makeCanvas(w, h);
  ctxOf(S).drawImage(shape, -R.x, -R.y);
  const sd = ctxOf(S).getImageData(0, 0, w, h).data, A = new Float32Array(w * h), B = new Float32Array(w * h);
  for (let p = 0; p < A.length; p++) { A[p] = sd[p * 4 + 3] / 255; B[p] = 1 - A[p]; }
  const O = makeCanvas(w, h), ox = ctxOf(O);
  const put = (c: HTMLCanvasElement, opacity: number, blend: string, dx = 0, dy = 0) => {
    ox.globalAlpha = opacity; ox.globalCompositeOperation = blendOp(blend);
    ox.drawImage(c, dx, dy);
    ox.globalAlpha = 1; ox.globalCompositeOperation = 'source-over';
  };
  const clip = (c: HTMLCanvasElement, how: 'destination-in' | 'destination-out') => { const x = ctxOf(c); x.globalCompositeOperation = how; x.drawImage(S, 0, 0); x.globalCompositeOperation = 'source-over'; return c; };
  const knock = (c: HTMLCanvasElement, dx: number, dy: number) => { const k = makeCanvas(w, h); ctxOf(k).drawImage(c, dx, dy); return clip(k, 'destination-out'); };

  const ds = fx.dropShadow;
  if (ds?.on) { const { dx, dy } = shadowOffset(ds.angle, ds.distance); put(fill < 1 ? knock(soft(A, w, h, ds.color, ds.size, ds.spread), dx, dy) : soft(A, w, h, ds.color, ds.size, ds.spread), ds.opacity, ds.blend, fill < 1 ? 0 : dx, fill < 1 ? 0 : dy); }
  const og = fx.outerGlow;
  if (og?.on) put(knock(soft(A, w, h, og.color, og.size, og.spread), 0, 0), og.opacity, og.blend);
  ox.globalAlpha = fill; ox.drawImage(S, 0, 0); ox.globalAlpha = 1;                       // the layer's own pixels
  const co = fx.colorOverlay;
  if (co?.on) put(colored(A, w, h, co.color), co.opacity, co.blend);
  const go = fx.gradientOverlay;
  if (go?.on) {
    const g = makeCanvas(w, h), gx = ctxOf(g), e = gradientEnds(b.x - R.x, b.y - R.y, b.w, b.h, go.angle), grad = gx.createLinearGradient(e.x0, e.y0, e.x1, e.y1);
    grad.addColorStop(0, go.reverse ? go.color2 : go.color1); grad.addColorStop(1, go.reverse ? go.color1 : go.color2);
    gx.fillStyle = grad; gx.fillRect(0, 0, w, h);
    put(clip(g, 'destination-in'), go.opacity, go.blend);
  }
  const ig = fx.innerGlow;
  if (ig?.on) put(clip(soft(B, w, h, ig.color, ig.size, ig.spread), 'destination-in'), ig.opacity, ig.blend);
  const is = fx.innerShadow;
  if (is?.on) { const { dx, dy } = shadowOffset(is.angle, is.distance), s = soft(B, w, h, is.color, is.size, is.spread), sh = makeCanvas(w, h); ctxOf(sh).drawImage(s, dx, dy); put(clip(sh, 'destination-in'), is.opacity, is.blend); }
  const st = fx.stroke;
  if (st?.on) put(colored(ringCoverage(A, w, h, st.size, st.position), w, h, st.color), st.opacity, st.blend);

  ctxOf(result).drawImage(O, R.x, R.y);
  return result;
}
