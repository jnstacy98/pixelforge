import { app } from './state';
import { clampRect, ctxOf, type Rect } from './doc';
import type { Pt, Tool } from './tools';
import { commitSelection, ellipseShape, matchShape, opFrom, pathShape, rectShape, type SelOp } from './selection';
import { floodSelect } from './flood';
import { flatten } from './render';

const norm = (a: Pt, b: Pt): Rect => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });
const stroke = (ctx: CanvasRenderingContext2D, path: () => void) => {
  ctx.save(); ctx.lineWidth = 1; ctx.setLineDash([5, 5]);
  ctx.strokeStyle = '#000'; ctx.beginPath(); path(); ctx.stroke();
  ctx.strokeStyle = '#fff'; ctx.lineDashOffset = 5; ctx.beginPath(); path(); ctx.stroke();
  ctx.restore();
};

export class MarqueeTool implements Tool {
  cursor = 'crosshair';
  private a: Pt | null = null;
  private b: Pt | null = null;
  private op: SelOp = 'replace';
  down(p: Pt, e: PointerEvent) { this.a = this.b = p; this.op = opFrom(e); }
  move(p: Pt) { if (this.a) { this.b = p; app.doc.emit('selection'); } }
  up(p: Pt) {
    const a = this.a; this.a = null; this.b = null;
    if (!a) return;
    const doc = app.doc;
    const r = clampRect(norm(a, p), doc.width, doc.height);
    if (!r || r.w < 2 || r.h < 2) { if (this.op === 'replace' && doc.selection) doc.setSelection(null); else doc.emit('selection'); return; }
    if (app.marquee.shape === 'rect' && this.op === 'replace') doc.setSelection(r);
    else commitSelection(doc, app.marquee.shape === 'rect' ? rectShape(doc, r) : ellipseShape(doc, r), this.op);
  }
  overlay(ctx: CanvasRenderingContext2D, ts: (x: number, y: number) => [number, number]) {
    if (!this.a || !this.b) return;
    const r = norm(this.a, this.b), [x, y] = ts(r.x, r.y), z = app.view.zoom;
    if (app.marquee.shape === 'rect') stroke(ctx, () => ctx.rect(x + 0.5, y + 0.5, r.w * z, r.h * z));
    else stroke(ctx, () => ctx.ellipse(x + (r.w * z) / 2, y + (r.h * z) / 2, Math.max(0.5, (r.w * z) / 2), Math.max(0.5, (r.h * z) / 2), 0, 0, Math.PI * 2));
  }
}

export class LassoTool implements Tool {
  cursor = 'crosshair';
  private pts: { x: number; y: number }[] = [];
  private op: SelOp = 'replace';
  private on = false;
  /** Polygonal mode: points placed so far (null when not drawing). */
  private poly: { pts: { x: number; y: number }[]; op: SelOp; last: number } | null = null;
  get trackHover() { return !!this.poly; }

  down(p: Pt, e: PointerEvent) {
    if (app.lasso.mode === 'poly') return this.polyDown(p, e);
    this.poly = null;
    this.pts = [{ x: p.x, y: p.y }]; this.op = opFrom(e); this.on = true;
  }
  move(p: Pt) {
    if (!this.on) return;
    const l = this.pts[this.pts.length - 1];
    if (Math.hypot(p.x - l.x, p.y - l.y) < 1.5 / app.view.zoom) return;
    this.pts.push({ x: p.x, y: p.y }); app.doc.emit('selection');
  }
  up() {
    if (!this.on) return;
    this.on = false;
    const doc = app.doc, pts = this.pts; this.pts = [];
    if (pts.length < 3) { if (this.op === 'replace' && doc.selection) doc.setSelection(null); else doc.emit('selection'); return; }
    commitSelection(doc, pathShape(doc, pts), this.op);
  }

  private polyDown(p: Pt, e: PointerEvent) {
    const now = performance.now();
    if (!this.poly) { this.poly = { pts: [{ x: p.x, y: p.y }], op: opFrom(e), last: now }; app.doc.emit('selection'); return; }
    const first = this.poly.pts[0], lastPt = this.poly.pts[this.poly.pts.length - 1];
    const dbl = now - this.poly.last < 350 && Math.hypot(p.x - lastPt.x, p.y - lastPt.y) * app.view.zoom < 6;
    this.poly.last = now;
    if (dbl || (this.poly.pts.length >= 3 && Math.hypot(p.x - first.x, p.y - first.y) * app.view.zoom < 7)) return this.finish();
    this.poly.pts.push({ x: p.x, y: p.y });
    app.doc.emit('selection');
  }
  private finish() {
    const poly = this.poly; this.poly = null;
    const doc = app.doc;
    if (!poly || poly.pts.length < 3) { doc.emit('selection'); return; }
    commitSelection(doc, pathShape(doc, poly.pts), poly.op);
  }
  /** Enter closes the polygon, Esc cancels it, Backspace removes the last point. */
  key(e: KeyboardEvent) {
    if (!this.poly) return false;
    if (e.key === 'Enter') { this.finish(); return true; }
    if (e.key === 'Escape') { this.poly = null; app.doc.emit('selection'); return true; }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      if (this.poly.pts.length <= 1) this.poly = null; else this.poly.pts.pop();
      app.doc.emit('selection'); return true;
    }
    return false;
  }
  overlay(ctx: CanvasRenderingContext2D, ts: (x: number, y: number) => [number, number]) {
    if (this.poly) {
      const pts = this.poly.pts, cur = app.view.cursorDoc;
      stroke(ctx, () => { pts.forEach((p, i) => { const [x, y] = ts(p.x, p.y); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); if (cur) { const [x, y] = ts(cur.x, cur.y); ctx.lineTo(x, y); } });
      const [fx, fy] = ts(pts[0].x, pts[0].y);
      ctx.save(); ctx.strokeStyle = '#000'; ctx.fillStyle = '#fff'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(fx, fy, 3.5, 0, 7); ctx.fill(); ctx.stroke(); ctx.restore();
      return;
    }
    if (!this.on || this.pts.length < 2) return;
    stroke(ctx, () => this.pts.forEach((p, i) => { const [x, y] = ts(p.x, p.y); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }));
  }
}

