import { app } from './state';
import { cloneCanvas, clampRect, ctxOf, makeCanvas, pushPixelEdit, type Doc, type Rect } from './doc';
import type { Pt, Tool } from './tools';
import { LassoTool } from './selecttools';
import { currentMask } from './selection';
import { healPatch } from './heal';
import { sampleSnapshot } from './sampling';

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
  private lasso = new LassoTool();
  private state: 'idle' | 'draw' | 'drag' = 'idle';
  private start: Pt | null = null;
  private snap!: HTMLCanvasElement;
  private mask!: HTMLCanvasElement;
  private origWasRect = false;
  private preview: HTMLCanvasElement | null = null;
  private delta = { x: 0, y: 0 };

  down(p: Pt, e: PointerEvent) {
    const doc = app.doc;
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
  private renderPreview(dx: number, dy: number) {
    const doc = app.doc, dest = app.patch.mode === 'dest';
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

  private commit(dx: number, dy: number) {
    const doc = app.doc, layer = doc.active, dest = app.patch.mode === 'dest', W = layer.target.width, H = layer.target.height;
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
