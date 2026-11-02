import { app } from './state';
import { clampRect, cloneCanvas, ctxOf, makeCanvas, pushPixelEdit, type Layer, type Rect, type Doc } from './doc';
import { clipToSelection } from './selection';
import { composite } from './render';
import * as A from './adjust';

let busy = false;
/** True while an adjustment dialog is open (global shortcuts are suspended). */
export const isAdjusting = () => busy;

/** What a dialog builds: UI element plus how to read its current settings. */
interface UI { el: HTMLElement; luts: () => A.RGBLUTs; state: () => A.AdjustmentData | null; reset: () => void }

/** Where an adjustment dialog's result goes: straight into pixels, or into an adjustment layer's parameters. */
interface Sess {
  hist(ch: A.Channel): Uint32Array;
  render(ui: UI): void;
  restore(): void;
  ok(ui: UI, label: string): void;
  cancelled(): void;
}

/** Destructive mode: holds the original pixels of the edit target and renders tone adjustments onto it. */
class PixelSession implements Sess {
  doc: Doc = app.doc;
  layer: Layer = app.doc.active;
  orig = cloneCanvas(this.layer.target);
  r: Rect;
  src: ImageData;
  private dst: ImageData;
  private hists = new Map<A.Channel, Uint32Array>();
  constructor() {
    const { width: w, height: h } = this.orig;
    this.r = (this.doc.selection && clampRect(this.doc.selection, w, h)) || { x: 0, y: 0, w, h };
    this.src = ctxOf(this.orig).getImageData(this.r.x, this.r.y, this.r.w, this.r.h);
    this.dst = new ImageData(this.r.w, this.r.h);
  }
  hist(ch: A.Channel) {
    let h = this.hists.get(ch);
    if (!h) this.hists.set(ch, (h = A.histogramOf(this.src.data, ch)));
    return h;
  }
  render(ui: UI) {
    const l = ui.luts();
    A.applyLUTs(this.src.data, this.dst.data, l);
    const ctx = this.layer.tctx, { doc, r } = this;
    if (!doc.selMask) ctx.putImageData(this.dst, r.x, r.y);
    else {
      const tmp = makeCanvas(this.orig.width, this.orig.height);
      ctxOf(tmp).putImageData(this.dst, r.x, r.y);
      const keep = cloneCanvas(this.orig), kx = ctxOf(keep);
      kx.globalCompositeOperation = 'destination-out'; kx.drawImage(doc.selMask, 0, 0);
      ctx.clearRect(0, 0, tmp.width, tmp.height);
      ctx.drawImage(keep, 0, 0);
      ctx.drawImage(clipToSelection(doc, tmp), 0, 0);
    }
    this.layer.touchMask();
    doc.emit('pixels');
  }
  restore() {
    const ctx = this.layer.tctx;
    ctx.clearRect(0, 0, this.orig.width, this.orig.height);
    ctx.drawImage(this.orig, 0, 0);
    this.layer.touchMask();
    this.doc.emit('pixels');
  }
  ok(ui: UI, label: string) {
    if (isIdentity(ui.luts())) return this.restore();
    this.render(ui);
    pushPixelEdit(this.doc, this.layer, this.orig, this.r, label);
  }
  cancelled() {}
}

/** Non-destructive mode: edits the parameters of an adjustment layer; the compositor does the rest. */
class LayerSession implements Sess {
  doc: Doc = app.doc;
  before: A.AdjustmentData;
  private src: ImageData | null = null;
  private hists = new Map<A.Channel, Uint32Array>();
  constructor(public layer: Layer, private fresh: boolean) { this.before = A.cloneAdjustment(layer.adjustment!); }
  /** Histograms describe what the adjustment *receives*: the composite of the layers beneath it. */
  hist(ch: A.Channel) {
    if (!this.src) {
      const below = { width: this.doc.width, height: this.doc.height, layers: this.doc.layers.slice(0, this.doc.layers.indexOf(this.layer)), stroke: null, selMask: null } as unknown as Doc;
      const c = makeCanvas(this.doc.width, this.doc.height);
      composite(below, ctxOf(c));
      this.src = ctxOf(c).getImageData(0, 0, c.width, c.height);
    }
    let h = this.hists.get(ch);
    if (!h) this.hists.set(ch, (h = A.histogramOf(this.src.data, ch)));
    return h;
  }
  render(ui: UI) { this.layer.adjustment = ui.state(); this.doc.emit('pixels'); }
  restore() { this.layer.adjustment = A.cloneAdjustment(this.before); this.doc.emit('pixels'); }
  ok(ui: UI) {
    const next = ui.state()!;
    this.layer.adjustment = A.cloneAdjustment(this.before);
    if (!A.sameAdjustment(next, this.before)) this.doc.setAdjustment(this.layer, next, this.before);
    else this.doc.emit('structure');
  }
  cancelled() {
    // a layer that was just created and then cancelled is removed again
    if (this.fresh && this.doc.history.undoLabel === 'New Adjustment Layer') this.doc.history.undo();
  }
}

