import { app } from './state';
import { cloneCanvas, ctxOf, makeCanvas } from './doc';
import { composite } from './render';

/**
 * Freeze the pixels that Clone / Healing / Patch tools sample from, per the shared "Sample" option:
 * the current layer (or its mask when that is the edit target), the current layer and everything below it, or the whole image.
 */
export function sampleSnapshot(): HTMLCanvasElement {
  const doc = app.doc, layer = doc.active, mode = layer.maskMode ? 'layer' : app.clone.sample;
  if (mode === 'layer') return cloneCanvas(layer.target);
  const upTo = mode === 'below' ? doc.layers.indexOf(layer) + 1 : doc.layers.length;
  const shim = { width: doc.width, height: doc.height, layers: doc.layers.slice(0, upTo), stroke: null, selMask: null } as unknown as typeof doc;
  const c = makeCanvas(doc.width, doc.height);
  composite(shim, ctxOf(c));
  return c;
}
