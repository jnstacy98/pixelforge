// Free Transform (Ctrl+T): scale, rotate and move the active layer's pixels (or the selected pixels) with handles, then
// commit with Enter. Smart objects are transformed through their placed transform, re-rendered from the source.
import { app } from './state';
import { clampRect, cloneCanvas, ctxOf, makeCanvas, pushPixelEdit, type Doc, type Layer } from './doc';
import type { Pt, Tool } from './tools';
import { currentMask } from './selection';
import { draw as drawSmart, linkedFor, decodeLinked } from './smart';
import { quadInfo, type Quad } from './smartmath';
import { HANDLES, corners, dragHandle, handlePos, rotateTo, toLocal, type Handle, type XForm } from './xformmath';
export type { XForm } from './xformmath';

// ---------------------------------------------------------------- the tool
type Drag = { kind: 'move'; x: number; y: number; cx: number; cy: number } | { kind: 'handle'; h: Handle } | { kind: 'rotate'; start: number; grab: number };

class FreeTransformTool implements Tool {
  cursor = 'default';
  trackHover = false;
  active = false;
  m!: XForm;
  private doc!: Doc; private layer!: Layer;
  private src!: HTMLCanvasElement;
  private before: HTMLCanvasElement | null = null;
  private smartMode = false;
  private drag: Drag | null = null;

  /** Begin transforming the active layer (or its selected pixels). */
  async begin(prev: typeof app.toolId) {
    if (this.active) return;
    const doc = app.doc, layer = doc.active;
    if (layer.isGroup || layer.adjustment) return app.toast('Free Transform works on pixel, text and smart-object layers');
    if (!doc.requirePaintable() || layer.maskMode) return app.toast('Select the layer\'s pixels (not its mask) first');
    this.doc = doc; this.layer = layer; this.prev = prev; this.smartMode = !!layer.smart && !doc.selection;
    if (this.smartMode) {
      const f = linkedFor(doc, layer);
      if (!f) { this.smartMode = false; } else {
        this.src = await decodeLinked(f);
        const p = layer.smart!.placed, q = p.transform as Quad, w = p.width || this.src.width, h = p.height || this.src.height, i = quadInfo(q, w, h);
        this.m = { w, h, cx: (q[0] + q[4]) / 2, cy: (q[1] + q[5]) / 2, sx: i.sx, sy: i.sy, angle: i.rot };
        layer.hiddenForEdit = true; doc.emit('pixels');             // the preview is drawn over the canvas, so hide the layer itself meanwhile
      }
    }
    if (!this.smartMode) {
      const W = layer.canvas.width, H = layer.canvas.height, sel = doc.selection;
      let r = sel ? clampRect(sel, W, H) : null;
      const data = layer.ctx.getImageData(0, 0, W, H).data, mask = sel && doc.selMask ? ctxOf(doc.selMask).getImageData(0, 0, W, H).data : null;
      let x0 = W, y0 = H, x1 = -1, y1 = -1;
      const inR = (x: number, y: number) => !r || (x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h && (!mask || mask[(y * W + x) * 4 + 3] > 127));
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (data[(y * W + x) * 4 + 3] && inR(x, y)) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      if (x1 < 0) return app.toast('Nothing to transform here');
      const w = x1 - x0 + 1, h = y1 - y0 + 1;
      this.before = cloneCanvas(layer.canvas);
      this.src = makeCanvas(w, h);
      const sx = ctxOf(this.src);
      sx.drawImage(layer.canvas, -x0, -y0);
      if (sel) {                                                               // only the selected pixels travel
        const keep = makeCanvas(W, H), kx = ctxOf(keep);
        kx.fillStyle = '#000'; kx.fillRect(0, 0, W, H);
        kx.globalCompositeOperation = 'destination-in'; kx.drawImage(currentMask(doc)!, 0, 0);
        sx.globalCompositeOperation = 'destination-in'; sx.drawImage(keep, -x0, -y0); sx.globalCompositeOperation = 'source-over';
        const lx = layer.ctx; lx.save(); lx.globalCompositeOperation = 'destination-out'; lx.drawImage(keep, 0, 0); lx.restore();   // lift them off the layer
      } else { const lx = layer.ctx; lx.save(); lx.setTransform(1, 0, 0, 1, 0, 0); lx.clearRect(0, 0, W, H); lx.restore(); }
      layer.touchMask(); doc.emit('pixels');
      this.m = { w, h, cx: x0 + w / 2, cy: y0 + h / 2, sx: 1, sy: 1, angle: 0 };
    }
    this.active = true; this.trackHover = true;
    app.setTool('transform');
    app.toast('Free Transform: drag handles to scale (Shift keeps proportions, Alt from centre), drag outside to rotate, Enter applies, Esc cancels');
    app.emit('xform');
  }
  prev: typeof app.toolId = 'move';