export class WandTool implements Tool {
  cursor = 'crosshair';
  down(p: Pt, e: PointerEvent) {
    const doc = app.doc, x = Math.floor(p.x), y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return;
    const src = app.wand.allLayers || !doc.active.paintable ? flatten(doc) : doc.active.target;
    const d = ctxOf(src).getImageData(0, 0, doc.width, doc.height).data;
    const m = floodSelect(d, doc.width, doc.height, x, y, app.fill.tolerance, app.fill.contiguous, { x: 0, y: 0, w: doc.width, h: doc.height });
    if (!m.some((v) => v)) return;
    commitSelection(doc, matchShape(doc, m), opFrom(e));
  }
  move() {} up() {}
}

/**
 * Quick Selection: paint over an object and the selection grows outward from the brush, following colour edges.
 * Each brush stamp flood-fills (within three brush radii, at the chosen tolerance) from the pixel under its centre.
 * The first stroke makes a new selection, later ones add; Alt subtracts.
 */
export class QuickSelectTool implements Tool {
  cursor = 'crosshair';
  brushCursor = true;
  cursorSize = () => app.quick.size;
  private on = false;
  private op: SelOp = 'add';
  private data!: Uint8ClampedArray;
  private acc!: Uint8Array;
  private circle!: Uint8Array;
  private preview: HTMLCanvasElement | null = null;
  private last: { x: number; y: number } | null = null;

  down(p: Pt, e: PointerEvent) {
    const doc = app.doc;
    if (p.x < 0 || p.y < 0 || p.x >= doc.width || p.y >= doc.height) return;
    const src = app.wand.allLayers || !doc.active.paintable ? flatten(doc) : doc.active.target;
    this.data = ctxOf(src).getImageData(0, 0, doc.width, doc.height).data;
    this.acc = new Uint8Array(doc.width * doc.height);
    this.circle = new Uint8Array(doc.width * doc.height);
    this.op = e.altKey ? 'subtract' : e.shiftKey || doc.selection ? 'add' : 'replace';
    this.preview = document.createElement('canvas'); this.preview.width = doc.width; this.preview.height = doc.height;
    this.on = true; this.last = null;
    this.stamp(p.x, p.y);
  }
  move(p: Pt) {
    if (!this.on) return;
    const r = app.quick.size / 2, l = this.last!;
    const d = Math.hypot(p.x - l.x, p.y - l.y), step = Math.max(1, r / 2);
    if (d < step) return;
    const n = Math.floor(d / step);
    for (let i = 1; i <= n; i++) this.stamp(l.x + ((p.x - l.x) * i) / n, l.y + ((p.y - l.y) * i) / n);
  }
  private stamp(fx: number, fy: number) {
    const doc = app.doc, W = doc.width, H = doc.height, x = Math.floor(fx), y = Math.floor(fy);
    this.last = { x: fx, y: fy };
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const r = Math.max(2, Math.round(app.quick.size * 1.5));            // the selection grows to 3× the brush radius, stopping at colour edges
    const x0 = Math.max(0, x - r), y0 = Math.max(0, y - r), x1 = Math.min(W - 1, x + r), y1 = Math.min(H - 1, y + r);
    for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) this.circle[yy * W + xx] = (xx - x) ** 2 + (yy - y) ** 2 <= r * r ? 1 : 0;
    const rect = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    const m = floodSelect(this.data, W, H, x, y, app.quick.tolerance, true, rect, this.circle);
    const px = ctxOf(this.preview!), img = px.getImageData(x0, y0, rect.w, rect.h);
    for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) {
      const p = yy * W + xx;
      if (m[p] && !this.acc[p]) { this.acc[p] = 1; const i = ((yy - y0) * rect.w + (xx - x0)) * 4; img.data[i] = 40; img.data[i + 1] = 140; img.data[i + 2] = 255; img.data[i + 3] = 110; }
    }
    px.putImageData(img, x0, y0);
    for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) this.circle[yy * W + xx] = 0;
    doc.emit('selection');
  }
  up() {
    if (!this.on) return;
    this.on = false;
    const doc = app.doc, acc = this.acc;
    this.preview = null;
    if (!acc.some((v) => v)) { doc.emit('selection'); return; }
    commitSelection(doc, matchShape(doc, acc), this.op);
  }
  overlay(ctx: CanvasRenderingContext2D, ts: (x: number, y: number) => [number, number]) {
    if (!this.on || !this.preview) return;
    const [x0, y0] = ts(0, 0), [x1, y1] = ts(app.doc.width, app.doc.height);
    ctx.save(); ctx.imageSmoothingEnabled = false; ctx.drawImage(this.preview, x0, y0, x1 - x0, y1 - y0); ctx.restore();
  }
}
