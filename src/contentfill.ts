import { app } from './state';
import { cloneCanvas, ctxOf, makeCanvas, pushPixelEdit } from './doc';
import { composite } from './render';
import { expandMask, inpaint } from './inpaint';
import { formDialog } from './dialog';

let running = false;
/** True while a fill is in progress (the overlay blocks the canvas; shortcuts are suspended). */
export const isFilling = () => running;

export interface FillOptions { expand: number; sample: 'layer' | 'all'; quality: 'fast' | 'normal' | 'high'; tune?: { holeWeight?: [number, number]; offsetPenalty?: number; seed?: number } }

/** Edit ▸ Content-Aware Fill: fill the selection with image content synthesised from the rest of the layer. */
export async function contentAwareFill(opts?: FillOptions): Promise<boolean> {
  const doc = app.doc;
  if (running) return false;
  if (!doc.selection) { app.toast('Make a selection first (marquee, lasso or wand), then choose Content-Aware Fill'); return false; }
  if (!doc.requirePaintable()) return false;
  const layer = doc.active;
  const o: FillOptions | null = opts ?? ((v) => (v ? { expand: v.expand, sample: v.sample, quality: v.quality } : null))(await formDialog('Content-Aware Fill', [
    { key: 'expand', label: 'Expand selection (px)', type: 'number', value: 3, min: 0, max: 40 },
    { key: 'sample', label: 'Sample from', type: 'select', value: 'layer', options: [['layer', 'Current layer'], ['all', 'All visible layers']] },
    { key: 'quality', label: 'Quality', type: 'select', value: 'normal', options: [['fast', 'Fast'], ['normal', 'Normal'], ['high', 'High (slower)']] },
  ], 'Fill'));
  if (!o) return false;

  running = true;
  const t0 = performance.now();
  const overlay = document.createElement('div');
  overlay.className = 'caf-overlay';
  const bar = document.createElement('div'); bar.className = 'caf-bar'; const fillBar = document.createElement('div'); bar.append(fillBar);
  const label = document.createElement('div'); label.textContent = 'Content-Aware Fill…';
  let cancelled = false;
  const cancel = document.createElement('button'); cancel.textContent = 'Cancel'; cancel.onclick = () => { cancelled = true; label.textContent = 'Cancelling…'; };
  overlay.append(label, bar, cancel);
  document.body.append(overlay);
  await new Promise((r) => setTimeout(r, 30));            // let the overlay paint before the heavy work starts

  try {
    const target = layer.target, W = target.width, H = target.height, sel = doc.selection;
    // Work on a crop: the selection plus enough surrounding context to find matching patches (capped for speed).
    const grow = Math.ceil(o.expand);
    let margin = Math.min(240, Math.max(48, Math.round(1.5 * Math.max(sel.w, sel.h))));
    const roiFor = (m: number) => { const x0 = Math.max(0, Math.floor(sel.x - grow - m)), y0 = Math.max(0, Math.floor(sel.y - grow - m)), x1 = Math.min(W, Math.ceil(sel.x + sel.w + grow + m)), y1 = Math.min(H, Math.ceil(sel.y + sel.h + grow + m)); return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }; };
    let roi = roiFor(margin);
    while (roi.w * roi.h > 700_000 && margin > 24) { margin -= 16; roi = roiFor(margin); }
    const { x: rx, y: ry, w: rw, h: rh } = roi;

    let source: HTMLCanvasElement = target;
    if (o.sample === 'all' && !layer.maskMode) { source = makeCanvas(doc.width, doc.height); composite(doc, ctxOf(source)); }
    const rgba = ctxOf(source).getImageData(rx, ry, rw, rh).data;

    const hole = new Uint8Array(rw * rh);
    if (doc.selMask) { const m = ctxOf(doc.selMask).getImageData(rx, ry, rw, rh).data; for (let p = 0; p < hole.length; p++) hole[p] = m[p * 4 + 3] > 127 ? 1 : 0; }
    else for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) { const gx = x + rx, gy = y + ry; if (gx >= sel.x && gx < sel.x + sel.w && gy >= sel.y && gy < sel.y + sel.h) hole[y * rw + x] = 1; }
    const big = expandMask(hole, rw, rh, o.expand);

    const out = await inpaint(new Uint8ClampedArray(rgba), rw, rh, big, {
      quality: o.quality, ...o.tune,
      onProgress: (f) => { fillBar.style.width = `${Math.round(f * 100)}%`; },
      shouldCancel: () => cancelled,
    });

    // Replace only the hole pixels on the layer with the synthesised ones.
    const before = cloneCanvas(target);
    const fill = new ImageData(rw, rh), cut = new ImageData(rw, rh);
    for (let p = 0; p < big.length; p++) if (big[p]) { for (let c = 0; c < 4; c++) fill.data[p * 4 + c] = out[p * 4 + c]; cut.data[p * 4 + 3] = 255; }
    const fillC = makeCanvas(rw, rh), cutC = makeCanvas(rw, rh);
    ctxOf(fillC).putImageData(fill, 0, 0); ctxOf(cutC).putImageData(cut, 0, 0);
    const ctx = layer.tctx;
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out'; ctx.drawImage(cutC, rx, ry);
    ctx.globalCompositeOperation = 'source-over'; ctx.drawImage(fillC, rx, ry);
    ctx.restore();
    pushPixelEdit(doc, layer, before, roi, 'Content-Aware Fill');
    app.toast(`Content-Aware Fill finished in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    return true;
  } catch (e) {
    app.toast((e as Error).message === 'cancelled' ? 'Content-Aware Fill cancelled' : `Content-Aware Fill failed: ${(e as Error).message}`);
    return false;
  } finally {
    overlay.remove();
    running = false;
  }
}
