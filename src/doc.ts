import { History } from './history';
import { renderText, textLabel, type TextData } from './text';
import { cloneAdjustment, type AdjustmentData } from './adjust';
import { applyAdjustmentOnto, composite, renderedCanvas } from './render';
import { cloneFx, type LayerEffects } from './fx';

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
/** Groups can additionally be Pass Through (the default: their contents composite as if ungrouped). */
export const GROUP_BLEND_MODES = [{ id: 'pass through', label: 'Pass Through', op: 'source-over' as GlobalCompositeOperation }, ...BLEND_MODES];
export const blendOp = (id: string): GlobalCompositeOperation =>
  BLEND_MODES.find((b) => b.id === id)?.op ?? 'source-over';

/** Convert a grayscale mask (white = visible) into an alpha-only canvas usable with destination-in. */
export function grayToAlpha(src: HTMLCanvasElement, dst: HTMLCanvasElement, stats?: { full: boolean }): HTMLCanvasElement {
  const w = src.width, h = src.height;
  if (dst.width !== w || dst.height !== h) { dst.width = w; dst.height = h; }
  const img = ctxOf(src).getImageData(0, 0, w, h), d = img.data;
  let min = 255;
  for (let i = 0; i < d.length; i += 4) {
    const a = ((d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8) * d[i + 3] / 255;
    d[i + 3] = a; if (a < min) min = a;
    d[i] = d[i + 1] = d[i + 2] = 0;
  }
  if (stats) stats.full = min >= 254.5;
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
  /** Non-destructive adjustment applied to everything below this layer (through its mask and opacity). */
  adjustment: AdjustmentData | null = null;
  /** Layer styles (drop shadow, stroke, ...). Rendered from the layer's shape at composite time. */
  effects: LayerEffects | null = null;
  /** Fill opacity: scales the layer's own pixels but not its effects (Opacity scales both). */
  fillOpacity = 1;
  /** Bumped whenever the layer's pixels / mask may have changed; keys the styled-render cache. */
  rev = 0;
  styled: { key: string; canvas: HTMLCanvasElement } | null = null;
  /** Set while the text editor overlay is open on this layer. */
  hiddenForEdit = false;
  /** 'group' layers have no pixels of their own: they hold other layers (those whose `parent` is this group). */
  kind: 'layer' | 'group' = 'layer';
  /** The group this layer belongs to (null = top level). */
  parent: Layer | null = null;
  /** Panel state: children hidden in the Layers panel. */
  collapsed = false;
  /** Clipped to the nearest unclipped layer below it (same group): only shows where that layer has pixels. */
  clipped = false;
  private alphaCanvas: HTMLCanvasElement | null = null;
  private maskVer = 0;
  private alphaVer = -1;
  private alphaFull = false;
  constructor(public name: string, public canvas: HTMLCanvasElement) {}
  get ctx() { return ctxOf(this.canvas); }
  get isGroup() { return this.kind === 'group'; }
  /** Pixels can be painted on this layer (a group only exposes its mask). */
  get paintable() { return !this.isGroup || this.maskMode; }
  /** A group layer. Groups default to Pass Through, so they only affect compositing when opacity/mask/blend ask them to. */
  static group(name: string) {
    const g = new Layer(name, makeCanvas(1, 1));
    g.kind = 'group'; g.blend = 'pass through';
    return g;
  }
  get maskMode() { return !!this.mask && (this.editMask || !!this.adjustment); }
  /** The canvas that editing tools should draw on. */
  get target() { return this.maskMode ? this.mask! : this.canvas; }
  get tctx() { return ctxOf(this.target); }
  touchMask() { this.maskVer++; this.rev++; }
  maskAlpha(): HTMLCanvasElement {
    if (!this.alphaCanvas) this.alphaCanvas = makeCanvas(this.mask!.width, this.mask!.height);
    if (this.alphaVer !== this.maskVer || this.alphaCanvas.width !== this.mask!.width || this.alphaCanvas.height !== this.mask!.height) {
      const stats = { full: false };
      grayToAlpha(this.mask!, this.alphaCanvas, stats);
      this.alphaFull = stats.full;
      this.alphaVer = this.maskVer;
    }
    return this.alphaCanvas;
  }
  /** True when the (enabled) mask reveals everything, so it can be ignored when compositing. */
  maskIsFull(): boolean { this.maskAlpha(); return this.alphaFull; }
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

/** The layer stack as a tree (children bottom→top). Layers whose parent isn't in `layers` become roots. */
export interface LayerNode { layer: Layer; children: LayerNode[] }
export function buildTree(layers: Layer[]): LayerNode[] {
  const nodes = new Map<Layer, LayerNode>(), roots: LayerNode[] = [];
  for (const l of layers) nodes.set(l, { layer: l, children: [] });
  for (const l of layers) { const n = nodes.get(l)!, p = l.parent && nodes.get(l.parent); (p ? p.children : roots).push(n); }
  return roots;
}

/** An in-progress brush stroke, composited at render time so stroke opacity behaves like Photoshop. */
export interface Stroke { layer: Layer; canvas: HTMLCanvasElement; opacity: number; erase: boolean; onMask: boolean }

interface LayerState { canvas: HTMLCanvasElement; mask: HTMLCanvasElement | null; maskEnabled: boolean; editMask: boolean; text: TextData | null; adjustment: AdjustmentData | null; effects: LayerEffects | null; fillOpacity: number }
const captureLayer = (l: Layer): LayerState => ({
  canvas: cloneCanvas(l.canvas), mask: l.mask && cloneCanvas(l.mask), maskEnabled: l.maskEnabled, editMask: l.editMask, text: l.text && { ...l.text },
  adjustment: l.adjustment && cloneAdjustment(l.adjustment), effects: cloneFx(l.effects), fillOpacity: l.fillOpacity,
});
const restoreLayer = (l: Layer, s: LayerState) => {
  l.canvas = cloneCanvas(s.canvas); l.mask = s.mask && cloneCanvas(s.mask);
  l.maskEnabled = s.maskEnabled; l.editMask = s.editMask; l.text = s.text && { ...s.text }; l.adjustment = s.adjustment && cloneAdjustment(s.adjustment); l.effects = cloneFx(s.effects); l.fillOpacity = s.fillOpacity; l.touchMask();
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
  /** Extra layers selected in the panel (Ctrl/Shift+click) for grouping; the active layer is always included. */
  multi = new Set<Layer>();
  /** Shown to the user when an operation is refused (set by the app). */
  notice: (msg: string) => void = () => {};
  /** Messages produced while importing (e.g. unsupported PSD features). */
  notes: string[] = [];

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
  emit(k: ChangeKind) {
    // style caches are keyed by `rev`: structural changes may touch any layer, live pixel edits the active one
    if (k === 'structure') for (const l of this.layers) l.rev++; else if (k === 'pixels' && this.active) this.active.rev++;
    this.subs.forEach((f) => f(k));
  }

  select(layer: Layer) { this.active = layer; this.emit('structure'); }
  /** Choose whether the pixels or the layer mask receive edits. */
  setEditMask(layer: Layer, on: boolean) {
    layer.editMask = (on || !!layer.adjustment) && !!layer.mask;
    if (layer.editMask) layer.maskEnabled = true;
    this.active = layer;
    this.emit('structure');
  }

  // ---- layer operations (all undoable) -------------------------------------
  addLayer(name?: string, canvas?: HTMLCanvasElement, at = this.layers.indexOf(this.active) + 1): Layer {
    const l = new Layer(name ?? `Layer ${this.layers.filter((x) => !x.isGroup).length + 1}`, canvas ?? makeCanvas(this.width, this.height));
    l.parent = this.active?.parent ?? null;
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
    if (src.isGroup) return this.duplicateGroup(src);
    const at = this.layers.indexOf(src) + 1;
    const l = this.addLayer(`${src.name} copy`, cloneCanvas(src.canvas), at);
    l.parent = src.parent; l.clipped = src.clipped; l.effects = cloneFx(src.effects); l.fillOpacity = src.fillOpacity;
    l.opacity = src.opacity; l.blend = src.blend; l.visible = src.visible;
    if (src.mask) { l.mask = cloneCanvas(src.mask); l.maskEnabled = src.maskEnabled; }
    if (src.text) l.text = { ...src.text };
    if (src.adjustment) l.adjustment = cloneAdjustment(src.adjustment);
    this.emit('structure');
    return l;
  }

  // ---- groups ----------------------------------------------------------------
  // Layout invariant: `layers` is bottom→top and a group sits directly AFTER all of its descendants, which
  // form one contiguous block just before it. A layer's `parent` is the group it belongs to.
  isDescendant(l: Layer, ancestor: Layer) { for (let p = l.parent; p; p = p.parent) if (p === ancestor) return true; return false; }
  /** The layer plus (for a group) everything inside it, in stack order. */
  blockOf(l: Layer): Layer[] { return l.isGroup ? [...this.layers.filter((e) => this.isDescendant(e, l)), l] : [l]; }
  tree() { return buildTree(this.layers); }
  /** Visible itself and inside no hidden group. */
  isShown(l: Layer) { for (let p: Layer | null = l; p; p = p.parent) if (!p.visible) return false; return true; }
  get leafCount() { return this.layers.filter((l) => !l.isGroup).length; }
  /** Layers highlighted in the panel: the active layer plus any Ctrl/Shift-selected ones. */
  selectedLayers(): Layer[] { return this.multi.size ? [...new Set([...this.multi, this.active])] : [this.active]; }
  /** Notify and return false when the active item is a group without a mask (nothing to paint on). */
  requirePaintable(): boolean {
    if (this.active.paintable) return true;
    this.notice('This is a group — select a layer inside it to paint (or edit its mask)');
    return false;
  }

  private structSnap() { return { layers: this.layers.slice(), parents: this.layers.map((l) => l.parent), active: this.active }; }
  private structApply(s: ReturnType<Doc['structSnap']>) {
    this.layers = s.layers.slice();
    s.layers.forEach((l, i) => (l.parent = s.parents[i]));
    this.active = s.active; this.multi.clear();
    this.emit('structure');
  }
  /** Run a stack-structure change (order / parents / membership) and make it undoable. */
  private structEdit(label: string, fn: () => void) {
    const before = this.structSnap();
    fn();
    const after = this.structSnap();
    this.history.push({ label, undo: () => this.structApply(before), redo: () => this.structApply(after) });
    this.emit('structure');
  }

  /** Put the given layers (and everything inside any groups among them) into a new group. */
  groupLayers(sel: Layer[] = this.selectedLayers()): Layer | null {
    const picked = [...new Set(sel)];
    const nodes = picked.filter((l) => !picked.some((o) => o !== l && this.isDescendant(l, o)));
    if (!nodes.length) return null;
    const parent = nodes[0].parent;
    if (nodes.some((n) => n.parent !== parent)) { this.notice('Select layers that are in the same group'); return null; }
    nodes.sort((a, b) => this.layers.indexOf(a) - this.layers.indexOf(b));
    const g = Layer.group(`Group ${this.layers.filter((l) => l.isGroup).length + 1}`);
    this.structEdit('Group Layers', () => {
      const moved = nodes.flatMap((n) => this.blockOf(n)), set = new Set(moved), last = moved[moved.length - 1];
      const out: Layer[] = [];
      for (const e of this.layers) { if (set.has(e)) { if (e === last) out.push(...moved, g); } else out.push(e); }
      for (const n of nodes) n.parent = g;
      g.parent = parent;
      this.layers = out; this.active = g; this.multi.clear();
    });
    return g;
  }

  /** An empty group just above the active layer. */
  newGroup(): Layer {
    const g = Layer.group(`Group ${this.layers.filter((l) => l.isGroup).length + 1}`);
    this.structEdit('New Group', () => {
      g.parent = this.active.parent;
      this.layers.splice(this.layers.indexOf(this.active) + 1, 0, g);
      this.active = g; this.multi.clear();
    });
    return g;
  }

  /** Dissolve a group: its contents move up one level, in place. (Group opacity/mask/blend are discarded.) */
  ungroup(g = this.active) {
    if (!g.isGroup) return;
    this.structEdit('Ungroup Layers', () => {
      const kids = this.layers.filter((e) => e.parent === g);
      for (const k of kids) k.parent = g.parent;
      this.layers = this.layers.filter((e) => e !== g);
      this.active = kids.length ? kids[kids.length - 1] : (this.layers.filter((e) => !e.isGroup).pop() ?? this.layers[0]);
      this.multi.clear();
    });
  }

  /** Re-parent / re-order `n` (with its contents) relative to `target`. 'above'/'below' are in panel terms. */
  moveNode(n: Layer, target: Layer, pos: 'above' | 'below' | 'inside'): boolean {
    if (n === target || this.isDescendant(target, n) || (pos === 'inside' && !target.isGroup)) return false;
    this.structEdit('Move Layer', () => {
      const block = this.blockOf(n), set = new Set(block);
      const rest = this.layers.filter((e) => !set.has(e));
      let idx: number, parent: Layer | null;
      if (pos === 'inside') { idx = rest.indexOf(target); parent = target; }               // top child: just before the group entry
      else if (pos === 'above') { idx = rest.indexOf(target) + 1; parent = target.parent; } // a group's entry ends its block
      else {
        idx = rest.indexOf(target);
        if (target.isGroup) while (idx > 0 && this.isDescendant(rest[idx - 1], target)) idx--;
        parent = target.parent;
      }
      rest.splice(idx, 0, ...block);
      n.parent = parent;
      this.layers = rest;
    });
    return true;
  }
  /** Raise (+1) or lower (−1) among siblings; at the edge of a group it hops out of it. */
  nudgeNode(n: Layer, dir: 1 | -1) {
    const sibs = this.layers.filter((e) => e.parent === n.parent), i = sibs.indexOf(n);
    const other = sibs[i + dir];
    if (other) this.moveNode(n, other, dir === 1 ? 'above' : 'below');
    else if (n.parent) this.moveNode(n, n.parent, dir === 1 ? 'above' : 'below');
  }

  duplicateGroup(g: Layer): Layer {
    const block = this.blockOf(g), map = new Map<Layer, Layer>();
    for (const e of block) {
      const c = e.isGroup ? Layer.group(e.name) : new Layer(e.name, cloneCanvas(e.canvas));
      c.opacity = e.opacity; c.blend = e.blend; c.visible = e.visible; c.collapsed = e.collapsed; c.clipped = e.clipped; c.effects = cloneFx(e.effects); c.fillOpacity = e.fillOpacity;
      if (e.mask) { c.mask = cloneCanvas(e.mask); c.maskEnabled = e.maskEnabled; }
      if (e.text) c.text = { ...e.text };
      if (e.adjustment) c.adjustment = cloneAdjustment(e.adjustment);
      map.set(e, c);
    }
    for (const e of block) map.get(e)!.parent = e === g ? g.parent : map.get(e.parent!) ?? g.parent;
    const copy = map.get(g)!;
    copy.name = `${g.name} copy`;
    this.structEdit('Duplicate Group', () => {
      this.layers.splice(this.layers.indexOf(g) + 1, 0, ...block.map((e) => map.get(e)!));
      this.active = copy; this.multi.clear();
    });
    return copy;
  }

  /** Flatten a group into a single pixel layer (hidden layers inside are discarded). */
  mergeGroup(g = this.active) {
    if (!g.isGroup) return;
    const inside = this.layers.filter((e) => this.isDescendant(e, g));
    this.structEdit('Merge Group', () => {
      const c = makeCanvas(this.width, this.height);
      composite({ width: this.width, height: this.height, layers: inside, stroke: null, selMask: null } as unknown as Doc, ctxOf(c));
      if (g.mask && g.maskEnabled) { const x = ctxOf(c); x.globalCompositeOperation = 'destination-in'; x.drawImage(g.maskAlpha(), 0, 0); x.globalCompositeOperation = 'source-over'; }
      const m = new Layer(g.name, c);
      m.opacity = g.opacity; m.visible = g.visible; m.blend = g.blend === 'pass through' ? 'normal' : g.blend; m.parent = g.parent; m.clipped = g.clipped;
      const drop = new Set(inside);
      this.layers = this.layers.filter((e) => !drop.has(e)).map((e) => (e === g ? m : e));
      this.active = m; this.multi.clear();
    });
  }

  // ---- clipping masks ----------------------------------------------------------
  /** The layer `l` is clipped to: the nearest unclipped sibling below it (adjustment layers can't be bases). */
  clipBase(l: Layer): Layer | null {
    if (!l.clipped) return null;
    const sibs = this.layers.filter((e) => e.parent === l.parent);
    for (let i = sibs.indexOf(l) - 1; i >= 0; i--) if (!sibs[i].clipped) return sibs[i].adjustment ? null : sibs[i];
    return null;
  }
  /** Layers clipped to `base`, bottom to top. */
  clipStackOf(base: Layer): Layer[] { return this.layers.filter((e) => e.clipped && this.clipBase(e) === base); }
  setClipped(list: Layer[], on: boolean) {
    const changed = list.filter((l) => l.clipped !== on);
    if (!changed.length) return;
    changed.forEach((l) => (l.clipped = on));
    this.history.push({
      label: on ? 'Create Clipping Mask' : 'Release Clipping Mask',
      undo: () => { changed.forEach((l) => (l.clipped = !on)); this.emit('structure'); },
      redo: () => { changed.forEach((l) => (l.clipped = on)); this.emit('structure'); },
    });
    this.emit('structure');
  }
  /** Create (or, if already clipped, release) a clipping mask for the selected layers. */
  toggleClip() {
    const sel = this.selectedLayers();
    if (sel.every((l) => l.clipped)) return this.setClipped(sel, false);
    const ok = sel.filter((l) => !l.clipped && this.layers.some((e) => e.parent === l.parent && this.layers.indexOf(e) < this.layers.indexOf(l)));
    if (!ok.length) { this.notice('There is no layer below to clip to'); return; }
    this.setClipped(ok, true);
  }
  /** Flatten a base layer and the layers clipped to it into one layer. */
  mergeClipStack(base = this.active) {
    const stack = this.clipStackOf(base);
    if (!stack.length) { this.notice('No layers are clipped to this layer'); return; }
    const parts = [...this.blockOf(base), ...stack.flatMap((s) => this.blockOf(s))], drop = new Set(parts);
    this.structEdit('Merge Clipping Mask', () => {
      const keep = { o: base.opacity, b: base.blend, v: base.visible };
      base.opacity = 1; base.visible = true; base.blend = base.isGroup ? 'pass through' : 'normal';
      const c = makeCanvas(this.width, this.height);
      composite({ width: this.width, height: this.height, layers: this.layers.filter((e) => drop.has(e)), stroke: null, selMask: null } as unknown as Doc, ctxOf(c));
      base.opacity = keep.o; base.blend = keep.b; base.visible = keep.v;
      const m = new Layer(base.name, c);
      m.opacity = keep.o; m.blend = keep.b === 'pass through' ? 'normal' : keep.b; m.visible = keep.v; m.parent = base.parent;
      this.layers = this.layers.flatMap((e) => (e === base ? [m] : drop.has(e) ? [] : [e]));
      this.active = m; this.multi.clear();
    });
  }

  removeLayer(l = this.active) {
    const block = this.blockOf(l), set = new Set(block);
    if (!this.layers.some((e) => !e.isGroup && !set.has(e))) return;      // always keep at least one real layer
    this.structEdit(l.isGroup ? 'Delete Group' : 'Delete Layer', () => {
      const at = this.layers.indexOf(block[0]);
      this.layers = this.layers.filter((e) => !set.has(e));
      this.active = this.layers[Math.min(at, this.layers.length - 1)];
      this.multi.clear();
    });
  }

  /** Structural self-check used by tests: returns a list of problems (empty = healthy). */
  validate(): string[] {
    const bad: string[] = [], at = new Map(this.layers.map((l, i) => [l, i] as const));
    if (!this.layers.some((l) => !l.isGroup)) bad.push('no real layers');
    if (!at.has(this.active)) bad.push('active layer is not in the stack');
    for (const l of this.layers) {
      if (l.parent && (!at.has(l.parent) || !l.parent.isGroup)) bad.push(`${l.name}: parent missing or not a group`);
      for (let p = l.parent, n = 0; p; p = p.parent) if (p === l || ++n > 99) { bad.push(`${l.name}: parent cycle`); break; }
    }
    for (const g of this.layers.filter((l) => l.isGroup)) {
      const idx = at.get(g)!, inside = this.layers.filter((e) => this.isDescendant(e, g)).map((e) => at.get(e)!).sort((a, b) => a - b);
      if (inside.some((i) => i > idx)) bad.push(`${g.name}: has contents above its own entry`);
      if (inside.length && inside[inside.length - 1] - inside[0] !== inside.length - 1) bad.push(`${g.name}: contents not contiguous`);
      if (inside.length && inside[inside.length - 1] !== idx - 1) bad.push(`${g.name}: contents don't end right below the group`);
    }
    return bad;
  }
  /** Compact structural fingerprint ("[A B [C D]g1]") for comparing stack shapes in tests. */
  signature(): string {
    const f = (ns: LayerNode[]): string => ns.map((n) => (n.layer.isGroup ? `[${n.layer.name}${n.layer.clipped ? '^' : ''}:${f(n.children)}]` : n.layer.name + (n.layer.clipped ? '^' : ''))).join(',');
    return f(this.tree());
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

  addAdjustmentLayer(data: AdjustmentData, name: string): Layer {
    const l = new Layer(name, makeCanvas(this.width, this.height));
    l.adjustment = cloneAdjustment(data);
    const m = makeCanvas(this.width, this.height), x = ctxOf(m);
    x.fillStyle = '#fff'; x.fillRect(0, 0, m.width, m.height);
    l.mask = m; l.editMask = true;
    l.parent = this.active.parent;
    const at = this.layers.indexOf(this.active) + 1, prev = this.active;
    this.layers.splice(at, 0, l);
    this.active = l;
    this.history.push({
      label: 'New Adjustment Layer',
      undo: () => { this.layers.splice(this.layers.indexOf(l), 1); this.active = prev; this.emit('structure'); },
      redo: () => { this.layers.splice(at, 0, l); this.active = l; this.emit('structure'); },
    });
    this.emit('structure');
    return l;
  }
  /** Replace a layer's styles (null = none) as one undoable step. */
  setEffects(l: Layer, next: LayerEffects | null, before: LayerEffects | null = l.effects) {
    const a = cloneFx(next), b = cloneFx(before);
    l.effects = a;
    this.history.push({
      label: 'Layer Style',
      undo: () => { l.effects = cloneFx(b); this.emit('structure'); },
      redo: () => { l.effects = cloneFx(a); this.emit('structure'); },
    });
    this.emit('structure');
  }
  setAdjustment(l: Layer, next: AdjustmentData, before: AdjustmentData | null = l.adjustment) {
    const a = cloneAdjustment(next), b = before && cloneAdjustment(before);
    l.adjustment = a;
    this.history.push({
      label: 'Edit Adjustment',
      undo: () => { l.adjustment = b && cloneAdjustment(b); this.emit('structure'); },
      redo: () => { l.adjustment = cloneAdjustment(a); this.emit('structure'); },
    });
    this.emit('structure');
  }

  mergeDown(l = this.active) {
    if (l.isGroup) return this.mergeGroup(l);
    const i = this.layers.indexOf(l);
    if (i <= 0) return;
    const below = this.layers[i - 1];
    if (below.parent !== l.parent) { this.notice('Nothing below this layer in its group to merge into'); return; }
    if (below.isGroup) { this.notice('Cannot merge into a group — use Merge Group'); return; }
    if (below.adjustment) { this.notice('Cannot merge into an adjustment layer'); return; }
    if (below.clipped && !l.clipped) { this.notice('Release the clipping mask first (or use Merge Clipping Mask)'); return; }
    const belowBefore = captureLayer(below);
    const prevActive = this.active;
    const merged = renderedCanvas(below);        // bake the lower layer's mask and styles first
    below.canvas = merged; below.mask = null; below.editMask = false; below.text = null; below.effects = null; below.fillOpacity = 1;
    const bctx = below.ctx;
    if (l.adjustment) {
      // an adjustment merged down is applied to the layer below only
      if (l.visible) applyAdjustmentOnto(bctx, this.width, this.height, l, l.mask && l.maskEnabled && !l.maskIsFull() ? l.maskAlpha() : null);
    } else {
      const content = renderedCanvas(l);
      const base = l.clipped ? this.clipBase(l) : null;
      if (base) {                                   // a clipped layer only contributes where its base has pixels
        const cx = ctxOf(content);
        cx.globalCompositeOperation = 'destination-in';
        cx.drawImage(base === below ? merged : bakedCanvas(base), 0, 0);
        cx.globalCompositeOperation = 'source-over';
      }
      bctx.save();
      bctx.globalAlpha = l.visible ? l.opacity : 0;
      bctx.globalCompositeOperation = blendOp(l.blend);
      bctx.drawImage(content, 0, 0);
      bctx.restore();
    }
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

  /** Replace all layers with a single layer containing the visible composite (adjustments included). */
  flatten() {
    if (this.layers.length <= 1 && !this.layers[0]?.adjustment) return;
    const before = this.layers.slice(), prevActive = this.active;
    const c = makeCanvas(this.width, this.height);
    composite(this, ctxOf(c));
    const flat = new Layer('Background', c);
    this.layers = [flat]; this.active = flat;
    this.history.push({
      label: 'Flatten Image',
      undo: () => { this.layers = before.slice(); this.active = prevActive; this.emit('structure'); },
      redo: () => { this.layers = [flat]; this.active = flat; this.emit('structure'); },
    });
    this.emit('structure');
  }

  // ---- layer masks -----------------------------------------------------------
  addMask(kind: 'reveal' | 'hide' | 'selection', l = this.active) {
    if (l.mask || l.adjustment) return;
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
    if (!l.mask || l.adjustment) return;
    this.layerEdit(l, 'Delete Layer Mask', () => { l.mask = null; l.editMask = false; l.touchMask(); });
  }
  /** Bake the mask into the layer's pixels and remove it. */
  applyMask(l = this.active) {
    if (!l.mask || l.adjustment) return;
    this.layerEdit(l, 'Apply Layer Mask', () => { l.canvas = bakedCanvas(l); l.text = null; l.mask = null; l.editMask = false; l.touchMask(); });
  }
  toggleMask(l = this.active) {
    if (!l.mask) return;
    const on = !l.maskEnabled;
    this.layerEdit(l, on ? 'Enable Layer Mask' : 'Disable Layer Mask', () => { l.maskEnabled = on; if (!on && !l.adjustment) l.editMask = false; l.touchMask(); });
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

  setProp<K extends 'name' | 'visible' | 'opacity' | 'blend' | 'fillOpacity'>(l: Layer, key: K, value: Layer[K], oldValue: Layer[K] = l[key]) {
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
      if (!l.isGroup) { const c = makeCanvas(nw, nh); draw(ctxOf(c), l.canvas); l.canvas = c; }
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
