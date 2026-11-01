import { app } from './state';
import { clampRect, cloneCanvas, ctxOf, makeCanvas, pushPixelEdit, type Layer, type Rect, type Doc } from './doc';
import { clipToSelection } from './selection';
import * as A from './adjust';

let busy = false;
/** True while a Levels/Curves dialog is open (global shortcuts are suspended). */
export const isAdjusting = () => busy;

/** Holds the original pixels of the edit target and renders tone adjustments onto it (live preview + commit). */
class Session {
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
  render(l: A.RGBLUTs) {
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
  commit(label: string) { pushPixelEdit(this.doc, this.layer, this.orig, this.r, label); }
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
function openAdjust(title: string, label: string, build: (s: Session, preview: () => void) => { el: HTMLElement; luts: () => A.RGBLUTs; reset: () => void }) {
  if (busy) return;
  busy = true;
  const s = new Session();
  const back = el('div', { class: 'adjust-back' });
  const panel = el('div', { class: 'adjust-panel', tabIndex: -1 });
  const head = el('h2', { textContent: title });
  const previewBox = el('input', { type: 'checkbox', checked: true });
  let raf = 0;
  const preview = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; previewBox.checked ? s.render(ui.luts()) : s.restore(); });
  };
  const ui = build(s, preview);
  const close = () => { cancelAnimationFrame(raf); back.remove(); busy = false; };
  const cancel = el('button', { textContent: 'Cancel', type: 'button' });
  const ok = el('button', { textContent: 'OK', type: 'button', className: 'primary' });
  const reset = el('button', { textContent: 'Reset', type: 'button' });
  cancel.onclick = () => { s.restore(); close(); };
  ok.onclick = () => {
    const l = ui.luts();
    if (isIdentity(l)) s.restore(); else { s.render(l); s.commit(label); }
    close();
  };
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
export function openLevels() {
  openAdjust('Levels', 'Levels', (s, preview) => {
    const P: Record<A.Channel, A.LevelsParams> = { rgb: A.identityLevels(), r: A.identityLevels(), g: A.identityLevels(), b: A.identityLevels() };
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
    return { el: body, luts, reset };
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

export function openCurves() {
  openAdjust('Curves', 'Curves', (s, preview) => {
    const P: Record<A.Channel, A.CurvePoint[]> = { rgb: A.identityCurve(), r: A.identityCurve(), g: A.identityCurve(), b: A.identityCurve() };
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
    return { el: body, luts, reset };
  });
}

// ---------------------------------------------------------------- Auto Levels (no dialog)
export function autoLevels() {
  if (busy) return;
  const s = new Session();
  const t = (['r', 'g', 'b'] as A.Channel[]).map((c) => {
    const { ib, iw } = A.autoPoints(s.hist(c));
    return A.levelsLUT({ ib, gamma: 1, iw, ob: 0, ow: 255 });
  });
  const id = A.levelsLUT(A.identityLevels());
  const luts = A.combineLUTs(id, t[0], t[1], t[2]);
  if (isIdentity(luts)) return app.toast('Auto Levels: nothing to adjust');
  s.render(luts);
  s.commit('Auto Levels');
}
