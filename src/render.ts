import { clampRect, Doc, bakedCanvas, blendOp, buildTree, makeCanvas, ctxOf, grayToAlpha, type Layer, type LayerNode, type Rect, type Stroke } from './doc';
import { applyAdjustmentData, applyLUTs, filterFor, isPixelAdjustment, lutsFor, type RGBLUTs } from './adjust';
import { cloneFx, hasEffects } from './fx';
import { renderStyled, type Styled } from './fxrender';
import { blendInto, isCustomBlend } from './blend';
import { applyBlendIf, isBlendIfActive, type BlendIf } from './blendif';
import { blendFiltered, getCache } from './filtercache';
import { clipToSelection } from './selection';

const scratches: HTMLCanvasElement[] = [];
// Partial repaint: while CLIP is set, every working buffer is clipped to that rectangle too, so the cost of a frame follows
// the size of the changed area, not of the whole image. (The buffers are only meaningful inside the rectangle then.)
let CLIP: Rect | null = null;
const clippedCtx = new Set<CanvasRenderingContext2D>();
function withClip(c: HTMLCanvasElement) {
  if (!CLIP) return c;
  const x = ctxOf(c);
  if (!clippedCtx.has(x)) { x.save(); x.beginPath(); x.rect(CLIP.x, CLIP.y, CLIP.w, CLIP.h); x.clip(); clippedCtx.add(x); }
  return c;
}
/** The region pixel loops have to touch: the repaint clip, or the whole canvas. */
const region = (w: number, h: number): Rect => CLIP ?? { x: 0, y: 0, w, h };
function scratch(i: number, w: number, h: number) {
  let c = scratches[i];
  if (!c || c.width !== w || c.height !== h) c = scratches[i] = makeCanvas(w, h);
  return withClip(c);
}
/** Free the big working buffers (they are re-created on demand): called when the editor has been idle for a while. */
export function releaseRenderBuffers() { scratches.length = 0; groupBufs.length = 0; clipBufs.length = 0; clippedCtx.clear(); }

/** `src` (placed at ox,oy) with its alpha scaled by the Blend If sliders, judged against what is already in `ctx`. */
function withBlendIf(ctx: CanvasRenderingContext2D, src: HTMLCanvasElement, ox: number, oy: number, bi: BlendIf): HTMLCanvasElement {
  const w = src.width, h = src.height, out = scratch(8, w, h), ox2 = ctxOf(out);
  ox2.globalAlpha = 1; ox2.globalCompositeOperation = 'source-over'; ox2.filter = 'none';
  ox2.clearRect(0, 0, w, h); ox2.drawImage(src, 0, 0);
  const img = ox2.getImageData(0, 0, w, h);
  const bw = ctx.canvas.width, bh = ctx.canvas.height, sx = Math.max(0, ox), sy = Math.max(0, oy), ex = Math.min(bw, ox + w), ey = Math.min(bh, oy + h);
  const back = new Uint8ClampedArray(w * h * 4);
  if (ex > sx && ey > sy) {
    const b = ctx.getImageData(sx, sy, ex - sx, ey - sy);
    for (let y = sy; y < ey; y++) back.set(b.data.subarray((y - sy) * (ex - sx) * 4, (y - sy + 1) * (ex - sx) * 4), ((y - oy) * w + (sx - ox)) * 4);
  }
  applyBlendIf(bi, img.data, back);
  ox2.putImageData(img, 0, 0);
  return out;
}

/** base + the in-progress stroke (at its opacity) drawn into dst. */
function withStroke(dst: HTMLCanvasElement, base: HTMLCanvasElement, s: Stroke) {
  const x = ctxOf(dst);
  x.globalAlpha = 1; x.globalCompositeOperation = 'source-over';
  x.clearRect(0, 0, dst.width, dst.height);
  x.drawImage(base, 0, 0);
  x.globalAlpha = s.opacity;
  x.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over';
  x.drawImage(s.canvas, 0, 0);
  x.globalAlpha = 1; x.globalCompositeOperation = 'source-over';
  return dst;
}

/**
 * Apply an adjustment layer to whatever is already drawn on `ctx`.
 * result = lerp(below, blend(below, adjusted(below)), k) with k = mask * layer opacity, computed exactly in premultiplied space.
 * The layer's blend mode (Normal by default) decides how the adjusted pixels combine with the ones below, e.g. Color or
 * Luminosity to restrict a Curves layer to colour or tone only, or Multiply / Screen for a stronger effect.
 */
