import { Doc, blendOp, buildTree, makeCanvas, ctxOf, grayToAlpha, type Layer, type LayerNode, type Stroke } from './doc';
import { applyLUTs, filterFor, lutsFor } from './adjust';
import { clipToSelection } from './selection';

const scratches: HTMLCanvasElement[] = [];
function scratch(i: number, w: number, h: number) {
  let c = scratches[i];
  if (!c || c.width !== w || c.height !== h) c = scratches[i] = makeCanvas(w, h);
  return c;
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
 * result = lerp(below, adjusted(below), k) with k = mask * layer opacity, computed exactly in premultiplied space.
 */
export function applyAdjustmentOnto(ctx: CanvasRenderingContext2D, w: number, h: number, layer: Layer, alpha: HTMLCanvasElement | null) {
  const a = layer.adjustment!;
  if (!alpha && layer.opacity >= 1) {
    // Fast path (no mask, full opacity): the result is simply the adjusted pixels, so skip the blend scaffolding.
    const luts = lutsFor(a);
    if (luts) {
      const img = ctx.getImageData(0, 0, w, h);
      applyLUTs(img.data, img.data, luts);
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      ctx.putImageData(img, 0, 0);
    } else {
      const copy = scratch(5, w, h), cx = ctxOf(copy);
      cx.globalAlpha = 1; cx.globalCompositeOperation = 'source-over'; cx.filter = 'none';
      cx.clearRect(0, 0, w, h); cx.drawImage(ctx.canvas, 0, 0);
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, w, h);
      ctx.filter = filterFor(a) ?? 'none'; ctx.drawImage(copy, 0, 0); ctx.filter = 'none';
    }
    return;
  }
  const base = scratch(5, w, h), bx = ctxOf(base);
  bx.globalAlpha = 1; bx.globalCompositeOperation = 'source-over'; bx.filter = 'none';
  bx.clearRect(0, 0, w, h); bx.drawImage(ctx.canvas, 0, 0);
  const adj = scratch(6, w, h), ax = ctxOf(adj);
  ax.globalAlpha = 1; ax.globalCompositeOperation = 'source-over'; ax.filter = 'none';
  ax.clearRect(0, 0, w, h);
  const luts = lutsFor(a);
  if (luts) {
    ax.drawImage(base, 0, 0);
    const img = ax.getImageData(0, 0, w, h);
    applyLUTs(img.data, img.data, luts);
    ax.putImageData(img, 0, 0);
  } else {
    ax.filter = filterFor(a) ?? 'none'; ax.drawImage(base, 0, 0); ax.filter = 'none';
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
function groupBuf(depth: number, w: number, h: number) {
  let c = groupBufs[depth];
  if (!c || c.width !== w || c.height !== h) c = groupBufs[depth] = makeCanvas(w, h);
  return c;
}

function drawNodes(doc: Doc, nodes: LayerNode[], ctx: CanvasRenderingContext2D, includeHidden: boolean, depth: number) {
  const { width: w, height: h } = doc;
  for (const node of nodes) {
    const layer = node.layer;
    if ((!layer.visible && !includeHidden) || layer.hiddenForEdit) continue;
    let live = doc.stroke && doc.stroke.layer === layer ? doc.stroke : null;
    if (live && doc.selMask) live = { ...live, canvas: clipToSelection(doc, live.canvas, scratch(4, w, h)) };
    let alpha: HTMLCanvasElement | null = null;
    if (layer.mask && layer.maskEnabled) {
      alpha = live?.onMask ? grayToAlpha(withStroke(scratch(1, w, h), layer.mask, live), scratch(2, w, h)) : layer.maskAlpha();
    }
    if (layer.isGroup) {
      // Pass Through groups only matter when something (opacity / a mask that hides pixels) needs them isolated.
      const passThrough = layer.blend === 'pass through';
      const needsMask = !!alpha && (!!live?.onMask || !layer.maskIsFull());
      if (passThrough && layer.opacity >= 1 && !needsMask) { drawNodes(doc, node.children, ctx, includeHidden, depth); continue; }
      const buf = groupBuf(depth, w, h), bx = ctxOf(buf);
      bx.setTransform(1, 0, 0, 1, 0, 0); bx.globalAlpha = 1; bx.globalCompositeOperation = 'source-over'; bx.filter = 'none';
      bx.clearRect(0, 0, w, h);
      drawNodes(doc, node.children, bx, includeHidden, depth + 1);
      if (needsMask) { bx.globalCompositeOperation = 'destination-in'; bx.drawImage(alpha!, 0, 0); bx.globalCompositeOperation = 'source-over'; }
      ctx.globalAlpha = layer.opacity;
      ctx.globalCompositeOperation = passThrough ? 'source-over' : blendOp(layer.blend);
      ctx.drawImage(buf, 0, 0);
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      continue;
    }
    if (layer.adjustment) { applyAdjustmentOnto(ctx, w, h, layer, alpha && !live?.onMask && layer.maskIsFull() ? null : alpha); continue; }
    let src = layer.canvas;
    if (live && !live.onMask) src = withStroke(scratch(0, w, h), layer.canvas, live);
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
    ctx.globalAlpha = layer.opacity;
    ctx.globalCompositeOperation = blendOp(layer.blend);
    ctx.drawImage(src, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
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

export function flatten(doc: Doc, background: string | null = null): HTMLCanvasElement {
  const c = makeCanvas(doc.width, doc.height);
  const ctx = ctxOf(c);
  if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, c.width, c.height); }
  const tmp = makeCanvas(doc.width, doc.height);
  composite(doc, ctxOf(tmp));
  ctx.drawImage(tmp, 0, 0);
  return c;
}
