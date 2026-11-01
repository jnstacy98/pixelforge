import { History } from './history';
import { renderText, textLabel, type TextData } from './text';

export interface Rect { x: number; y: number; w: number; h: number }
export type ChangeKind = 'pixels' | 'structure' | 'selection';

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}
export const ctxOf = (c: HTMLCanvasElement) => c.getContext('2d', { willReadFrequently: true })!;
export function cloneCanvas(c: HTMLCanvasElement): HTMLCanvasElement {
  const n = makeCanvas(c.width, c.height);
  ctxOf(n).drawImage(c, 0, 0);
  return n;
}

/** Blend modes keyed by their PSD names so PSD round-trips are lossless. */
export const BLEND_MODES: { id: string; label: string; op: GlobalCompositeOperation }[] = [
  { id: 'normal', label: 'Normal', op: 'source-over' },
  { id: 'darken', label: 'Darken', op: 'darken' },
  { id: 'multiply', label: 'Multiply', op: 'multiply' },
  { id: 'color burn', label: 'Color Burn', op: 'color-burn' },
  { id: 'lighten', label: 'Lighten', op: 'lighten' },
  { id: 'screen', label: 'Screen', op: 'screen' },
  { id: 'color dodge', label: 'Color Dodge', op: 'color-dodge' },
  { id: 'linear dodge', label: 'Linear Dodge (Add)', op: 'lighter' },
  { id: 'overlay', label: 'Overlay', op: 'overlay' },
  { id: 'soft light', label: 'Soft Light', op: 'soft-light' },
  { id: 'hard light', label: 'Hard Light', op: 'hard-light' },
  { id: 'difference', label: 'Difference', op: 'difference' },
  { id: 'exclusion', label: 'Exclusion', op: 'exclusion' },
  { id: 'hue', label: 'Hue', op: 'hue' },
  { id: 'saturation', label: 'Saturation', op: 'saturation' },
  { id: 'color', label: 'Color', op: 'color' },
  { id: 'luminosity', label: 'Luminosity', op: 'luminosity' },
];
export const blendOp = (id: string): GlobalCompositeOperation =>
  BLEND_MODES.find((b) => b.id === id)?.op ?? 'source-over';

/** Convert a grayscale mask (white = visible) into an alpha-only canvas usable with destination-in. */
export function grayToAlpha(src: HTMLCanvasElement, dst: HTMLCanvasElement): HTMLCanvasElement {
  const w = src.width, h = src.height;
  if (dst.width !== w || dst.height !== h) { dst.width = w; dst.height = h; }
  const img = ctxOf(src).getImageData(0, 0, w, h), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i + 3] = ((d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8) * d[i + 3] / 255;
    d[i] = d[i + 1] = d[i + 2] = 0;
  }
  ctxOf(dst).putImageData(img, 0, 0);
  return dst;
}

let nextId = 1;
export class Layer {
  id = nextId++;
  visible = true;
  opacity = 1;
  blend = 'normal';
  /** Grayscale, document-sized, opaque. White reveals, black hides (PSD-compatible). */
  mask: HTMLCanvasElement | null = null;
  maskEnabled = true;
  /** True while the mask (rather than the pixels) is the edit target. */
  editMask = false;
  /** Editable text; the pixels in `canvas` are a raster of this. */
  text: TextData | null = null;
  /** Set while the text editor overlay is open on this layer. */
  hiddenForEdit = false;
  private alphaCanvas: HTMLCanvasElement | null = null;
  private maskVer = 0;
  private alphaVer = -1;
  constructor(public name: string, public canvas: HTMLCanvasElement) {}
  get ctx() { return ctxOf(this.canvas); }
  get maskMode() { return !!this.mask && this.editMask; }
  /** The canvas that editing tools should draw on. */
  get target() { return this.maskMode ? this.mask! : this.canvas; }
  get tctx() { return ctxOf(this.target); }
  touchMask() { this.maskVer++; }
  maskAlpha(): HTMLCanvasElement {
    if (!this.alphaCanvas) this.alphaCanvas = makeCanvas(this.mask!.width, this.mask!.height);
    if (this.alphaVer !== this.maskVer || this.alphaCanvas.width !== this.mask!.width || this.alphaCanvas.height !== this.mask!.height) {
      grayToAlpha(this.mask!, this.alphaCanvas);
      this.alphaVer = this.maskVer;
    }
    return this.alphaCanvas;
  }
}

/** Layer pixels with the (enabled) mask applied. */
export function bakedCanvas(l: Layer): HTMLCanvasElement {
  const c = cloneCanvas(l.canvas);
  if (l.mask && l.maskEnabled) {
    const x = ctxOf(c);
    x.globalCompositeOperation = 'destination-in';
    x.drawImage(l.maskAlpha(), 0, 0);
    x.globalCompositeOperation = 'source-over';
  }
  return c;
}