export function applyAdjustmentOnto(ctx: CanvasRenderingContext2D, w: number, h: number, layer: Layer, alpha: HTMLCanvasElement | null) {
  const a = layer.adjustment!, blend = layer.blend === 'pass through' ? 'normal' : layer.blend;
  if (!alpha && layer.opacity >= 1 && blend === 'normal') {
    // Fast path (no mask, full opacity): the result is simply the adjusted pixels, so skip the blend scaffolding.
    if (isPixelAdjustment(a)) {
      const R = region(w, h), img = ctx.getImageData(R.x, R.y, R.w, R.h);
      applyAdjustmentData(a, img.data);
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      ctx.putImageData(img, R.x, R.y);
    } else {
      const copy = scratch(5, w, h), cx = ctxOf(copy);
      cx.globalAlpha = 1; cx.globalCompositeOperation = 'source-over'; cx.filter = 'none';
      cx.clearRect(0, 0, w, h); cx.drawImage(ctx.canvas, 0, 0);
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, w, h);
      const R = region(w, h);
      ctx.filter = filterFor(a) ?? 'none'; ctx.drawImage(copy, R.x, R.y, R.w, R.h, R.x, R.y, R.w, R.h); ctx.filter = 'none';
    }
    return;
  }
  const base = scratch(5, w, h), bx = ctxOf(base);
  bx.globalAlpha = 1; bx.globalCompositeOperation = 'source-over'; bx.filter = 'none';
  bx.clearRect(0, 0, w, h); bx.drawImage(ctx.canvas, 0, 0);
  const adj = scratch(6, w, h), ax = ctxOf(adj);
  ax.globalAlpha = 1; ax.globalCompositeOperation = 'source-over'; ax.filter = 'none';
  ax.clearRect(0, 0, w, h);
  if (isPixelAdjustment(a)) {
    ax.drawImage(base, 0, 0);
    const R = region(w, h), img = ax.getImageData(R.x, R.y, R.w, R.h);
    applyAdjustmentData(a, img.data);
    ax.putImageData(img, R.x, R.y);
  } else {
    ax.filter = filterFor(a) ?? 'none'; ax.drawImage(base, 0, 0); ax.filter = 'none';
  }
  if (blend !== 'normal') {                                                  // combine the adjusted pixels with the ones below using the blend mode
    const bl = scratch(9, w, h), blx = ctxOf(bl);
    blx.globalAlpha = 1; blx.globalCompositeOperation = 'source-over'; blx.filter = 'none';
    blx.clearRect(0, 0, w, h); blx.drawImage(base, 0, 0);
    paint(blx, adj, 0, 0, 1, blend);
    ax.globalCompositeOperation = 'source-over'; ax.clearRect(0, 0, w, h); ax.drawImage(bl, 0, 0);
  }
  const k = scratch(7, w, h), kx = ctxOf(k);
  kx.globalCompositeOperation = 'source-over'; kx.clearRect(0, 0, w, h);
  kx.globalAlpha = layer.opacity;
  if (alpha) kx.drawImage(alpha, 0, 0); else { kx.fillStyle = '#000'; kx.fillRect(0, 0, w, h); }
  kx.globalAlpha = 1;
  bx.globalCompositeOperation = 'destination-out'; bx.drawImage(k, 0, 0);   // below * (1 - k)
  ax.globalCompositeOperation = 'destination-in'; ax.drawImage(k, 0, 0);    // adjusted * k
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(base, 0, 0);
  ctx.globalCompositeOperation = 'lighter'; ctx.drawImage(adj, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
}

const groupBufs: HTMLCanvasElement[] = [];
const clipBufs: HTMLCanvasElement[] = [];
function groupBuf(depth: number, w: number, h: number) {
  let c = groupBufs[depth];
  if (!c || c.width !== w || c.height !== h) c = groupBufs[depth] = makeCanvas(w, h);
  return withClip(c);
}
function clipBuf(depth: number, w: number, h: number) {
  let c = clipBufs[depth];
  if (!c || c.width !== w || c.height !== h) c = clipBufs[depth] = makeCanvas(w, h);
  return withClip(c);
}
const resetCtx = (x: CanvasRenderingContext2D) => { x.setTransform(1, 0, 0, 1, 0, 0); x.globalAlpha = 1; x.globalCompositeOperation = 'source-over'; x.filter = 'none'; };
const blendIdFor = (l: Layer) => (l.isGroup && l.blend === 'pass through' ? 'normal' : l.blend);

