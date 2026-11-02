// Free Transform (Ctrl+T): scale, rotate and move the active layer's pixels (or the selected pixels) with handles, then
// commit with Enter. Smart objects are transformed through their placed transform, re-rendered from the source.
import { app } from './state';
import { clampRect, cloneCanvas, ctxOf, makeCanvas, pushPixelEdit, type Doc, type Layer } from './doc';
import type { Pt, Tool } from './tools';
import { currentMask } from './selection';
import { draw as drawSmart, linkedFor, decodeLinked } from './smart';
import { quadInfo, type Quad } from './smartmath';
import { HANDLES, bezierMesh, corners, distortCorner, distortEdge, EDGE_CORNERS, inQuad, latticeFromQuad, meshBounds, perspectiveCorner, quadMesh, renderMesh, skewEdge, dragHandle, handlePos, rotateTo, toLocal, translateGrid, translateQuad, type Handle, type XForm } from './xformmath';
export type { XForm } from './xformmath';

// ---------------------------------------------------------------- the tool
export type XMode = 'affine' | 'skew' | 'distort' | 'perspective' | 'warp';
type Edge = 't' | 'r' | 'b' | 'l';
type Drag = { kind: 'move'; x: number; y: number; cx: number; cy: number } | { kind: 'handle'; h: Handle } | { kind: 'rotate'; start: number; grab: number }
  | { kind: 'corner'; i: number; q0: Quad } | { kind: 'edge'; e: Edge; q0: Quad; x: number; y: number } | { kind: 'point'; k: number } | { kind: 'moveq'; x: number; y: number; q0: Quad | null; g0: number[] | null };

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
  /** Transform mode. Anything but 'affine' works on four corners (`quad`) or, for Warp, a 4×4 Bézier control lattice (`grid`). */
  mode: XMode = 'affine';
  quad: Quad | null = null;
  grid: number[] | null = null;
  private m0!: XForm;

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
    this.m0 = { ...this.m }; this.mode = 'affine'; this.quad = null; this.grid = null;
    this.active = true; this.trackHover = true;
    app.setTool('transform');
    app.toast('Free Transform: drag handles to scale (Shift keeps proportions, Alt from centre), drag outside to rotate, Enter applies, Esc cancels');
    app.emit('xform');
  }
  prev: typeof app.toolId = 'move';

  private hit(p: Pt): Drag | null {
    const z = app.view.zoom, m = this.m, near = (x: number, y: number) => Math.hypot(x - p.x, y - p.y) * z <= 8;
    if (this.mode !== 'affine') {
      const q = this.curQuad();
      if (this.mode === 'warp') { const g = this.grid!; for (let k = 0; k < 16; k++) if (near(g[k * 2], g[k * 2 + 1])) return { kind: 'point', k }; }
      else {
        if (this.mode !== 'skew') for (let i = 0; i < 4; i++) if (near(q[i * 2], q[i * 2 + 1])) return { kind: 'corner', i, q0: [...q] as Quad };
        if (this.mode !== 'perspective') for (const e of ['t', 'r', 'b', 'l'] as Edge[]) { const [a, b] = EDGE_CORNERS[e]; if (near((q[a * 2] + q[b * 2]) / 2, (q[a * 2 + 1] + q[b * 2 + 1]) / 2)) return { kind: 'edge', e, q0: [...q] as Quad, x: p.x, y: p.y }; }
      }
      return inQuad(q, p.x, p.y) ? { kind: 'moveq', x: p.x, y: p.y, q0: this.quad && [...this.quad] as Quad, g0: this.grid && [...this.grid] } : null;
    }
    for (const h of HANDLES) { const [x, y] = handlePos(m, h); if (near(x, y)) return { kind: 'handle', h }; }
    const [u, v] = toLocal(m, p.x, p.y);
    if (u >= 0 && v >= 0 && u <= m.w && v <= m.h) return { kind: 'move', x: p.x, y: p.y, cx: m.cx, cy: m.cy };
    return { kind: 'rotate', start: m.angle, grab: (Math.atan2(p.y - m.cy, p.x - m.cx) * 180) / Math.PI };
  }
  /** The four corners in the current mode (for Warp: the lattice's own corners). */
  private curQuad(): Quad {
    if (this.mode === 'warp' && this.grid) { const g = this.grid; return [g[0], g[1], g[6], g[7], g[30], g[31], g[24], g[25]]; }
    return this.quad ?? corners(this.m);
  }
  down(p: Pt) { if (this.active) this.drag = this.hit(p); }
  move(p: Pt, e: PointerEvent) {
    if (!this.active || !this.drag) return;
    const d = this.drag;
    if (d.kind === 'move') this.m = { ...this.m, cx: d.cx + p.x - d.x, cy: d.cy + p.y - d.y };
    else if (d.kind === 'handle') this.m = dragHandle(this.m, d.h, p.x, p.y, e.shiftKey, e.altKey);
    else if (d.kind === 'rotate') this.m = rotateTo(this.m, p.x, p.y, d.start, d.grab, e.shiftKey);
    else if (d.kind === 'corner') this.quad = this.mode === 'perspective' ? perspectiveCorner(d.q0, d.i, p.x, p.y) : distortCorner(d.q0, d.i, p.x, p.y);
    else if (d.kind === 'edge') this.quad = this.mode === 'skew' ? skewEdge(d.q0, d.e, p.x - d.x, p.y - d.y) : distortEdge(d.q0, d.e, p.x - d.x, p.y - d.y);
    else if (d.kind === 'point') { this.grid![d.k * 2] = p.x; this.grid![d.k * 2 + 1] = p.y; }
    else if (d.kind === 'moveq') { const dx = p.x - d.x, dy = p.y - d.y; if (d.q0) this.quad = translateQuad(d.q0, dx, dy); if (d.g0) this.grid = translateGrid(d.g0, dx, dy); }
    app.emit('xform'); app.doc.emit('selection');
  }
  up() { this.drag = null; }

  /** Switch between Scale/Rotate, Skew, Distort, Perspective and Warp. Leaving the free-form modes for Scale/Rotate resets the shape. */
  setMode(mode: XMode) {
    if (!this.active || mode === this.mode) return;
    if (mode !== 'affine' && this.smartMode) { app.toast('Perspective, distort and warp are not available on a smart object — rasterize it first'); app.emit('xform'); return; }
    if (mode === 'affine') { this.m = { ...this.m0 }; this.quad = null; this.grid = null; }
    else {
      if (!this.quad && !this.grid) this.quad = corners(this.m);
      if (mode === 'warp') { if (!this.grid) this.grid = latticeFromQuad(this.quad!); }
      else if (this.grid) { this.quad = this.curQuad(); this.grid = null; }
    }
    this.mode = mode; this.drag = null;
    app.emit('xform'); app.doc.emit('selection');
  }
  /** Back to the untransformed state. */
  reset() { if (!this.active) return; this.m = { ...this.m0 }; this.quad = null; this.grid = null; this.mode = 'affine'; app.emit('xform'); app.doc.emit('selection'); }

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
    } else if (this.mode !== 'affine') {
      if (!this.commitMesh()) { this.restore(); return; }
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
  /** Perspective / distort / warp: rasterise through a fine mesh (exact, anti-aliased). Returns false if nothing is visible. */
  private commitMesh(): boolean {
    const { doc, layer } = this, N = 40, mesh = this.mode === 'warp' ? bezierMesh(this.grid!, N) : quadMesh(this.curQuad(), N);
    const b = meshBounds(mesh), W = layer.canvas.width, H = layer.canvas.height;
    const ox = Math.max(0, Math.floor(b.x0) - 1), oy = Math.max(0, Math.floor(b.y0) - 1), ex = Math.min(W, Math.ceil(b.x1) + 1), ey = Math.min(H, Math.ceil(b.y1) + 1), ow = ex - ox, oh = ey - oy;
    if (ow < 1 || oh < 1) { app.toast('The transformed layer is completely outside the canvas'); return false; }
    const sw = this.src.width, sh = this.src.height, data = ctxOf(this.src).getImageData(0, 0, sw, sh).data;
    const out = renderMesh(data, sw, sh, mesh, N, ox, oy, ow, oh, ow * oh > 3_000_000 ? 1 : 2);
    const tmp = makeCanvas(ow, oh);
    ctxOf(tmp).putImageData(new ImageData(out as Uint8ClampedArray<ArrayBuffer>, ow, oh), 0, 0);
    layer.ctx.drawImage(tmp, ox, oy);
    pushPixelEdit(doc, layer, this.before!, { x: 0, y: 0, w: W, h: H }, 'Free Transform');
    if (doc.selection) { doc.setSelection(null); doc.history.merge('Free Transform'); }
    return true;
  }
  cancel() {
    if (!this.active) return;
    this.end();
    this.restore();
  }
  private restore() {
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
    if (this.mode !== 'affine') return this.overlayMesh(ctx, ts);
    const m = this.m, z = app.view.zoom, [tx, ty] = ts(0, 0), r = (m.angle * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
    // preview of the pixels
    ctx.save();
    ctx.imageSmoothingQuality = 'high';
    const a = c * m.sx * z, b = s * m.sx * z, cc = -s * m.sy * z, d = c * m.sy * z;
    const ox = m.cx + (-m.w / 2) * m.sx * c + (m.h / 2) * m.sy * s, oy = m.cy + (-m.w / 2) * m.sx * s - (m.h / 2) * m.sy * c;
    ctx.setTransform(a, b, cc, d, tx + ox * z, ty + oy * z);
    ctx.drawImage(this.src, 0, 0);
    ctx.restore();
    this.outline(ctx, ts, corners(m), HANDLES.map((h) => handlePos(m, h)));
  }
  private outline(ctx: CanvasRenderingContext2D, ts: (x: number, y: number) => [number, number], quad: Quad, handles: [number, number][]) {
    const q: [number, number][] = [0, 1, 2, 3].map((i) => ts(quad[i * 2], quad[i * 2 + 1]));
    ctx.save(); ctx.lineWidth = 1;
    for (const [col, off] of [['#000', 0], ['#fff', 1]] as const) { ctx.strokeStyle = col; ctx.beginPath(); q.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.lineDashOffset = off * 4; ctx.setLineDash([4, 4]); ctx.stroke(); }
    ctx.setLineDash([]); ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000';
    for (const h of handles) { const [x, y] = ts(h[0], h[1]); ctx.fillRect(x - 4, y - 4, 8, 8); ctx.strokeRect(x - 4.5, y - 4.5, 9, 9); }
    ctx.restore();
  }
  /** Live preview of a warped / perspective layer: the mesh drawn as affine-mapped triangles (fast, slightly seamed; the committed render is exact). */
  private overlayMesh(ctx: CanvasRenderingContext2D, ts: (x: number, y: number) => [number, number]) {
    const N = 14, mesh = this.mode === 'warp' ? bezierMesh(this.grid!, N) : quadMesh(this.curQuad(), N), sw = this.src.width, sh = this.src.height;
    const P = (i: number, j: number) => ts(mesh[(j * (N + 1) + i) * 2], mesh[(j * (N + 1) + i) * 2 + 1]);
    const tri = (A: [number, number], B: [number, number], C: [number, number], u0: number, v0: number, u1: number, v1: number, u2: number, v2: number) => {
      const det = u0 * (v1 - v2) + u1 * (v2 - v0) + u2 * (v0 - v1);
      if (Math.abs(det) < 1e-9) return;
      const a = (A[0] * (v1 - v2) + B[0] * (v2 - v0) + C[0] * (v0 - v1)) / det, c = (A[0] * (u2 - u1) + B[0] * (u0 - u2) + C[0] * (u1 - u0)) / det, e = (A[0] * (u1 * v2 - u2 * v1) + B[0] * (u2 * v0 - u0 * v2) + C[0] * (u0 * v1 - u1 * v0)) / det;
      const b = (A[1] * (v1 - v2) + B[1] * (v2 - v0) + C[1] * (v0 - v1)) / det, d = (A[1] * (u2 - u1) + B[1] * (u0 - u2) + C[1] * (u1 - u0)) / det, f = (A[1] * (u1 * v2 - u2 * v1) + B[1] * (u2 * v0 - u0 * v2) + C[1] * (u0 * v1 - u1 * v0)) / det;
      const cx = (A[0] + B[0] + C[0]) / 3, cy = (A[1] + B[1] + C[1]) / 3, grow = (p: [number, number]): [number, number] => { const dx = p[0] - cx, dy = p[1] - cy, l = Math.hypot(dx, dy) || 1; return [p[0] + (dx / l) * 0.7, p[1] + (dy / l) * 0.7]; };
      ctx.save(); ctx.beginPath(); const [g0, g1, g2] = [grow(A), grow(B), grow(C)]; ctx.moveTo(...g0); ctx.lineTo(...g1); ctx.lineTo(...g2); ctx.closePath(); ctx.clip();
      ctx.setTransform(a, b, c, d, e, f); ctx.drawImage(this.src, 0, 0); ctx.restore();
    };
    ctx.save(); ctx.imageSmoothingQuality = 'medium';
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const u0 = (i / N) * sw, u1 = ((i + 1) / N) * sw, v0 = (j / N) * sh, v1 = ((j + 1) / N) * sh, A = P(i, j), B = P(i + 1, j), C = P(i + 1, j + 1), D = P(i, j + 1);
      tri(A, B, C, u0, v0, u1, v0, u1, v1); tri(A, C, D, u0, v0, u1, v1, u0, v1);
    }
    ctx.restore();
    const q = this.curQuad();
    if (this.mode === 'warp') {
      const g = this.grid!;
      ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,.8)'; ctx.lineWidth = 1;
      for (let j = 0; j < 4; j++) { ctx.beginPath(); for (let i = 0; i < 4; i++) { const [x, y] = ts(g[(j * 4 + i) * 2], g[(j * 4 + i) * 2 + 1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.stroke(); }
      for (let i = 0; i < 4; i++) { ctx.beginPath(); for (let j = 0; j < 4; j++) { const [x, y] = ts(g[(j * 4 + i) * 2], g[(j * 4 + i) * 2 + 1]); j ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.stroke(); }
      ctx.restore();
      this.outline(ctx, ts, q, Array.from({ length: 16 }, (_, k) => [g[k * 2], g[k * 2 + 1]] as [number, number]));
    } else {
      const hs: [number, number][] = [];
      if (this.mode !== 'skew') for (let i = 0; i < 4; i++) hs.push([q[i * 2], q[i * 2 + 1]]);
      if (this.mode !== 'perspective') for (const e of ['t', 'r', 'b', 'l'] as Edge[]) { const [a, b] = EDGE_CORNERS[e]; hs.push([(q[a * 2] + q[b * 2]) / 2, (q[a * 2 + 1] + q[b * 2 + 1]) / 2]); }
      this.outline(ctx, ts, q, hs);
    }
  }
}
export const freeTransform = new FreeTransformTool();
export const startFreeTransform = () => freeTransform.begin(app.toolId === 'transform' ? 'move' : app.toolId);

// choosing another tool (or switching away) applies the transform, like Photoshop
app.on('tool', () => { if (freeTransform.active && app.toolId !== 'transform') freeTransform.commit(); });
