import { app, hexToRgb, rgbToHex, type ToolId } from './state';
import { Layer, cloneCanvas, clampRect, ctxOf, makeCanvas, pushPixelEdit, type Rect } from './doc';
import { flatten } from './render';

export interface Pt { x: number; y: number; pressure: number }
export interface Tool {
  cursor: string;
  down(p: Pt, e: PointerEvent): void;
  move(p: Pt, e: PointerEvent): void;
  up(p: Pt, e: PointerEvent): void;
  overlay?(ctx: CanvasRenderingContext2D, toScreen: (x: number, y: number) => [number, number]): void;
  brushCursor?: boolean;
}

const norm = (a: Pt, b: Pt): Rect => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });

// ---------------------------------------------------------------- brush stamps
const stampCache = new Map<string, HTMLCanvasElement>();
function getStamp(size: number, hardness: number, color: string) {
  const key = `${size}|${hardness.toFixed(2)}|${color}`;
  let s = stampCache.get(key);
  if (s) return s;
  if (stampCache.size > 200) stampCache.clear();
  const d = Math.max(1, Math.ceil(size)) + 2;
  s = makeCanvas(d, d);
  const ctx = ctxOf(s);
  const r = size / 2, c = d / 2;
  const [R, G, B] = hexToRgb(color);
  if (size <= 2) {
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(c, c, Math.max(0.6, r), 0, Math.PI * 2); ctx.fill();
  } else {
    const g = ctx.createRadialGradient(c, c, 0, c, c, r);
    const h = Math.min(0.99, hardness);
    g.addColorStop(0, `rgba(${R},${G},${B},1)`);
    g.addColorStop(h, `rgba(${R},${G},${B},1)`);
    g.addColorStop(1, `rgba(${R},${G},${B},0)`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, d, d);
  }
  stampCache.set(key, s);
  return s;
}

let strokeCanvas: HTMLCanvasElement | null = null;

class PaintTool implements Tool {
  cursor = 'none';
  brushCursor = true;
  private last: Pt | null = null;
  private carry = 0;
  private before!: HTMLCanvasElement;
  private dirty: Rect | null = null;
  private layer!: Layer;
  private active = false;
  constructor(private erase: boolean) {}

  down(p: Pt) {
    const doc = app.doc;
    this.layer = doc.active;
    this.before = cloneCanvas(this.layer.canvas);
    if (!strokeCanvas || strokeCanvas.width !== doc.width || strokeCanvas.height !== doc.height) strokeCanvas = makeCanvas(doc.width, doc.height);
    const sctx = ctxOf(strokeCanvas);
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(0, 0, doc.width, doc.height);
    sctx.save();
    if (doc.selection) { const s = doc.selection; sctx.beginPath(); sctx.rect(s.x, s.y, s.w, s.h); sctx.clip(); }
    doc.stroke = { layer: this.layer, canvas: strokeCanvas, opacity: app.brush.opacity, erase: this.erase };
    this.dirty = null; this.carry = 0; this.active = true;
    this.dab(p);
    this.last = p;
    doc.emit('pixels');
  }

