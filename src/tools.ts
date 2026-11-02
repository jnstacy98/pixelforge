import { app, hexToRgb, rgbToHex, paintColor, grayOf, type ToolId } from './state';
import { TextTool } from './texttool';
import { shapeTool } from './shape';
import { freeTransform } from './freetransform';
import { getTip } from './brushtips';
import { quantTilt, tiltShape } from './tilt';
import { MarqueeTool, LassoTool, WandTool, QuickSelectTool } from './selecttools';
import { clipToSelection, selectedFlags } from './selection';
import { floodSelect } from './flood';
import { chooseSpotOffset, healPatch } from './heal';
import { sampleSnapshot } from './sampling';
import { ContentMoveTool, PatchTool } from './patchtool';
import { Layer, cloneCanvas, clampRect, ctxOf, makeCanvas, pushPixelEdit, hooks, type Rect } from './doc';
import { flatten } from './render';

export interface Pt { x: number; y: number; pressure: number; tiltX?: number; tiltY?: number }
export interface Tool {
  cursor: string;
  down(p: Pt, e: PointerEvent): void;
  move(p: Pt, e: PointerEvent): void;
  up(p: Pt, e: PointerEvent): void;
  overlay?(ctx: CanvasRenderingContext2D, toScreen: (x: number, y: number) => [number, number]): void;
  brushCursor?: boolean;
  /** Redraw the overlay on every mouse move (rubber-band previews). */
  trackHover?: boolean;
  /** Diameter (doc px) of the circle drawn at the cursor when `brushCursor` is set; defaults to the brush size. */
  cursorSize?(): number;
  /** Keyboard hook while this tool is active; return true if handled. */
  key?(e: KeyboardEvent): boolean;
}

