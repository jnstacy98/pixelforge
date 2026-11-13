import { fingerprint } from './smartmath';
import { fromPsdFilters, toPsdFilters } from './smartfilters';
import { decodeTiff, encodeTiff } from './tiff';
import { getPattern, hasPattern, registerPattern } from './patterns';
import { fromPsdRanges, isBlendIfActive, toPsdRanges } from './blendif';
import { readPsd, writePsd, type Layer as PsdLayer, type Psd } from 'ag-psd';
import { Doc, Layer, makeCanvas, ctxOf } from './doc';
import { flatten } from './render';
import { fromPsdAdjustment, toPsdAdjustment } from './psdadjust.ts';
import { fromPsdEffects, toPsdEffects } from './fx.ts';

export type ExportFormat = 'png' | 'jpeg' | 'webp' | 'bmp' | 'tiff' | 'psd';
export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'ico', 'svg', 'tif', 'tiff'];
export const OPEN_EXTS = ['psd', 'psb', ...IMAGE_EXTS];

const extOf = (name: string) => name.split('.').pop()?.toLowerCase() ?? '';
const baseName = (name: string) => name.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');

export type UpdateStatus =
  | { state: 'checking' | 'current' | 'busy' }
  | { state: 'available'; version: string; notes?: string }
  | { state: 'downloading'; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'unsupported'; portable?: boolean; packaged?: boolean }
  | { state: 'error'; message: string };

export interface OpenedFile { name: string; path?: string; data: ArrayBuffer }

declare global {
  interface Window {
    native?: {
      open(): Promise<{ name: string; path: string; data: Uint8Array }[]>;
      save(name: string, ext: string, data: Uint8Array): Promise<string | null>;
      onOpenPath?(cb: (f: { name: string; path: string; data: Uint8Array }) => void): void;
      info?(): Promise<{ version: string; canSelfUpdate: boolean; portable: boolean; packaged: boolean; electron: string; platform: string; arch: string }>;
      checkForUpdates?(): Promise<{ state: string }>;
      downloadUpdate?(): Promise<void>;
      installUpdate?(): Promise<void>;
      openExternal?(url: string): Promise<void>;
      quit?(): Promise<void>;
      onUpdateStatus?(cb: (s: UpdateStatus) => void): void;
    };
  }
}

const toAB = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

export async function pickFiles(): Promise<OpenedFile[]> {
  if (window.native) return (await window.native.open()).map((f) => ({ name: f.name, path: f.path, data: toAB(f.data) }));
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.multiple = true;
    inp.accept = OPEN_EXTS.map((e) => '.' + e).join(',');
    inp.onchange = async () => resolve(await Promise.all([...(inp.files ?? [])].map(async (f) => ({ name: f.name, data: await f.arrayBuffer() }))));
    inp.oncancel = () => resolve([]);
    inp.click();
  });
}

// ------------------------------------------------------------------ import
export async function importFile(file: OpenedFile): Promise<Doc> {
  const ext = extOf(file.name);
  const name = baseName(file.name);
  let doc: Doc;
  if (ext === 'psd' || ext === 'psb') doc = importPsd(file.data, name);
  else if (ext === 'tif' || ext === 'tiff') doc = importTiff(file.data, name);
  else doc = await importRaster(file.data, name, ext);
  doc.path = file.path ?? null;
  doc.history.dirty = false;
  return doc;
}

/** TIFF: every full-resolution page becomes a layer (the first one visible); the canvas is as big as the largest page. */
function importTiff(data: ArrayBuffer, name: string): Doc {
  let pages;
  try { pages = decodeTiff(data); }
  catch (e) { throw new Error(`Could not read this TIFF (${(e as Error).message}). 8/16-bit RGB, gray, palette and CMYK files with LZW, PackBits or Deflate compression are supported.`); }
  const W = Math.max(...pages.map((p) => p.w)), H = Math.max(...pages.map((p) => p.h));
  const doc = new Doc(W, H, name);
  pages.forEach((p, i) => {
    const l = new Layer(pages.length > 1 ? `Page ${i + 1}` : 'Layer 0', makeCanvas(W, H));
    l.ctx.putImageData(new ImageData(p.rgba as Uint8ClampedArray<ArrayBuffer>, p.w, p.h), 0, 0);
    l.visible = i === 0;
    doc.layers.push(l);
  });
  doc.active = doc.layers[0];
  return doc;
}

