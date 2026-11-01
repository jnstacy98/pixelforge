import { app } from './state';
import { clampRect, cloneCanvas, ctxOf, makeCanvas, pushPixelEdit } from './doc';

/** Apply a CSS-filter-string based adjustment to the active layer (within the selection, if any). */
export function applyFilter(label: string, filter: string) {
  const doc = app.doc, layer = doc.active;
  const before = cloneCanvas(layer.canvas);
  const w = layer.canvas.width, h = layer.canvas.height;
  const tmp = makeCanvas(w, h), t = ctxOf(tmp);
  t.filter = filter;
  t.drawImage(layer.canvas, 0, 0);
  const r = (doc.selection && clampRect(doc.selection, w, h)) || { x: 0, y: 0, w, h };
  const ctx = layer.ctx;
  ctx.save();
  ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
  ctx.clearRect(r.x, r.y, r.w, r.h);
  ctx.drawImage(tmp, 0, 0);
  ctx.restore();
  pushPixelEdit(doc, layer, before, r, label);
}

export function clearSelection() {
  const doc = app.doc, layer = doc.active;
  const w = layer.canvas.width, h = layer.canvas.height;
  const r = (doc.selection && clampRect(doc.selection, w, h)) || { x: 0, y: 0, w, h };
  const before = cloneCanvas(layer.canvas);
  layer.ctx.clearRect(r.x, r.y, r.w, r.h);
  pushPixelEdit(doc, layer, before, r, 'Clear');
}

export function fillSelection(color: string) {
  const doc = app.doc, layer = doc.active;
  const w = layer.canvas.width, h = layer.canvas.height;
  const r = (doc.selection && clampRect(doc.selection, w, h)) || { x: 0, y: 0, w, h };
  const before = cloneCanvas(layer.canvas);
  layer.ctx.fillStyle = color;
  layer.ctx.fillRect(r.x, r.y, r.w, r.h);
  pushPixelEdit(doc, layer, before, r, 'Fill');
}