/** An in-progress brush stroke, composited at render time so stroke opacity behaves like Photoshop. */
export interface Stroke { layer: Layer; canvas: HTMLCanvasElement; opacity: number; erase: boolean; onMask: boolean }

interface LayerState { canvas: HTMLCanvasElement; mask: HTMLCanvasElement | null; maskEnabled: boolean; editMask: boolean; text: TextData | null }
const captureLayer = (l: Layer): LayerState => ({
  canvas: cloneCanvas(l.canvas), mask: l.mask && cloneCanvas(l.mask), maskEnabled: l.maskEnabled, editMask: l.editMask, text: l.text && { ...l.text },
});
const restoreLayer = (l: Layer, s: LayerState) => {
  l.canvas = cloneCanvas(s.canvas); l.mask = s.mask && cloneCanvas(s.mask);
  l.maskEnabled = s.maskEnabled; l.editMask = s.editMask; l.text = s.text && { ...s.text }; l.touchMask();
};

interface Snapshot { w: number; h: number; items: { layer: Layer; state: LayerState }[] }

export class Doc {
  layers: Layer[] = [];
  active!: Layer;
  /** Bounding box of the selection. With `selMask` null the selection is exactly this rectangle. */
  selection: Rect | null = null;
  /** Alpha mask (document-sized) for non-rectangular selections. Treat as immutable once set. */
  selMask: HTMLCanvasElement | null = null;
  /** Temporary offset applied to the selection outline while the Move tool drags it. */
  selShift: { dx: number; dy: number } | null = null;
  stroke: Stroke | null = null;
  history = new History();
  view: { zoom: number; panX: number; panY: number } | null = null;
  path: string | null = null;
  private subs = new Set<(k: ChangeKind) => void>();

  constructor(public width: number, public height: number, public name = 'Untitled') {}

  static blank(w: number, h: number, name: string, bg: string | null): Doc {
    const d = new Doc(w, h, name);
    const base = new Layer('Background', makeCanvas(w, h));
    if (bg) { base.ctx.fillStyle = bg; base.ctx.fillRect(0, 0, w, h); }
    d.layers.push(base);
    d.active = base;
    d.history.dirty = false;
    return d;
  }

  on(fn: (k: ChangeKind) => void) { this.subs.add(fn); return () => this.subs.delete(fn); }
  emit(k: ChangeKind) { this.subs.forEach((f) => f(k)); }

  select(layer: Layer) { this.active = layer; this.emit('structure'); }
  /** Choose whether the pixels or the layer mask receive edits. */
  setEditMask(layer: Layer, on: boolean) {
    layer.editMask = on && !!layer.mask;
    if (layer.editMask) layer.maskEnabled = true;
    this.active = layer;
    this.emit('structure');
  }

  // ---- layer operations (all undoable) -------------------------------------
  addLayer(name?: string, canvas?: HTMLCanvasElement, at = this.layers.indexOf(this.active) + 1): Layer {
    const l = new Layer(name ?? `Layer ${this.layers.length + 1}`, canvas ?? makeCanvas(this.width, this.height));
    const prev = this.active;
    this.layers.splice(at, 0, l);
    this.active = l;
    this.history.push({
      label: 'New Layer',
      undo: () => { this.layers.splice(this.layers.indexOf(l), 1); this.active = prev; this.emit('structure'); },
      redo: () => { this.layers.splice(at, 0, l); this.active = l; this.emit('structure'); },
    });
    this.emit('structure');
    return l;
  }

  duplicateLayer(src = this.active) {
    const at = this.layers.indexOf(src) + 1;
    const l = this.addLayer(`${src.name} copy`, cloneCanvas(src.canvas), at);
    l.opacity = src.opacity; l.blend = src.blend; l.visible = src.visible;
    if (src.mask) { l.mask = cloneCanvas(src.mask); l.maskEnabled = src.maskEnabled; }
    if (src.text) l.text = { ...src.text };
    this.emit('structure');
    return l;
  }

  removeLayer(l = this.active) {
    if (this.layers.length <= 1) return;
    const at = this.layers.indexOf(l);
    const prev = this.active;
    this.layers.splice(at, 1);
    this.active = this.layers[Math.min(at, this.layers.length - 1)];
    const next = this.active;
    this.history.push({
      label: 'Delete Layer',
      undo: () => { this.layers.splice(at, 0, l); this.active = prev; this.emit('structure'); },
      redo: () => { this.layers.splice(this.layers.indexOf(l), 1); this.active = next; this.emit('structure'); },
    });
    this.emit('structure');
  }