  private dab(p: Pt, pressureOn = true) {
    const b = app.brush;
    const size = b.size * (pressureOn && p.pressure > 0 && p.pressure < 1 ? Math.max(0.15, p.pressure) : 1);
    const stamp = getStamp(Math.max(1, Math.round(size)), b.hardness, this.erase ? '#000000' : app.fg);
    const ctx = ctxOf(strokeCanvas!);
    ctx.globalAlpha = b.flow;
    ctx.drawImage(stamp, p.x - stamp.width / 2, p.y - stamp.height / 2);
    const r = stamp.width;
    const d = { x: p.x - r / 2 - 1, y: p.y - r / 2 - 1, w: r + 2, h: r + 2 };
    if (!this.dirty) this.dirty = d;
    else {
      const x0 = Math.min(this.dirty.x, d.x), y0 = Math.min(this.dirty.y, d.y);
      const x1 = Math.max(this.dirty.x + this.dirty.w, d.x + d.w), y1 = Math.max(this.dirty.y + this.dirty.h, d.y + d.h);
      this.dirty = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
  }

  move(p: Pt) {
    if (!this.active || !this.last) return;
    const step = Math.max(1, app.brush.size * app.brush.spacing);
    const dx = p.x - this.last.x, dy = p.y - this.last.y;
    const d = Math.hypot(dx, dy);
    if (d === 0) return;
    let pos = this.carry === 0 ? step : this.carry;
    while (pos <= d) {
      const t = pos / d;
      this.dab({ x: this.last.x + dx * t, y: this.last.y + dy * t, pressure: this.last.pressure + (p.pressure - this.last.pressure) * t });
      pos += step;
    }
    this.carry = pos - d;
    this.last = p;
    app.doc.emit('pixels');
  }

  up() {
    if (!this.active) return;
    this.active = false;
    const doc = app.doc, s = doc.stroke!;
    ctxOf(strokeCanvas!).restore();
    const ctx = this.layer.ctx;
    ctx.save();
    ctx.globalAlpha = s.opacity;
    ctx.globalCompositeOperation = this.erase ? 'destination-out' : 'source-over';
    ctx.drawImage(s.canvas, 0, 0);
    ctx.restore();
    doc.stroke = null;
    pushPixelEdit(doc, this.layer, this.before, this.dirty, this.erase ? 'Eraser' : 'Brush Stroke');
  }
}

// ---------------------------------------------------------------- bucket fill
class BucketTool implements Tool {
  cursor = 'crosshair';
  down(p: Pt) {
    const doc = app.doc, layer = doc.active;
    const w = layer.canvas.width, h = layer.canvas.height;
    const sx = Math.floor(p.x), sy = Math.floor(p.y);
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) return;
    const bounds = doc.selection ? clampRect(doc.selection, w, h)! : { x: 0, y: 0, w, h };
    if (!bounds || sx < bounds.x || sy < bounds.y || sx >= bounds.x + bounds.w || sy >= bounds.y + bounds.h) return;
    const before = cloneCanvas(layer.canvas);
    const img = layer.ctx.getImageData(0, 0, w, h), d = img.data;
    const o = (sy * w + sx) * 4;
    const t = [d[o], d[o + 1], d[o + 2], d[o + 3]];
    const tol = app.fill.tolerance;
    const match = (i: number) =>
      Math.abs(d[i] - t[0]) <= tol && Math.abs(d[i + 1] - t[1]) <= tol && Math.abs(d[i + 2] - t[2]) <= tol && Math.abs(d[i + 3] - t[3]) <= tol;
    const mask = new Uint8Array(w * h);
    const x0 = bounds.x, x1 = bounds.x + bounds.w, y0 = bounds.y, y1 = bounds.y + bounds.h;
    if (app.fill.contiguous) {
      const stack = [sx, sy];
      while (stack.length) {
        const y = stack.pop()!; let x = stack.pop()!;
        while (x >= x0 && !mask[y * w + x] && match((y * w + x) * 4)) x--;
        x++;
        let up = false, down = false;
        while (x < x1 && !mask[y * w + x] && match((y * w + x) * 4)) {
          mask[y * w + x] = 1;
          if (y > y0) { const m = !mask[(y - 1) * w + x] && match(((y - 1) * w + x) * 4); if (m && !up) { stack.push(x, y - 1); up = true; } else if (!m) up = false; }
          if (y < y1 - 1) { const m = !mask[(y + 1) * w + x] && match(((y + 1) * w + x) * 4); if (m && !down) { stack.push(x, y + 1); down = true; } else if (!m) down = false; }
          x++;
        }
      }
    } else {
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (match((y * w + x) * 4)) mask[y * w + x] = 1;
    }
    const [R, G, B] = hexToRgb(app.fg);
    const out = new ImageData(w, h), od = out.data;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      if (!mask[y * w + x]) continue;
      const i = (y * w + x) * 4;
      od[i] = R; od[i + 1] = G; od[i + 2] = B; od[i + 3] = 255;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    if (maxX < 0) return;
    const tmp = makeCanvas(w, h);
    ctxOf(tmp).putImageData(out, 0, 0);
    const ctx = layer.ctx;
    ctx.save(); ctx.globalAlpha = app.brush.opacity; ctx.drawImage(tmp, 0, 0); ctx.restore();
    pushPixelEdit(doc, layer, before, { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }, 'Paint Bucket');
  }
  move() {} up() {}
}

// ---------------------------------------------------------------- gradient
class GradientTool implements Tool {
  cursor = 'crosshair';
  private a: Pt | null = null; private b: Pt | null = null;
  down(p: Pt) { this.a = p; this.b = p; }
  move(p: Pt) { if (this.a) { this.b = p; app.doc.emit('selection'); } }
  up(p: Pt) {
    const a = this.a; this.a = null;
    if (!a) return;
    const doc = app.doc, layer = doc.active;
    if (Math.hypot(p.x - a.x, p.y - a.y) < 2) { doc.emit('selection'); return; }
    const before = cloneCanvas(layer.canvas);
    const tmp = makeCanvas(doc.width, doc.height), ctx = ctxOf(tmp);
    const g = ctx.createLinearGradient(a.x, a.y, p.x, p.y);
    const [r, gg, b] = hexToRgb(app.fg);
    g.addColorStop(0, app.fg);
    g.addColorStop(1, app.gradient.mode === 'fg-bg' ? app.bg : `rgba(${r},${gg},${b},0)`);
    ctx.fillStyle = g;
    const s = doc.selection ?? { x: 0, y: 0, w: doc.width, h: doc.height };
    ctx.fillRect(s.x, s.y, s.w, s.h);
    const lctx = layer.ctx;
    lctx.save(); lctx.globalAlpha = app.brush.opacity; lctx.drawImage(tmp, 0, 0); lctx.restore();
    pushPixelEdit(doc, layer, before, s, 'Gradient');
    this.b = null;
  }
  overlay(ctx: CanvasRenderingContext2D, ts: (x: number, y: number) => [number, number]) {
    if (!this.a || !this.b) return;
    const [x0, y0] = ts(this.a.x, this.a.y), [x1, y1] = ts(this.b.x, this.b.y);
    ctx.save(); ctx.lineWidth = 3; ctx.strokeStyle = '#000'; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    ctx.lineWidth = 1; ctx.strokeStyle = '#fff'; ctx.stroke(); ctx.restore();
  }
}