/** Draw `src` (placed at x, y) onto ctx with an opacity and a Photoshop blend mode: a native operator, or per-pixel maths for the rest. */
export function paint(ctx: CanvasRenderingContext2D, src: HTMLCanvasElement, x: number, y: number, opacity: number, blend: string) {
  if (opacity <= 0) return;
  if (isCustomBlend(blend)) {
    const cw = ctx.canvas.width, ch = ctx.canvas.height, R = region(cw, ch);
    const x0 = Math.max(0, x, R.x), y0 = Math.max(0, y, R.y), x1 = Math.min(cw, x + src.width, R.x + R.w), y1 = Math.min(ch, y + src.height, R.y + R.h);
    if (x1 <= x0 || y1 <= y0) return;
    const back = ctx.getImageData(x0, y0, x1 - x0, y1 - y0), source = ctxOf(src).getImageData(x0 - x, y0 - y, x1 - x0, y1 - y0);
    blendInto(back.data, source.data, blend, opacity);
    ctx.putImageData(back, x0, y0);
    return;
  }
  ctx.globalAlpha = opacity; ctx.globalCompositeOperation = blendOp(blend);
  ctx.drawImage(src, x, y);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
}

/** The live-stroke state for a layer and its mask coverage as an alpha canvas (null = no / fully-revealing mask). */
function maskAlphaFor(doc: Doc, layer: Layer, w: number, h: number) {
  let live = doc.stroke && doc.stroke.layer === layer ? doc.stroke : null;
  if (live && doc.selMask && !live.unclipped) live = { ...live, canvas: clipToSelection(doc, live.canvas, scratch(4, w, h)) };
  let alpha: HTMLCanvasElement | null = null;
  if (layer.mask && layer.maskEnabled) {
    alpha = live?.onMask && !layer.fmaskEdit ? grayToAlpha(withStroke(scratch(1, w, h), layer.mask, live), scratch(2, w, h), undefined, CLIP) : layer.maskAlpha();
  }
  return { live, alpha };
}

/** Draw one node. `neutral` renders it at full opacity / Normal (used inside clipping stacks, where the caller applies them). */
function drawNode(doc: Doc, node: LayerNode, ctx: CanvasRenderingContext2D, includeHidden: boolean, depth: number, neutral = false) {
  const { width: w, height: h } = doc, layer = node.layer;
  if ((!layer.visible && !includeHidden) || layer.hiddenForEdit) return;
  const { live, alpha } = maskAlphaFor(doc, layer, w, h);
  const opacity = neutral ? 1 : layer.opacity, blend = neutral ? 'normal' : blendIdFor(layer);
  if (layer.isGroup) {
    // Pass Through groups only matter when something (opacity / a mask that hides pixels) needs them isolated.
    const passThrough = layer.blend === 'pass through' || neutral;
    const needsMask = !!alpha && (!!live?.onMask || !layer.maskIsFull());
    if (passThrough && opacity >= 1 && !needsMask) { drawNodes(doc, node.children, ctx, includeHidden, depth); return; }
    const buf = groupBuf(depth, w, h), bx = ctxOf(buf);
    resetCtx(bx); bx.clearRect(0, 0, w, h);
    drawNodes(doc, node.children, bx, includeHidden, depth + 1);
    if (needsMask) { bx.globalCompositeOperation = 'destination-in'; bx.drawImage(alpha!, 0, 0); bx.globalCompositeOperation = 'source-over'; }
    paint(ctx, buf, 0, 0, opacity, blend);
    return;
  }
  if (layer.adjustment) { applyAdjustmentOnto(ctx, w, h, layer, alpha && !live?.onMask && layer.maskIsFull() ? null : alpha); return; }
  let src = layer.canvas;
  if (live && !live.onMask) src = withStroke(scratch(0, w, h), layer.canvas, live);
  else if (live && layer.fmaskEdit && layer.smart?.filterMask) {          // painting on a smart filter mask: show the stroke by re-blending the cached renders
    const cache = getCache(layer);
    if (cache) { const out = scratch(10, w, h); blendFiltered(ctxOf(out), cache.U, cache.F, withStroke(scratch(11, w, h), layer.smart.filterMask, live)); src = out; }
  }
  if (alpha) {
    const b = scratch(3, w, h), bx = ctxOf(b);
    bx.globalAlpha = 1; bx.globalCompositeOperation = 'source-over';
    bx.clearRect(0, 0, w, h);
    bx.drawImage(src, 0, 0);
    bx.globalCompositeOperation = 'destination-in';
    bx.drawImage(alpha, 0, 0);
    bx.globalCompositeOperation = 'source-over';
    src = b;
  }
  const bi = !neutral && isBlendIfActive(layer.blendIf) ? layer.blendIf : null;
  if (hasEffects(layer.effects)) {
    // Shadows and outer glows blend with whatever is *underneath* the layer; everything else is in the layer's own buffer.
    const st = styledFor(layer, src, !!live);
    for (const u of st.under) paint(ctx, u.canvas, u.x, u.y, u.opacity * opacity, u.blend);
    paint(ctx, bi ? withBlendIf(ctx, st.main, st.x, st.y, bi) : st.main, st.x, st.y, opacity, blend);
  } else paint(ctx, bi ? withBlendIf(ctx, src, 0, 0, bi) : src, 0, 0, opacity * layer.fillOpacity, blend);
}