  moveLayer(from: number, to: number) {
    if (from === to || to < 0 || to >= this.layers.length) return;
    const apply = (a: number, b: number) => { const [l] = this.layers.splice(a, 1); this.layers.splice(b, 0, l); this.emit('structure'); };
    apply(from, to);
    this.history.push({ label: 'Reorder Layer', undo: () => apply(to, from), redo: () => apply(from, to) });
  }

  /** Run `fn` on a layer and record before/after states for undo. */
  private layerEdit(l: Layer, label: string, fn: () => void) {
    const before = captureLayer(l), prevActive = this.active;
    fn();
    const after = captureLayer(l), nextActive = this.active;
    this.history.push({
      label,
      undo: () => { restoreLayer(l, before); this.active = prevActive; this.emit('structure'); },
      redo: () => { restoreLayer(l, after); this.active = nextActive; this.emit('structure'); },
    });
    this.emit('structure');
  }

  mergeDown(l = this.active) {
    const i = this.layers.indexOf(l);
    if (i <= 0) return;
    const below = this.layers[i - 1];
    const belowBefore = captureLayer(below);
    const prevActive = this.active;
    const merged = bakedCanvas(below);           // bake the lower layer's mask first
    below.canvas = merged; below.mask = null; below.editMask = false; below.text = null;
    const bctx = below.ctx;
    bctx.save();
    bctx.globalAlpha = l.visible ? l.opacity : 0;
    bctx.globalCompositeOperation = blendOp(l.blend);
    bctx.drawImage(bakedCanvas(l), 0, 0);
    bctx.restore();
    const belowAfter = captureLayer(below);
    this.layers.splice(i, 1);
    this.active = below;
    this.history.push({
      label: 'Merge Layers',
      undo: () => { restoreLayer(below, belowBefore); this.layers.splice(i, 0, l); this.active = prevActive; this.emit('structure'); },
      redo: () => { restoreLayer(below, belowAfter); this.layers.splice(this.layers.indexOf(l), 1); this.active = below; this.emit('structure'); },
    });
    this.emit('structure');
  }

  flatten() {
    while (this.layers.length > 1) this.mergeDown(this.layers[this.layers.length - 1]);
  }

  // ---- layer masks -----------------------------------------------------------
  addMask(kind: 'reveal' | 'hide' | 'selection', l = this.active) {
    if (l.mask) return;
    this.layerEdit(l, 'Add Layer Mask', () => {
      const m = makeCanvas(this.width, this.height), x = ctxOf(m);
      x.fillStyle = kind === 'reveal' ? '#fff' : '#000';
      x.fillRect(0, 0, m.width, m.height);
      if (kind === 'selection' && this.selection) {
        const white = makeCanvas(m.width, m.height), wx = ctxOf(white);
        wx.fillStyle = '#fff'; wx.fillRect(0, 0, m.width, m.height);
        if (this.selMask) { wx.globalCompositeOperation = 'destination-in'; wx.drawImage(this.selMask, 0, 0); }
        else { wx.globalCompositeOperation = 'destination-in'; wx.fillRect(this.selection.x, this.selection.y, this.selection.w, this.selection.h); }
        x.drawImage(white, 0, 0);
      }
      l.mask = m; l.maskEnabled = true; l.editMask = true; l.touchMask(); this.active = l;
    });
  }
  deleteMask(l = this.active) {
    if (!l.mask) return;
    this.layerEdit(l, 'Delete Layer Mask', () => { l.mask = null; l.editMask = false; l.touchMask(); });
  }
  /** Bake the mask into the layer's pixels and remove it. */
  applyMask(l = this.active) {
    if (!l.mask) return;
    this.layerEdit(l, 'Apply Layer Mask', () => { l.canvas = bakedCanvas(l); l.text = null; l.mask = null; l.editMask = false; l.touchMask(); });
  }
  toggleMask(l = this.active) {
    if (!l.mask) return;
    const on = !l.maskEnabled;
    this.layerEdit(l, on ? 'Enable Layer Mask' : 'Disable Layer Mask', () => { l.maskEnabled = on; if (!on) l.editMask = false; l.touchMask(); });
  }

  // ---- text layers -----------------------------------------------------------
  createTextLayer(t: TextData) {
    const l = this.addLayer(textLabel(t));
    l.text = { ...t };
    renderText(l.canvas, l.text);
    this.emit('structure');
    return l;
  }
  setText(l: Layer, next: TextData) {
    const autoName = l.text && l.name === textLabel(l.text);
    this.layerEdit(l, 'Edit Text', () => {
      l.text = { ...next };
      renderText(l.canvas, l.text);
      if (autoName) l.name = textLabel(next);
      l.editMask = false;
    });
  }

