import { app } from './state';
import { cloneCanvas, clampRect, ctxOf, makeCanvas, pushPixelEdit, type Doc, type Rect } from './doc';
import type { Pt, Tool } from './tools';
import { LassoTool } from './selecttools';
import { currentMask } from './selection';
import { healPatch } from './heal';
import { sampleSnapshot } from './sampling';
import { expandMask, inpaint } from './inpaint';
import { isFilling, withFillOverlay } from './contentfill';

const insideSelection = (doc: Doc, p: Pt) => {
  const s = doc.selection;
  if (!s) return false;
  const x = Math.floor(p.x), y = Math.floor(p.y);
  if (x < s.x || y < s.y || x >= s.x + s.w || y >= s.y + s.h) return false;
  return doc.selMask ? ctxOf(doc.selMask).getImageData(x, y, 1, 1).data[3] > 127 : true;
};

/**
 * Patch tool. Draw a freehand selection around the area, then drag it:
 *  • Source — the selected area is repaired with the texture of the area you drag the outline onto;
 *  • Destination — the selected area's content is copied to where you drop it.
 * While dragging you see a plain preview; on release the patch is blended in (tone and lighting matched to its
 * surroundings, exactly like the Healing Brush) unless "Match tone & texture" is off.
 */
export class PatchTool implements Tool {
  cursor = 'crosshair';
  protected lasso = new LassoTool();
  protected state: 'idle' | 'draw' | 'drag' = 'idle';
  protected start: Pt | null = null;
  protected snap!: HTMLCanvasElement;
  protected mask!: HTMLCanvasElement;
  protected origWasRect = false;
  protected preview: HTMLCanvasElement | null = null;
  protected delta = { x: 0, y: 0 };

  protected destMode() { return app.patch.mode === 'dest'; }

  down(p: Pt, e: PointerEvent) {
    const doc = app.doc;
    if (isFilling()) return;
    if (!insideSelection(doc, p)) { this.state = 'draw'; this.lasso.down(p, e); return; }   // outside the selection: draw a new one
    if (!doc.requirePaintable()) return;
    this.state = 'drag'; this.start = p; this.delta = { x: 0, y: 0 };
    this.snap = sampleSnapshot();
    this.origWasRect = !doc.selMask;
    this.mask = currentMask(doc)!;
    doc.selMask = this.mask;                // lets the outline follow the drag (it is drawn from the mask)
    doc.selShift = { dx: 0, dy: 0 };
    doc.emit('selection');
  }

  move(p: Pt) {
    if (this.state === 'draw') return this.lasso.move(p);
    if (this.state !== 'drag' || !this.start) return;
    const dx = Math.round(p.x - this.start.x), dy = Math.round(p.y - this.start.y), doc = app.doc;
    this.delta = { x: dx, y: dy };
    doc.selShift = { dx, dy };
    this.renderPreview(dx, dy);
    doc.emit('pixels');
  }

  /** What will be pasted, as a live (unblended) preview. */
  protected renderPreview(dx: number, dy: number) {
    const doc = app.doc, dest = this.destMode();
    if (!this.preview || this.preview.width !== doc.width || this.preview.height !== doc.height) this.preview = makeCanvas(doc.width, doc.height);
    const x = ctxOf(this.preview);
    x.globalCompositeOperation = 'source-over'; x.globalAlpha = 1;
    x.clearRect(0, 0, doc.width, doc.height);
    x.drawImage(this.snap, dest ? dx : -dx, dest ? dy : -dy);          // pixel p shows snap(p + offset)
    x.globalCompositeOperation = 'destination-in';
    x.drawImage(this.mask, dest ? dx : 0, dest ? dy : 0);              // only inside the target area
    x.globalCompositeOperation = 'source-over';
    doc.stroke = { layer: doc.active, canvas: this.preview, opacity: 1, erase: false, onMask: doc.active.maskMode, unclipped: true };
  }

  up() {
    if (this.state === 'draw') { this.state = 'idle'; return this.lasso.up(); }
    if (this.state !== 'drag') return;
    this.state = 'idle';
    const doc = app.doc, { x: dx, y: dy } = this.delta;
    doc.stroke = null; doc.selShift = null;
    const restore = () => { doc.selMask = this.origWasRect ? null : this.mask; };
    if (!dx && !dy) { restore(); doc.emit('structure'); return; }
    restore();
    this.commit(dx, dy);
  }

