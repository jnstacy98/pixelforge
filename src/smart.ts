// Smart objects: keep Photoshop's embedded source files, let you edit their contents, re-render them through the placed
// transform, scale / rotate them without losing quality, convert a layer into one, or rasterize it.
import { app } from './state';
import { ctxOf, hooks, makeCanvas, type Doc, type Layer } from './doc';
import { blendFiltered, recomposite, setCache } from './filtercache';
import { affineFromQuad, fingerprint, newLinkId, quadAt, quadInfo, resizeSource, scaleQuad, type LinkedFile, type Quad, type SmartInfo } from './smartmath';
import { flatten } from './render';
import { importFile, encode } from './io';
import { formDialog } from './dialog';
import { FILTER_INFO, FILTER_KINDS, applySmartFilters, cloneFilters, describeFilter, newFilter, type FilterKind, type SmartFilter } from './smartfilters';

const decoded = new Map<string, HTMLCanvasElement>();
const key = (f: LinkedFile) => `${f.id}:${f.data.byteLength}:${f.data.length > 8 ? f.data[8] + f.data[f.data.length >> 1] : 0}`;

export const linkedFor = (doc: Doc, l: Layer) => (l.smart ? doc.linked.find((f) => f.id === l.smart!.placed.id) : undefined);

/** The embedded source file as a flattened canvas. */
export async function decodeLinked(f: LinkedFile): Promise<HTMLCanvasElement> {
  const k = key(f), hit = decoded.get(k);
  if (hit) return hit;
  const d = await importFile({ name: f.name || 'source', data: f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.byteLength) as ArrayBuffer });
  const c = flatten(d, null);
  if (decoded.size > 12) decoded.clear();
  decoded.set(k, c);
  return c;
}
const printOf = (l: Layer) => fingerprint(l.ctx.getImageData(0, 0, l.canvas.width, l.canvas.height).data, l.canvas.width, l.canvas.height);

/** Redraw the layer's pixels from its source through its placed transform. */
export function draw(l: Layer, src: HTMLCanvasElement) {
  const p = l.smart!.placed, w = p.width || src.width, h = p.height || src.height, W = l.canvas.width, H = l.canvas.height;
  const U = makeCanvas(W, H), c = ctxOf(U);                                   // the placed, unfiltered render
  c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
  const [a, b, cc, d, e, f] = affineFromQuad(p.transform as Quad, w, h);
  c.setTransform(a, b, cc, d, e, f);
  c.drawImage(src, 0, 0, src.width, src.height, 0, 0, w, h);
  c.setTransform(1, 0, 0, 1, 0, 0);
  const fs = l.smart!.filters?.filter((q) => q.on);
  let F = U;
  if (fs?.length) { F = makeCanvas(W, H); const fx = ctxOf(F); fx.drawImage(U, 0, 0); const img = fx.getImageData(0, 0, W, H); applySmartFilters(fs, img.data, img.width, img.height); fx.putImageData(img, 0, 0); }
  setCache(l, U, F);
  const lc = l.ctx, fm = l.smart!.filterMask;
  if (fm && F !== U) blendFiltered(lc, U, F, fm);
  else { lc.save(); lc.setTransform(1, 0, 0, 1, 0, 0); lc.globalCompositeOperation = 'source-over'; lc.clearRect(0, 0, W, H); lc.drawImage(F, 0, 0); lc.restore(); }
  l.smart!.print = printOf(l);
  l.touchMask();
}
/** Re-blend after the filter mask was painted on (cheap: uses the cached unfiltered / filtered renders). */
hooks.fmaskChanged = (l) => { if (l.smart && recomposite(l)) l.smart.print = printOf(l); };

export function isSmart(l: Layer) { return !!l.smart; }