const isIdentity = (l: A.RGBLUTs) => [l.r, l.g, l.b].every((t) => t.every((v, i) => v === i));

// ---------------------------------------------------------------- tiny DOM helper
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...kids: (Node | string)[]) {
  const e = document.createElement(tag);
  const { class: cls, ...rest } = props as any;
  if (cls) e.className = cls;
  Object.assign(e, rest);
  e.append(...kids);
  return e;
}
const CHANNELS: [A.Channel, string][] = [['rgb', 'RGB'], ['r', 'Red'], ['g', 'Green'], ['b', 'Blue']];
const channelSelect = (onchange: (c: A.Channel) => void) => {
  const s = el('select');
  for (const [v, l] of CHANNELS) s.append(el('option', { value: v, textContent: l }));
  s.onchange = () => onchange(s.value as A.Channel);
  return s;
};
const numField = (min: number, max: number, step: number, oninput: (v: number) => void) => {
  const i = el('input', { type: 'number', min: String(min), max: String(max), step: String(step) });
  i.style.width = '64px';
  i.oninput = () => { const v = Number(i.value); if (Number.isFinite(v)) oninput(Math.min(max, Math.max(min, v))); };
  return i;
};

/** Shared floating dialog: live preview checkbox, Reset / Cancel / OK, drag by title, Esc / Enter. */
function openAdjust(title: string, label: string, sess: Sess, build: (preview: () => void) => UI) {
  if (busy) return;
  busy = true;
  const back = el('div', { class: 'adjust-back' });
  const panel = el('div', { class: 'adjust-panel', tabIndex: -1 });
  const head = el('h2', { textContent: title });
  const previewBox = el('input', { type: 'checkbox', checked: true });
  let raf = 0;
  const preview = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; previewBox.checked ? sess.render(ui) : sess.restore(); });
  };
  const ui = build(preview);
  const close = () => { cancelAnimationFrame(raf); back.remove(); busy = false; };
  const cancel = el('button', { textContent: 'Cancel', type: 'button' });
  const ok = el('button', { textContent: 'OK', type: 'button', className: 'primary' });
  const reset = el('button', { textContent: 'Reset', type: 'button' });
  cancel.onclick = () => { sess.restore(); close(); sess.cancelled(); };
  ok.onclick = () => { sess.ok(ui, label); close(); };
  reset.onclick = () => { ui.reset(); preview(); };
  previewBox.onchange = preview;
  panel.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') cancel.click();
    else if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'BUTTON') ok.click();
  };
  // drag the panel by its title
  head.onpointerdown = (e) => {
    const r = panel.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    head.setPointerCapture(e.pointerId);
    head.onpointermove = (m) => { panel.style.left = `${m.clientX - dx}px`; panel.style.top = `${m.clientY - dy}px`; panel.style.right = 'auto'; };
    head.onpointerup = () => { head.onpointermove = null; head.onpointerup = null; };
  };
  panel.append(head, ui.el, el('div', { class: 'adjust-foot' }, el('label', {}, previewBox, ' Preview'), reset, el('span', { class: 'grow' }), cancel, ok));
  back.append(panel);
  document.body.append(back);
  panel.focus();
  preview();
}