// ---------------------------------------------------------------- brush stamps
const stampCache = new Map<string, HTMLCanvasElement>();
const tipCache = new Map<string, HTMLCanvasElement>();
/** A custom tip as a canvas of `color` whose alpha is the tip shape. */
function tipCanvas(tipId: string, color: string) {
  const key = `${tipId}|${color}`, hit = tipCache.get(key), tip = getTip(tipId)!;
  if (hit) return hit;
  if (tipCache.size > 60) tipCache.clear();
  const c = makeCanvas(tip.w, tip.h), x = ctxOf(c), img = x.createImageData(tip.w, tip.h), [R, G, B] = hexToRgb(color);
  for (let p = 0; p < tip.alpha.length; p++) { img.data[p * 4] = R; img.data[p * 4 + 1] = G; img.data[p * 4 + 2] = B; img.data[p * 4 + 3] = tip.alpha[p]; }
  x.putImageData(img, 0, 0);
  tipCache.set(key, c);
  return c;
}
const tiltCache = new Map<string, HTMLCanvasElement>();
/** The brush stamp, optionally squashed into an ellipse by pen tilt. */
function getStamp(size: number, hardness: number, color: string, tipId = 'round', angle = 0, tilt?: { az: number; stretch: number }) {
  const base = baseStamp(size, hardness, color, tipId, angle);
  if (!tilt || tilt.stretch <= 1.05) return base;
  const key = `${size}|${hardness.toFixed(2)}|${color}|${tipId}|${angle}|${tilt.az}|${tilt.stretch}`;
  let s = tiltCache.get(key);
  if (s) return s;
  if (tiltCache.size > 200) tiltCache.clear();
  const d = Math.ceil(base.width * tilt.stretch) + 2;
  s = makeCanvas(d, d);
  const x = ctxOf(s);
  x.imageSmoothingQuality = 'high';
  x.translate(d / 2, d / 2); x.rotate((tilt.az * Math.PI) / 180); x.scale(tilt.stretch, 1);
  x.drawImage(base, -base.width / 2, -base.height / 2);
  tiltCache.set(key, s);
  return s;
}
function baseStamp(size: number, hardness: number, color: string, tipId = 'round', angle = 0) {
  const tip = getTip(tipId);
  const key = `${size}|${hardness.toFixed(2)}|${color}|${tip ? tipId + '|' + angle : ''}`;
  let s = stampCache.get(key);
  if (s) return s;
  if (stampCache.size > 200) stampCache.clear();
  if (tip) {                                          // custom tip: longest side = size, rotated about its centre
    const long = Math.max(1, Math.ceil(size)), sc = long / Math.max(tip.w, tip.h), sw = tip.w * sc, sh = tip.h * sc;
    const d = (angle % 360 === 0 ? long : Math.ceil(Math.hypot(sw, sh))) + 2;
    s = makeCanvas(d, d);
    const x = ctxOf(s);
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
    x.translate(d / 2, d / 2); x.rotate((angle * Math.PI) / 180);
    x.drawImage(tipCanvas(tipId, color), -sw / 2, -sh / 2, sw, sh);
    stampCache.set(key, s);
    return s;
  }
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
let cloneBuf: HTMLCanvasElement | null = null;

class PaintTool implements Tool {
  cursor = 'none';
  brushCursor = true;
  private last: Pt | null = null;
  private carry = 0;
  private before!: HTMLCanvasElement;
  private dirty: Rect | null = null;
  private layer!: Layer;
  private active = false;
  private onMask = false;
  private snap: HTMLCanvasElement | null = null;   // clone source pixels, frozen at stroke start
  private off = { x: 0, y: 0 };                    // dest → source offset for the current stroke
  constructor(private kind: 'brush' | 'eraser' | 'clone' | 'heal' | 'spot' = 'brush') {}
  private get erase() { return this.kind === 'eraser'; }
  /** Clone and Healing Brush both paint from a user-set source point. */
  private get isClone() { return this.kind === 'clone' || this.kind === 'heal'; }
  private get isHeal() { return this.kind === 'heal'; }
  /** Spot Healing paints a coverage mask, then picks its own source on release. */
  private get isSpot() { return this.kind === 'spot'; }
  /** On a mask the eraser paints the background color instead of removing alpha. */
  private get erasing() { return this.erase && !this.onMask; }

  down(p: Pt, e?: PointerEvent) {
    if (!(this.isClone && e?.altKey) && !app.doc.requirePaintable()) return;   // (Alt+click only sets a clone source)
    if (this.isClone && !this.startClone(p, e)) return;
    if (this.isSpot) this.takeSnap();
    const doc = app.doc;
    this.layer = doc.active;
    this.onMask = this.layer.maskMode;
    this.before = cloneCanvas(this.layer.target);
    if (!strokeCanvas || strokeCanvas.width !== doc.width || strokeCanvas.height !== doc.height) strokeCanvas = makeCanvas(doc.width, doc.height);
    const sctx = ctxOf(strokeCanvas);
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(0, 0, doc.width, doc.height);
    sctx.save();
    if (doc.selection) { const s = doc.selection; sctx.beginPath(); sctx.rect(s.x, s.y, s.w, s.h); sctx.clip(); }
    doc.stroke = { layer: this.layer, canvas: strokeCanvas, opacity: this.isSpot ? 0.5 : app.brush.opacity, erase: this.erasing, onMask: this.onMask };
    this.dirty = null; this.carry = 0; this.active = true;
    this.dab(p);
    this.last = p;
    doc.emit('pixels');
  }

  /** Alt+click sets the source; otherwise prepare a clone stroke. Returns false when no stroke should start. */
  private startClone(p: Pt, e?: PointerEvent): boolean {
    const c = app.clone, doc = app.doc;
    if (e?.altKey) {
      Object.assign(c, { src: { x: Math.round(p.x), y: Math.round(p.y) }, offset: null, doc, w: doc.width, h: doc.height });
      app.toast('Clone source set — now paint');
      doc.emit('selection');
      return false;
    }
    if (!c.src || c.doc !== doc || c.w !== doc.width || c.h !== doc.height) { app.toast('Alt+click to set a clone source first'); return false; }
    if (!c.aligned || !c.offset) c.offset = { x: c.src.x - Math.round(p.x), y: c.src.y - Math.round(p.y) };
    this.off = c.offset;
    this.takeSnap();
    return true;
  }

  /** Freeze the pixels we sample from (current layer, current & below, or everything) at stroke start. */
  private takeSnap() { this.snap = sampleSnapshot(); }

  /** A brush-tip-shaped patch of source pixels, positioned on whole pixels so cloning stays sharp. */
  private cloneStamp(p: Pt, size: number) {
    const brush = getStamp(Math.max(1, Math.round(size)), app.brush.hardness, '#000000', app.brush.tip, this.angleFor(0));
    const d = brush.width;
    if (!cloneBuf || cloneBuf.width !== d || cloneBuf.height !== d) cloneBuf = makeCanvas(d, d);
    const x = Math.round(p.x - d / 2), y = Math.round(p.y - d / 2), cx = ctxOf(cloneBuf);
    cx.globalAlpha = 1; cx.globalCompositeOperation = 'source-over';
    cx.clearRect(0, 0, d, d);
    cx.drawImage(this.snap!, x + this.off.x, y + this.off.y, d, d, 0, 0, d, d);
    cx.globalCompositeOperation = 'destination-in';
    cx.drawImage(brush, 0, 0);
    cx.globalCompositeOperation = 'source-over';
    return { img: cloneBuf, x, y };
  }

  /** Tip rotation for a dab: the fixed angle, plus the stroke direction when "follow stroke" is on (quantised to 5°). */
  private angleFor(dir: number) {
    const b = app.brush, a = b.angle + (b.follow ? dir : 0);
    return ((Math.round(a / 5) * 5) % 360 + 360) % 360;
  }

  private dab(p: Pt, pressureOn = true, dir = 0) {
    const b = app.brush;
    const tilt = b.tilt && (p.tiltX || p.tiltY) ? quantTilt(tiltShape(p.tiltX ?? 0, p.tiltY ?? 0)) : undefined;
    const size = b.size * (pressureOn && p.pressure > 0 && p.pressure < 1 ? Math.max(0.15, p.pressure) : 1);
    let img: HTMLCanvasElement, x: number, y: number;
    if (this.isClone) ({ img, x, y } = this.cloneStamp(p, size));
    else {
      const color = this.isSpot ? '#000000' : this.onMask ? grayOf(this.erase ? app.bg : app.fg) : this.erase ? '#000000' : app.fg;
      img = getStamp(Math.max(1, Math.round(size)), b.hardness, color, b.tip, this.angleFor(dir), tilt);
      x = p.x - img.width / 2; y = p.y - img.height / 2;
    }
    const ctx = ctxOf(strokeCanvas!);
    ctx.globalAlpha = this.isSpot ? 1 : b.flow;
    ctx.drawImage(img, x, y);
    const r = img.width;
    const d = { x: x - 1, y: y - 1, w: r + 2, h: r + 2 };
    if (!this.dirty) this.dirty = d;
    else {
      const x0 = Math.min(this.dirty.x, d.x), y0 = Math.min(this.dirty.y, d.y);
      const x1 = Math.max(this.dirty.x + this.dirty.w, d.x + d.w), y1 = Math.max(this.dirty.y + this.dirty.h, d.y + d.h);
      this.dirty = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
  }

  /**
   * Replace the raw stroke (clone preview / spot coverage) with healed pixels: source texture + colours matched to
   * the destination's surroundings. Returns false if nothing could be healed (stroke is then discarded).
   */
  private healStroke(): boolean {
    const d = this.dirty!, snap = this.snap!, sctx = ctxOf(strokeCanvas!);
    const W = snap.width, H = snap.height, pad = 10;
    const x0 = Math.max(0, Math.floor(d.x - pad)), y0 = Math.max(0, Math.floor(d.y - pad));
    const r = { x: x0, y: y0, w: Math.min(W, Math.ceil(d.x + d.w + pad)) - x0, h: Math.min(H, Math.ceil(d.y + d.h + pad)) - y0 };
    if (r.w < 1 || r.h < 1) return false;
    const cov = sctx.getImageData(r.x, r.y, r.w, r.h).data;
    const dst = ctxOf(snap).getImageData(r.x, r.y, r.w, r.h).data;
    let off = this.off;
    if (this.isSpot) {
      const found = this.pickSpotOffset(r, d, dst, cov);
      if (!found) { sctx.clearRect(r.x, r.y, r.w, r.h); app.toast('Spot Healing: no clean area found nearby'); return false; }
      off = { x: found[0], y: found[1] };
    }
    const src = ctxOf(snap).getImageData(r.x + off.x, r.y + off.y, r.w, r.h).data;   // outside the image reads as transparent
    const img = new ImageData(r.w, r.h);
    img.data.set(healPatch(dst, src, cov, r.w, r.h));
    sctx.putImageData(img, r.x, r.y);
    return true;
  }

  /** Spot Healing: search rings of offsets around the blemish for the source whose surroundings match best. */
  private pickSpotOffset(r: Rect, d: Rect, dst: Uint8ClampedArray, cov: Uint8ClampedArray): [number, number] | null {
    const snap = this.snap!, W = snap.width, H = snap.height;
    const base = Math.max(d.w, d.h) / 2 + 12, cands: [number, number][] = [];
    for (const k of [1.6, 2.4, 3.3, 4.5]) for (let a = 0; a < 16; a++) {
      const dx = Math.round(Math.cos((a * Math.PI) / 8) * base * k), dy = Math.round(Math.sin((a * Math.PI) / 8) * base * k);
      const apart = Math.abs(dx) >= d.w + 6 || Math.abs(dy) >= d.h + 6;           // source must not overlap the blemish
      if (apart && r.x + dx >= 0 && r.y + dy >= 0 && r.x + r.w + dx <= W && r.y + r.h + dy <= H) cands.push([dx, dy]);
    }
    if (!cands.length) return null;
    const ax = Math.max(0, r.x + Math.min(...cands.map((c) => c[0]))), ay = Math.max(0, r.y + Math.min(...cands.map((c) => c[1])));
    const bx = Math.min(W, r.x + r.w + Math.max(...cands.map((c) => c[0]))), by = Math.min(H, r.y + r.h + Math.max(...cands.map((c) => c[1])));
    const area = ctxOf(snap).getImageData(ax, ay, bx - ax, by - ay).data;
    return chooseSpotOffset(area, bx - ax, by - ay, ax, ay, dst, cov, r, cands);
  }

  /** Clone Stamp / Healing Brush: show where pixels are being sampled from. */
  overlay(ctx: CanvasRenderingContext2D, ts: (x: number, y: number) => [number, number]) {
    const c = app.clone;
    if (!this.isClone || !c.src || c.doc !== app.doc) return;
    const cur = app.view.cursorDoc;
    const pos = (c.aligned || this.active) && c.offset && cur ? { x: cur.x + c.offset.x, y: cur.y + c.offset.y } : c.src;
    const [sx, sy] = ts(pos.x, pos.y), r = Math.max(4, (app.brush.size * app.view.zoom) / 2);
    ctx.save(); ctx.lineWidth = 1;
    for (const [col, grow] of [['rgba(0,0,0,.85)', 0], ['rgba(255,255,255,.9)', 1]] as const) {
      ctx.strokeStyle = col; ctx.beginPath(); ctx.arc(sx, sy, r + grow, 0, Math.PI * 2);
      ctx.moveTo(sx - 7 - grow, sy); ctx.lineTo(sx + 7 + grow, sy); ctx.moveTo(sx, sy - 7 - grow); ctx.lineTo(sx, sy + 7 + grow); ctx.stroke();
    }
    ctx.restore();
  }

  move(p: Pt) {
    if (!this.active || !this.last) return;
    const step = Math.max(1, app.brush.size * app.brush.spacing);
    const dx = p.x - this.last.x, dy = p.y - this.last.y;
    const d = Math.hypot(dx, dy);
    if (d === 0) return;
    let pos = this.carry === 0 ? step : this.carry;
    const dir = (Math.atan2(dy, dx) * 180) / Math.PI;
    while (pos <= d) {
      const t = pos / d;
      this.dab({ x: this.last.x + dx * t, y: this.last.y + dy * t, pressure: this.last.pressure + (p.pressure - this.last.pressure) * t, tiltX: p.tiltX, tiltY: p.tiltY }, true, dir);
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
    if ((this.isHeal || this.isSpot) && this.dirty) { if (!this.healStroke()) this.dirty = null; }
    if (this.isSpot) s.opacity = 1;
    if (doc.selMask) clipToSelection(doc, strokeCanvas!, strokeCanvas!);
    const ctx = this.layer.tctx;
    ctx.save();
    ctx.globalAlpha = s.opacity;
    ctx.globalCompositeOperation = this.erasing ? 'destination-out' : 'source-over';
    ctx.drawImage(s.canvas, 0, 0);
    ctx.restore();
    doc.stroke = null;
    pushPixelEdit(doc, this.layer, this.before, this.dirty, this.isHeal ? 'Healing Brush' : this.isSpot ? 'Spot Healing' : this.isClone ? 'Clone Stamp' : this.erase ? 'Eraser' : 'Brush Stroke');
    this.snap = null;
  }
}

// ---------------------------------------------------------------- bucket fill
class BucketTool implements Tool {
  cursor = 'crosshair';
  down(p: Pt) {
    if (!app.doc.requirePaintable()) return;
    const doc = app.doc, layer = doc.active;
    const w = layer.target.width, h = layer.target.height;
    const sx = Math.floor(p.x), sy = Math.floor(p.y);
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) return;
    const bounds = doc.selection ? clampRect(doc.selection, w, h) : { x: 0, y: 0, w, h };
    if (!bounds) return;
    const before = cloneCanvas(layer.target);
    const img = layer.tctx.getImageData(0, 0, w, h);
    const mask = floodSelect(img.data, w, h, sx, sy, app.fill.tolerance, app.fill.contiguous, bounds, selectedFlags(doc));
    const [R, G, B] = hexToRgb(paintColor(app.fg));
    const out = new ImageData(w, h), od = out.data;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = bounds.y; y < bounds.y + bounds.h; y++) for (let x = bounds.x; x < bounds.x + bounds.w; x++) {
      if (!mask[y * w + x]) continue;
      const i = (y * w + x) * 4;
      od[i] = R; od[i + 1] = G; od[i + 2] = B; od[i + 3] = 255;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    if (maxX < 0) return;
    const tmp = makeCanvas(w, h);
    ctxOf(tmp).putImageData(out, 0, 0);
    const ctx = layer.tctx;
    ctx.save(); ctx.globalAlpha = app.brush.opacity; ctx.drawImage(tmp, 0, 0); ctx.restore();
    pushPixelEdit(doc, layer, before, { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }, 'Paint Bucket');
  }
  move() {} up() {}
}

// ---------------------------------------------------------------- gradient
class GradientTool implements Tool {
  cursor = 'crosshair';
  private a: Pt | null = null; private b: Pt | null = null;
  down(p: Pt) { if (!app.doc.requirePaintable()) return; this.a = p; this.b = p; }
  move(p: Pt) { if (this.a) { this.b = p; app.doc.emit('selection'); } }
  up(p: Pt) {
    const a = this.a; this.a = null;
    if (!a) return;
    const doc = app.doc, layer = doc.active;
    if (Math.hypot(p.x - a.x, p.y - a.y) < 2) { doc.emit('selection'); return; }
    const before = cloneCanvas(layer.target);
    const tmp = makeCanvas(doc.width, doc.height), ctx = ctxOf(tmp);
    const g = ctx.createLinearGradient(a.x, a.y, p.x, p.y);
    const fg = paintColor(app.fg);
    const [r, gg, b] = hexToRgb(fg);
    g.addColorStop(0, fg);
    g.addColorStop(1, app.gradient.mode === 'fg-bg' ? paintColor(app.bg) : `rgba(${r},${gg},${b},0)`);
    ctx.fillStyle = g;
    const s = doc.selection ?? { x: 0, y: 0, w: doc.width, h: doc.height };
    ctx.fillRect(s.x, s.y, s.w, s.h);
    if (doc.selMask) clipToSelection(doc, tmp, tmp);
    const lctx = layer.tctx;
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
/**
 * Moves the active layer — pixels, linked mask and text position — or, for a group, everything inside it.
 * With a selection (and a plain layer) it moves just the selected pixels of the edit target instead.
 */
class MoveTool implements Tool {
  cursor = 'move';
  private start: Pt | null = null;
  private items: { layer: Layer; get: () => HTMLCanvasElement; snap: HTMLCanvasElement }[] = [];
  private texts: { layer: Layer; x: number; y: number }[] = [];
  private shapes: { layer: Layer; e: number; f: number }[] = [];
  private rasterShape: Layer | null = null;     // a shape layer whose pixels are being moved through a selection: it stops being a shape
  private layers: Layer[] = [];
  private selMode = false;
  private selBefore: Rect | null = null;
  private selNow: Rect | null = null;
  private selMaskBefore: HTMLCanvasElement | null = null;
  private floating: HTMLCanvasElement | null = null;
  down(p: Pt) {
    const doc = app.doc, l = doc.active;
    this.start = p;
    this.selBefore = doc.selection; this.selNow = this.selBefore; this.selMaskBefore = doc.selMask;
    this.selMode = !!doc.selection && !l.isGroup;
    this.layers = l.isGroup ? [...doc.layers.filter((e) => doc.isDescendant(e, l)), l] : [l];
    this.items = [];
    if (this.selMode) {
      const c = l.target;
      this.items = [{ layer: l, get: () => l.target, snap: cloneCanvas(c) }];
    } else {
      for (const e of this.layers) {
        if (!e.isGroup) this.items.push({ layer: e, get: () => e.canvas, snap: cloneCanvas(e.canvas) });
        if (e.mask) this.items.push({ layer: e, get: () => e.mask!, snap: cloneCanvas(e.mask) });
      }
    }
    this.texts = this.selMode ? [] : this.layers.filter((e) => e.text).map((e) => ({ layer: e, x: e.text!.x, y: e.text!.y }));
    this.rasterShape = this.selMode && l.shape ? l : null;
    this.shapes = this.selMode ? [] : this.layers.filter((e) => e.shape).map((e) => ({ layer: e, e: e.shape!.T[4], f: e.shape!.T[5] }));
    this.floating = this.selMode && doc.selMask ? clipToSelection(doc, this.items[0].snap) : null;   // selected pixels, cut out
  }
  move(p: Pt) {
    if (!this.start) return;
    const dx = Math.round(p.x - this.start.x), dy = Math.round(p.y - this.start.y), doc = app.doc;
    const s = this.selMode && this.selBefore ? clampRect(this.selBefore, doc.width, doc.height) : null;
    for (const it of this.items) {
      const c = it.get(), ctx = ctxOf(c);
      ctx.save();
      ctx.clearRect(0, 0, c.width, c.height);
      if (s && this.floating) {
        ctx.drawImage(it.snap, 0, 0);
        ctx.globalCompositeOperation = 'destination-out';
        ctx.drawImage(this.selMaskBefore!, 0, 0);
        ctx.globalCompositeOperation = 'source-over';
        ctx.drawImage(this.floating, dx, dy);
      } else if (s) {
        ctx.drawImage(it.snap, 0, 0);
        ctx.clearRect(s.x, s.y, s.w, s.h);
        ctx.drawImage(it.snap, s.x, s.y, s.w, s.h, s.x + dx, s.y + dy, s.w, s.h);
      } else ctx.drawImage(it.snap, dx, dy);
      ctx.restore();
    }
    if (s) {
      this.selNow = { ...this.selBefore!, x: this.selBefore!.x + dx, y: this.selBefore!.y + dy }; doc.selection = this.selNow;
      if (this.selMaskBefore) doc.selShift = { dx, dy };
    }
    for (const t of this.texts) { t.layer.text!.x = t.x + dx; t.layer.text!.y = t.y + dy; }
    for (const sh of this.shapes) { sh.layer.shape!.T[4] = sh.e + dx; sh.layer.shape!.T[5] = sh.f + dy; }
    for (const l of this.layers) { l.touchMask(); if (l.fmaskEdit) hooks.fmaskChanged(l); }
    doc.emit('pixels');
  }
  up() {
    if (!this.start) return;
    this.start = null;
    const doc = app.doc, items = this.items, texts = this.texts, layers = this.layers, selB = this.selBefore, selN = this.selNow;
    const maskB = this.selMaskBefore;
    let maskN = maskB;
    if (maskB && doc.selShift) { maskN = makeCanvas(maskB.width, maskB.height); ctxOf(maskN).drawImage(maskB, doc.selShift.dx, doc.selShift.dy); doc.selMask = maskN; }
    doc.selShift = null; this.floating = null;
    const after = items.map((it) => cloneCanvas(it.get()));
    const textsAfter = texts.map((t) => ({ x: t.layer.text!.x, y: t.layer.text!.y })), shapes = this.shapes, shapesAfter = shapes.map((q) => ({ e: q.layer.shape!.T[4], f: q.layer.shape!.T[5] }));
    const put = (src: HTMLCanvasElement[], sel: Rect | null, sm: HTMLCanvasElement | null, txt: { x: number; y: number }[], shp: { e: number; f: number }[], undo: boolean) => {
      items.forEach((it, i) => { const c = it.get(), x = ctxOf(c); x.clearRect(0, 0, c.width, c.height); x.drawImage(src[i], 0, 0); });
      doc.selection = sel; doc.selMask = sm;
      texts.forEach((t, i) => { t.layer.text!.x = txt[i].x; t.layer.text!.y = txt[i].y; });
      shapes.forEach((q, i) => { q.layer.shape!.T[4] = shp[i].e; q.layer.shape!.T[5] = shp[i].f; });
      if (rs) rs.shape = undo ? rsShape : null;
      for (const l of layers) { l.touchMask(); if (l.fmaskEdit) hooks.fmaskChanged(l); }
      doc.emit('structure');
    };
    const rs = this.rasterShape, rsShape = rs ? rs.shape : null;
    if (rs) rs.shape = null;
    const before = items.map((it) => it.snap), textsBefore = texts.map((t) => ({ x: t.x, y: t.y })), shapesBefore = shapes.map((q) => ({ e: q.e, f: q.f }));
    doc.history.push({ label: 'Move', undo: () => put(before, selB, maskB, textsBefore, shapesBefore, true), redo: () => put(after, selN, maskN, textsAfter, shapesAfter, false) });
    doc.emit('structure');
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
  move: new MoveTool(), marquee: new MarqueeTool(), brush: new PaintTool('brush'), eraser: new PaintTool('eraser'),
  bucket: new BucketTool(), gradient: new GradientTool(), eyedropper: new EyedropperTool(), hand: new HandTool(), text: new TextTool(), lasso: new LassoTool(), wand: new WandTool(), quick: new QuickSelectTool(), clone: new PaintTool('clone'), heal: new PaintTool('heal'), spot: new PaintTool('spot'), patch: new PatchTool(), cmove: new ContentMoveTool(), transform: freeTransform, shape: shapeTool,
};
