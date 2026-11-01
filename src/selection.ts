import { Doc, clampRect, cloneCanvas, ctxOf, makeCanvas, type Rect } from './doc';

export type SelOp = 'replace' | 'add' | 'subtract' | 'intersect';
export const opFrom = (e: { shiftKey: boolean; altKey: boolean }): SelOp =>
  e.shiftKey && e.altKey ? 'intersect' : e.shiftKey ? 'add' : e.altKey ? 'subtract' : 'replace';

/** Tight bounds of non-transparent pixels, or null if empty. */
export function alphaBounds(c: HTMLCanvasElement): Rect | null {
  const { width: w, height: h } = c;
  const d = ctxOf(c).getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (d[(y * w + x) * 4 + 3] > 0) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// ---- shapes (alpha masks the size of the document) ------------------------------
export function rectShape(doc: Doc, r: Rect) {
  const c = makeCanvas(doc.width, doc.height), x = ctxOf(c);
  x.fillStyle = '#000'; x.fillRect(r.x, r.y, r.w, r.h);
  return c;
}
export function ellipseShape(doc: Doc, r: Rect) {
  const c = makeCanvas(doc.width, doc.height), x = ctxOf(c);
  x.fillStyle = '#000'; x.beginPath(); x.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2); x.fill();
  return c;
}
export function pathShape(doc: Doc, pts: { x: number; y: number }[]) {
  const c = makeCanvas(doc.width, doc.height), x = ctxOf(c);
  x.fillStyle = '#000'; x.beginPath(); pts.forEach((p, i) => (i ? x.lineTo(p.x, p.y) : x.moveTo(p.x, p.y))); x.closePath(); x.fill();
  return c;
}
export function matchShape(doc: Doc, m: Uint8Array) {
  const c = makeCanvas(doc.width, doc.height), x = ctxOf(c);
  const img = x.createImageData(doc.width, doc.height);
  for (let p = 0; p < m.length; p++) if (m[p]) img.data[p * 4 + 3] = 255;
  x.putImageData(img, 0, 0);
  return c;
}

/** The current selection as an alpha mask (null when nothing is selected). */
export function currentMask(doc: Doc): HTMLCanvasElement | null {
  if (!doc.selection) return null;
  return doc.selMask ?? rectShape(doc, doc.selection);
}

/** Combine `shape` with the current selection using `op` and make it the selection. */
export function commitSelection(doc: Doc, shape: HTMLCanvasElement, op: SelOp) {
  const cur = currentMask(doc);
  let result = shape;
  if (cur && op !== 'replace') {
    result = cloneCanvas(cur);
    const x = ctxOf(result);
    x.globalCompositeOperation = op === 'add' ? 'source-over' : op === 'subtract' ? 'destination-out' : 'destination-in';
    x.drawImage(shape, 0, 0);
    x.globalCompositeOperation = 'source-over';
  } else if (!cur && (op === 'subtract' || op === 'intersect')) return;
  const b = alphaBounds(result);
  if (!b) { if (doc.selection) doc.setSelection(null); return; }
  doc.setSelection(b, result);
}

export function invertSelection(doc: Doc) {
  const full = makeCanvas(doc.width, doc.height), x = ctxOf(full);
  x.fillStyle = '#000'; x.fillRect(0, 0, full.width, full.height);
  const cur = currentMask(doc);
  if (cur) { x.globalCompositeOperation = 'destination-out'; x.drawImage(cur, 0, 0); }
  const b = alphaBounds(full);
  doc.setSelection(b, b ? full : null);
}

export function featherSelection(doc: Doc, radius: number) {
  const cur = currentMask(doc);
  if (!cur || radius <= 0) return;
  const out = makeCanvas(doc.width, doc.height), x = ctxOf(out);
  x.filter = `blur(${radius}px)`;
  x.drawImage(cur, 0, 0);
  const b = alphaBounds(out);
  doc.setSelection(b, b ? out : null);
}

/** Per-pixel (0/1) selected flags for flood tools; null when there is no irregular selection. */
export function selectedFlags(doc: Doc): Uint8Array | null {
  if (!doc.selMask) return null;
  const { width: w, height: h } = doc.selMask;
  const d = ctxOf(doc.selMask).getImageData(0, 0, w, h).data, f = new Uint8Array(w * h);
  for (let p = 0; p < f.length; p++) f[p] = d[p * 4 + 3] > 127 ? 1 : 0;
  return f;
}

/** Copy of `src` limited to the selection (soft edges preserved). */
export function clipToSelection(doc: Doc, src: HTMLCanvasElement, dst?: HTMLCanvasElement) {
  const c = dst ?? makeCanvas(src.width, src.height), x = ctxOf(c);
  x.globalCompositeOperation = 'source-over'; x.globalAlpha = 1;
  if (c !== src) { x.clearRect(0, 0, c.width, c.height); x.drawImage(src, 0, 0); }
  if (doc.selMask) { x.globalCompositeOperation = 'destination-in'; x.drawImage(doc.selMask, 0, 0); x.globalCompositeOperation = 'source-over'; }
  return c;
}

// ---- marching-ants outline for irregular selections ------------------------------
const outlines = new WeakMap<HTMLCanvasElement, HTMLCanvasElement>();
export function outlineOf(mask: HTMLCanvasElement): HTMLCanvasElement {
  let o = outlines.get(mask);
  if (o) return o;
  const { width: w, height: h } = mask;
  const src = ctxOf(mask).getImageData(0, 0, w, h).data;
  o = makeCanvas(w, h);
  const img = ctxOf(o).createImageData(w, h), d = img.data;
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && src[(y * w + x) * 4 + 3] > 127;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!on(x, y) || (on(x - 1, y) && on(x + 1, y) && on(x, y - 1) && on(x, y + 1))) continue;
    const i = (y * w + x) * 4, v = ((x >> 2) + (y >> 2)) & 1 ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
  }
  ctxOf(o).putImageData(img, 0, 0);
  outlines.set(mask, o);
  return o;
}
export { clampRect };