// ---------------------------------------------------------------- Levels
export const openLevels = () => { if (app.doc.requirePaintable()) levelsDialog(new PixelSession(), null); };
function levelsDialog(s: Sess, init: A.AdjustmentData | null) {
  openAdjust('Levels', 'Levels', s, (preview) => {
    const P: Record<A.Channel, A.LevelsParams> = init?.type === 'levels' ? (A.cloneAdjustment(init) as typeof init).P : { rgb: A.identityLevels(), r: A.identityLevels(), g: A.identityLevels(), b: A.identityLevels() };
    let ch: A.Channel = 'rgb';
    const W = 256, PAD = 8;
    const hist = el('canvas', { width: W + PAD * 2, height: 100 });
    const hand = el('canvas', { width: W + PAD * 2, height: 20 });
    const ib = numField(0, 253, 1, (v) => { P[ch].ib = Math.min(v, P[ch].iw - 2); refresh(); });
    const gm = numField(0.1, 9.99, 0.01, (v) => { P[ch].gamma = v; refresh(false); });
    const iw = numField(2, 255, 1, (v) => { P[ch].iw = Math.max(v, P[ch].ib + 2); refresh(); });
    const ob = numField(0, 255, 1, (v) => { P[ch].ob = v; refresh(false); });
    const ow = numField(0, 255, 1, (v) => { P[ch].ow = v; refresh(false); });
    const sel = channelSelect((c) => { ch = c; refresh(); drawAll(); });
    const auto = el('button', { textContent: 'Auto', type: 'button' });
    auto.onclick = () => {
      for (const c of ch === 'rgb' ? (['r', 'g', 'b'] as A.Channel[]) : [ch]) {
        const { ib: b, iw: w } = A.autoPoints(s.hist(c));
        P[c].ib = b; P[c].iw = w; P[c].gamma = 1;
      }
      refresh(); drawAll();
    };

    function drawAll() {
      const hx = hist.getContext('2d')!, h = s.hist(ch);
      hx.fillStyle = '#111'; hx.fillRect(0, 0, hist.width, hist.height);
      let max = 1; for (let i = 1; i < 255; i++) max = Math.max(max, h[i]);
      hx.fillStyle = ch === 'r' ? '#e66' : ch === 'g' ? '#6c6' : ch === 'b' ? '#69f' : '#bbb';
      for (let i = 0; i < 256; i++) { const bh = Math.min(1, Math.sqrt(h[i] / max)) * (hist.height - 2); hx.fillRect(PAD + i, hist.height - bh, 1, bh); }
      drawHandles();
    }
    function drawHandles() {
      const x = hand.getContext('2d')!, p = P[ch];
      x.clearRect(0, 0, hand.width, hand.height);
      const g = x.createLinearGradient(PAD, 0, PAD + W, 0); g.addColorStop(0, '#000'); g.addColorStop(1, '#fff');
      x.fillStyle = g; x.fillRect(PAD, 0, W, 6);
      const tri = (v: number, fill: string) => {
        x.beginPath(); x.moveTo(PAD + v, 7); x.lineTo(PAD + v - 6, 19); x.lineTo(PAD + v + 6, 19); x.closePath();
        x.fillStyle = fill; x.fill(); x.strokeStyle = '#888'; x.stroke();
      };
      tri(p.ib, '#000'); tri(A.gammaHandleX(p), '#808080'); tri(p.iw, '#fff');
    }
    function refresh(fields = true) {
      if (fields) {
        const p = P[ch];
        ib.value = String(p.ib); iw.value = String(p.iw); gm.value = p.gamma.toFixed(2); ob.value = String(p.ob); ow.value = String(p.ow);
      }
      drawHandles(); preview();
    }
    let drag: 'b' | 'g' | 'w' | null = null;
    hand.onpointerdown = (e) => {
      const p = P[ch], x = e.offsetX - PAD;
      const hs = { b: p.ib, g: A.gammaHandleX(p), w: p.iw };
      drag = (Object.keys(hs) as ('b' | 'g' | 'w')[]).reduce((a, k) => (Math.abs(hs[k] - x) < Math.abs(hs[a] - x) ? k : a), 'b' as 'b' | 'g' | 'w');
      hand.setPointerCapture(e.pointerId); hand.onpointermove!(e);
    };
    hand.onpointermove = (e) => {
      if (!drag) return;
      const p = P[ch], v = Math.min(255, Math.max(0, Math.round(e.offsetX - PAD)));
      if (drag === 'b') p.ib = Math.min(v, p.iw - 2);
      else if (drag === 'w') p.iw = Math.max(v, p.ib + 2);
      else p.gamma = A.gammaFromHandle(p.ib, p.iw, v);
      refresh();
    };
    hand.onpointerup = () => (drag = null);

    const body = el('div', { class: 'adjust-body' },
      el('div', { class: 'row' }, 'Channel ', sel, el('span', { class: 'grow' }), auto),
      hist, hand,
      el('div', { class: 'row' }, 'Input Levels', el('span', { class: 'grow' }), ib, gm, iw),
      el('div', { class: 'row' }, 'Output Levels', el('span', { class: 'grow' }), ob, ow));
    const luts = () => A.combineLUTs(A.levelsLUT(P.rgb), A.levelsLUT(P.r), A.levelsLUT(P.g), A.levelsLUT(P.b));
    const reset = () => { for (const c of Object.keys(P) as A.Channel[]) P[c] = A.identityLevels(); refresh(); drawAll(); };
    refresh(); drawAll();
    // test/automation hook
    (body as any).__levels = { P, set: (c: A.Channel, p: Partial<A.LevelsParams>) => { Object.assign(P[c], p); refresh(); } };
    const state = (): A.AdjustmentData => ({ type: 'levels', P: JSON.parse(JSON.stringify(P)) });
    return { el: body, luts, state, reset };
  });
}

