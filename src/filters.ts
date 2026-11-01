import { app } from './state';
import { clampRect, cloneCanvas, ctxOf, makeCanvas, pushPixelEdit } from './doc';
import { paintColor } from './state';
import { clipToSelection } from './selection';

/** Apply a CSS-filter-string based adjustment to the active layer (within the selection, if any). */
export function applyFilter(label: string, filter: string) {
  if (!app.doc.requirePaintable()) return;
  const doc = app.doc, layer = doc.active;
  const before = cloneCanvas(layer.target);
  const w = layer.target.width, h = layer.target.height;
  const tmp = makeCanvas(w, h), t = ctxOf(tmp);
  t.filter = filter;
  t.drawImage(layer.target, 0, 0);
  const r = (doc.selection && clampRect(doc.selection, w, h)) || { x: 0, y: 0, w, h };
  const ctx = layer.tctx;
  if (doc.selMask) {
    // keep original outside the selection, filtered result inside (soft edges blend)
    const keep = cloneCanvas(layer.target), kx = ctxOf(keep);
    kx.globalCompositeOperation = 'destination-out'; kx.drawImage(doc.selMask, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(keep, 0, 0);
    ctx.drawImage(clipToSelection(doc, tmp), 0, 0);
  } else {
    ctx.save();
    ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
    ctx.clearRect(r.x, r.y, r.w, r.h);
    ctx.drawImage(tmp, 0, 0);
    ctx.restore();
  }
  pushPixelEdit(doc, layer, before, r, label);
}

export function clearSelection() {
  if (!app.doc.requirePaintable()) return;
  const doc = app.doc, layer = doc.active;
  const w = layer.target.width, h = layer.target.height;
  const r = (doc.selection && clampRect(doc.selection, w, h)) || { x: 0, y: 0, w, h };
  const before = cloneCanvas(layer.target);
  if (layer.maskMode) fillRegion(layer.tctx, '#000', r, doc.selMask, doc); // hide
  else if (doc.selMask) { const x = layer.tctx; x.save(); x.globalCompositeOperation = 'destination-out'; x.drawImage(doc.selMask, 0, 0); x.restore(); }
  else layer.tctx.clearRect(r.x, r.y, r.w, r.h);
  pushPixelEdit(doc, layer, before, r, 'Clear');
}

export function fillSelection(color: string) {
  if (!app.doc.requirePaintable()) return;
  const doc = app.doc, layer = doc.active;
  const w = layer.target.width, h = layer.target.height;
  const r = (doc.selection && clampRect(doc.selection, w, h)) || { x: 0, y: 0, w, h };
  const before = cloneCanvas(layer.target);
  fillRegion(layer.tctx, paintColor(color), r, doc.selMask, doc);
  pushPixelEdit(doc, layer, before, r, 'Fill');
}

/** Fill rect `r` with a color, honoring an irregular selection mask. */
function fillRegion(ctx: CanvasRenderingContext2D, color: string, r: { x: number; y: number; w: number; h: number }, sel: HTMLCanvasElement | null, doc: import('./doc').Doc) {
  if (!sel) { ctx.fillStyle = color; ctx.fillRect(r.x, r.y, r.w, r.h); return; }
  const c = makeCanvas(sel.width, sel.height), x = ctxOf(c);
  x.fillStyle = color; x.fillRect(r.x, r.y, r.w, r.h);
  ctx.drawImage(clipToSelection(doc, c), 0, 0);
}
