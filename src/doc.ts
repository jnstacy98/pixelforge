import { History } from './history';

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

let nextId = 1;
export class Layer {
  id = nextId++;
  visible = true;
  opacity = 1;
  blend = 'normal';
  constructor(public name: string, public canvas: HTMLCanvasElement) {}
  get ctx() { return ctxOf(this.canvas); }
}

/** An in-progress brush stroke, composited at render time so stroke opacity behaves like Photoshop. */
export interface Stroke { layer: Layer; canvas: HTMLCanvasElement; opacity: number; erase: boolean }

interface Snapshot { w: number; h: number; items: { layer: Layer; canvas: HTMLCanvasElement }[] }

export class Doc {
  layers: Layer[] = [];
  active!: Layer;
  selection: Rect | null = null;
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

  mergeDown(l = this.active) {
    const i = this.layers.indexOf(l);
    if (i <= 0) return;
    const below = this.layers[i - 1];
    const belowBefore = cloneCanvas(below.canvas);
    const prevActive = this.active;
    const bctx = below.ctx;
    bctx.save();
    bctx.globalAlpha = l.visible ? l.opacity : 0;
    bctx.globalCompositeOperation = blendOp(l.blend);
    bctx.drawImage(l.canvas, 0, 0);
    bctx.restore();
    const belowAfter = cloneCanvas(below.canvas);
    this.layers.splice(i, 1);
    this.active = below;
    this.history.push({
      label: 'Merge Layers',
      undo: () => { below.canvas = cloneCanvas(belowBefore); this.layers.splice(i, 0, l); this.active = prevActive; this.emit('structure'); },
      redo: () => { below.canvas = cloneCanvas(belowAfter); this.layers.splice(this.layers.indexOf(l), 1); this.active = below; this.emit('structure'); },
    });
    this.emit('structure');
  }

  flatten() {
    while (this.layers.length > 1) this.mergeDown(this.layers[this.layers.length - 1]);
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

  setSelection(sel: Rect | null) {
    const before = this.selection;
    this.selection = sel;
    this.history.push({
      label: 'Selection',
      undo: () => { this.selection = before; this.emit('selection'); },
      redo: () => { this.selection = sel; this.emit('selection'); },
    });
    this.emit('selection');
  }

  // ---- whole-document transforms -------------------------------------------
  private capture(): Snapshot {
    return { w: this.width, h: this.height, items: this.layers.map((layer) => ({ layer, canvas: cloneCanvas(layer.canvas) })) };
  }
  private restore(s: Snapshot) {
    this.width = s.w; this.height = s.h;
    for (const it of s.items) it.layer.canvas = cloneCanvas(it.canvas);
    this.selection = null;
    this.emit('structure');
  }
  /** Rebuild every layer canvas at a new size using `draw`. */
  transformAll(label: string, nw: number, nh: number, draw: (ctx: CanvasRenderingContext2D, src: HTMLCanvasElement) => void) {
    const before = this.capture();
    for (const l of this.layers) {
      const c = makeCanvas(nw, nh);
      draw(ctxOf(c), l.canvas);
      l.canvas = c;
    }
    this.width = Math.round(nw); this.height = Math.round(nh);
    this.selection = null;
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

/** Record a pixel edit of `rect` on `layer`; `before` is a copy of the layer taken before the edit. */
export function pushPixelEdit(doc: Doc, layer: Layer, before: HTMLCanvasElement, rect: Rect | null, label: string) {
  const r = rect && clampRect(rect, layer.canvas.width, layer.canvas.height);
  if (!r) return;
  const b = ctxOf(before).getImageData(r.x, r.y, r.w, r.h);
  const a = layer.ctx.getImageData(r.x, r.y, r.w, r.h);
  doc.history.push({
    label,
    undo: () => { layer.ctx.putImageData(b, r.x, r.y); doc.emit('structure'); },
    redo: () => { layer.ctx.putImageData(a, r.x, r.y); doc.emit('structure'); },
  });
  doc.emit('structure');
}
