import { Doc, blendOp, makeCanvas, ctxOf, grayToAlpha, type Stroke } from './doc';
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

/** Composite all visible layers (plus any live stroke preview) onto ctx. */
export function composite(doc: Doc, ctx: CanvasRenderingContext2D, includeHidden = false) {
  const { width: w, height: h } = doc;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  for (const layer of doc.layers) {
    if ((!layer.visible && !includeHidden) || layer.hiddenForEdit) continue;
    let src = layer.canvas;
    let live = doc.stroke && doc.stroke.layer === layer ? doc.stroke : null;
    if (live && doc.selMask) live = { ...live, canvas: clipToSelection(doc, live.canvas, scratch(4, w, h)) };
    if (live && !live.onMask) src = withStroke(scratch(0, w, h), layer.canvas, live);
    if (layer.mask && layer.maskEnabled) {
      const alpha = live?.onMask
        ? grayToAlpha(withStroke(scratch(1, w, h), layer.mask, live), scratch(2, w, h))
        : layer.maskAlpha();
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
  }
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