  protected commit(dx: number, dy: number) {
    const doc = app.doc, layer = doc.active, dest = this.destMode(), W = layer.target.width, H = layer.target.height;
    const sh = dest ? { x: dx, y: dy } : { x: 0, y: 0 };          // where the repaired/pasted area is
    const off = dest ? { x: -dx, y: -dy } : { x: dx, y: dy };     // a pixel p there reads the sample at p + off
    const sel = doc.selection!;
    const target: Rect = { x: sel.x + sh.x, y: sel.y + sh.y, w: sel.w, h: sel.h };
    const pad = 10, g = clampRect({ x: target.x - pad, y: target.y - pad, w: target.w + 2 * pad, h: target.h + 2 * pad }, W, H);
    if (!g) return;
    const covC = makeCanvas(W, H);
    ctxOf(covC).drawImage(this.mask, sh.x, sh.y);
    const cov = ctxOf(covC).getImageData(g.x, g.y, g.w, g.h).data;
    const snapCtx = ctxOf(this.snap);
    const dst = snapCtx.getImageData(g.x, g.y, g.w, g.h).data;
    const src = snapCtx.getImageData(g.x + off.x, g.y + off.y, g.w, g.h).data;     // outside the image reads as transparent
    let out: Uint8ClampedArray;
    if (app.patch.blend) out = healPatch(dst, src, cov, g.w, g.h);
    else { out = new Uint8ClampedArray(g.w * g.h * 4); for (let p = 0; p < g.w * g.h; p++) { const i = p * 4; if (cov[i + 3] > 5) { out[i] = src[i]; out[i + 1] = src[i + 1]; out[i + 2] = src[i + 2]; out[i + 3] = Math.round((cov[i + 3] * src[i + 3]) / 255); } } }
    const before = cloneCanvas(layer.target);
    const img = new ImageData(g.w, g.h);
    img.data.set(out);
    const tmp = makeCanvas(g.w, g.h);
    ctxOf(tmp).putImageData(img, 0, 0);
    layer.tctx.drawImage(tmp, g.x, g.y);
    pushPixelEdit(doc, layer, before, g, 'Patch');
    if (dest) {                                                     // the selection travels with the pasted area, as one undo step
      const nm = makeCanvas(W, H);
      ctxOf(nm).drawImage(this.mask, dx, dy);
      const nb = clampRect({ x: sel.x + dx, y: sel.y + dy, w: sel.w, h: sel.h }, W, H);
      doc.setSelection(nb, nb ? (this.origWasRect ? null : nm) : null);
      doc.history.merge('Patch');
    }
  }

  overlay(ctx: CanvasRenderingContext2D, ts: (x: number, y: number) => [number, number]) {
    if (this.state === 'draw') this.lasso.overlay?.(ctx, ts);
  }
}

/**
 * Content-Aware Move. Draw around an object and drag it somewhere else:
 *  • Move — the object lands at the new spot (blended into its surroundings) and the hole it leaves is filled with
 *    Content-Aware Fill;
 *  • Extend — the object is copied to the new spot and the original stays (use it to extend or repeat things).
 */
export class ContentMoveTool extends PatchTool {
  protected destMode() { return true; }

  protected commit(dx: number, dy: number) { void this.commitAsync(dx, dy); }