  private hit(p: Pt): Drag | null {
    const z = app.view.zoom, m = this.m;
    for (const h of HANDLES) { const [x, y] = handlePos(m, h); if (Math.hypot(x - p.x, y - p.y) * z <= 8) return { kind: 'handle', h }; }
    const [u, v] = toLocal(m, p.x, p.y);
    if (u >= 0 && v >= 0 && u <= m.w && v <= m.h) return { kind: 'move', x: p.x, y: p.y, cx: m.cx, cy: m.cy };
    return { kind: 'rotate', start: m.angle, grab: (Math.atan2(p.y - m.cy, p.x - m.cx) * 180) / Math.PI };
  }
  down(p: Pt) { if (this.active) this.drag = this.hit(p); }
  move(p: Pt, e: PointerEvent) {
    if (!this.active || !this.drag) return;
    const d = this.drag;
    if (d.kind === 'move') this.m = { ...this.m, cx: d.cx + p.x - d.x, cy: d.cy + p.y - d.y };
    else if (d.kind === 'handle') this.m = dragHandle(this.m, d.h, p.x, p.y, e.shiftKey, e.altKey);
    else this.m = rotateTo(this.m, p.x, p.y, d.start, d.grab, e.shiftKey);
    app.emit('xform'); app.doc.emit('selection');
  }
  up() { this.drag = null; }

  /** Numeric entry from the options bar. */
  set(patch: Partial<XForm>) { if (this.active) { this.m = { ...this.m, ...patch }; app.doc.emit('selection'); } }

  key(e: KeyboardEvent) {
    if (!this.active) return false;
    if (e.key === 'Enter') { this.commit(); return true; }
    if (e.key === 'Escape') { this.cancel(); return true; }
    return false;
  }

  /** Apply the transform. */
  commit() {
    if (!this.active) return;
    this.end();
    const { doc, layer, m } = this;
    if (this.smartMode) {
      const p = layer.smart!.placed;
      doc.editSmart('Free Transform', layer, () => { p.transform = corners(m); drawSmart(layer, this.src); });
    } else {
      const ctx = layer.ctx;
      ctx.save(); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      const r = (m.angle * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
      ctx.setTransform(c * m.sx, s * m.sx, -s * m.sy, c * m.sy, m.cx + (-m.w / 2) * m.sx * c + (m.h / 2) * m.sy * s, m.cy + (-m.w / 2) * m.sx * s - (m.h / 2) * m.sy * c);
      ctx.drawImage(this.src, 0, 0);
      ctx.restore();
      pushPixelEdit(doc, layer, this.before!, { x: 0, y: 0, w: layer.canvas.width, h: layer.canvas.height }, 'Free Transform');
      if (doc.selection) { doc.setSelection(null); doc.history.merge('Free Transform'); }
    }
    doc.emit('structure');
  }
  cancel() {
    if (!this.active) return;
    this.end();
    if (this.before) { const c = this.layer.ctx; c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, this.layer.canvas.width, this.layer.canvas.height); c.drawImage(this.before, 0, 0); c.restore(); this.layer.touchMask(); }
    this.doc.emit('structure');
  }
  private end() {
    this.active = false; this.trackHover = false; this.drag = null; this.layer.hiddenForEdit = false;
    if (app.toolId === 'transform') { app.toolId = this.prev; app.emit('tool'); }
    app.emit('xform');
  }

  overlay(ctx: CanvasRenderingContext2D, ts: (x: number, y: number) => [number, number]) {
    if (!this.active) return;
    const m = this.m, z = app.view.zoom, [tx, ty] = ts(0, 0), r = (m.angle * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
    // preview of the pixels
    ctx.save();
    ctx.imageSmoothingQuality = 'high';
    const a = c * m.sx * z, b = s * m.sx * z, cc = -s * m.sy * z, d = c * m.sy * z;
    const ox = m.cx + (-m.w / 2) * m.sx * c + (m.h / 2) * m.sy * s, oy = m.cy + (-m.w / 2) * m.sx * s - (m.h / 2) * m.sy * c;
    ctx.setTransform(a, b, cc, d, tx + ox * z, ty + oy * z);
    ctx.drawImage(this.src, 0, 0);
    ctx.restore();
    // box + handles
    const q = corners(m).reduce<number[][]>((acc, _v, i, arr) => (i % 2 ? acc : [...acc, [arr[i], arr[i + 1]]]), []).map(([x, y]) => ts(x, y));
    ctx.save(); ctx.lineWidth = 1;
    for (const [col, off] of [['#000', 0], ['#fff', 1]] as const) { ctx.strokeStyle = col; ctx.beginPath(); q.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.lineDashOffset = off * 4; ctx.setLineDash([4, 4]); ctx.stroke(); }
    ctx.setLineDash([]); ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000';
    for (const h of HANDLES) { const [x, y] = ts(...handlePos(m, h)); ctx.fillRect(x - 4, y - 4, 8, 8); ctx.strokeRect(x - 4.5, y - 4.5, 9, 9); }
    ctx.restore();
  }
}
export const freeTransform = new FreeTransformTool();
export const startFreeTransform = () => freeTransform.begin(app.toolId === 'transform' ? 'move' : app.toolId);

// choosing another tool (or switching away) applies the transform, like Photoshop
app.on('tool', () => { if (freeTransform.active && app.toolId !== 'transform') freeTransform.commit(); });