  setProp<K extends 'name' | 'visible' | 'opacity' | 'blend'>(l: Layer, key: K, value: Layer[K], oldValue: Layer[K] = l[key]) {
    l[key] = value;
    if (oldValue !== value) {
      this.history.push({
        label: 'Layer Property',
        undo: () => { l[key] = oldValue; this.emit('structure'); },
        redo: () => { l[key] = value; this.emit('structure'); },
      });
    }
    this.emit('structure');
  }

  setSelection(sel: Rect | null, mask: HTMLCanvasElement | null = null) {
    const before = this.selection, beforeMask = this.selMask;
    this.selection = sel; this.selMask = sel ? mask : null;
    const afterMask = this.selMask;
    this.history.push({
      label: 'Selection',
      undo: () => { this.selection = before; this.selMask = beforeMask; this.emit('selection'); },
      redo: () => { this.selection = sel; this.selMask = afterMask; this.emit('selection'); },
    });
    this.emit('selection');
  }

  // ---- whole-document transforms -------------------------------------------
  private capture(): Snapshot {
    return { w: this.width, h: this.height, items: this.layers.map((layer) => ({ layer, state: captureLayer(layer) })) };
  }
  private restore(s: Snapshot) {
    this.width = s.w; this.height = s.h;
    for (const it of s.items) restoreLayer(it.layer, it.state);
    this.selection = null; this.selMask = null;
    this.emit('structure');
  }
  /** Rebuild every layer canvas (and mask) at a new size using `draw`. Text layers are rasterized. */
  transformAll(label: string, nw: number, nh: number, draw: (ctx: CanvasRenderingContext2D, src: HTMLCanvasElement) => void) {
    const before = this.capture();
    for (const l of this.layers) {
      const c = makeCanvas(nw, nh);
      draw(ctxOf(c), l.canvas);
      l.canvas = c;
      if (l.mask) { const m = makeCanvas(nw, nh); draw(ctxOf(m), l.mask); l.mask = m; l.touchMask(); }
      l.text = null;
    }
    this.width = Math.round(nw); this.height = Math.round(nh);
    this.selection = null; this.selMask = null;
    const after = this.capture();
    this.history.push({ label, undo: () => this.restore(before), redo: () => this.restore(after) });
    this.emit('structure');
  }
  flip(horizontal: boolean) {
    const { width: w, height: h } = this;
    this.transformAll(horizontal ? 'Flip Horizontal' : 'Flip Vertical', w, h, (ctx, src) => {
      if (horizontal) { ctx.translate(w, 0); ctx.scale(-1, 1); } else { ctx.translate(0, h); ctx.scale(1, -1); }
      ctx.drawImage(src, 0, 0);
    });
  }
  rotate90(clockwise: boolean) {
    const { width: w, height: h } = this;
    this.transformAll('Rotate 90°', h, w, (ctx, src) => {
      ctx.translate(clockwise ? h : 0, clockwise ? 0 : w);
      ctx.rotate((clockwise ? 1 : -1) * Math.PI / 2);
      ctx.drawImage(src, 0, 0);
    });
  }
  resizeImage(nw: number, nh: number) {
    this.transformAll('Image Size', nw, nh, (ctx, src) => {
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(src, 0, 0, nw, nh);
    });
  }
  resizeCanvas(nw: number, nh: number) {
    const ox = Math.round((nw - this.width) / 2), oy = Math.round((nh - this.height) / 2);
    this.transformAll('Canvas Size', nw, nh, (ctx, src) => ctx.drawImage(src, ox, oy));
  }
}

export const clampRect = (r: Rect, w: number, h: number): Rect | null => {
  const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(w, Math.ceil(r.x + r.w)), y1 = Math.min(h, Math.ceil(r.y + r.h));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
};

/**
 * Record a pixel edit of `rect` on the layer's current edit target (pixels or mask).
 * `before` is a copy of that target taken before the edit. Editing a text layer's pixels rasterizes it.
 */
export function pushPixelEdit(doc: Doc, layer: Layer, before: HTMLCanvasElement, rect: Rect | null, label: string) {
  const isMask = layer.maskMode;
  const get = () => (isMask ? layer.mask! : layer.canvas);
  const r = rect && clampRect(rect, get().width, get().height);
  if (!r) return;
  const b = ctxOf(before).getImageData(r.x, r.y, r.w, r.h);
  const a = ctxOf(get()).getImageData(r.x, r.y, r.w, r.h);
  const rasterized = !isMask ? layer.text : null;
  if (rasterized) layer.text = null;
  layer.touchMask();
  doc.history.push({
    label,
    undo: () => { ctxOf(get()).putImageData(b, r.x, r.y); if (rasterized) layer.text = rasterized; layer.touchMask(); doc.emit('structure'); },
    redo: () => { ctxOf(get()).putImageData(a, r.x, r.y); if (rasterized) layer.text = null; layer.touchMask(); doc.emit('structure'); },
  });
  doc.emit('structure');
}