async function importRaster(data: ArrayBuffer, name: string, ext: string): Promise<Doc> {
  const mime: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', avif: 'image/avif', ico: 'image/x-icon', svg: 'image/svg+xml' };
  let bmp: ImageBitmap;
  try { bmp = await createImageBitmap(new Blob([data], { type: mime[ext] ?? '' })); }
  catch { throw new Error(`Could not decode ".${ext}" files. Supported: PSD, PNG, JPEG, WebP, GIF, BMP, TIFF, AVIF, ICO, SVG.`); }
  const doc = new Doc(bmp.width, bmp.height, name);
  const l = new Layer('Layer 0', makeCanvas(bmp.width, bmp.height));
  l.ctx.drawImage(bmp, 0, 0);
  bmp.close();
  doc.layers.push(l); doc.active = l;
  return doc;
}

function importPsd(data: ArrayBuffer, name: string): Doc {
  const psd = readPsd(data, { skipThumbnail: true, skipLayerImageData: false });
  for (const p of psd.patterns ?? []) {                          // pattern tiles used by Pattern Overlay
    const { w, h } = p.bounds;
    if (p.id && w > 0 && h > 0 && p.data.length === w * h * 4) registerPattern({ id: p.id, name: p.name || 'Pattern', w, h, data: new Uint8ClampedArray(p.data) });
  }
  const doc = new Doc(psd.width, psd.height, name);
  for (const f of psd.linkedFiles ?? []) if (f.data && f.id) doc.linked.push({ id: f.id, name: f.name || 'Linked file', type: f.type, data: f.data.slice() });
  /** Expand a PSD mask rectangle to a document-sized grayscale mask (filled with the mask's default colour). */
  const importMask = (c: PsdLayer, l: Layer) => {
    if (!c.mask || (!c.mask.canvas && c.mask.defaultColor === undefined)) return;
    const m = makeCanvas(psd.width, psd.height), mx = ctxOf(m), dc = c.mask.defaultColor ?? 0;
    mx.fillStyle = `rgb(${dc},${dc},${dc})`; mx.fillRect(0, 0, m.width, m.height);
    const rel = c.mask.positionRelativeToLayer ? (c.left ?? 0) : 0, relY = c.mask.positionRelativeToLayer ? (c.top ?? 0) : 0;
    if (c.mask.canvas) mx.drawImage(c.mask.canvas, (c.mask.left ?? 0) + rel, (c.mask.top ?? 0) + relY);   // (a uniform mask is stored as just its default colour)
    l.mask = m; l.maskEnabled = !c.mask.disabled;
  };
  const walk = (children: PsdLayer[], parent: Layer | null) => {
    for (const c of children) {
      if (c.children) {
        // A group: its contents go first, then the group entry itself (groups follow their children in the stack).
        const g = Layer.group(c.name || 'Group');
        g.parent = parent; g.visible = !c.hidden; g.opacity = c.opacity ?? 1; g.collapsed = c.opened === false; g.clipped = !!c.clipping;
        const bm = c.blendMode as string | undefined;
        g.blend = !bm || bm === 'pass through' ? 'pass through' : bm;
        importMask(c, g);
        if (c.effects && Object.keys(c.effects).some((k) => k !== 'disabled' && k !== 'scale')) doc.notes.push(`group "${g.name}": layer styles on groups aren't supported`);
        walk(c.children, g);
        doc.layers.push(g);
        continue;
      }
      const canvas = makeCanvas(psd.width, psd.height);
      if (c.canvas) ctxOf(canvas).drawImage(c.canvas, c.left ?? 0, c.top ?? 0);
      const l = new Layer(c.name || 'Layer', canvas);
      l.parent = parent; l.visible = !c.hidden; l.opacity = c.opacity ?? 1; l.clipped = !!c.clipping; l.fillOpacity = c.fillOpacity ?? 1;
      l.blendIf = fromPsdRanges(c.blendingRanges);
      if (c.placedLayer && doc.linked.some((f) => f.id === c.placedLayer!.id)) {
        const placed = JSON.parse(JSON.stringify(c.placedLayer)), pf = placed.filter?.list;
        delete placed.filter;
        l.smart = { placed, print: layerPrint(l) };
        if (pf?.length) { const r = fromPsdFilters(pf); if (r.filters.length) l.smart.filters = r.filters; if (r.unsupported.length) { l.smart.rawFilters = r.unsupported; doc.notes.push(`"${l.name}": ${[...new Set(r.unsupported.map((x) => x.name))].join(', ')} smart filter(s) kept as rendered pixels but can't be edited here`); } }
      }
      if (c.effects) {
        const { fx, unsupported } = fromPsdEffects(c.effects, psd.imageResources?.globalAngle !== undefined ? { angle: psd.imageResources.globalAngle, altitude: psd.imageResources.globalAltitude ?? 30 } : undefined);
        if (Object.keys(fx).length) l.effects = fx;
        if (fx.patternOverlay && !hasPattern(fx.patternOverlay.id)) doc.notes.push(`"${l.name}": pattern "${fx.patternOverlay.name}" is not stored in the file — its Pattern Overlay is skipped`);
        if (unsupported.length) doc.notes.push(`"${l.name}": ${[...new Set(unsupported)].join(', ')} not supported (skipped)`);
      }
      importMask(c, l);
      if (c.adjustment) {
        const a = fromPsdAdjustment(c.adjustment);
        if (a) {
          l.adjustment = a;
          if (!l.mask) { const m = makeCanvas(psd.width, psd.height), mx = ctxOf(m); mx.fillStyle = '#fff'; mx.fillRect(0, 0, m.width, m.height); l.mask = m; }
          l.editMask = true;
        } else {
          l.visible = false; l.name = `${l.name} (unsupported ${c.adjustment.type} adjustment)`;
          doc.notes.push(`"${c.name}" is a ${c.adjustment.type} adjustment layer, which PixelForge can't render yet — kept as a hidden placeholder`);
        }
      }
      l.blend = (c.blendMode as string) && (c.blendMode as string) !== 'pass through' ? (c.blendMode as string) : 'normal';
      doc.layers.push(l);
    }
  };
  if (psd.children?.length) walk(psd.children, null);
  if (!doc.layers.some((l) => !l.isGroup)) {
    const l = new Layer('Background', makeCanvas(psd.width, psd.height));
    if (psd.canvas) l.ctx.drawImage(psd.canvas, 0, 0);
    doc.layers.unshift(l);
  }
  doc.active = [...doc.layers].reverse().find((l) => !l.isGroup)!;
  return doc;
}

