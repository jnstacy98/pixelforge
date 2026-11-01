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
  down(p: Pt, e: PointerEvent) { this.pts = [{ x: p.x, y: p.y }]; this.op = opFrom(e); this.on = true; }
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
  overlay(ctx: CanvasRenderingContext2D, ts: (x: number, y: number) => [number, number]) {
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
