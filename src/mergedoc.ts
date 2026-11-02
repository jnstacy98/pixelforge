// Import layers from another file into the open document ("merge documents"): the file's layers (groups, masks, styles,
// text, shapes, smart objects, adjustment layers…) are placed above the active layer, positioned on the canvas, as one undoable step.
import { app } from './state';
import { Layer, ctxOf, makeCanvas, type Doc } from './doc';
import { fingerprint, newLinkId, type LinkedFile } from './smartmath';
import { translateShape } from './shapemath';
import { flatten } from './render';
import { importFile, pickFiles, type OpenedFile } from './io';
import { formDialog } from './dialog';

export interface MergeOpts { place: 'center' | 'topleft'; group: boolean; flatten: boolean }
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Move `src`'s layers onto a canvas of `target`'s size (offset by dx, dy) and reconcile its embedded smart-object files. */
export function prepareImport(target: Doc, src: Doc, name: string, o: MergeOpts): { layers: Layer[]; linked: LinkedFile[] } {
  const W = target.width, H = target.height;
  const dx = o.place === 'center' ? Math.round((W - src.width) / 2) : 0, dy = o.place === 'center' ? Math.round((H - src.height) / 2) : 0;
  let layers: Layer[];
  if (o.flatten) {
    const c = makeCanvas(W, H);
    ctxOf(c).drawImage(flatten(src, null), dx, dy);
    layers = [new Layer(name, c)];
  } else {
    layers = src.layers;
    const moved = (c: HTMLCanvasElement, fill: boolean) => {
      const n = makeCanvas(W, H), x = ctxOf(n);
      if (fill) { const e = ctxOf(c).getImageData(0, 0, 1, 1).data; x.fillStyle = `rgb(${e[0]},${e[1]},${e[2]})`; x.fillRect(0, 0, W, H); }   // a mask continues with its border colour
      x.drawImage(c, dx, dy);
      return n;
    };
    for (const l of layers) {
      if (!l.isGroup) l.canvas = l.adjustment ? makeCanvas(W, H) : moved(l.canvas, false);
      if (l.mask) l.mask = moved(l.mask, true);
      if (l.text) l.text = { ...l.text, x: l.text.x + dx, y: l.text.y + dy };
      if (l.shape) l.shape = translateShape(l.shape, dx, dy);
      if (l.smart) {
        const t = l.smart.placed.transform;
        l.smart.placed = { ...l.smart.placed, transform: t.map((v, i) => v + (i % 2 ? dy : dx)) };
        if (l.smart.filterMask) l.smart.filterMask = moved(l.smart.filterMask, true);
        l.smart.print = fingerprint(ctxOf(l.canvas).getImageData(0, 0, W, H).data, W, H);
      }
      l.touchMask();
    }
    if (layers.length === 1 && !layers[0].isGroup && /^(background|layer 0)$/i.test(layers[0].name)) layers[0].name = name;   // a picture file: name the layer after it
  }
  // embedded files of smart objects: reuse identical ones, give clashing ids a fresh GUID
  const linked: LinkedFile[] = [];
  for (const f of src.linked) {
    const users = layers.filter((l) => l.smart?.placed.id === f.id);
    if (!users.length) continue;
    const have = target.linked.find((q) => q.id === f.id);
    if (!have) linked.push(f);
    else if (!sameBytes(have.data, f.data)) { const id = newLinkId(); for (const l of users) l.smart!.placed = { ...l.smart!.placed, id }; linked.push({ ...f, id }); }
  }
  const roots = layers.filter((l) => !l.parent || !layers.includes(l.parent));
  if (o.group && !o.flatten) {
    const g = Layer.group(name);
    for (const r of roots) r.parent = g;
    layers = [...layers, g];
  }
  return { layers, linked };
}

/** Import `src` into `doc` (undoable). Returns the layers that were added. */
export function mergeDocument(doc: Doc, src: Doc, name: string, o: MergeOpts): Layer[] {
  const { layers, linked } = prepareImport(doc, src, name, o);
  doc.insertLayers(layers, linked, 'Import Layers');
  return layers;
}

/** File ▸ Import Layers from File… (or Shift+drop files onto the window). */
export async function importLayersFromFile(files?: OpenedFile[]) {
  const picked = files ?? await pickFiles();
  if (!picked.length) return;
  const doc = app.doc;
  for (const f of picked) {
    let src: Doc;
    try { src = await importFile(f); } catch (e) { app.toast(`Could not open ${f.name}: ${(e as Error).message}`); continue; }
    const many = src.layers.length > 1;
    const v = await formDialog(`Import layers — ${f.name}`, [
      { key: 'place', label: `Position (file is ${src.width}×${src.height}, canvas ${doc.width}×${doc.height})`, type: 'select', value: 'center', options: [['center', 'Centered'], ['topleft', 'Top-left corner']] },
      ...(many ? [{ key: 'flatten', label: `${src.layers.filter((l) => !l.isGroup).length} layers`, type: 'select' as const, value: 'layers', options: [['layers', 'Keep the layers'], ['flat', 'One flattened layer']] as [string, string][] }] : []),
      ...(many ? [{ key: 'group', label: 'Put them in a new group', type: 'checkbox' as const, value: true }] : []),
    ], 'Import');
    if (!v) continue;
    const name = f.name.replace(/\.[^.]+$/, '');
    mergeDocument(doc, src, name, { place: v.place, flatten: v.flatten === 'flat', group: !!v.group });
    if (src.notes.length) app.toast(src.notes.join(' · '));
  }
}