// ------------------------------------------------------------------ export
export async function encode(doc: Doc, fmt: ExportFormat, quality = 0.92): Promise<Uint8Array> {
  if (fmt === 'psd') {
    const psd: Psd = {
      width: doc.width, height: doc.height,
      canvas: flatten(doc),
      ...(usedPatterns(doc).length ? { patterns: usedPatterns(doc) } : {}),
      ...(usedLinked(doc).length ? { linkedFiles: usedLinked(doc) } : {}),
      children: doc.tree().map(function toPsd(n): PsdLayer {
        const l = n.layer;
        return {
          name: l.name, left: 0, top: 0, opacity: l.opacity, hidden: !l.visible, clipping: l.clipped,
          ...(!l.isGroup && !l.adjustment ? { fillOpacity: l.fillOpacity } : {}),
          ...(l.effects ? { effects: toPsdEffects(l.effects) } : {}),
          ...(!l.isGroup && smartIntact(doc, l) ? { placedLayer: placedFor(l) } : {}),
          ...(isBlendIfActive(l.blendIf) ? { blendingRanges: toPsdRanges(l.blendIf) } : {}),
          ...(l.isGroup ? { children: n.children.map(toPsd), opened: !l.collapsed } : l.adjustment ? { adjustment: toPsdAdjustment(l.adjustment) } : { canvas: l.canvas }),
          blendMode: l.blend as PsdLayer['blendMode'],
          mask: l.mask ? { ...packMask(l.mask), disabled: !l.maskEnabled } : undefined,
        };
      }),
    };
    return new Uint8Array(writePsd(psd, { generateThumbnail: true, trimImageData: true }));
  }
  const flat = flatten(doc, fmt === 'jpeg' || fmt === 'bmp' ? '#ffffff' : null);
  if (fmt === 'bmp') return encodeBmp(flat);
  if (fmt === 'tiff') return encodeTiff(ctxOf(flat).getImageData(0, 0, flat.width, flat.height).data, flat.width, flat.height);
  const mime = fmt === 'jpeg' ? 'image/jpeg' : fmt === 'webp' ? 'image/webp' : 'image/png';
  const blob = await new Promise<Blob | null>((r) => flat.toBlob(r, mime, quality));
  if (!blob) throw new Error('Encoding failed');
  return new Uint8Array(await blob.arrayBuffer());
}

