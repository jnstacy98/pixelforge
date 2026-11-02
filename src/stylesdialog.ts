import { app } from './state';
import { BLEND_MODES, type Layer } from './doc';
import { allPatterns, definePattern, hasPattern, getPattern } from './patterns';
import { FX_LABELS, FX_ORDER, cloneFx, defaultFx, sameFx, type FxKind, type LayerEffects } from './fx';

let busy = false;
/** True while the Layer Style dialog is open (global shortcuts are suspended). */
export const isStyling = () => busy;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...kids: (Node | string)[]) {
  const e = document.createElement(tag);
  const { class: cls, ...rest } = props as { class?: string };
  if (cls) e.className = cls;
  Object.assign(e, rest);
  e.append(...kids);
  return e;
}

/** Stacking order for the list: Photoshop shows the top-most effect first. */
const LIST: FxKind[] = [...FX_ORDER].reverse();

/**
 * Edit a layer's styles with a live preview. `focus` selects (and enables) one effect, like clicking an
 * effect in Photoshop's fx menu; without it the first enabled effect (or Drop Shadow) is shown.
 */
export function openLayerStyle(layer: Layer = app.doc.active, focus?: FxKind) {
  if (busy) return;
  if (layer.isGroup || layer.adjustment) { app.toast('Layer styles apply to pixel and text layers'); return; }
  const doc = app.doc;
  busy = true;
  doc.select(layer);
  const before = cloneFx(layer.effects);
  // a draft for every kind; absent ones start disabled with defaults
  const draft: { [K in FxKind]: NonNullable<LayerEffects[K]> } = {} as never;
  for (const k of LIST) { const d = defaultFx(k); (draft as Record<string, unknown>)[k] = { ...d, on: false, ...(k === 'gradientOverlay' ? { style: 'linear', scale: 1 } : {}), ...((before?.[k] as object) ?? {}) }; }
  if (focus) (draft[focus] as { on: boolean }).on = true;
  let current: FxKind = focus ?? LIST.find((k) => draft[k].on) ?? 'dropShadow';

  const build = (): LayerEffects | null => {
    const out: LayerEffects = {};
    for (const k of LIST) if (draft[k].on || before?.[k]) (out as Record<string, unknown>)[k] = JSON.parse(JSON.stringify(draft[k]));
    return Object.values(out).some((v) => (v as { on: boolean }).on) || (before && Object.keys(out).length) ? out : null;
  };
  let raf = 0;
  const changed = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; layer.effects = build(); doc.emit('pixels'); });
  };

  // ---- controls --------------------------------------------------------------
  const body = el('div', { class: 'fx-controls' });
  const row = (label: string, ...ctl: HTMLElement[]) => el('div', { class: 'row' }, el('span', { textContent: label, class: 'lbl' }), ...ctl);
  const range = (d: Record<string, unknown>, key: string, min: number, max: number, step = 1, scale = 1) => {
    const n = el('input', { type: 'number', min: String(min * scale), max: String(max * scale), step: String(step * scale) });
    const r = el('input', { type: 'range', min: String(min), max: String(max), step: String(step) });
    const set = (v: number) => { d[key] = v; n.value = String(Math.round(v * scale * 100) / 100); r.value = String(v); changed(); };
    r.value = String(d[key]); n.value = String(Math.round((d[key] as number) * scale * 100) / 100);
    r.oninput = () => set(Number(r.value));
    n.oninput = () => { const v = Number(n.value) / scale; if (Number.isFinite(v)) set(Math.min(max, Math.max(min, v))); };
    n.style.width = '58px';
    return [r, n];
  };
  const color = (d: Record<string, unknown>, key: string) => { const c = el('input', { type: 'color', value: d[key] as string }); c.oninput = () => { d[key] = c.value; changed(); }; return [c]; };
  const blend = (d: Record<string, unknown>, key = 'blend') => {
    const s = el('select'); s.innerHTML = BLEND_MODES.map((m) => `<option value="${m.id}">${m.label}</option>`).join('');
    s.value = BLEND_MODES.some((m) => m.id === d[key]) ? (d[key] as string) : 'normal'; s.onchange = () => { d[key] = s.value; changed(); };
    return [s];
  };
  const choice = (d: Record<string, unknown>, key: string, options: [string, string][]) => {
    const s = el('select'); s.innerHTML = options.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    s.value = d[key] as string; s.onchange = () => { d[key] = s.value; changed(); };
    return [s];
  };
  const common = (d: Record<string, unknown>) => [row('Blend', ...blend(d)), row('Opacity %', ...range(d, 'opacity', 0, 1, 0.01, 100))];
  const controls: Record<FxKind, (d: never) => HTMLElement[]> = {
    dropShadow: (d: Record<string, unknown>) => [...common(d), row('Color', ...color(d, 'color')), row('Angle °', ...range(d, 'angle', 0, 360)), row('Distance', ...range(d, 'distance', 0, 100)), row('Spread %', ...range(d, 'spread', 0, 100)), row('Size', ...range(d, 'size', 0, 100))] as never,
    innerShadow: (d: Record<string, unknown>) => [...common(d), row('Color', ...color(d, 'color')), row('Angle °', ...range(d, 'angle', 0, 360)), row('Distance', ...range(d, 'distance', 0, 100)), row('Choke %', ...range(d, 'spread', 0, 100)), row('Size', ...range(d, 'size', 0, 100))] as never,
    outerGlow: (d: Record<string, unknown>) => [...common(d), row('Color', ...color(d, 'color')), row('Spread %', ...range(d, 'spread', 0, 100)), row('Size', ...range(d, 'size', 0, 100))] as never,
    innerGlow: (d: Record<string, unknown>) => [...common(d), row('Color', ...color(d, 'color')), row('Choke %', ...range(d, 'spread', 0, 100)), row('Size', ...range(d, 'size', 0, 100))] as never,
    colorOverlay: (d: Record<string, unknown>) => [...common(d), row('Color', ...color(d, 'color'))] as never,
    gradientOverlay: (d: Record<string, unknown>) => {
      const rev = el('input', { type: 'checkbox', checked: !!d.reverse }); rev.onchange = () => { d.reverse = rev.checked; changed(); };
      const custom = Array.isArray(d.stops) && d.stops.length > 2, resetStops = () => { delete d.stops; };
      const col = (key: string) => { const c = el('input', { type: 'color', value: d[key] as string }); c.oninput = () => { d[key] = c.value; resetStops(); changed(); }; return [c]; };
      return [...common(d), ...(custom ? [row('Gradient', el('span', { textContent: `Custom, ${(d.stops as unknown[]).length} stops`, class: 'lbl' } as never))] : []),
        row('From', ...col('color1')), row('To', ...col('color2')), row('Style', ...choice(d, 'style', [['linear', 'Linear'], ['radial', 'Radial'], ['angle', 'Angle'], ['reflected', 'Reflected'], ['diamond', 'Diamond (as radial)']])),
        row('Angle °', ...range(d, 'angle', 0, 360)), row('Scale %', ...range(d, 'scale', 0.1, 3, 0.01, 100)), row('Reverse', rev)] as never;
    },
    patternOverlay: (d: Record<string, unknown>) => {
      const sel = el('select');
      const fill = () => {
        sel.innerHTML = allPatterns().map((t) => `<option value="${t.id}">${t.name.replace(/[<&"]/g, '')}</option>`).join('');
        if (!hasPattern(d.id as string)) sel.append(el('option', { value: d.id as string, textContent: `${d.name} (missing)` }));
        sel.value = d.id as string;
      };
      fill();
      sel.onchange = () => { d.id = sel.value; d.name = getPattern(sel.value)?.name ?? sel.value; changed(); };
      const mk = el('button', { type: 'button', textContent: 'New pattern from selection / layer' });
      mk.onclick = () => {
        const L = layer.canvas, sr = doc.selection;
        let r = sr ? { x: Math.floor(sr.x), y: Math.floor(sr.y), w: Math.ceil(sr.w), h: Math.ceil(sr.h) } : { x: 0, y: 0, w: L.width, h: L.height };
        if (!sr) {                                                             // tight box around the layer's pixels
          const dd = L.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, L.width, L.height).data;
          let x0 = L.width, y0 = L.height, x1 = -1, y1 = -1;
          for (let y = 0; y < L.height; y++) for (let x = 0; x < L.width; x++) if (dd[(y * L.width + x) * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
          if (x1 < 0) return app.toast('The layer is empty');
          r = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
        }
        if (r.w < 2 || r.h < 2 || r.w * r.h > 1024 * 1024) return app.toast('Pick an area between 2×2 and 1024×1024 pixels');
        const img = L.getContext('2d', { willReadFrequently: true })!.getImageData(r.x, r.y, r.w, r.h);
        const t = definePattern(`Pattern ${allPatterns().filter((p) => p.id.startsWith('pf:user')).length + 1}`, r.w, r.h, img.data);
        d.id = t.id; d.name = t.name; fill(); changed();
      };
      return [row('Pattern', sel), row('', mk), ...common(d), row('Scale %', ...range(d, 'scale', 0.1, 8, 0.01, 100)), row('Angle °', ...range(d, 'angle', -180, 180))] as never;
    },
    satin: (d: Record<string, unknown>) => {
      const inv = el('input', { type: 'checkbox', checked: !!d.invert }); inv.onchange = () => { d.invert = inv.checked; changed(); };
      return [...common(d), row('Color', ...color(d, 'color')), row('Angle °', ...range(d, 'angle', 0, 360)), row('Distance', ...range(d, 'distance', 0, 60)), row('Size', ...range(d, 'size', 0, 60)), row('Invert', inv)] as never;
    },
    bevel: (d: Record<string, unknown>) => [
      row('Style', ...choice(d, 'style', [['inner', 'Inner Bevel'], ['outer', 'Outer Bevel'], ['emboss', 'Emboss'], ['pillow', 'Pillow Emboss'], ['stroke', 'Stroke Emboss']])),
      row('Technique', ...choice(d, 'technique', [['smooth', 'Smooth'], ['hard', 'Chisel Hard'], ['soft', 'Chisel Soft']])),
      row('Depth %', ...range(d, 'depth', 1, 500)), row('Direction', ...choice(d, 'direction', [['up', 'Up'], ['down', 'Down']])),
      row('Size', ...range(d, 'size', 0, 100)), row('Soften', ...range(d, 'soften', 0, 16)),
      row('Angle °', ...range(d, 'angle', 0, 360)), row('Altitude °', ...range(d, 'altitude', 0, 90)),
      row('Highlight', ...blend(d, 'hiBlend')), row('', ...color(d, 'hiColor')), row('Opacity %', ...range(d, 'hiOpacity', 0, 1, 0.01, 100)),
      row('Shadow', ...blend(d, 'shBlend')), row('', ...color(d, 'shColor')), row('Opacity %', ...range(d, 'shOpacity', 0, 1, 0.01, 100)),
    ] as never,
    stroke: (d: Record<string, unknown>) => {
      const pos = el('select'); pos.innerHTML = '<option value="outside">Outside</option><option value="inside">Inside</option><option value="center">Center</option>';
      pos.value = d.position as string; pos.onchange = () => { d.position = pos.value; changed(); };
      return [row('Size', ...range(d, 'size', 1, 100)), row('Position', pos), ...common(d), row('Color', ...color(d, 'color'))] as never;
    },
  };
  const showControls = () => {
    body.innerHTML = '';
    body.append(el('h3', { textContent: FX_LABELS[current] }), ...controls[current](draft[current] as never));
    list.querySelectorAll('.fx-item').forEach((i) => i.classList.toggle('sel', (i as HTMLElement).dataset.kind === current));
  };

  // ---- list ------------------------------------------------------------------
  const list = el('div', { class: 'fx-list' });
  const boxes: Record<string, HTMLInputElement> = {};
  for (const k of LIST) {
    const cb = el('input', { type: 'checkbox', checked: draft[k].on });
    boxes[k] = cb;
    cb.onchange = () => { draft[k].on = cb.checked; current = k; showControls(); changed(); };
    const item = el('div', { class: 'fx-item' }, cb, el('span', { textContent: FX_LABELS[k] }));
    item.dataset.kind = k;
    item.onclick = (e) => { if (e.target !== cb) { current = k; showControls(); } };
    list.append(item);
  }

  // ---- frame -----------------------------------------------------------------
  const back = el('div', { class: 'adjust-back' });
  const panel = el('div', { class: 'adjust-panel fx-panel', tabIndex: -1 });
  const head = el('h2', { textContent: `Layer Style — ${layer.name}` });
  const close = () => { cancelAnimationFrame(raf); back.remove(); busy = false; };
  const cancel = el('button', { type: 'button', textContent: 'Cancel' });
  const ok = el('button', { type: 'button', textContent: 'OK', className: 'primary' });
  const clear = el('button', { type: 'button', textContent: 'Clear' });
  cancel.onclick = () => { layer.effects = cloneFx(before); doc.emit('pixels'); close(); };
  ok.onclick = () => {
    const next = build();
    layer.effects = cloneFx(before);
    if (!sameFx(next, before)) doc.setEffects(layer, next, before); else doc.emit('structure');
    close();
  };
  clear.onclick = () => { for (const k of LIST) { draft[k].on = false; boxes[k].checked = false; } showControls(); changed(); };
  panel.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') cancel.click();
    else if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'BUTTON' && (e.target as HTMLElement).tagName !== 'SELECT') ok.click();
  };
  head.onpointerdown = (e) => {
    const r = panel.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    head.setPointerCapture(e.pointerId);
    head.onpointermove = (m) => { panel.style.left = `${m.clientX - dx}px`; panel.style.top = `${m.clientY - dy}px`; panel.style.right = 'auto'; };
    head.onpointerup = () => { head.onpointermove = null; head.onpointerup = null; };
  };
  panel.append(head, el('div', { class: 'fx-body' }, list, body), el('div', { class: 'adjust-foot' }, clear, el('span', { class: 'grow' }), cancel, ok));
  (panel as unknown as { __fx: unknown }).__fx = {
    draft, select: (k: FxKind) => { current = k; showControls(); },
    set: (k: FxKind, patch: Record<string, unknown>) => { Object.assign(draft[k], patch); if (boxes[k]) boxes[k].checked = draft[k].on; if (k === current) showControls(); changed(); },
  };
  back.append(panel);
  document.body.append(back);
  showControls();
  panel.focus();
  changed();
}

/** Copy / paste / clear styles on the active layer. */
export function copyStyle() {
  const l = app.doc.active;
  if (!l.effects) return app.toast('This layer has no layer style');
  app.styleClip = cloneFx(l.effects); app.toast('Layer style copied');
}
export function pasteStyle() {
  const doc = app.doc, targets = doc.selectedLayers().filter((l) => !l.isGroup && !l.adjustment);
  if (!app.styleClip) return app.toast('Copy a layer style first');
  for (const l of targets) doc.setEffects(l, app.styleClip);
}
export function clearStyle() {
  const doc = app.doc, l = doc.active;
  if (l.effects) doc.setEffects(l, null);
}