/** The styled render of a layer's (masked) pixels, cached until the layer, its mask or its styles change. */
function styledFor(layer: Layer, shape: HTMLCanvasElement, bypass: boolean): Styled {
  const key = `${layer.rev}|${layer.fillOpacity}|${layer.maskEnabled ? 1 : 0}|${shape.width}x${shape.height}|${JSON.stringify(layer.effects)}`;
  if (!bypass && layer.styled?.key === key) return layer.styled.styled;
  const styled = renderStyled(shape, layer.effects!, layer.fillOpacity);
  if (!bypass) layer.styled = { key, styled };
  return styled;
}

/** A copy of the layer's pixels with its mask and layer styles baked in (used when merging). */
export function renderedCanvas(l: Layer): HTMLCanvasElement {
  const baked = bakedCanvas(l);
  if (hasEffects(l.effects)) {                       // flatten the styled layer onto a transparent canvas (shadows/glows have nothing to blend with)
    const st = renderStyled(baked, cloneFx(l.effects)!, l.fillOpacity), out = makeCanvas(baked.width, baked.height), ox = ctxOf(out);
    for (const u of st.under) paint(ox, u.canvas, u.x, u.y, u.opacity, u.blend);
    paint(ox, st.main, st.x, st.y, 1, 'normal');
    return out;
  }
  if (l.fillOpacity >= 1) return baked;
  const c = makeCanvas(baked.width, baked.height), x = ctxOf(c);
  x.globalAlpha = l.fillOpacity; x.drawImage(baked, 0, 0);
  return c;
}

/**
 * A clipping stack: the base layer plus the layers clipped to it, rendered as one isolated unit. Clipped
 * content only shows where the base has pixels; the base's opacity / blend mode apply to the whole stack.
 */
function drawClipStack(doc: Doc, base: LayerNode, clipped: LayerNode[], ctx: CanvasRenderingContext2D, includeHidden: boolean, depth: number) {
  const { width: w, height: h } = doc, b = base.layer;
  if ((!b.visible && !includeHidden) || b.hiddenForEdit) return;          // hiding the base hides everything clipped to it
  const buf = groupBuf(depth, w, h), bx = ctxOf(buf);
  resetCtx(bx); bx.clearRect(0, 0, w, h);
  drawNode(doc, base, bx, includeHidden, depth + 1, true);
  const tmp = clipBuf(depth, w, h), tx = ctxOf(tmp);
  for (const c of clipped) {
    const L = c.layer;
    if ((!L.visible && !includeHidden) || L.hiddenForEdit) continue;
    if (L.adjustment) {                                                      // acts on the stack so far; outside the base there are no pixels to change
      const { live, alpha } = maskAlphaFor(doc, L, w, h);
      applyAdjustmentOnto(bx, w, h, L, alpha && !live?.onMask && L.maskIsFull() ? null : alpha);
      continue;
    }
    resetCtx(tx); tx.clearRect(0, 0, w, h);
    drawNode(doc, c, tx, includeHidden, depth + 1, true);
    tx.globalCompositeOperation = 'destination-in'; tx.drawImage(buf, 0, 0); tx.globalCompositeOperation = 'source-over';   // cut to the base's shape
    paint(bx, tmp, 0, 0, L.opacity, blendIdFor(L));
  }
  paint(ctx, buf, 0, 0, b.opacity, blendIdFor(b));
}

