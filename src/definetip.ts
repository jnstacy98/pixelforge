import { app } from './state';
import { ctxOf, makeCanvas } from './doc';
import { allTips, defineTip, tipFromPixels } from './brushtips';
import { formDialog } from './dialog';
import { renderOptions } from './ui';

/** Edit ▸ Define Brush Tip from Selection: turns the selected pixels of the active layer into a custom brush tip. */
export async function defineBrushTip() {
  const doc = app.doc, sel = doc.selection, layer = doc.active;
  if (!sel) return app.toast('Select the area to use as a brush tip first');
  if (layer.isGroup || layer.adjustment) return app.toast('Select a pixel layer first');
  const x = Math.floor(sel.x), y = Math.floor(sel.y), w = Math.ceil(sel.w), h = Math.ceil(sel.h);
  if (w < 2 || h < 2) return app.toast('The selection is too small');
  // read the selection (honouring an irregular shape), at most 256 px on the long side
  const k = Math.min(1, 256 / Math.max(w, h)), tw = Math.max(2, Math.round(w * k)), th = Math.max(2, Math.round(h * k));
  const c = makeCanvas(w, h), cx = ctxOf(c);
  cx.drawImage(layer.canvas, -x, -y);
  if (doc.selMask) { cx.globalCompositeOperation = 'destination-in'; cx.drawImage(doc.selMask, -x, -y); cx.globalCompositeOperation = 'source-over'; }
  const t = makeCanvas(tw, th), tx = ctxOf(t);
  tx.imageSmoothingQuality = 'high'; tx.drawImage(c, 0, 0, w, h, 0, 0, tw, th);
  const alpha = tipFromPixels(tx.getImageData(0, 0, tw, th).data, tw, th);
  if (!alpha) return app.toast('Nothing to use: the selection is empty or completely white');
  const v = await formDialog('Define Brush Tip', [{ key: 'name', label: 'Name', type: 'text', value: `Tip ${allTips().filter((q) => q.id.startsWith('tip:user')).length + 1}` }]);
  if (!v) return;
  const tip = defineTip(String(v.name).trim() || 'Tip', tw, th, alpha);
  app.brush.tip = tip.id; app.brush.spacing = Math.max(app.brush.spacing, 0.25);
  app.setTool('brush'); renderOptions(); app.emit('options');
  app.toast(`Brush tip "${tip.name}" defined and selected`);
}
