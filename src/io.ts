import { readPsd, writePsd, type Layer as PsdLayer, type Psd } from 'ag-psd';
import { Doc, Layer, makeCanvas, ctxOf } from './doc';
import { flatten } from './render';
import { fromPsdAdjustment, toPsdAdjustment } from './psdadjust.ts';
import { fromPsdEffects, toPsdEffects } from './fx.ts';

export type ExportFormat = 'png' | 'jpeg' | 'webp' | 'bmp' | 'psd';
export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'ico', 'svg'];
export const OPEN_EXTS = ['psd', 'psb', ...IMAGE_EXTS];

const extOf = (name: string) => name.split('.').pop()?.toLowerCase() ?? '';
const baseName = (name: string) => name.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');

export interface OpenedFile { name: string; path?: string; data: ArrayBuffer }

declare global {
  interface Window {
    native?: {
      open(): Promise<{ name: string; path: string; data: Uint8Array }[]>;
      save(name: string, ext: string, data: Uint8Array): Promise<string | null>;
      onOpenPath?(cb: (f: { name: string; path: string; data: Uint8Array }) => void): void;
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
  else doc = await importRaster(file.data, name, ext);
  doc.path = file.path ?? null;
  doc.history.dirty = false;
  return doc;
}

async function importRaster(data: ArrayBuffer, name: string, ext: string): Promise<Doc> {
  const mime: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', avif: 'image/avif', ico: 'image/x-icon', svg: 'image/svg+xml' };
  let bmp: ImageBitmap;
  try { bmp = await createImageBitmap(new Blob([data], { type: mime[ext] ?? '' })); }
  catch { throw new Error(`Could not decode ".${ext}" files. Supported: PSD, PNG, JPEG, WebP, GIF, BMP, AVIF, ICO, SVG.`); }
  const doc = new Doc(bmp.width, bmp.height, name);
  const l = new Layer('Layer 0', makeCanvas(bmp.width, bmp.height));
  l.ctx.drawImage(bmp, 0, 0);
  bmp.close();
  doc.layers.push(l); doc.active = l;
  return doc;
}

function importPsd(data: ArrayBuffer, name: string): Doc {
  const psd = readPsd(data, { skipThumbnail: true, skipLayerImageData: false });
  const doc = new Doc(psd.width, psd.height, name);
  /** Expand a PSD mask rectangle to a document-sized grayscale mask (filled with the mask's default colour). */
  const importMask = (c: PsdLayer, l: Layer) => {
    if (!c.mask?.canvas) return;
    const m = makeCanvas(psd.width, psd.height), mx = ctxOf(m), dc = c.mask.defaultColor ?? 0;
    mx.fillStyle = `rgb(${dc},${dc},${dc})`; mx.fillRect(0, 0, m.width, m.height);
    const rel = c.mask.positionRelativeToLayer ? (c.left ?? 0) : 0, relY = c.mask.positionRelativeToLayer ? (c.top ?? 0) : 0;
    mx.drawImage(c.mask.canvas, (c.mask.left ?? 0) + rel, (c.mask.top ?? 0) + relY);
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
      if (c.effects) {
        const { fx, unsupported } = fromPsdEffects(c.effects, psd.imageResources?.globalAngle !== undefined ? { angle: psd.imageResources.globalAngle, altitude: psd.imageResources.globalAltitude ?? 30 } : undefined);
        if (Object.keys(fx).length) l.effects = fx;
        if (unsupported.length) doc.notes.push(`"${l.name}": ${[...new Set(unsupported)].join(', ')} not supported (skipped)`);
      }
      importMask(c, l);
      if (c.adjustment) {
        const a = fromPsdAdjustment(c.adjustment);
        if (a) {
          l.adjustment = a;
          if (!l.mask) { const m = makeCanvas(psd.width, psd.height), mx = ctxOf(m); mx.fillStyle = '#fff'; mx.fillRect(0, 0, m.width, m.height); l.mask = m; }
          l.editMask = true; l.blend = 'normal';
        } else {
          l.visible = false; l.name = `${l.name} (unsupported ${c.adjustment.type} adjustment)`;
          doc.notes.push(`"${c.name}" is a ${c.adjustment.type} adjustment layer, which PixelForge can't render yet — kept as a hidden placeholder`);
        }
      }
      if (!c.adjustment) l.blend = (c.blendMode as string) && (c.blendMode as string) !== 'pass through' ? (c.blendMode as string) : 'normal';
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
      children: doc.tree().map(function toPsd(n): PsdLayer {
        const l = n.layer;
        return {
          name: l.name, left: 0, top: 0, opacity: l.opacity, hidden: !l.visible, clipping: l.clipped,
          ...(!l.isGroup && !l.adjustment ? { fillOpacity: l.fillOpacity } : {}),
          ...(l.effects ? { effects: toPsdEffects(l.effects) } : {}),
          ...(l.isGroup ? { children: n.children.map(toPsd), opened: !l.collapsed } : l.adjustment ? { adjustment: toPsdAdjustment(l.adjustment) } : { canvas: l.canvas }),
          blendMode: l.blend as PsdLayer['blendMode'],
          mask: l.mask ? { canvas: l.mask, left: 0, top: 0, right: doc.width, bottom: doc.height, defaultColor: 0, disabled: !l.maskEnabled } : undefined,
        };
      }),
    };
    return new Uint8Array(writePsd(psd, { generateThumbnail: true }));
  }
  const flat = flatten(doc, fmt === 'jpeg' || fmt === 'bmp' ? '#ffffff' : null);
  if (fmt === 'bmp') return encodeBmp(flat);
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
  const ext = fmt === 'jpeg' ? 'jpg' : fmt;
  const filename = `${doc.name}.${ext}`;
  if (window.native) {
    const p = await window.native.save(filename, ext, data);
    if (!p) return false;
    if (fmt === 'psd') { doc.path = p; doc.history.dirty = false; }
    return true;
  }
  const mime = fmt === 'psd' ? 'image/vnd.adobe.photoshop' : `image/${fmt}`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data as BlobPart], { type: mime }));
  a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  if (fmt === 'psd') doc.history.dirty = false;
  return true;
}
