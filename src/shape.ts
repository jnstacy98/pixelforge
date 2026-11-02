// Vector shape layers: rendering and the Shape tool (rectangle, rounded rectangle, ellipse, polygon, star, line, pen path).
import { app } from './state';
import { ctxOf } from './doc';
import type { Pt, Tool } from './tools';
import { shapeCmds, shapeFromDrag, shapeFromPoints, SHAPE_LABELS, type Cmd, type ShapeData, type ShapeKind } from './shapemath';

const pathOf = (cmds: Cmd[]) => {
  const p = new Path2D();
  for (const c of cmds) { if (c[0] === 'M') p.moveTo(c[1], c[2]); else if (c[0] === 'L') p.lineTo(c[1], c[2]); else if (c[0] === 'C') p.bezierCurveTo(c[1], c[2], c[3], c[4], c[5], c[6]); else p.closePath(); }
  return p;
};
/** Draw a shape's fill and stroke onto a transparent canvas (anti-aliased, at document resolution). */
export function renderShape(canvas: HTMLCanvasElement, s: ShapeData) {
  const ctx = ctxOf(canvas);
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
  const p = pathOf(shapeCmds(s));
  if (s.fill) { ctx.fillStyle = s.fill; ctx.fill(p, 'nonzero'); }
  if (s.stroke && s.strokeW > 0) { ctx.strokeStyle = s.stroke; ctx.lineWidth = s.strokeW; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke(p); }
  ctx.restore();
}

export type ShapeTool = ShapeKind | 'line';
const styleFrom = (): Partial<ShapeData> => {
  const o = app.shape;
  return { fill: o.useFill ? o.fill : null, stroke: o.useStroke ? o.stroke : null, strokeW: o.strokeW, radius: o.radius, sides: o.sides, inner: o.inner };
};
const nameFor = (k: ShapeTool) => (k === 'line' ? 'Line' : SHAPE_LABELS[k]);

class ShapeToolImpl implements Tool {
  cursor = 'crosshair';
  private a: Pt | null = null; private b: Pt | null = null; private e: { shift: boolean; alt: boolean } = { shift: false, alt: false };
  private pen: { pts: [number, number][]; last: number } | null = null;
  get trackHover() { return !!this.pen; }

  private draft(): ShapeData | null {
    const k = app.shape.kind;
    if (!this.a || !this.b || k === 'path') return null;
    if (k === 'line') {
      let { x, y } = this.b; if (this.e.shift) { const dx = x - this.a.x, dy = y - this.a.y, ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), l = Math.hypot(dx, dy); x = this.a.x + Math.cos(ang) * l; y = this.a.y + Math.sin(ang) * l; }
      return shapeFromPoints([[this.a.x, this.a.y], [x, y]], false, { ...styleFrom(), fill: null, stroke: app.shape.useStroke ? app.shape.stroke : app.shape.fill, strokeW: Math.max(1, app.shape.strokeW) });
    }
    return shapeFromDrag(k, this.a.x, this.a.y, this.b.x, this.b.y, this.e, styleFrom());
  }

  down(p: Pt, e: PointerEvent) {
    if (!app.doc.requirePaintable()) return;
    if (app.shape.kind === 'path') { this.penDown(p); return; }
    this.pen = null; this.a = p; this.b = p; this.e = { shift: e.shiftKey, alt: e.altKey };
  }
  move(p: Pt, e: PointerEvent) { if (this.a) { this.b = p; this.e = { shift: e.shiftKey, alt: e.altKey }; app.doc.emit('selection'); } }
  up() {
    if (!this.a) return;
    const s = this.draft(), k = app.shape.kind as ShapeTool;
    this.a = this.b = null;
    if (s) { app.doc.createShapeLayer(s, `${nameFor(k)} ${app.doc.layers.filter((l) => l.shape).length + 1}`, renderShape); }
    else app.doc.emit('selection');
  }

  // ---- pen path: click corners; click the first point to close, Enter / double-click to finish open, Backspace removes, Esc cancels
  private penDown(p: Pt) {
    const now = performance.now(), z = app.view.zoom;
    if (!this.pen) { this.pen = { pts: [[p.x, p.y]], last: now }; app.doc.emit('selection'); return; }
    const first = this.pen.pts[0], last = this.pen.pts[this.pen.pts.length - 1];
    const dbl = now - this.pen.last < 350 && Math.hypot(p.x - last[0], p.y - last[1]) * z < 6;
    this.pen.last = now;
    if (this.pen.pts.length >= 3 && Math.hypot(p.x - first[0], p.y - first[1]) * z < 7) return this.finishPen(true);
    if (dbl) return this.finishPen(false);
    this.pen.pts.push([p.x, p.y]); app.doc.emit('selection');
  }
  private finishPen(closed: boolean) {
    const pen = this.pen; this.pen = null;
    if (!pen) return;
    const s = shapeFromPoints(pen.pts, closed, { ...styleFrom(), fill: closed && app.shape.useFill ? app.shape.fill : null, stroke: app.shape.useStroke || !closed || !app.shape.useFill ? app.shape.stroke : null, strokeW: Math.max(1, app.shape.strokeW) });
    if (s) app.doc.createShapeLayer(s, `Path ${app.doc.layers.filter((l) => l.shape).length + 1}`, renderShape); else app.doc.emit('selection');
  }
  key(e: KeyboardEvent) {
    if (!this.pen) return false;
    if (e.key === 'Enter') { this.finishPen(false); return true; }
    if (e.key === 'Escape') { this.pen = null; app.doc.emit('selection'); return true; }
    if (e.key === 'Backspace' || e.key === 'Delete') { if (this.pen.pts.length <= 1) this.pen = null; else this.pen.pts.pop(); app.doc.emit('selection'); return true; }
    return false;
  }

  overlay(ctx: CanvasRenderingContext2D, ts: (x: number, y: number) => [number, number]) {
    const draw = (cmds: Cmd[], fill: boolean) => {
      ctx.beginPath();
      for (const c of cmds) { if (c[0] === 'M') ctx.moveTo(...ts(c[1], c[2])); else if (c[0] === 'L') ctx.lineTo(...ts(c[1], c[2])); else if (c[0] === 'C') ctx.bezierCurveTo(...ts(c[1], c[2]), ...ts(c[3], c[4]), ...ts(c[5], c[6])); else ctx.closePath(); }
      if (fill) { ctx.fillStyle = 'rgba(58,123,213,.25)'; ctx.fill(); }
      ctx.lineWidth = 1; ctx.strokeStyle = '#000'; ctx.stroke(); ctx.strokeStyle = '#fff'; ctx.setLineDash([4, 4]); ctx.stroke(); ctx.setLineDash([]);
    };
    ctx.save();
    const d = this.draft(); if (d) draw(shapeCmds(d), d.closed || d.kind !== 'path');
    if (this.pen) {
      const pts: [number, number][] = [...this.pen.pts], cur = app.view.cursorDoc; if (cur) pts.push([cur.x, cur.y]);
      draw(pts.map((p, i): Cmd => [i ? 'L' : 'M', p[0], p[1]]), false);
      const [fx, fy] = ts(this.pen.pts[0][0], this.pen.pts[0][1]); ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.beginPath(); ctx.arc(fx, fy, 3.5, 0, 7); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }
}
export const shapeTool = new ShapeToolImpl();