  private async commitAsync(dx: number, dy: number) {
    const doc = app.doc, layer = doc.active, W = layer.target.width, H = layer.target.height, sel = doc.selection!, move = app.cmove.mode === 'move';
    const snapCtx = ctxOf(this.snap);
    const before = cloneCanvas(layer.target);
    const touched: Rect[] = [];
    let bg: HTMLCanvasElement = this.snap, cut: HTMLCanvasElement | null = null, fill: HTMLCanvasElement | null = null, roi: Rect | null = null;
    try {
      if (move) {
        const grow = 3;
        let margin = Math.min(240, Math.max(48, Math.round(1.5 * Math.max(sel.w, sel.h))));
        const roiFor = (m: number) => clampRect({ x: sel.x - grow - m, y: sel.y - grow - m, w: sel.w + 2 * (grow + m), h: sel.h + 2 * (grow + m) }, W, H)!;
        roi = roiFor(margin);
        while (roi.w * roi.h > 500_000 && margin > 24) { margin -= 16; roi = roiFor(margin); }
        const { x: rx, y: ry, w: rw, h: rh } = roi;
        const rgba = snapCtx.getImageData(rx, ry, rw, rh).data;
        const m = ctxOf(this.mask).getImageData(rx, ry, rw, rh).data, hole = new Uint8Array(rw * rh);
        for (let q = 0; q < hole.length; q++) hole[q] = m[q * 4 + 3] > 127 ? 1 : 0;
        const big = expandMask(hole, rw, rh, grow);
        const out = await withFillOverlay('Content-Aware Move…', (progress, cancelled) =>
          inpaint(new Uint8ClampedArray(rgba), rw, rh, big, { quality: 'fast', onProgress: progress, shouldCancel: cancelled }));
        const f = new ImageData(rw, rh), c = new ImageData(rw, rh);
        for (let q = 0; q < big.length; q++) if (big[q]) { for (let k = 0; k < 4; k++) f.data[q * 4 + k] = out[q * 4 + k]; c.data[q * 4 + 3] = 255; }
        fill = makeCanvas(rw, rh); cut = makeCanvas(rw, rh);
        ctxOf(fill).putImageData(f, 0, 0); ctxOf(cut).putImageData(c, 0, 0);
        bg = cloneCanvas(this.snap);
        const bx = ctxOf(bg);
        bx.globalCompositeOperation = 'destination-out'; bx.drawImage(cut, rx, ry);
        bx.globalCompositeOperation = 'source-over'; bx.drawImage(fill, rx, ry);
        touched.push(roi);
      }
    } catch (e) {
      app.toast((e as Error).message === 'cancelled' ? 'Content-Aware Move cancelled' : `Content-Aware Move failed: ${(e as Error).message}`);
      doc.emit('structure');
      return;
    }
    // paste the object at its new place, blended with the (filled) background there
    const target: Rect = { x: sel.x + dx, y: sel.y + dy, w: sel.w, h: sel.h }, pad = 10;
    const g = clampRect({ x: target.x - pad, y: target.y - pad, w: target.w + 2 * pad, h: target.h + 2 * pad }, W, H);
    let tmp: HTMLCanvasElement | null = null;
    if (g) {
      const covC = makeCanvas(W, H);
      ctxOf(covC).drawImage(this.mask, dx, dy);
      const cov = ctxOf(covC).getImageData(g.x, g.y, g.w, g.h).data;
      const dst = ctxOf(bg).getImageData(g.x, g.y, g.w, g.h).data;
      const src = snapCtx.getImageData(g.x - dx, g.y - dy, g.w, g.h).data;
      let out: Uint8ClampedArray;
      if (app.cmove.blend) out = healPatch(dst, src, cov, g.w, g.h);
      else { out = new Uint8ClampedArray(g.w * g.h * 4); for (let q = 0; q < g.w * g.h; q++) { const i = q * 4; if (cov[i + 3] > 5) { out[i] = src[i]; out[i + 1] = src[i + 1]; out[i + 2] = src[i + 2]; out[i + 3] = Math.round((cov[i + 3] * src[i + 3]) / 255); } } }
      const img = new ImageData(g.w, g.h); img.data.set(out);
      tmp = makeCanvas(g.w, g.h); ctxOf(tmp).putImageData(img, 0, 0);
      touched.push(g);
    }
    if (!touched.length) { doc.emit('structure'); return; }
    const ctx = layer.tctx;
    if (move && cut && fill && roi) {
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out'; ctx.drawImage(cut, roi.x, roi.y);
      ctx.globalCompositeOperation = 'source-over'; ctx.drawImage(fill, roi.x, roi.y);
      ctx.restore();
    }
    if (tmp && g) ctx.drawImage(tmp, g.x, g.y);
    const x0 = Math.min(...touched.map((r) => r.x)), y0 = Math.min(...touched.map((r) => r.y));
    const x1 = Math.max(...touched.map((r) => r.x + r.w)), y1 = Math.max(...touched.map((r) => r.y + r.h));
    pushPixelEdit(doc, layer, before, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, 'Content-Aware Move');
    const nm = makeCanvas(W, H);
    ctxOf(nm).drawImage(this.mask, dx, dy);
    const nb = clampRect({ x: sel.x + dx, y: sel.y + dy, w: sel.w, h: sel.h }, W, H);
    doc.setSelection(nb, nb ? (this.origWasRect ? null : nm) : null);
    doc.history.merge('Content-Aware Move');
  }
}