// ---------------------------------------------------------------- Curves
const PRESETS: [string, A.CurvePoint[]][] = [
  ['Linear (default)', A.identityCurve()],
  ['Lighter', [{ x: 0, y: 0 }, { x: 128, y: 168 }, { x: 255, y: 255 }]],
  ['Darker', [{ x: 0, y: 0 }, { x: 128, y: 92 }, { x: 255, y: 255 }]],
  ['Increase Contrast', [{ x: 0, y: 0 }, { x: 64, y: 44 }, { x: 192, y: 212 }, { x: 255, y: 255 }]],
  ['Decrease Contrast', [{ x: 0, y: 24 }, { x: 255, y: 231 }]],
  ['Invert', [{ x: 0, y: 255 }, { x: 255, y: 0 }]],
];

export const openCurves = () => { if (app.doc.requirePaintable()) curvesDialog(new PixelSession(), null); };
function curvesDialog(s: Sess, init: A.AdjustmentData | null) {
  openAdjust('Curves', 'Curves', s, (preview) => {
    const P: Record<A.Channel, A.CurvePoint[]> = init?.type === 'curves' ? (A.cloneAdjustment(init) as typeof init).P : { rgb: A.identityCurve(), r: A.identityCurve(), g: A.identityCurve(), b: A.identityCurve() };
    let ch: A.Channel = 'rgb';
    const PAD = 4, N = 256;
    const cv = el('canvas', { width: N + PAD * 2, height: N + PAD * 2, class: 'curvecanvas' });
    const readout = el('div', { class: 'readout', textContent: ' ' });
    const sel = channelSelect((c) => { ch = c; draw(); });
    const presets = el('select');
    presets.append(el('option', { value: '', textContent: 'Preset…' }));
    PRESETS.forEach(([n], i) => presets.append(el('option', { value: String(i), textContent: n })));
    presets.onchange = () => { if (presets.value) P[ch] = PRESETS[Number(presets.value)][1].map((p) => ({ ...p })); presets.value = ''; draw(); preview(); };
    const px = (v: number) => PAD + v, py = (v: number) => PAD + N - 1 - v;

    function draw() {
      const x = cv.getContext('2d')!, pts = P[ch];
      x.fillStyle = '#111'; x.fillRect(0, 0, cv.width, cv.height);
      const h = s.hist(ch); let max = 1; for (let i = 1; i < 255; i++) max = Math.max(max, h[i]);
      x.fillStyle = 'rgba(190,190,190,.28)';
      for (let i = 0; i < 256; i++) { const bh = Math.min(1, Math.sqrt(h[i] / max)) * (N - 2); x.fillRect(px(i), PAD + N - bh, 1, bh); }
      x.strokeStyle = '#333'; x.lineWidth = 1; x.beginPath();
      for (let g = 0; g <= 4; g++) { const v = Math.min(255, g * 64); x.moveTo(px(v) + .5, PAD); x.lineTo(px(v) + .5, PAD + N); x.moveTo(PAD, py(v) + .5); x.lineTo(PAD + N, py(v) + .5); }
      x.stroke();
      x.setLineDash([3, 3]); x.strokeStyle = '#555'; x.beginPath(); x.moveTo(px(0), py(0)); x.lineTo(px(255), py(255)); x.stroke(); x.setLineDash([]);
      const lut = A.curveLUT(pts);
      x.strokeStyle = ch === 'r' ? '#f66' : ch === 'g' ? '#6d6' : ch === 'b' ? '#6af' : '#fff'; x.lineWidth = 2; x.beginPath();
      for (let v = 0; v < 256; v++) (v ? x.lineTo(px(v), py(lut[v])) : x.moveTo(px(v), py(lut[v])));
      x.stroke();
      x.fillStyle = '#fff'; x.strokeStyle = '#000'; x.lineWidth = 1;
      for (const p of pts) { x.fillRect(px(p.x) - 3, py(p.y) - 3, 7, 7); x.strokeRect(px(p.x) - 3.5, py(p.y) - 3.5, 7, 7); }
    }
    const toVal = (e: PointerEvent) => ({ x: Math.min(255, Math.max(0, Math.round(e.offsetX - PAD))), y: Math.min(255, Math.max(0, Math.round(N - 1 - (e.offsetY - PAD)))) });
    let dragIdx = -1;
    const hit = (v: { x: number; y: number }) => P[ch].findIndex((p) => Math.hypot(p.x - v.x, p.y - v.y) <= 8);
    cv.onpointerdown = (e) => {
      if (e.button === 2) return;
      const v = toVal(e), pts = P[ch];
      let i = hit(v);
      if (i < 0) {
        if (pts.length >= 16 || pts.some((p) => p.x === v.x)) return;
        pts.push(v); pts.sort((a, b) => a.x - b.x); i = pts.indexOf(v);
      }
      dragIdx = i; cv.setPointerCapture(e.pointerId); cv.onpointermove!(e);
    };
    cv.onpointermove = (e) => {
      const v = toVal(e), pts = P[ch];
      if (dragIdx < 0) { readout.textContent = `Input: ${v.x}   Output: ${A.curveLUT(pts)[v.x]}`; return; }
      const p = pts[dragIdx], last = dragIdx === pts.length - 1;
      p.y = v.y;
      if (dragIdx > 0 && !last) p.x = Math.min(pts[dragIdx + 1].x - 1, Math.max(pts[dragIdx - 1].x + 1, v.x));
      readout.textContent = `Input: ${p.x}   Output: ${p.y}`;
      draw(); preview();
    };
    cv.onpointerup = () => (dragIdx = -1);
    const removeAt = (e: MouseEvent) => {
      e.preventDefault();
      const v = toVal(e as PointerEvent), i = hit(v), pts = P[ch];
      if (i > 0 && i < pts.length - 1) { pts.splice(i, 1); draw(); preview(); }
    };
    cv.oncontextmenu = removeAt; cv.ondblclick = removeAt;

    const body = el('div', { class: 'adjust-body' },
      el('div', { class: 'row' }, 'Channel ', sel, el('span', { class: 'grow' }), presets),
      cv, readout,
      el('div', { class: 'hint', textContent: 'Click the curve to add a point · drag to adjust · double-click or right-click a point to remove it' }));
    const luts = () => A.combineLUTs(A.curveLUT(P.rgb), A.curveLUT(P.r), A.curveLUT(P.g), A.curveLUT(P.b));
    const reset = () => { for (const c of Object.keys(P) as A.Channel[]) P[c] = A.identityCurve(); draw(); };
    draw();
    (body as any).__curves = { P, set: (c: A.Channel, pts: A.CurvePoint[]) => { P[c] = pts; draw(); preview(); } };
    const state = (): A.AdjustmentData => ({ type: 'curves', P: JSON.parse(JSON.stringify(P)) });
    return { el: body, luts, state, reset };
  });
}

