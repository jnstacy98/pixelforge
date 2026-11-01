import type { Doc } from './doc';
import type { Viewer } from './viewer';

export type ToolId = 'move' | 'marquee' | 'brush' | 'eraser' | 'bucket' | 'gradient' | 'eyedropper' | 'hand';

type Evt = 'tool' | 'color' | 'doc' | 'options' | 'history';

class App {
  docs: Doc[] = [];
  doc!: Doc;
  view!: Viewer;
  fg = '#000000';
  bg = '#ffffff';
  toolId: ToolId = 'brush';
  brush = { size: 24, hardness: 0.7, opacity: 1, flow: 1, spacing: 0.12 };
  fill = { tolerance: 32, contiguous: true };
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
