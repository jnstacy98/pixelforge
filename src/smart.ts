// Smart objects: keep Photoshop's embedded source files, let you edit their contents, re-render them through the placed
// transform, scale / rotate them without losing quality, convert a layer into one, or rasterize it.
import { app } from './state';
import { ctxOf, makeCanvas, type Doc, type Layer } from './doc';
import { affineFromQuad, fingerprint, newLinkId, quadAt, quadInfo, resizeSource, scaleQuad, type LinkedFile, type Quad, type SmartInfo } from './smartmath';
import { flatten } from './render';
import { importFile, encode } from './io';
import { formDialog } from './dialog';

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
function draw(l: Layer, src: HTMLCanvasElement) {
  const p = l.smart!.placed, w = p.width || src.width, h = p.height || src.height;
  const c = l.ctx;
  c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, l.canvas.width, l.canvas.height);
  c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
  const [a, b, cc, d, e, f] = affineFromQuad(p.transform as Quad, w, h);
  c.setTransform(a, b, cc, d, e, f);
  c.drawImage(src, 0, 0, src.width, src.height, 0, 0, w, h);
  c.restore();
  l.smart!.print = printOf(l);
  l.touchMask();
}

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