// ---------------------------------------------------------------- Auto Levels (no dialog)
export function autoLevels() {
  if (busy || !app.doc.requirePaintable()) return;
  const s = new PixelSession();
  const t = (['r', 'g', 'b'] as A.Channel[]).map((c) => {
    const { ib, iw } = A.autoPoints(s.hist(c));
    return A.levelsLUT({ ib, gamma: 1, iw, ob: 0, ow: 255 });
  });
  const id = A.levelsLUT(A.identityLevels());
  const luts = A.combineLUTs(id, t[0], t[1], t[2]);
  if (isIdentity(luts)) return app.toast('Auto Levels: nothing to adjust');
  s.render({ luts: () => luts } as UI);
  pushPixelEdit(s.doc, s.layer, s.orig, s.r, 'Auto Levels');
}

// ---------------------------------------------------------------- slider-based adjustments (layer mode only)
function slidersDialog(title: string, sess: Sess, defs: { key: string; label: string; min: number; max: number }[], make: (v: Record<string, number>) => A.AdjustmentData, init: Record<string, number>) {
  openAdjust(title, title, sess, (preview) => {
    const v: Record<string, number> = { ...init };
    const outs: Record<string, HTMLInputElement> = {}, ranges: Record<string, HTMLInputElement> = {};
    const rows = defs.map((d) => {
      const r = el('input', { type: 'range', min: String(d.min), max: String(d.max), value: String(v[d.key]) });
      const n = numField(d.min, d.max, 1, (x) => { v[d.key] = x; r.value = String(x); preview(); });
      n.value = String(v[d.key]);
      r.oninput = () => { v[d.key] = Number(r.value); n.value = r.value; preview(); };
      ranges[d.key] = r; outs[d.key] = n;
      return el('div', { class: 'row' }, el('span', { textContent: d.label, style: 'width:80px' } as any), r, n);
    });
    const body = el('div', { class: 'adjust-body' }, ...rows);
    const identity = A.defaultAdjustment(make(init).type);
    const reset = () => { for (const d of defs) { v[d.key] = 0; ranges[d.key].value = '0'; outs[d.key].value = '0'; } };
    (body as any).__sliders = { v, set: (k: string, x: number) => { v[k] = x; ranges[k].value = String(x); outs[k].value = String(x); preview(); } };
    return { el: body, luts: () => A.lutsFor(identity) ?? { r: new Uint8ClampedArray(256).map((_, i) => i), g: new Uint8ClampedArray(256).map((_, i) => i), b: new Uint8ClampedArray(256).map((_, i) => i) }, state: () => make(v), reset };
  });
}

