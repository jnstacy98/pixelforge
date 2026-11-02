import { app, type ToolId } from './state';
import { BLEND_MODES, GROUP_BLEND_MODES, type Layer, type LayerNode } from './doc';
import { FONTS } from './text';
import { editAdjustment, newAdjustmentLayer } from './adjustdialog';
import { ROUND, allTips } from './brushtips';
import { openLayerStyle } from './stylesdialog';
import { freeTransform } from './freetransform';
import { editContents } from './smart';
import { openBlendIf } from './blendifdialog';
import { FX_LABELS, FX_ORDER, hasEffects } from './fx';
import { ADJUSTMENT_LABELS, type AdjustmentType } from './adjust';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const svg = (p: string) => `<svg viewBox="0 0 24 24">${p}</svg>`;

const TOOLS: { id: ToolId; key: string; label: string; icon: string }[] = [
  { id: 'move', key: 'V', label: 'Move', icon: svg('<path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20"/>') },
  { id: 'marquee', key: 'M', label: 'Rectangular Marquee', icon: svg('<rect x="4" y="4" width="16" height="16" stroke-dasharray="3 3"/>') },
  { id: 'lasso', key: 'L', label: 'Lasso', icon: svg('<path d="M7 22a5 5 0 01-2-4"/><path d="M3.3 14A6.8 6.8 0 012 10c0-4.4 4.5-8 10-8s10 3.6 10 8-4.5 8-10 8a12 12 0 01-5-1"/><circle cx="5" cy="19" r="2"/>') },
  { id: 'quick', key: 'Q', label: 'Quick Selection (paint over an object)', icon: svg('<path d="M3 21l6-6"/><circle cx="15" cy="9" r="6" stroke-dasharray="3 2.5"/><path d="M9 15l3-3"/>') },
  { id: 'wand', key: 'W', label: 'Magic Wand', icon: svg('<path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8L19 13M15 9h.01M17.8 6.2L19 5M3 21l9-9M12.2 6.2L11 5"/>') },
  { id: 'brush', key: 'B', label: 'Brush', icon: svg('<path d="M9.06 11.9l8.07-8.06a2.85 2.85 0 114.03 4.03l-8.06 8.08"/><path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 00-3-3.02z"/>') },
  { id: 'clone', key: 'S', label: 'Clone Stamp (Alt+click to set source)', icon: svg('<path d="M5 22h14"/><path d="M19.27 13.73A2.5 2.5 0 0017.5 13h-11A2.5 2.5 0 004 15.5V17a1 1 0 001 1h14a1 1 0 001-1v-1.5c0-.66-.26-1.3-.73-1.77z"/><path d="M14 13V8.5C14 7 15 7 15 5a3 3 0 00-3-3c-1.66 0-3 1-3 3s1 2 1 3.5V13"/>') },
  { id: 'heal', key: 'J', label: 'Healing Brush (Alt+click to set source)', icon: svg('<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M10 10.01h.01M10 14h.01M14 10.01h.01M14 14h.01M18 6v12M6 6v12"/>') },
  { id: 'spot', key: 'K', label: 'Spot Healing Brush', icon: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>') },
  { id: 'patch', key: 'P', label: 'Patch (draw a selection, then drag it)', icon: svg('<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M12 8v8M8 12h8"/>') },
  { id: 'cmove', key: 'O', label: 'Content-Aware Move (draw around an object, then drag it)', icon: svg('<path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3"/><rect x="8.5" y="8.5" width="7" height="7" rx="1.5"/>') },
  { id: 'eraser', key: 'E', label: 'Eraser', icon: svg('<path d="M20 20H8l-4.6-4.6a1.4 1.4 0 010-2L13 3.8a1.4 1.4 0 012 0l5.6 5.6a1.4 1.4 0 010 2L11 21"/><path d="M7 11l6 6"/>') },
  { id: 'bucket', key: 'G', label: 'Paint Bucket', icon: svg('<path d="M19 11l-8-8-8.6 8.6a2 2 0 000 2.8l5.2 5.2c.8.8 2 .8 2.8 0L19 11z"/><path d="M5 2l5 5M2 13h15"/><path d="M22 20a2 2 0 11-4 0c0-1.6 1.7-2.4 2-4 .3 1.6 2 2.4 2 4z"/>') },
  { id: 'gradient', key: 'D', label: 'Gradient', icon: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 17L17 7" stroke-dasharray="1 3"/>') },
  { id: 'text', key: 'T', label: 'Text', icon: svg('<path d="M4 7V4h16v3M9 20h6M12 4v16"/>') },
  { id: 'eyedropper', key: 'I', label: 'Eyedropper', icon: svg('<path d="M2 22l1-1h3l9-9M3 21v-3l9-9"/><path d="M15 6l3.4-3.4a2.1 2.1 0 013 3L18 9l.4.4a2.1 2.1 0 11-3 3l-3.8-3.8a2.1 2.1 0 113-3L15 6z"/>') },
  { id: 'hand', key: 'H', label: 'Hand (or hold Space)', icon: svg('<path d="M18 11V6a2 2 0 00-4 0M14 10V4a2 2 0 00-4 0v2M10 10.5V6a2 2 0 00-4 0v8"/><path d="M18 8a2 2 0 114 0v6a8 8 0 01-8 8h-2c-2.8 0-4.5-.9-5.9-2.4L3.4 16a2 2 0 013-2.8L8 15"/>') },
];
export const toolKeys: Record<string, ToolId> = Object.fromEntries(TOOLS.map((t) => [t.key.toLowerCase(), t.id]));

export function initToolbar() {
  const bar = $('toolbar');
  for (const t of TOOLS) {
    const el = document.createElement('div');
    el.className = 'tool'; el.dataset.tool = t.id; el.title = `${t.label} (${t.key})`; el.innerHTML = t.icon;
    el.onclick = () => app.setTool(t.id);
    bar.append(el);
  }
  const sw = document.createElement('div');
  sw.className = 'swatches';
  sw.innerHTML = `<input type="color" class="bg" id="bgc" title="Background color"><input type="color" class="fg" id="fgc" title="Foreground color"><span class="swap" title="Swap (X)">⇄</span>`;
  bar.append(sw);
  const fg = sw.querySelector('#fgc') as HTMLInputElement, bg = sw.querySelector('#bgc') as HTMLInputElement;
  fg.oninput = () => app.setFg(fg.value); bg.oninput = () => app.setBg(bg.value);
  (sw.querySelector('.swap') as HTMLElement).onclick = () => app.swapColors();
  const sync = () => { fg.value = app.fg; bg.value = app.bg; };
  app.on('color', sync); sync();
  const hl = () => bar.querySelectorAll('.tool').forEach((el) => el.classList.toggle('active', (el as HTMLElement).dataset.tool === app.toolId));
  app.on('tool', hl); hl();
}

// ---------------------------------------------------------------- options bar
function slider(label: string, get: () => number, set: (v: number) => void, min: number, max: number, step = 1, fmt = (v: number) => String(v)) {
  const wrap = document.createElement('label');
  const out = document.createElement('b'); out.textContent = fmt(get());
  const inp = document.createElement('input'); inp.type = 'range'; inp.min = String(min); inp.max = String(max); inp.step = String(step); inp.value = String(get());
  inp.oninput = () => { set(Number(inp.value)); out.textContent = fmt(Number(inp.value)); app.emit('options'); };
  wrap.append(label, inp, out);
  return wrap;
}
const hintEl = (text: string) => { const s = document.createElement('span'); s.style.color = 'var(--dim)'; s.textContent = text; return s; };
let xformSync: (() => void) | null = null;
app.on('xform', () => xformSync?.());
export function renderOptions() {
  const el = $('options'); el.innerHTML = '';
  const t = app.toolId, b = app.brush;
  const pct = (v: number) => Math.round(v * 100) + '%';
  if (t === 'brush' || t === 'eraser') {
    el.append(slider('Size', () => b.size, (v) => (b.size = v), 1, 500, 1, (v) => v + 'px'),
      slider('Hardness', () => b.hardness, (v) => (b.hardness = v), 0, 1, 0.01, pct),
      slider('Opacity', () => b.opacity, (v) => (b.opacity = v), 0.01, 1, 0.01, pct),
      slider('Flow', () => b.flow, (v) => (b.flow = v), 0.01, 1, 0.01, pct),
      slider('Spacing', () => b.spacing, (v) => (b.spacing = v), 0.02, 1, 0.01, pct));
    const tl = document.createElement('label'), ts = document.createElement('select');
    ts.className = 'tipsel';
    ts.innerHTML = `<option value="${ROUND}">Round (soft)</option>` + allTips().map((x) => `<option value="${x.id}">${x.name.replace(/[<&"]/g, '')}</option>`).join('');
    ts.value = allTips().some((x) => x.id === b.tip) ? b.tip : ROUND; ts.onchange = () => { b.tip = ts.value; renderOptions(); app.emit('options'); }; tl.append('Tip', ts);
    const pl = document.createElement('label'), pc = document.createElement('input'); pc.type = 'checkbox'; pc.checked = b.tilt; pc.onchange = () => (b.tilt = pc.checked); pl.append(pc, 'Pen tilt');
    el.append(tl, pl);
    if (b.tip !== ROUND) {
      const fl = document.createElement('label'), fc = document.createElement('input'); fc.type = 'checkbox'; fc.checked = b.follow; fc.onchange = () => (b.follow = fc.checked); fl.append(fc, 'Follow stroke');
      el.append(slider('Angle', () => b.angle, (v) => (b.angle = v), 0, 359, 1, (v) => v + '°'), fl,
        hintEl('Edit ▸ Define Brush Tip from Selection makes a tip from the selected pixels'));
    }
  } else if (t === 'spot') {
    el.append(slider('Size', () => b.size, (v) => (b.size = v), 1, 500, 1, (v) => v + 'px'),
      slider('Hardness', () => b.hardness, (v) => (b.hardness = v), 0, 1, 0.01, pct));
    const sl = document.createElement('label'); const ss = document.createElement('select');
    ss.innerHTML = '<option value="layer">Current layer</option><option value="below">Current &amp; below</option><option value="all">All layers</option>';
    ss.value = app.clone.sample; ss.onchange = () => (app.clone.sample = ss.value as typeof app.clone.sample); sl.append('Sample', ss);
    el.append(sl, hintEl('Paint over a blemish — it is healed from a matching nearby area when you release'));
  } else if (t === 'patch') {
    const ml = document.createElement('label'); const ms = document.createElement('select');
    ms.innerHTML = '<option value="source">Source</option><option value="dest">Destination</option><option value="content">Content-Aware</option>'; ms.value = app.patch.mode; ms.onchange = () => (app.patch.mode = ms.value as 'source' | 'dest' | 'content'); ml.append('Patch', ms);
    const bl = document.createElement('label'); const bc = document.createElement('input'); bc.type = 'checkbox'; bc.checked = app.patch.blend; bc.onchange = () => (app.patch.blend = bc.checked); bl.append(bc, 'Match tone & texture');
    const sl = document.createElement('label'); const ss = document.createElement('select');
    ss.innerHTML = '<option value="layer">Current layer</option><option value="below">Current &amp; below</option><option value="all">All layers</option>';
    ss.value = app.clone.sample; ss.onchange = () => (app.clone.sample = ss.value as typeof app.clone.sample); sl.append('Sample', ss);
    el.append(ml, bl, sl, hintEl('Draw around an area, then drag the selection: Source = repair it from where you drop it · Destination = copy it there · Content-Aware = fill it with new content built mostly from where you drop it'));
  } else if (t === 'cmove') {
    const ml = document.createElement('label'); const ms = document.createElement('select');
    ms.innerHTML = '<option value="move">Move</option><option value="extend">Extend (copy)</option>'; ms.value = app.cmove.mode; ms.onchange = () => (app.cmove.mode = ms.value as 'move' | 'extend'); ml.append('Mode', ms);
    const bl = document.createElement('label'); const bc = document.createElement('input'); bc.type = 'checkbox'; bc.checked = app.cmove.blend; bc.onchange = () => (app.cmove.blend = bc.checked); bl.append(bc, 'Match tone & texture');
    const sl = document.createElement('label'); const ss = document.createElement('select');
    ss.innerHTML = '<option value="layer">Current layer</option><option value="below">Current &amp; below</option><option value="all">All layers</option>';
    ss.value = app.clone.sample; ss.onchange = () => (app.clone.sample = ss.value as typeof app.clone.sample); sl.append('Sample', ss);
    el.append(ml, bl, sl, hintEl('Draw around an object, then drag it: Move = the hole it leaves is filled in automatically · Extend = a blended copy, the original stays'));
  } else if (t === 'clone' || t === 'heal') {
    el.append(slider('Size', () => b.size, (v) => (b.size = v), 1, 500, 1, (v) => v + 'px'),
      slider('Hardness', () => b.hardness, (v) => (b.hardness = v), 0, 1, 0.01, pct),
      slider('Opacity', () => b.opacity, (v) => (b.opacity = v), 0.01, 1, 0.01, pct),
      slider('Flow', () => b.flow, (v) => (b.flow = v), 0.01, 1, 0.01, pct));
    const al = document.createElement('label'); const ac = document.createElement('input'); ac.type = 'checkbox'; ac.checked = app.clone.aligned;
    ac.onchange = () => { app.clone.aligned = ac.checked; app.clone.offset = null; }; al.append(ac, 'Aligned');
    const sl = document.createElement('label'); const ss = document.createElement('select');
    ss.innerHTML = '<option value="layer">Current layer</option><option value="below">Current &amp; below</option><option value="all">All layers</option>';
    ss.value = app.clone.sample; ss.onchange = () => (app.clone.sample = ss.value as typeof app.clone.sample); sl.append('Sample', ss);
    el.append(al, sl, hintEl(t === 'heal' ? 'Alt+click to set the source, then paint — the patch blends in when you release' : 'Alt+click to set the source, then paint'));
  } else if (t === 'bucket') {
    el.append(slider('Tolerance', () => app.fill.tolerance, (v) => (app.fill.tolerance = v), 0, 255),
      slider('Opacity', () => b.opacity, (v) => (b.opacity = v), 0.01, 1, 0.01, pct));
    const l = document.createElement('label'); const c = document.createElement('input'); c.type = 'checkbox'; c.checked = app.fill.contiguous;
    c.onchange = () => (app.fill.contiguous = c.checked); l.append(c, 'Contiguous'); el.append(l);
  } else if (t === 'gradient') {
    const l = document.createElement('label'); const s = document.createElement('select');
    s.innerHTML = '<option value="fg-bg">Foreground → Background</option><option value="fg-transparent">Foreground → Transparent</option>';
    s.value = app.gradient.mode; s.onchange = () => (app.gradient.mode = s.value as any); l.append('Mode', s); el.append(l);
    el.append(slider('Opacity', () => b.opacity, (v) => (b.opacity = v), 0.01, 1, 0.01, pct));
  } else if (t === 'marquee') {
    const l = document.createElement('label'); const s = document.createElement('select');
    s.innerHTML = '<option value="rect">Rectangle</option><option value="ellipse">Ellipse</option>';
    s.value = app.marquee.shape; s.onchange = () => (app.marquee.shape = s.value as 'rect' | 'ellipse'); l.append('Shape', s);
    el.append(l, hintEl('Shift = add · Alt = subtract · Shift+Alt = intersect'));
  } else if (t === 'lasso') {
    const ml = document.createElement('label'); const ms = document.createElement('select');
    ms.innerHTML = '<option value="free">Freehand</option><option value="poly">Polygonal</option>'; ms.value = app.lasso.mode; ms.onchange = () => (app.lasso.mode = ms.value as 'free' | 'poly'); ml.append('Mode', ms);
    el.append(ml, hintEl('Freehand: drag · Polygonal: click corners, click the first point / double-click / Enter to close, Backspace removes a point, Esc cancels · L toggles the mode · Shift = add · Alt = subtract'));
  } else if (t === 'transform') {
    const num = (label: string, get: () => number, set: (v: number) => void, step = 0.1) => {
      const l = document.createElement('label'), i = document.createElement('input'); i.type = 'number'; i.step = String(step); i.style.width = '72px';
      i.value = String(Math.round(get() * 100) / 100); i.onchange = () => { const v = Number(i.value); if (Number.isFinite(v)) set(v); };
      l.append(label, i); return { l, i, get };
    };
    const w = num('W %', () => Math.abs(freeTransform.m?.sx ?? 1) * 100, (v) => freeTransform.set({ sx: Math.sign(freeTransform.m.sx || 1) * Math.max(0.01, v / 100) }));
    const h = num('H %', () => Math.abs(freeTransform.m?.sy ?? 1) * 100, (v) => freeTransform.set({ sy: Math.sign(freeTransform.m.sy || 1) * Math.max(0.01, v / 100) }));
    const a = num('Angle °', () => freeTransform.m?.angle ?? 0, (v) => freeTransform.set({ angle: v }));
    const mode = document.createElement('select');
    mode.innerHTML = '<option value="affine">Scale / Rotate</option><option value="skew">Skew</option><option value="distort">Distort</option><option value="perspective">Perspective</option><option value="warp">Warp</option>';
    mode.value = freeTransform.mode; mode.onchange = () => freeTransform.setMode(mode.value as typeof freeTransform.mode);
    const ml = document.createElement('label'); ml.append('Mode', mode);
    const rs = document.createElement('button'); rs.textContent = 'Reset'; rs.onclick = () => freeTransform.reset();
    const sync = () => { if (!freeTransform.active) return; mode.value = freeTransform.mode; for (const f of [w, h, a]) { f.i.value = String(Math.round(f.get() * 100) / 100); f.i.disabled = freeTransform.mode !== 'affine'; } };
    xformSync = sync;
    const ok = document.createElement('button'); ok.textContent = '✓ Apply'; ok.onclick = () => freeTransform.commit();
    const no = document.createElement('button'); no.textContent = '✕ Cancel'; no.onclick = () => freeTransform.cancel();
    el.append(ml, w.l, h.l, a.l, rs, ok, no, hintEl('Enter applies · Esc cancels · Scale/Rotate: Shift keeps proportions / snaps rotation, Alt scales from the centre · Skew: drag edges · Distort: drag corners or edges · Perspective: drag a corner and its neighbour mirrors · Warp: drag the 16 control points'));
  } else if (t === 'quick') {
    el.append(slider('Size', () => app.quick.size, (v) => (app.quick.size = v), 4, 300, 1, (v) => v + 'px'),
      slider('Tolerance', () => app.quick.tolerance, (v) => (app.quick.tolerance = v), 0, 255));
    const l = document.createElement('label'); const c = document.createElement('input'); c.type = 'checkbox'; c.checked = app.wand.allLayers; c.onchange = () => (app.wand.allLayers = c.checked); l.append(c, 'Sample all layers');
    el.append(l, hintEl('Paint over an object: the selection grows along colour edges · Shift = add · Alt = subtract · later strokes add automatically'));
  } else if (t === 'wand') {
    el.append(slider('Tolerance', () => app.fill.tolerance, (v) => (app.fill.tolerance = v), 0, 255));
    const mk = (label: string, get: () => boolean, set: (v: boolean) => void) => {
      const l = document.createElement('label'); const c = document.createElement('input'); c.type = 'checkbox'; c.checked = get();
      c.onchange = () => set(c.checked); l.append(c, label); return l;
    };
    el.append(mk('Contiguous', () => app.fill.contiguous, (v) => (app.fill.contiguous = v)),
      mk('Sample all layers', () => app.wand.allLayers, (v) => (app.wand.allLayers = v)),
      hintEl('Shift = add · Alt = subtract'));
  } else if (t === 'text') {
    const tx = app.text, fire = () => app.emit('textstyle');
    const fontSel = document.createElement('select');
    fontSel.innerHTML = FONTS.map(([n, css]) => `<option value="${css.replace(/"/g, '&quot;')}">${n}</option>`).join('');
    fontSel.value = tx.font; fontSel.onchange = () => { tx.font = fontSel.value; fire(); };
    const size = document.createElement('input'); size.type = 'number'; size.min = '4'; size.max = '1000'; size.value = String(tx.size); size.style.width = '64px';
    size.onchange = () => { tx.size = Math.max(4, Math.min(1000, Number(size.value) || 48)); fire(); };
    const toggle = (label: string, style: string, get: () => boolean, set: (v: boolean) => void) => {
      const b = document.createElement('button'); b.innerHTML = label; b.style.cssText = style; b.classList.toggle('primary', get());
      b.onclick = () => { set(!get()); b.classList.toggle('primary', get()); fire(); }; return b;
    };
    const align = document.createElement('select');
    align.innerHTML = '<option value="left">Left</option><option value="center">Center</option><option value="right">Right</option>';
    align.value = tx.align; align.onchange = () => { tx.align = align.value as typeof tx.align; fire(); };
    const lab = (n: string, el: HTMLElement) => { const l = document.createElement('label'); l.append(n, el); return l; };
    const hint = document.createElement('span'); hint.style.color = 'var(--dim)';
    hint.textContent = 'Click canvas to type · click text to edit · Esc / Ctrl+Enter to finish · color = foreground';
    el.append(lab('Font', fontSel), lab('Size', size), toggle('<b>B</b>', '', () => tx.bold, (v) => (tx.bold = v)),
      toggle('<i>I</i>', '', () => tx.italic, (v) => (tx.italic = v)), lab('Align', align), hint);
  } else {
    const hint = document.createElement('span');
    hint.style.color = 'var(--dim)';
    hint.textContent = ({ move: 'Drag to move the active layer (or the selected pixels).', eyedropper: 'Click to pick foreground color. Alt+click for background.', hand: 'Drag to pan. Scroll wheel zooms.' } as Record<string, string>)[t] ?? '';
    el.append(hint);
  }
}

// ---------------------------------------------------------------- layers panel
export function initPanels() {
  $('layerpanel').innerHTML = `<h3>Layers</h3>
    <div class="lprops">
      <span>Opacity</span><input type="range" id="lop" min="0" max="100"><span id="lopv"></span>
      <span>Fill</span><input type="range" id="lfill" min="0" max="100"><span id="lfillv"></span>
      <span>Blend</span><select id="lblend"></select>
    </div>
    <div id="layerlist"></div>
    <div class="lbtns">
      <button id="lnew" title="New layer (Ctrl+Shift+N)">＋</button><button id="ldup" title="Duplicate (Ctrl+J)">⧉</button><button id="lgroup" title="Group layers (Ctrl+G)"><svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:middle"><path d="M3 6.5A1.5 1.5 0 014.5 5H9l2 2.5h8.5A1.5 1.5 0 0121 9v8.5a1.5 1.5 0 01-1.5 1.5h-15A1.5 1.5 0 013 17.5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg></button>
      <button id="lclip" title="Create / release clipping mask (Ctrl+Alt+G)"><svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:middle"><path d="M5 4v10a3 3 0 003 3h10M14 13l4 4-4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button><button id="lup" title="Move up">▲</button><button id="ldown" title="Move down">▼</button>
      <button id="ladj" title="New adjustment layer"><svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:middle"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 3.5a8.5 8.5 0 010 17z" fill="currentColor"/></svg></button><button id="lfx" title="Layer style (drop shadow, stroke, glow...)"><i style="font-weight:700;font-size:12px">fx</i></button><button id="lmask" title="Add layer mask (from selection if one exists)"><svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:middle"><rect x="3" y="3" width="18" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="5" fill="currentColor"/></svg></button><button id="lmerge" title="Merge down (Ctrl+E)">⤓</button><button id="ldel" title="Delete layer">🗑</button>
    </div>`;
  const sel = $<HTMLSelectElement>('lblend');
  const op = $<HTMLInputElement>('lop');
  let startOpacity = 1;
  op.onpointerdown = () => (startOpacity = app.doc.active.opacity);
  op.oninput = () => { app.doc.active.opacity = Number(op.value) / 100; $('lopv').textContent = op.value + '%'; app.doc.emit('pixels'); };
  op.onchange = () => app.doc.setProp(app.doc.active, 'opacity', Number(op.value) / 100, startOpacity);
  sel.onchange = () => app.doc.setProp(app.doc.active, 'blend', sel.value);
  $('lnew').onclick = () => app.doc.addLayer();
  $('ldup').onclick = () => app.doc.duplicateLayer();
  $('ldel').onclick = () => app.doc.removeLayer();
  $('ladj').onclick = (e) => popup(e.currentTarget as HTMLElement,
    (['levels', 'curves', 'brightness', 'hue', 'invert', 'posterize', 'threshold', 'exposure', 'vibrance', 'bw', 'photo', 'lookup', 'selective', 'balance', 'mixer', 'gradmap'] as AdjustmentType[]).map((t) => [ADJUSTMENT_LABELS[t] + (t === 'invert' ? '' : '…'), () => newAdjustmentLayer(t)]));
  $('lmask').onclick = () => {
    const d = app.doc;
    if (d.active.mask) return app.toast('Layer already has a mask (Layer ▸ Layer Mask)');
    d.addMask(d.selection ? 'selection' : 'reveal');
  };
  $('lmerge').onclick = () => app.doc.mergeDown();
  const fill = $<HTMLInputElement>('lfill');
  let startFill = 1;
  fill.onpointerdown = () => (startFill = app.doc.active.fillOpacity);
  fill.oninput = () => { app.doc.active.fillOpacity = Number(fill.value) / 100; $('lfillv').textContent = fill.value + '%'; app.doc.emit('pixels'); };
  fill.onchange = () => app.doc.setProp(app.doc.active, 'fillOpacity', Number(fill.value) / 100, startFill);
  $('lfx').onclick = (e) => popup(e.currentTarget as HTMLElement, [
    ...[...FX_ORDER].reverse().map((k): [string, () => void] => [FX_LABELS[k] + '…', () => openLayerStyle(app.doc.active, k)]),
    ['Layer Style…', () => openLayerStyle()],
    ['Blend If…', () => openBlendIf()],
  ]);
  $('lgroup').onclick = () => app.doc.groupLayers();
  $('lclip').onclick = () => app.doc.toggleClip();
  $('lup').onclick = () => app.doc.nudgeNode(app.doc.active, 1);
  $('ldown').onclick = () => app.doc.nudgeNode(app.doc.active, -1);
  $('historypanel').innerHTML = `<h3>History</h3><div id="hlist"></div>`;
}

/** Small floating list anchored above a button; closes on any outside click. */
function popup(anchor: HTMLElement, items: [string, () => void][]) {
  document.querySelector('.popup')?.remove();
  const p = document.createElement('div'); p.className = 'popup';
  const r = anchor.getBoundingClientRect();
  p.style.left = `${r.left}px`; p.style.bottom = `${innerHeight - r.top + 4}px`;
  const off = (e: Event) => { if (!p.contains(e.target as Node)) { p.remove(); document.removeEventListener('pointerdown', off, true); } };
  for (const [label, fn] of items) {
    const row = document.createElement('div'); row.className = 'mi'; row.textContent = label;
    row.onclick = () => { p.remove(); document.removeEventListener('pointerdown', off, true); fn(); };
    p.append(row);
  }
  document.body.append(p);
  document.addEventListener('pointerdown', off, true);
}

function thumb(src: HTMLCanvasElement) {
  const c = document.createElement('canvas');
  const s = Math.min(1, 80 / src.width, 64 / src.height);
  c.width = Math.max(1, Math.round(src.width * s)); c.height = Math.max(1, Math.round(src.height * s));
  c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

const FOLDER = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M3 6.5A1.5 1.5 0 014.5 5H9l2 2.5h8.5A1.5 1.5 0 0121 9v8.5a1.5 1.5 0 01-1.5 1.5h-15A1.5 1.5 0 013 17.5z" fill="currentColor" opacity=".85"/></svg>';

export function renderLayers() {
  const doc = app.doc, list = $('layerlist');
  list.innerHTML = '';
  const shown: Layer[] = [];            // rows in panel order (for Shift-range selection)
  const bases = new Set(doc.layers.filter((x) => x.clipped).map((x) => doc.clipBase(x)));   // layers that have something clipped to them
  const rowOf = (l: Layer, depth: number) => {
    const row = document.createElement('div');
    row.className = 'layer' + (l === doc.active ? ' active' : '') + (doc.multi.has(l) ? ' multi' : '') + (l.isGroup ? ' isgroup' : '') + (l.clipped && doc.clipBase(l) ? ' clipped' : '') + (bases.has(l) ? ' clipbase' : '');
    row.dataset.layer = String(l.id);
    row.style.paddingLeft = `${8 + depth * 16 + (l.clipped && doc.clipBase(l) ? 14 : 0)}px`;
    row.draggable = true;
    const eye = document.createElement('span'); eye.className = 'eye' + (l.visible ? (doc.isShown(l) ? '' : ' dim') : ' off'); eye.textContent = '👁';
    eye.onclick = (e) => { e.stopPropagation(); doc.setProp(l, 'visible', !l.visible); };
    const parts: HTMLElement[] = [eye];
    if (l.clipped && doc.clipBase(l)) { const m = document.createElement('span'); m.className = 'clipmark'; m.textContent = '↳'; m.title = 'Clipped to the layer below'; parts.push(m); }
    if (l.isGroup) {
      const arrow = document.createElement('span'); arrow.className = 'arrow'; arrow.textContent = l.collapsed ? '▸' : '▾'; arrow.title = 'Expand / collapse';
      arrow.onclick = (e) => { e.stopPropagation(); l.collapsed = !l.collapsed; renderLayers(); };
      const icon = document.createElement('div'); icon.className = 'adjicon grpicon'; icon.innerHTML = FOLDER; icon.title = 'Group';
      icon.onclick = () => doc.setEditMask(l, false);
      parts.unshift(arrow); parts.push(icon);
    } else if (l.adjustment) {
      const icon = document.createElement('div'); icon.className = 'adjicon'; icon.title = `${ADJUSTMENT_LABELS[l.adjustment.type]} — double-click to edit`;
      icon.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 3.5a8.5 8.5 0 010 17z" fill="currentColor"/></svg>';
      icon.ondblclick = (e) => { e.stopPropagation(); editAdjustment(l); };
      parts.push(icon);
    } else {
      const pix = thumb(l.canvas); pix.classList.add('lthumb');
      pix.classList.toggle('target', l === doc.active && !l.maskMode);
      pix.onclick = () => doc.setEditMask(l, false);
      if (l.smart) {
        pix.title = 'Smart Object — double-click to edit its contents';
        pix.ondblclick = (e) => { e.stopPropagation(); doc.select(l); void editContents(doc, l, (d) => app.openDoc(d)); };
        const wrap = document.createElement('div'); wrap.className = 'smartwrap';
        const badge = document.createElement('span'); badge.className = 'smartbadge'; badge.textContent = '⧉'; badge.title = 'Smart Object';
        wrap.append(pix, badge); parts.push(wrap);
      } else parts.push(pix);
    }
    if (l.mask) {
      const m = thumb(l.mask); m.classList.add('mthumb');
      m.classList.toggle('target', l === doc.active && l.maskMode && !l.adjustment); m.classList.toggle('off', !l.maskEnabled);
      m.title = 'Layer mask — click to edit, Shift+click to enable/disable';
      m.onclick = (e) => { e.stopPropagation(); if (e.shiftKey) { doc.select(l); doc.toggleMask(l); } else doc.setEditMask(l, true); };
      parts.push(m);
    }
    const name = document.createElement('span'); name.className = 'name'; name.textContent = (l.text ? 'T  ' : '') + l.name; name.title = l.name;
    name.ondblclick = () => {
      const inp = document.createElement('input'); inp.type = 'text'; inp.value = l.name;
      name.textContent = ''; name.append(inp); inp.focus(); inp.select();
      const done = () => { const v = inp.value.trim(); if (v && v !== l.name) doc.setProp(l, 'name', v); else renderLayers(); };
      inp.onblur = done; inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') inp.blur(); if (e.key === 'Escape') { inp.value = l.name; inp.blur(); } };
    };
    // click: plain = select; Ctrl/Cmd = toggle in selection; Shift = range
    row.onclick = (e) => {
      if (e.shiftKey && shown.includes(doc.active)) {
        const a = shown.indexOf(doc.active), b = shown.indexOf(l);
        doc.multi = new Set(shown.slice(Math.min(a, b), Math.max(a, b) + 1));
        doc.select(l);
      } else if (e.ctrlKey || e.metaKey) {
        if (!doc.multi.size) doc.multi.add(doc.active);
        doc.multi.has(l) ? doc.multi.delete(l) : doc.multi.add(l);
        doc.select(l);
      } else { doc.multi.clear(); doc.select(l); }
    };
    // drag & drop: top/bottom quarter = before/after, middle of a group = move inside it
    const zone = (e: DragEvent) => {
      const r = row.getBoundingClientRect(), f = (e.clientY - r.top) / r.height;
      return l.isGroup ? (f < 0.25 ? 'above' : f > 0.75 ? 'below' : 'inside') : f < 0.5 ? 'above' : 'below';
    };
    const clear = () => row.classList.remove('dz-above', 'dz-below', 'dz-inside');
    row.ondragstart = (e) => e.dataTransfer!.setData('text/layer', String(l.id));
    row.ondragover = (e) => { if (e.dataTransfer!.types.includes('text/layer')) { e.preventDefault(); clear(); row.classList.add('dz-' + zone(e)); } };
    row.ondragleave = clear;
    row.ondrop = (e) => {
      e.preventDefault(); clear();
      const src = doc.layers.find((x) => String(x.id) === e.dataTransfer!.getData('text/layer'));
      if (src && !doc.moveNode(src, l, zone(e) as 'above' | 'below' | 'inside')) app.toast('Cannot move a group into itself');
    };
    row.append(...parts, name);
    if (hasEffects(l.effects)) {
      const fxb = document.createElement('span'); fxb.className = 'fxbadge'; fxb.textContent = 'fx'; fxb.title = 'Layer style — click to edit';
      fxb.onclick = (e) => { e.stopPropagation(); openLayerStyle(l); };
      row.append(fxb);
    }
    shown.push(l);
    list.append(row);
  };
  const walk = (nodes: LayerNode[], depth: number) => {
    for (const n of [...nodes].reverse()) { rowOf(n.layer, depth); if (n.layer.isGroup && !n.layer.collapsed) walk(n.children, depth + 1); }
  };
  walk(doc.tree(), 0);
  const a = doc.active;
  $<HTMLInputElement>('lop').value = String(Math.round(a.opacity * 100));
  $('lopv').textContent = Math.round(a.opacity * 100) + '%';
  const sel = $<HTMLSelectElement>('lblend'), modes = a.isGroup ? GROUP_BLEND_MODES : BLEND_MODES;
  sel.innerHTML = modes.map((m) => `<option value="${m.id}">${m.label}</option>`).join('');
  sel.value = modes.some((m) => m.id === a.blend) ? a.blend : 'normal';
  sel.disabled = false;
  const fl = $<HTMLInputElement>('lfill');
  fl.value = String(Math.round(a.fillOpacity * 100)); $('lfillv').textContent = fl.value + '%'; fl.disabled = a.isGroup || !!a.adjustment;
}

// ---------------------------------------------------------------- tabs & status
export function renderTabs(switchTo: (i: number) => void, close: (i: number) => void) {
  const tabs = $('tabs'); tabs.innerHTML = '';
  app.docs.forEach((d, i) => {
    const t = document.createElement('div');
    t.className = 'tab' + (d === app.doc ? ' active' : '');
    const n = document.createElement('span'); n.textContent = d.name + (d.history.dirty ? ' •' : '');
    const x = document.createElement('span'); x.className = 'x'; x.textContent = '✕';
    x.onclick = (e) => { e.stopPropagation(); close(i); };
    t.onclick = () => switchTo(i);
    t.onauxclick = () => close(i);
    t.append(n, x); tabs.append(t);
  });
}

app.on('textsync', () => renderOptions());

export function initStatus() {
  $('status').innerHTML = `<span id="sdoc"></span><span id="scur"></span><span class="sp"></span><button id="sfit">Fit</button><button id="s100">100%</button><span id="szoom"></span>`;
  $('sfit').onclick = () => app.view.fit();
  $('s100').onclick = () => app.view.setZoom(1);
}
export function renderStatus() {
  const d = app.doc, v = app.view;
  if (!d) return;
  $('sdoc').textContent = `${d.width} × ${d.height} px · ${d.active.name}${d.active.isGroup ? ' (group)' : ''}${d.active.maskMode ? ' (mask)' : ''}`;
  $('szoom').textContent = Math.round(v.zoom * 100) + '%';
  const c = v.cursorDoc;
  $('scur').textContent = c ? `${Math.floor(c.x)}, ${Math.floor(c.y)}` : '';
}

export function renderHistory() {
  const h = app.doc.history, list = $('hlist');
  list.innerHTML = '';
  const item = (t: string, cur = false) => { const d = document.createElement('div'); d.className = 'item' + (cur ? ' cur' : ''); d.textContent = t; list.append(d); };
  item(h.canUndo ? `Last: ${h.undoLabel}` : 'No history', true);
  if (h.canRedo) item(`Redo: ${h.redoLabel}`);
}