/** The tone tables of an adjustment layer that can be merged with its neighbours: plain (opacity 100%, Normal, nothing masked out). */
/** Test switch: turn run-fusing of adjustment layers off to compare against the plain one-by-one path. */
export const renderFlags = { fuse: true };
function fusableLUTs(doc: Doc, l: Layer): RGBLUTs | null {
  if (!renderFlags.fuse || !l.adjustment || l.clipped || !l.visible || l.hiddenForEdit || l.opacity < 1 || l.blend !== 'normal') return null;
  if (doc.stroke && doc.stroke.layer === l) return null;
  if (l.mask && l.maskEnabled && !l.maskIsFull()) return null;
  return lutsFor(l.adjustment);
}
const composeLUTs = (a: RGBLUTs, b: RGBLUTs): RGBLUTs => {
  const f = (x: Uint8ClampedArray, y: Uint8ClampedArray) => Uint8ClampedArray.from(x, (v) => y[v]);
  return { r: f(a.r, b.r), g: f(a.g, b.g), b: f(a.b, b.b) };
};

function drawNodes(doc: Doc, nodes: LayerNode[], ctx: CanvasRenderingContext2D, includeHidden: boolean, depth: number) {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const first = fusableLUTs(doc, node.layer);
    if (first && i + 1 < nodes.length) {                              // Levels + Curves + Invert … in a row: one pass over the pixels instead of one each
      let fused = first, j = i + 1;
      for (; j < nodes.length; j++) { const n = fusableLUTs(doc, nodes[j].layer); if (!n) break; fused = composeLUTs(fused, n); }
      if (j > i + 1) {
        const w = doc.width, h = doc.height, R = region(w, h), img = ctx.getImageData(R.x, R.y, R.w, R.h);
        applyLUTs(img.data, img.data, fused);
        ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.putImageData(img, R.x, R.y);
        i = j - 1; continue;
      }
    }
    let j = i + 1;
    // layers flagged "clipped" directly above this one are clipped to it (unless it is an adjustment layer or itself clipped)
    if (!node.layer.clipped && !node.layer.adjustment) while (j < nodes.length && nodes[j].layer.clipped) j++;
    if (j > i + 1) { drawClipStack(doc, node, nodes.slice(i + 1, j), ctx, includeHidden, depth); i = j - 1; }
    else drawNode(doc, node, ctx, includeHidden, depth);
  }
}

/** Composite all visible layers (groups included, plus any live stroke preview) onto ctx. */
export function composite(doc: Doc, ctx: CanvasRenderingContext2D, includeHidden = false) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, doc.width, doc.height);
  drawNodes(doc, buildTree(doc.layers), ctx, includeHidden, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

/**
 * Repaint only `rect` of the document into ctx (what a brush stroke or other local edit needs). Everything outside the
 * rectangle in ctx is left as it was, so the caller must only use this when nothing else changed.
 */
export function compositeRect(doc: Doc, ctx: CanvasRenderingContext2D, rect: Rect, includeHidden = false) {
  const r = clampRect({ x: rect.x - 2, y: rect.y - 2, w: rect.w + 4, h: rect.h + 4 }, doc.width, doc.height);
  if (!r) return;
  CLIP = r;
  try {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
    ctx.clearRect(r.x, r.y, r.w, r.h);
    drawNodes(doc, buildTree(doc.layers), ctx, includeHidden, 0);
    ctx.restore();
  } finally {
    for (const x of clippedCtx) x.restore();
    clippedCtx.clear(); CLIP = null;
  }
}

export function flatten(doc: Doc, background: string | null = null): HTMLCanvasElement {
  const c = makeCanvas(doc.width, doc.height);
  const ctx = ctxOf(c);
  if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, c.width, c.height); }
  const tmp = makeCanvas(doc.width, doc.height);
  composite(doc, ctxOf(tmp));
  ctx.drawImage(tmp, 0, 0);
  return c;
}