// ---------------------------------------------------------------- parameter dialogs (layer mode only)
type Path = (string | number)[];
type Field =
  | { kind: 'range'; label: string; path: Path; min: number; max: number; step?: number }
  | { kind: 'check'; label: string; path: Path }
  | { kind: 'color'; label: string; path: Path }
  | { kind: 'optcolor'; label: string; path: Path; def: A.RGB }     // nullable colour with an enable checkbox
  | { kind: 'stops' };
const FIELDS = (a: A.AdjustmentData): Field[] => {
  const r = (label: string, path: Path, min: number, max: number, step = 1): Field => ({ kind: 'range', label, path, min, max, step });
  switch (a.type) {
    case 'posterize': return [r('Levels', ['levels'], 2, 255)];
    case 'threshold': return [r('Threshold', ['level'], 1, 255)];
    case 'exposure': return [r('Exposure', ['exposure'], -20, 20, 0.05), r('Offset', ['offset'], -0.5, 0.5, 0.0005), r('Gamma', ['gamma'], 0.1, 9.99, 0.01)];
    case 'vibrance': return [r('Vibrance', ['vibrance'], -100, 100), r('Saturation', ['saturation'], -100, 100)];
    case 'bw': return [r('Reds', ['w', 0], -200, 300), r('Yellows', ['w', 1], -200, 300), r('Greens', ['w', 2], -200, 300), r('Cyans', ['w', 3], -200, 300), r('Blues', ['w', 4], -200, 300), r('Magentas', ['w', 5], -200, 300), { kind: 'optcolor', label: 'Tint', path: ['tint'], def: [225, 211, 179] }];
    case 'photo': return [{ kind: 'color', label: 'Color', path: ['color'] }, r('Density %', ['density'], 1, 100), { kind: 'check', label: 'Preserve Luminosity', path: ['lum'] }];
    case 'balance': return [
      ...(['shadows', 'mids', 'highs'] as const).flatMap((k) => [
        r(`${k === 'mids' ? 'Midtones' : k[0].toUpperCase() + k.slice(1)}: Cyan–Red`, [k, 0], -100, 100), r('Magenta–Green', [k, 1], -100, 100), r('Yellow–Blue', [k, 2], -100, 100)]),
      { kind: 'check', label: 'Preserve Luminosity', path: ['lum'] }];
    case 'mixer': return [
      { kind: 'check', label: 'Monochrome', path: ['mono'] },
      ...(a.mono ? [['Gray', 0]] : [['Red', 0], ['Green', 1], ['Blue', 2]]).flatMap(([n, i]) => [
        r(`${n} ← Red`, ['rows', i as number, 0], -200, 200), r(`${n} ← Green`, ['rows', i as number, 1], -200, 200), r(`${n} ← Blue`, ['rows', i as number, 2], -200, 200), r(`${n} const`, ['rows', i as number, 3], -100, 100)])];
    case 'gradmap': return [{ kind: 'check', label: 'Reverse', path: ['reverse'] }, { kind: 'stops' }];
    default: return [];
  }
};
const getAt = (o: any, p: Path) => p.reduce((x, k) => x[k], o);
const setAt = (o: any, p: Path, v: any) => { getAt(o, p.slice(0, -1))[p[p.length - 1]] = v; };
const hex = (c: A.RGB) => '#' + c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');
const unhex = (h: string): A.RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as A.RGB;