// ---------------------------------------------------------------- move
class MoveTool implements Tool {
  cursor = 'move';
  private start: Pt | null = null;
  private snap!: HTMLCanvasElement;
  private layer!: Layer;
  private selBefore: Rect | null = null;
  private selNow: Rect | null = null;
  down(p: Pt) {
    this.start = p; this.layer = app.doc.active;
    this.snap = cloneCanvas(this.layer.canvas);
    this.selBefore = app.doc.selection; this.selNow = this.selBefore;
  }
  move(p: Pt) {
    if (!this.start) return;
    const dx = Math.round(p.x - this.start.x), dy = Math.round(p.y - this.start.y);
    const ctx = this.layer.ctx, doc = app.doc;
    ctx.save();
    ctx.clearRect(0, 0, doc.width, doc.height);
    const s = this.selBefore ? clampRect(this.selBefore, doc.width, doc.height) : null;
    if (s) {
      ctx.drawImage(this.snap, 0, 0);
      ctx.clearRect(s.x, s.y, s.w, s.h);
      ctx.drawImage(this.snap, s.x, s.y, s.w, s.h, s.x + dx, s.y + dy, s.w, s.h);
      this.selNow = { ...this.selBefore!, x: this.selBefore!.x + dx, y: this.selBefore!.y + dy };
      doc.selection = this.selNow;
    } else ctx.drawImage(this.snap, dx, dy);
    ctx.restore();
    doc.emit('pixels');
  }
  up() {
    if (!this.start) return;
    this.start = null;
    const doc = app.doc, layer = this.layer, before = this.snap, selB = this.selBefore, selN = this.selNow;
    const a = cloneCanvas(layer.canvas);
    doc.history.push({
      label: 'Move',
      undo: () => { layer.ctx.clearRect(0, 0, doc.width, doc.height); layer.ctx.drawImage(before, 0, 0); doc.selection = selB; doc.emit('structure'); },
      redo: () => { layer.ctx.clearRect(0, 0, doc.width, doc.height); layer.ctx.drawImage(a, 0, 0); doc.selection = selN; doc.emit('structure'); },
    });
    doc.emit('structure');
  }
}

// ---------------------------------------------------------------- marquee
class MarqueeTool implements Tool {
  cursor = 'crosshair';
  private a: Pt | null = null;
  private before: Rect | null = null;
  down(p: Pt) { this.a = p; this.before = app.doc.selection; }
  move(p: Pt) {
    if (!this.a) return;
    const doc = app.doc;
    doc.selection = clampRect(norm(this.a, p), doc.width, doc.height);
    doc.emit('selection');
  }
  up(p: Pt) {
    if (!this.a) return;
    const doc = app.doc;
    let sel = clampRect(norm(this.a, p), doc.width, doc.height);
    if (sel && (sel.w < 2 || sel.h < 2)) sel = null;
    this.a = null;
    doc.selection = this.before;
    doc.setSelection(sel);
  }
}

// ---------------------------------------------------------------- eyedropper / hand
class EyedropperTool implements Tool {
  cursor = 'copy';
  private pick(p: Pt, e: PointerEvent) {
    const doc = app.doc;
    const x = Math.floor(p.x), y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return;
    const d = ctxOf(flatten(doc)).getImageData(x, y, 1, 1).data;
    if (d[3] === 0) return;
    const hex = rgbToHex(d[0], d[1], d[2]);
    if (e.altKey) app.setBg(hex); else app.setFg(hex);
  }
  down(p: Pt, e: PointerEvent) { this.pick(p, e); }
  move(p: Pt, e: PointerEvent) { if (e.buttons & 1) this.pick(p, e); }
  up() {}
}
class HandTool implements Tool { cursor = 'grab'; down() {} move() {} up() {} }

export const tools: Record<ToolId, Tool> = {
  move: new MoveTool(), marquee: new MarqueeTool(), brush: new PaintTool(false), eraser: new PaintTool(true),
  bucket: new BucketTool(), gradient: new GradientTool(), eyedropper: new EyedropperTool(), hand: new HandTool(),
};