function encodeBmp(c: HTMLCanvasElement): Uint8Array {
  const { width: w, height: h } = c;
  const px = ctxOf(c).getImageData(0, 0, w, h).data;
  const row = Math.ceil((w * 3) / 4) * 4, size = 54 + row * h;
  const out = new Uint8Array(size), dv = new DataView(out.buffer);
  out[0] = 0x42; out[1] = 0x4d; dv.setUint32(2, size, true); dv.setUint32(10, 54, true);
  dv.setUint32(14, 40, true); dv.setInt32(18, w, true); dv.setInt32(22, h, true);
  dv.setUint16(26, 1, true); dv.setUint16(28, 24, true); dv.setUint32(34, row * h, true);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = ((h - 1 - y) * w + x) * 4, d = 54 + y * row + x * 3;
    out[d] = px[s + 2]; out[d + 1] = px[s + 1]; out[d + 2] = px[s];
  }
  return out;
}

export async function saveAs(doc: Doc, fmt: ExportFormat, quality?: number): Promise<boolean> {
  const data = await encode(doc, fmt, quality);
  const ext = fmt === 'jpeg' ? 'jpg' : fmt === 'tiff' ? 'tif' : fmt;
  const filename = `${doc.name}.${ext}`;
  if (window.native) {
    const p = await window.native.save(filename, ext, data);
    if (!p) return false;
    if (fmt === 'psd') { doc.path = p; doc.history.dirty = false; }
    return true;
  }
  const mime = fmt === 'psd' ? 'image/vnd.adobe.photoshop' : fmt === 'tiff' ? 'image/tiff' : `image/${fmt}`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data as BlobPart], { type: mime }));
  a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  if (fmt === 'psd') doc.history.dirty = false;
  return true;
}

/** Pattern tiles referenced by the document's Pattern Overlays, in PSD form. */
function usedPatterns(doc: Doc) {
  const ids = new Set<string>();
  for (const l of doc.layers) if (l.effects?.patternOverlay) ids.add(l.effects.patternOverlay.id);
  return [...ids].flatMap((id) => {
    const t = getPattern(id);
    return t ? [{ name: t.name, id: t.id, x: 0, y: 0, bounds: { x: 0, y: 0, w: t.w, h: t.h }, data: new Uint8Array(t.data) }] : [];
  });
}

const layerPrint = (l: Layer) => fingerprint(l.ctx.getImageData(0, 0, l.canvas.width, l.canvas.height).data, l.canvas.width, l.canvas.height);
/** A smart object whose pixels were painted on after it was rendered is no longer a smart object. */
export function smartIntact(doc: Doc, l: Layer) { return !!l.smart && doc.linked.some((f) => f.id === l.smart!.placed.id) && layerPrint(l) === l.smart.print; }
function usedLinked(doc: Doc) {
  const ids = new Set(doc.layers.filter((l) => !l.isGroup && smartIntact(doc, l)).map((l) => l.smart!.placed.id));
  return doc.linked.filter((f) => ids.has(f.id)).map((f) => ({ id: f.id, name: f.name, type: f.type, data: f.data }));
}

/** The layer's placed-layer record with its smart filters written back in Photoshop's form. */
function placedFor(l: Layer) {
  const s = l.smart!, list = [...toPsdFilters(s.filters ?? []), ...(s.rawFilters ?? [])];
  return list.length ? { ...s.placed, filter: { enabled: true, validAtPosition: true, maskEnabled: true, maskLinked: true, maskExtendWithWhite: false, list } } : s.placed;
}

/**
 * A layer mask in PSD form without storing needless pixels: a uniform mask (the usual all-white adjustment-layer mask) is just
 * its default colour; otherwise only the part that differs from the border colour is written.
 */
export function packMask(m: HTMLCanvasElement) {
  const W = m.width, H = m.height, d = ctxOf(m).getImageData(0, 0, W, H).data, def = d[0];
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0, i = y * W * 4; x < W; x++, i += 4) if (d[i] !== def) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return { top: 0, left: 0, bottom: 0, right: 0, defaultColor: def };
  if (x0 === 0 && y0 === 0 && x1 === W - 1 && y1 === H - 1) return { canvas: m, left: 0, top: 0, right: W, bottom: H, defaultColor: def };
  const c = makeCanvas(x1 - x0 + 1, y1 - y0 + 1);
  ctxOf(c).drawImage(m, -x0, -y0);
  return { canvas: c, left: x0, top: y0, right: x1 + 1, bottom: y1 + 1, defaultColor: def };
}