function paramsDialog(title: string, sess: Sess, init: A.AdjustmentData) {
  openAdjust(title, title, sess, (preview) => {
    let cur = A.cloneAdjustment(init);
    const host = el('div', { class: 'adjust-body' });
    const ctl: Record<string, (v: any) => void> = {};
    const build = () => {
      host.replaceChildren();
      for (const f of FIELDS(cur)) {
        if (f.kind === 'range') {
          const key = f.path.join('.'), v0 = getAt(cur, f.path) as number;
          const rg = el('input', { type: 'range', min: String(f.min), max: String(f.max), step: String(f.step ?? 1), value: String(v0) });
          const n = numField(f.min, f.max, f.step ?? 1, (x) => { setAt(cur, f.path, x); rg.value = String(x); preview(); });
          n.value = String(v0); n.style.width = '72px';
          rg.oninput = () => { setAt(cur, f.path, Number(rg.value)); n.value = rg.value; preview(); };
          ctl[key] = (x) => { setAt(cur, f.path, x); rg.value = n.value = String(x); preview(); };
          host.append(el('div', { class: 'row' }, el('span', { textContent: f.label, style: 'width:130px' } as any), rg, n));
        } else if (f.kind === 'check') {
          const c = el('input', { type: 'checkbox', checked: !!getAt(cur, f.path) });
          c.onchange = () => { setAt(cur, f.path, c.checked); if (f.path[0] === 'mono') build(); preview(); };
          ctl[f.path.join('.')] = (x) => { setAt(cur, f.path, !!x); c.checked = !!x; if (f.path[0] === 'mono') build(); preview(); };
          host.append(el('label', { class: 'row' }, c, ' ' + f.label));
        } else if (f.kind === 'color' || f.kind === 'optcolor') {
          const v = getAt(cur, f.path) as A.RGB | null, c = el('input', { type: 'color', value: hex(v ?? (f as any).def ?? [0, 0, 0]) });
          const on = f.kind === 'optcolor' ? el('input', { type: 'checkbox', checked: !!v }) : null;
          const upd = () => { setAt(cur, f.path, on && !on.checked ? null : unhex(c.value)); preview(); };
          c.oninput = upd; if (on) on.onchange = upd;
          ctl[f.path.join('.')] = (x) => { setAt(cur, f.path, x); c.value = hex(x ?? (f as any).def); if (on) on.checked = !!x; preview(); };
          host.append(el('div', { class: 'row' }, ...(on ? [on] : []), ' ' + f.label + ' ', c));
        } else if (cur.type === 'gradmap') stopsEditor();
      }
    };
    const stopsEditor = () => {
      const g = cur as Extract<A.AdjustmentData, { type: 'gradmap' }>, box = el('div', { class: 'stops' });
      const bar = el('div', { class: 'gradbar', style: 'height:16px;border:1px solid #555;margin:4px 0' } as any);
      const paint = () => {
        const st = [...g.stops].sort((a, b) => a.x - b.x);
        bar.style.background = `linear-gradient(${g.reverse ? 270 : 90}deg, ${st.map((s) => `rgba(${s.c.map(Math.round).join(',')},${s.a}) ${Math.round(s.x * 100)}%`).join(',')})`;
      };
      const rows = () => {
        box.replaceChildren();
        g.stops.forEach((s, i) => {
          const c = el('input', { type: 'color', value: hex(s.c) }), pos = numField(0, 100, 1, (x) => { s.x = x / 100; paint(); preview(); }), op = numField(0, 100, 1, (x) => { s.a = x / 100; paint(); preview(); });
          pos.value = String(Math.round(s.x * 100)); op.value = String(Math.round(s.a * 100));
          c.oninput = () => { s.c = unhex(c.value); paint(); preview(); };
          const del = el('button', { type: 'button', textContent: '✕', disabled: g.stops.length <= 2 });
          del.onclick = () => { g.stops.splice(i, 1); rows(); paint(); preview(); };
          box.append(el('div', { class: 'row' }, c, ' at ', pos, '% opacity ', op, '% ', del));
        });
        const add = el('button', { type: 'button', textContent: 'Add stop' });
        add.onclick = () => { g.stops.push({ x: 0.5, c: [128, 128, 128], a: 1 }); rows(); paint(); preview(); };
        box.append(add);
      };
      rows(); paint(); host.append(bar, box);
      ctl.stops = () => { rows(); paint(); preview(); };
    };
    build();
    (host as any).__params = { get: () => cur, set: (k: string, v: any) => ctl[k]?.(v) };
    const reset = () => { cur = A.defaultAdjustment(init.type); build(); };
    const flat = { r: new Uint8ClampedArray(256), g: new Uint8ClampedArray(256), b: new Uint8ClampedArray(256) };
    return { el: host, luts: () => flat, state: () => A.cloneAdjustment(cur), reset };
  });
}