/** Layer ▸ Smart Object ▸ Convert: embeds the layer's pixels (cropped to what is painted) as a PNG source. */
export async function convertToSmart(doc: Doc, l: Layer) {
  if (l.isGroup || l.adjustment || l.text) return app.toast('Select a pixel layer to convert');
  if (l.smart) return app.toast('This layer is already a smart object');
  const W = l.canvas.width, H = l.canvas.height, data = l.ctx.getImageData(0, 0, W, H).data;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (data[(y * W + x) * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return app.toast('The layer is empty');
  const w = x1 - x0 + 1, h = y1 - y0 + 1, c = makeCanvas(w, h);
  ctxOf(c).drawImage(l.canvas, -x0, -y0);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
  if (!blob) return app.toast('Could not embed the pixels');
  const id = newLinkId(), file: LinkedFile = { id, name: `${l.name}.png`, type: 'png', data: new Uint8Array(await blob.arrayBuffer()) };
  doc.editSmart('Convert to Smart Object', l, () => {
    doc.linked.push(file);
    l.smart = { placed: { id, placed: newLinkId(), type: 'raster', pageNumber: 1, totalPages: 1, transform: quadAt(x0, y0, w, h), width: w, height: h, resolution: { value: 72, units: 'Density' } } as SmartInfo['placed'], print: '' };
    l.smart.print = printOf(l);
  });
  app.toast('Converted to a smart object — it can now be scaled and rotated without losing quality');
}

/** Drop the smart-object link; the layer keeps its pixels. */
export function rasterizeSmart(doc: Doc, l: Layer) {
  if (!l.smart) return app.toast('This layer is not a smart object');
  doc.editSmart('Rasterize Layer', l, () => { l.smart = null; });
}

/** Opens the embedded source in its own tab. Use "Update Smart Object" in that tab to send changes back. */
export async function editContents(doc: Doc, l: Layer, open: (d: Doc) => void) {
  const f = linkedFor(doc, l);
  if (!l.smart || !f) return app.toast('This layer is not a smart object');
  const child = await importFile({ name: f.name || 'Smart Object', data: f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.byteLength) as ArrayBuffer });
  child.name = `${f.name.replace(/\.[^.]+$/, '')} (smart object)`;
  child.path = null; child.smartSource = { doc, layer: l };
  open(child);
  app.toast('Edit the contents, then choose Layer ▸ Update Smart Object');
}

/** Sends a "Edit Contents" document back into the layer it came from. */
export async function updateSmart(child: Doc, goTo: (d: Doc) => void) {
  const src = child.smartSource;
  if (!src) return app.toast('This document was not opened with Edit Contents');
  const { doc, layer } = src;
  if (!doc.layers.includes(layer) || !layer.smart) return app.toast('The smart object layer no longer exists');
  const old = linkedFor(doc, layer);
  if (!old) return app.toast('The embedded file is missing');
  const asPsd = /\.psd$/i.test(old.name) || child.layers.length > 1;
  const data = await encode(child, asPsd ? 'psd' : 'png');
  const name = asPsd && !/\.psd$/i.test(old.name) ? old.name.replace(/\.[^.]+$/, '') + '.psd' : old.name;
  const next: LinkedFile = { ...old, name, data };
  const p = layer.smart.placed, oldW = p.width || child.width, oldH = p.height || child.height;
  doc.editSmart('Update Smart Object', layer, () => {
    doc.linked = doc.linked.map((f) => (f.id === old.id ? next : f));
    p.transform = resizeSmart(p.transform as Quad, oldW, oldH, child.width, child.height);
    p.width = child.width; p.height = child.height;
    draw(layer, flatten(child, null));
  });
  child.history.dirty = false;
  goTo(doc);
  app.toast('Smart object updated');
}
const resizeSmart = (q: Quad, ow: number, oh: number, nw: number, nh: number): Quad => (ow === nw && oh === nh ? q : resizeSource(q, ow, oh, nw, nh));

/** Scale / rotate the smart object, re-rendering from its source so nothing degrades. */
export async function transformSmart(doc: Doc, l: Layer) {
  const f = linkedFor(doc, l);
  if (!l.smart || !f) return app.toast('This layer is not a smart object');
  const src = await decodeLinked(f), p = l.smart.placed, w = p.width || src.width, h = p.height || src.height;
  const cur = quadInfo(p.transform as Quad, w, h);
  const v = await formDialog('Transform Smart Object', [
    { key: 'sx', label: 'Width (% of source)', type: 'number', value: Math.round(cur.sx * 1000) / 10, min: 1, max: 5000, step: 0.1 },
    { key: 'sy', label: 'Height (% of source)', type: 'number', value: Math.round(cur.sy * 1000) / 10, min: 1, max: 5000, step: 0.1 },
    { key: 'rot', label: 'Rotation (°)', type: 'number', value: Math.round(cur.rot * 10) / 10, min: -360, max: 360, step: 0.1 },
  ], 'Apply');
  if (!v) return;
  doc.editSmart('Transform Smart Object', l, () => {
    p.transform = scaleQuad(p.transform as Quad, v.sx / 100 / cur.sx, v.sy / 100 / cur.sy, v.rot - cur.rot);
    draw(l, src);
  });
}

// ---------------------------------------------------------------- smart filters
/** Change a smart object's filter list and re-render it from its source (one undo step). */
async function editFilters(doc: Doc, l: Layer, label: string, mutate: (list: SmartFilter[]) => void) {
  const f = linkedFor(doc, l);
  if (!l.smart || !f) return app.toast('Smart filters need a smart object');
  const src = await decodeLinked(f);
  doc.editSmart(label, l, () => { const list = cloneFilters(l.smart!.filters) ?? []; mutate(list); l.smart!.filters = list; draw(l, src); });
}
export const addSmartFilter = (doc: Doc, l: Layer, f: SmartFilter) => editFilters(doc, l, `Add ${FILTER_INFO[f.kind].label}`, (list) => { list.push(f); });
export const updateSmartFilter = (doc: Doc, l: Layer, i: number, patch: Partial<Pick<SmartFilter, 'on'>> & { p?: Record<string, number> }) =>
  editFilters(doc, l, patch.p ? `Edit ${FILTER_INFO[l.smart?.filters?.[i]?.kind ?? 'gaussian'].label}` : 'Toggle Smart Filter', (list) => { if (list[i]) { if (patch.p) list[i].p = { ...list[i].p, ...patch.p }; if (patch.on !== undefined) list[i].on = patch.on; } });
export const removeSmartFilter = (doc: Doc, l: Layer, i: number) => editFilters(doc, l, 'Delete Smart Filter', (list) => { list.splice(i, 1); });
export const moveSmartFilter = (doc: Doc, l: Layer, i: number, d: number) => editFilters(doc, l, 'Reorder Smart Filters', (list) => { const j = i + d; if (j >= 0 && j < list.length) [list[i], list[j]] = [list[j], list[i]]; });

const paramFields = (f: SmartFilter) => FILTER_INFO[f.kind].params.map((s) => ({ key: s.key, label: s.label, type: 'number' as const, value: f.p[s.key], min: s.min, max: s.max, step: s.step }));
async function askParams(f: SmartFilter, ok: string): Promise<Record<string, number> | null> {
  if (!FILTER_INFO[f.kind].params.length) return {};
  const v = await formDialog(FILTER_INFO[f.kind].label, paramFields(f), ok);
  return v ? Object.fromEntries(FILTER_INFO[f.kind].params.map((s) => [s.key, Math.min(s.max, Math.max(s.min, Number(v[s.key])))])) : null;
}

/** Layer ▸ Smart Filters…: the filter stack of the active smart object (turn on / off, edit, reorder, delete, add). */
export async function openSmartFilters(doc: Doc, l: Layer) {
  if (document.querySelector('.sf-panel')) return;
  if (!l.smart) { await convertToSmart(doc, l); if (!l.smart) return; }
  const back = document.createElement('div'); back.className = 'adjust-back';
  const panel = document.createElement('div'); panel.className = 'adjust-panel sf-panel'; panel.tabIndex = -1;
  const head = document.createElement('h2'); head.textContent = `Smart Filters — ${l.name}`;
  const list = document.createElement('div'); list.className = 'adjust-body';
  const foot = document.createElement('div'); foot.className = 'adjust-foot';
  const add = document.createElement('select'); add.innerHTML = '<option value="">Add filter…</option>' + FILTER_KINDS.map((k) => `<option value="${k}">${FILTER_INFO[k].label}</option>`).join('');
  const maskBtn = document.createElement('button'); maskBtn.type = 'button';
  const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Close'; close.className = 'primary';
  const grow = document.createElement('span'); grow.className = 'grow';
  foot.append(add, maskBtn, grow, close); panel.append(head, list, foot); back.append(panel); document.body.append(back);
  const done = () => { back.remove(); };
  close.onclick = done; panel.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Escape') done(); };
  const btn = (txt: string, title: string, fn: () => void, disabled = false) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = txt; b.title = title; b.disabled = disabled; b.onclick = fn; b.style.padding = '0 6px'; return b; };
  const syncMaskBtn = () => { maskBtn.textContent = l.smart?.filterMask ? 'Delete filter mask' : 'Add filter mask'; };
  maskBtn.title = 'A filter mask limits where the filters apply: paint black on it to keep parts of the object unfiltered';
  maskBtn.onclick = () => { if (l.smart?.filterMask) deleteFilterMask(doc, l); else { addFilterMask(doc, l); done(); } setTimeout(syncMaskBtn, 400); };
  const rebuild = () => {
    syncMaskBtn();
    list.replaceChildren();
    const fs = l.smart?.filters ?? [];
    if (!fs.length && !l.smart?.rawFilters?.length) { const e = document.createElement('div'); e.className = 'hint'; e.textContent = 'No smart filters yet. Filters stay editable: change or remove them any time and the layer is re-rendered from its original source.'; list.append(e); }
    fs.forEach((f, i) => {
      const row = document.createElement('div'); row.className = 'row';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = f.on; cb.onchange = async () => { await updateSmartFilter(doc, l, i, { on: cb.checked }); rebuild(); };
      const name = document.createElement('span'); name.textContent = describeFilter(f); name.style.flex = '1'; name.style.minWidth = '210px';
      row.append(cb, name,
        btn('✎', 'Edit', async () => { const p = await askParams(f, 'OK'); if (p) { await updateSmartFilter(doc, l, i, { p }); rebuild(); } }, !FILTER_INFO[f.kind].params.length),
        btn('↑', 'Move up', async () => { await moveSmartFilter(doc, l, i, -1); rebuild(); }, i === 0),
        btn('↓', 'Move down', async () => { await moveSmartFilter(doc, l, i, 1); rebuild(); }, i === fs.length - 1),
        btn('✕', 'Delete', async () => { await removeSmartFilter(doc, l, i); rebuild(); }));
      list.append(row);
    });
    if (l.smart?.rawFilters?.length) { const e = document.createElement('div'); e.className = 'hint'; e.textContent = `${l.smart.rawFilters.length} Photoshop filter(s) PixelForge can't run (${[...new Set(l.smart.rawFilters.map((x) => x.name))].join(', ')}) are kept and saved back untouched.`; list.append(e); }
  };
  add.onchange = async () => {
    const kind = add.value as FilterKind; add.value = '';
    if (!kind) return;
    const f = newFilter(kind), p = await askParams(f, 'Add');
    if (!p) return;
    f.p = { ...f.p, ...p }; await addSmartFilter(doc, l, f); rebuild();
  };
  rebuild(); panel.focus();
}

/** Layer ▸ Add Filter Mask: a white mask over the filter stack; paint black on it to keep parts of the object unfiltered. */
export function addFilterMask(doc: Doc, l: Layer) {
  if (!l.smart) return app.toast('Filter masks belong to smart objects');
  if (l.smart.filterMask) { doc.setEditFilterMask(l, true); return; }
  doc.editSmart('Add Filter Mask', l, () => { const m = makeCanvas(doc.width, doc.height), x = ctxOf(m); x.fillStyle = '#fff'; x.fillRect(0, 0, m.width, m.height); l.smart!.filterMask = m; });
  doc.setEditFilterMask(l, true);
}
export function deleteFilterMask(doc: Doc, l: Layer) {
  if (!l.smart?.filterMask) return;
  const f = linkedFor(doc, l);
  const done = (src?: HTMLCanvasElement) => doc.editSmart('Delete Filter Mask', l, () => { l.fmaskEdit = false; delete l.smart!.filterMask; if (src) draw(l, src); });
  if (f) decodeLinked(f).then(done); else done();
}
