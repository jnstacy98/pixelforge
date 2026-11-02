import type { Doc } from './doc';
import type { LayerEffects } from './fx';
import { FONTS } from './text';
import type { Viewer } from './viewer';

export type ToolId = 'move' | 'marquee' | 'brush' | 'eraser' | 'bucket' | 'gradient' | 'eyedropper' | 'hand' | 'text' | 'lasso' | 'wand' | 'clone' | 'heal' | 'spot' | 'patch' | 'cmove';

type Evt = 'tool' | 'color' | 'doc' | 'options' | 'history' | 'textstyle' | 'textsync';

class App {
  docs: Doc[] = [];
  doc!: Doc;
  view!: Viewer;
  fg = '#000000';
  bg = '#ffffff';
  toolId: ToolId = 'brush';
  brush = { size: 24, hardness: 0.7, opacity: 1, flow: 1, spacing: 0.12 };
  fill = { tolerance: 32, contiguous: true };
  text = { font: FONTS[0][1], size: 48, bold: false, italic: false, align: 'left' as 'left' | 'center' | 'right' };
  /** Clone Stamp: source point (Alt+click), the dest→source offset, and sampling options. */
  /** Copied layer style (Layer ▸ Copy / Paste Layer Style). */
  styleClip: LayerEffects | null = null;
  clone = { src: null as { x: number; y: number } | null, offset: null as { x: number; y: number } | null, doc: null as Doc | null, w: 0, h: 0, aligned: true, sample: 'layer' as 'layer' | 'below' | 'all' };
  /** Patch tool: Source (the selection takes texture from where you drag it) or Destination (it is copied there); blend = match tone like the Healing Brush. */
  cmove = { mode: 'move' as 'move' | 'extend', blend: true };
  patch = { mode: 'source' as 'source' | 'dest' | 'content', blend: true };
  marquee = { shape: 'rect' as 'rect' | 'ellipse' };
  wand = { allLayers: false };
  gradient = { mode: 'fg-bg' as 'fg-bg' | 'fg-transparent' };
  private subs = new Map<Evt, Set<() => void>>();
  on(e: Evt, fn: () => void) { if (!this.subs.has(e)) this.subs.set(e, new Set()); this.subs.get(e)!.add(fn); }
  emit(e: Evt) { this.subs.get(e)?.forEach((f) => f()); }
  setTool(t: ToolId) { this.toolId = t; this.emit('tool'); }
  setFg(c: string) { this.fg = c; this.emit('color'); }
  setBg(c: string) { this.bg = c; this.emit('color'); }
  swapColors() { [this.fg, this.bg] = [this.bg, this.fg]; this.emit('color'); }
  toast(msg: string) {
    const el = document.getElementById('toast')!;
    el.textContent = msg; el.classList.add('show');
    clearTimeout((this as any)._t);
    (this as any)._t = setTimeout(() => el.classList.remove('show'), 2600);
  }
}
export const app = new App();
export const hexToRgb = (h: string): [number, number, number] => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
export const rgbToHex = (r: number, g: number, b: number) =>
  '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
/** Luminance of a color as a gray hex (used when painting on layer masks). */
export const grayOf = (h: string) => {
  const [r, g, b] = hexToRgb(h);
  const v = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  return rgbToHex(v, v, v);
};
/** Color to paint with on the active edit target (grayscale when editing a mask). */
export const paintColor = (c: string) => (app.doc.active.maskMode ? grayOf(c) : c);