// ---------------------------------------------------------------- adjustment layers
/** Create a new adjustment layer above the active layer and open its settings (Invert has none). */
export function newAdjustmentLayer(type: A.AdjustmentType) {
  if (busy) return;
  const doc = app.doc;
  const layer = doc.addAdjustmentLayer(A.defaultAdjustment(type), A.ADJUSTMENT_LABELS[type]);
  if (type !== 'invert') openFor(layer, true);
}
/** Re-open the settings of an existing adjustment layer. */
export function editAdjustment(layer: Layer) {
  if (busy || !layer.adjustment || layer.adjustment.type === 'invert') return;
  app.doc.select(layer);
  openFor(layer, false);
}
function openFor(layer: Layer, fresh: boolean) {
  const a = layer.adjustment!, s = new LayerSession(layer, fresh);
  switch (a.type) {
    case 'levels': return levelsDialog(s, a);
    case 'curves': return curvesDialog(s, a);
    case 'brightness':
      return slidersDialog('Brightness/Contrast', s, [{ key: 'b', label: 'Brightness', min: -100, max: 100 }, { key: 'c', label: 'Contrast', min: -100, max: 100 }], (v) => ({ type: 'brightness', b: v.b, c: v.c }), { b: a.b, c: a.c });
    case 'hue':
      return slidersDialog('Hue/Saturation', s, [{ key: 'h', label: 'Hue', min: -180, max: 180 }, { key: 's', label: 'Saturation', min: -100, max: 100 }], (v) => ({ type: 'hue', h: v.h, s: v.s }), { h: a.h, s: a.s });
    default: return paramsDialog(A.ADJUSTMENT_LABELS[a.type], s, a);
  }
}
