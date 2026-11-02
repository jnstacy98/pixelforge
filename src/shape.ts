// Vector shape layers: rendering and the Shape tool (rectangle, rounded rectangle, ellipse, polygon, star, line, pen path).
import { app } from './state';
import { ctxOf } from './doc';
import type { Pt, Tool } from './tools';
import { apply, autoSmooth, cloneShape, insertAnchor, invertMat, nearestOnPath, normalizePath, shapeCmds, shapeFromDrag, shapeFromPoints, SHAPE_LABELS, type Cmd, type Handles, type ShapeData, type ShapeKind } from './shapemath';
import { cloneCanvas, type Layer } from './doc';

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
  private pen: { pts: [number, number][]; curves: (Handles | null)[]; last: number } | null = null;
  private penDrag = false;
  /** Editing an existing path layer: which anchor / handle is being dragged. */
  private ed: { layer: Layer; part: 'anchor' | 'in' | 'out'; i: number; start: ShapeData; startCanvas: HTMLCanvasElement; moved: boolean; alt: boolean } | null = null;
  private selAnchor = -1;
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
    if (!this.pen && this.editDown(p, e)) return;
    if (app.shape.kind === 'path') { this.penDown(p); return; }
    this.pen = null; this.a = p; this.b = p; this.e = { shift: e.shiftKey, alt: e.altKey };
  }
  move(p: Pt, e: PointerEvent) {
    if (this.ed) return this.editMove(p, e);
    if (this.pen && this.penDrag) {                                        // click-drag with the pen: pull out symmetric Bézier handles
      const pts = this.pen.pts, k = pts.length - 1, a = pts[k], o: [number, number] = [p.x - a[0], p.y - a[1]];
      if (Math.hypot(o[0], o[1]) * app.view.zoom > 3) { this.pen.curves[k] = { o, i: e.altKey ? (this.pen.curves[k]?.i ?? [0, 0]) : [-o[0], -o[1]] }; app.doc.emit('selection'); }
      return;
    }
    if (this.a) { this.b = p; this.e = { shift: e.shiftKey, alt: e.altKey }; app.doc.emit('selection'); }
  }
  up() {
    if (this.ed) return this.editUp();
    this.penDrag = false;
    if (!this.a) return;
    const s = this.draft(), k = app.shape.kind as ShapeTool;
    this.a = this.b = null;
    if (s) { app.doc.createShapeLayer(s, `${nameFor(k)} ${app.doc.layers.filter((l) => l.shape).length + 1}`, renderShape); }
    else app.doc.emit('selection');
  }

  // ---- pen path: click corners; click the first point to close, Enter / double-click to finish open, Backspace removes, Esc cancels
  private penDown(p: Pt) {
    const now = performance.now(), z = app.view.zoom;
    if (!this.pen) { this.pen = { pts: [[p.x, p.y]], curves: [null], last: now }; this.penDrag = true; app.doc.emit('selection'); return; }
    const first = this.pen.pts[0], last = this.pen.pts[this.pen.pts.length - 1];
    const dbl = now - this.pen.last < 350 && Math.hypot(p.x - last[0], p.y - last[1]) * z < 6;
    this.pen.last = now;
    if (this.pen.pts.length >= 3 && Math.hypot(p.x - first[0], p.y - first[1]) * z < 7) return this.finishPen(true);
    if (dbl) return this.finishPen(false);
    this.pen.pts.push([p.x, p.y]); this.pen.curves.push(null); this.penDrag = true; app.doc.emit('selection');
  }
  private finishPen(closed: boolean) {
    const pen = this.pen; this.pen = null;
    if (!pen) return;
    const s = shapeFromPoints(pen.pts, closed, { ...styleFrom(), fill: closed && app.shape.useFill ? app.shape.fill : null, stroke: app.shape.useStroke || !closed || !app.shape.useFill ? app.shape.stroke : null, strokeW: Math.max(1, app.shape.strokeW) }, pen.curves);
    if (s) app.doc.createShapeLayer(s, `Path ${app.doc.layers.filter((l) => l.shape).length + 1}`, renderShape); else app.doc.emit('selection');
  }
  key(e: KeyboardEvent) {
    if (!this.pen) return this.editKey(e);
    if (e.key === 'Enter') { this.finishPen(false); return true; }
    if (e.key === 'Escape') { this.pen = null; app.doc.emit('selection'); return true; }
    if (e.key === 'Backspace' || e.key === 'Delete') { if (this.pen.pts.length <= 1) this.pen = null; else { this.pen.pts.pop(); this.pen.curves.pop(); } app.doc.emit('selection'); return true; }
    return false;
  }

  // ---- editing an existing path layer (anchors and Bézier handles)
  private pathLayer(): Layer | null { const l = app.doc.active; return l.shape && l.shape.kind === 'path' && !l.maskMode ? l : null; }
  private editDown(p: Pt, e: PointerEvent): boolean {
    const layer = this.pathLayer(); if (!layer) return false;
    const s = layer.shape!, z = app.view.zoom, near = (q: [number, number]) => Math.hypot(q[0] - p.x, q[1] - p.y) * z <= 8;
    const at = (k: number) => apply(s.T, s.pts[k][0], s.pts[k][1]);
    const hand = (k: number, h: 'i' | 'o') => { const c = s.curves?.[k]; return c ? apply(s.T, s.pts[k][0] + c[h][0], s.pts[k][1] + c[h][1]) : null; };
    const begin = (part: 'anchor' | 'in' | 'out', i: number) => { this.selAnchor = i; this.ed = { layer, part, i, start: cloneShape(s)!, startCanvas: cloneCanvas(layer.canvas), moved: false, alt: e.altKey }; app.doc.emit('selection'); return true; };
    for (let k = 0; k < s.pts.length; k++) {                                      // handles first when an anchor's handles overlap it only if they are real handles
      const hi = hand(k, 'i'), ho = hand(k, 'o');
      if (ho && near(ho) && !near(at(k))) return begin('out', k);
      if (hi && near(hi) && !near(at(k))) return begin('in', k);
    }
    for (let k = 0; k < s.pts.length; k++) if (near(at(k))) {
      if (e.altKey) { this.toggleSmooth(layer, k); return true; }                  // Alt-click: smooth ⇄ corner
      return begin('anchor', k);
    }
    const inv = invertMat(s.T);
    if (e.ctrlKey && inv) {                                                       // Ctrl-click on a segment: add an anchor there
      const [lx, ly] = apply(inv, p.x, p.y), hit = nearestOnPath(s, lx, ly);
      if (hit && hit.d * Math.hypot(s.T[0], s.T[1]) * z <= 8) {
        app.doc.editShape('Add Anchor', layer, () => { const r = insertAnchor(s.pts, s.curves ?? s.pts.map(() => null), hit.seg, hit.t, s.closed); layer.shape = normalizePath({ ...s, pts: r.pts, curves: r.curves }); renderShape(layer.canvas, layer.shape); layer.touchMask(); });
        return true;
      }
    }
    return false;
  }
  private toggleSmooth(layer: Layer, k: number) {
    app.doc.editShape('Convert Anchor', layer, () => {
      const s = layer.shape!, cv = (s.curves ?? s.pts.map(() => null)).map((c) => (c ? { i: [...c.i] as [number, number], o: [...c.o] as [number, number] } : null));
      cv[k] = cv[k] ? null : autoSmooth(s.pts, k, s.closed);
      layer.shape = normalizePath({ ...s, curves: cv }); renderShape(layer.canvas, layer.shape); layer.touchMask();
    });
  }
  private editMove(p: Pt, e: PointerEvent) {
    const ed = this.ed!, s = ed.layer.shape!, inv = invertMat(s.T); if (!inv) return;
    const [lx, ly] = apply(inv, p.x, p.y), k = ed.i;
    if (ed.part === 'anchor') s.pts[k] = [lx, ly];
    else {
      const off: [number, number] = [lx - s.pts[k][0], ly - s.pts[k][1]];
      const cv = (s.curves ??= s.pts.map(() => null)), c = (cv[k] ??= { i: [0, 0], o: [0, 0] }), mine = ed.part === 'out' ? 'o' : 'i', other = ed.part === 'out' ? 'i' : 'o';
      c[mine] = off;
      if (!e.altKey) { const ol = Math.hypot(c[other][0], c[other][1]) || Math.hypot(off[0], off[1]), ml = Math.hypot(off[0], off[1]) || 1; c[other] = [(-off[0] / ml) * ol, (-off[1] / ml) * ol]; }   // keep the handles collinear
    }
    ed.moved = true; renderShape(ed.layer.canvas, s); ed.layer.touchMask(); app.doc.emit('pixels');
  }
  private editUp() {
    const ed = this.ed!; this.ed = null;
    if (!ed.moved) { app.doc.emit('selection'); return; }
    const after = normalizePath(ed.layer.shape!), c = ed.layer.ctx;
    ed.layer.shape = ed.start; c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, ed.layer.canvas.width, ed.layer.canvas.height); c.drawImage(ed.startCanvas, 0, 0); c.restore();
    app.doc.editShape('Edit Path', ed.layer, () => { ed.layer.shape = after; renderShape(ed.layer.canvas, after); ed.layer.touchMask(); });
  }
  private editKey(e: KeyboardEvent) {
    const layer = this.pathLayer();
    if (!layer || this.selAnchor < 0 || (e.key !== 'Delete' && e.key !== 'Backspace')) return false;
    const s = layer.shape!; if (s.pts.length <= 2) { app.toast('A path needs at least two anchors — delete the layer instead'); return true; }
    const k = this.selAnchor; this.selAnchor = -1;
    app.doc.editShape('Delete Anchor', layer, () => { layer.shape = normalizePath({ ...s, pts: s.pts.filter((_, i) => i !== k), curves: s.curves?.filter((_, i) => i !== k) }); renderShape(layer.canvas, layer.shape); layer.touchMask(); });
    return true;
  }
  private drawEditHandles(ctx: CanvasRenderingContext2D, ts: (x: number, y: number) => [number, number]) {
    const layer = this.pathLayer(); if (!layer) return;
    const s = layer.shape!;
    ctx.save(); ctx.lineWidth = 1;
    s.pts.forEach((pt, k) => {
      const [ax, ay] = ts(...apply(s.T, pt[0], pt[1])), c = s.curves?.[k];
      if (c) for (const h of [c.i, c.o]) {
        if (!h[0] && !h[1]) continue;
        const [hx, hy] = ts(...apply(s.T, pt[0] + h[0], pt[1] + h[1]));
        ctx.strokeStyle = '#1a6fd1'; ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(hx, hy); ctx.stroke();
        ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(hx, hy, 3.5, 0, 7); ctx.fill(); ctx.stroke();
      }
    });
    s.pts.forEach((pt, k) => { const [x, y] = ts(...apply(s.T, pt[0], pt[1])); ctx.fillStyle = k === this.selAnchor ? '#1a6fd1' : '#fff'; ctx.strokeStyle = '#000'; ctx.fillRect(x - 4, y - 4, 8, 8); ctx.strokeRect(x - 4.5, y - 4.5, 9, 9); });
    ctx.restore();
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
      const { pts, curves } = this.pen, cur = app.view.cursorDoc, cmds: Cmd[] = [['M', pts[0][0], pts[0][1]]];
      const seg = (a: [number, number], ca: Handles | null | undefined, b: [number, number], cb: Handles | null | undefined) => { if (ca?.o || cb?.i) cmds.push(['C', a[0] + (ca?.o[0] ?? 0), a[1] + (ca?.o[1] ?? 0), b[0] + (cb?.i[0] ?? 0), b[1] + (cb?.i[1] ?? 0), b[0], b[1]]); else cmds.push(['L', b[0], b[1]]); };
      for (let i = 1; i < pts.length; i++) seg(pts[i - 1], curves[i - 1], pts[i], curves[i]);
      if (cur && !this.penDrag) seg(pts[pts.length - 1], curves[pts.length - 1], [cur.x, cur.y], null);
      draw(cmds, false);
      pts.forEach((pt, k) => { const c = curves[k]; if (!c) return; const [ax, ay] = ts(pt[0], pt[1]); for (const h of [c.i, c.o]) { const [hx, hy] = ts(pt[0] + h[0], pt[1] + h[1]); ctx.strokeStyle = '#1a6fd1'; ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(hx, hy); ctx.stroke(); ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(hx, hy, 3, 0, 7); ctx.fill(); ctx.stroke(); } });
      const [fx, fy] = ts(this.pen.pts[0][0], this.pen.pts[0][1]); ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.beginPath(); ctx.arc(fx, fy, 3.5, 0, 7); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
    if (!this.pen) this.drawEditHandles(ctx, ts);
  }
}
export const shapeTool = new ShapeToolImpl();
