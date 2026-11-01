import { Doc, blendOp, makeCanvas, ctxOf } from './doc';

let scratch: HTMLCanvasElement | null = null;

/** Composite all visible layers (plus any live stroke preview) onto ctx. */
export function composite(doc: Doc, ctx: CanvasRenderingContext2D, includeHidden = false) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, doc.width, doc.height);
  for (const layer of doc.layers) {
    if (!layer.visible && !includeHidden) continue;
    let src = layer.canvas;
    const s = doc.stroke;
    if (s && s.layer === layer) {
      if (!scratch || scratch.width !== doc.width || scratch.height !== doc.height) scratch = makeCanvas(doc.width, doc.height);
      const sc = ctxOf(scratch);
      sc.globalAlpha = 1; sc.globalCompositeOperation = 'source-over';
      sc.clearRect(0, 0, doc.width, doc.height);
      sc.drawImage(layer.canvas, 0, 0);
      sc.globalAlpha = s.opacity;
      sc.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over';
      sc.drawImage(s.canvas, 0, 0);
      sc.globalAlpha = 1; sc.globalCompositeOperation = 'source-over';
      src = scratch;
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
