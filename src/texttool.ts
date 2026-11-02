import { app } from './state';
import type { Doc, Layer } from './doc';
import type { Pt, Tool } from './tools';
import { LINE_HEIGHT, distanceToTextPath, fontCss, layoutText, renderText, textRect, type TextData } from './text';
import { flattenCmds, nearestOnPoly } from './textpath';
import { shapeCmds, type Cmd } from './shapemath';
import { makeCanvas } from './doc';

/** Inline editor: a transparent <textarea> placed over the canvas while a text layer is being typed. */
class TextEditor {
  private ta: HTMLTextAreaElement | null = null;
  private layer: Layer | null = null;
  private doc: Doc | null = null;
  private data!: TextData;
  private syncing = false;
  private preview: HTMLCanvasElement | null = null;

  get active() { return !!this.ta; }

  get hasPath() { return !!this.ta && !!this.data.path; }
  /** Change the path text's start offset / side while editing. */
  setPathProps(patch: { pathOffset?: number; pathFlip?: boolean }) { if (this.ta) { Object.assign(this.data, patch); this.reposition(); } }
  get pathProps() { return { offset: this.data?.pathOffset ?? 0, flip: !!this.data?.pathFlip }; }

  /** Start typing along a shape's outline (path given in document coordinates; `s` = arc length of the click). */
  startOnPath(cmds: Cmd[], s: number) {
    this.commit();
    let x0 = Infinity, y0 = Infinity;
    for (const c of cmds) for (let i = 1; i < c.length; i += 2) { x0 = Math.min(x0, c[i] as number); y0 = Math.min(y0, c[i + 1] as number); }
    const rel = cmds.map((c) => (c[0] === 'Z' ? c : c[0] === 'C' ? ['C', c[1] - x0, c[2] - y0, c[3] - x0, c[4] - y0, c[5] - x0, c[6] - y0] : [c[0], c[1] - x0, c[2] - y0]) as Cmd);
    this.begin(null, { ...app.text, content: '', color: app.fg, x: Math.round(x0), y: Math.round(y0), path: { cmds: rel.map((c) => (c[0] === 'Z' ? c : c.map((v, i) => (i ? Math.round((v as number) * 100) / 100 : v))) as Cmd) }, pathOffset: Math.round(s), pathFlip: false });
  }

  start(layer: Layer | null, p: { x: number; y: number }) {
    this.commit();
    let seed: TextData | null = null;
    if (!layer) { const t = app.text; seed = { ...t, content: '', color: app.fg, x: Math.round(p.x), y: Math.round(p.y - (t.size * LINE_HEIGHT) / 2) }; }
    this.begin(layer, seed);
  }

  private begin(layer: Layer | null, seed: TextData | null) {
    const doc = (this.doc = app.doc);
    this.layer = layer;
    if (layer?.text) {
      this.data = { ...layer.text };
      this.syncing = true;
      Object.assign(app.text, { font: this.data.font, size: this.data.size, bold: this.data.bold, italic: this.data.italic, align: this.data.align });
      app.setFg(this.data.color);
      this.syncing = false;
      app.emit('textsync');
      layer.editMask = false;
      layer.hiddenForEdit = true;
      doc.select(layer);
      doc.emit('pixels');
    } else this.data = { ...seed! };
    const ta = (this.ta = document.createElement('textarea'));
    ta.className = 'texteditor';
    ta.spellcheck = false;
    ta.value = this.data.content;
    ta.addEventListener('input', () => { this.data.content = ta.value; this.reposition(); });
    if (this.data.path) ta.classList.add('pathtext');
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); this.commit(); }
    });
    document.getElementById('stage')!.append(ta);
    this.reposition();
    if (this.data.path) app.emit('textsync');
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  /** Match the textarea to the current text style, zoom and pan. */
  reposition() {
    const ta = this.ta;
    if (!ta) return;
    const d = this.data, z = app.view.zoom;
    if (d.path) {                                                        // text on a path: a small box beside the path's start; the text itself is previewed along the path
      const first = d.path.cmds.find((c) => c[0] === 'M') as Cmd & ['M', number, number] | undefined;
      Object.assign(ta.style, { left: `${app.view.panX + (d.x + (first?.[1] ?? 0)) * z}px`, top: `${app.view.panY + (d.y + (first?.[2] ?? 0)) * z + 8}px`, width: '260px', height: '28px', font: '14px system-ui, sans-serif', lineHeight: '20px', color: '#111', textAlign: 'left' });
      this.preview = null; app.doc.emit('selection');
      return;
    }
    const { W, H } = layoutText({ ...d, content: ta.value || ' ' });
    Object.assign(ta.style, {
      left: `${app.view.panX + d.x * z}px`, top: `${app.view.panY + d.y * z}px`,
      width: `${Math.ceil(W * z) + 24}px`, height: `${Math.ceil(H * z) + 2}px`,
      font: fontCss(d, z), lineHeight: `${d.size * LINE_HEIGHT * z}px`, color: d.color, textAlign: d.align,
    });
  }

  /** The path text being typed, drawn along its path (for the overlay). */
  previewCanvas(): HTMLCanvasElement | null {
    if (!this.ta || !this.data.path || !this.doc) return null;
    const c = (this.preview ??= makeCanvas(this.doc.width, this.doc.height));
    renderText(c, { ...this.data, content: this.ta.value });
    return c;
  }

  /** Called when the user changes font/size/align/color while the text tool is active. */
  styleChanged() {
    if (this.syncing || app.toolId !== 'text') return;
    const style = { ...app.text, color: app.fg };
    if (this.ta) { Object.assign(this.data, style); this.reposition(); return; }
    const l = app.doc.active;
    if (l.text && JSON.stringify({ ...l.text, ...style }) !== JSON.stringify(l.text)) app.doc.setText(l, { ...l.text, ...style });
  }

  commit() {
    const ta = this.ta;
    if (!ta) return;
    this.ta = null;
    ta.remove();
    const doc = this.doc!, layer = this.layer;
    const next: TextData = { ...this.data, content: ta.value };
    this.layer = null;
    if (layer) {
      layer.hiddenForEdit = false;
      if (!next.content.trim() && doc.leafCount > 1) doc.removeLayer(layer);
      else if (JSON.stringify(next) !== JSON.stringify(layer.text)) doc.setText(layer, next);
      else doc.emit('pixels');
    } else if (next.content.trim()) doc.createTextLayer(next);
  }
}
export const editor = new TextEditor();

app.on('textstyle', () => editor.styleChanged());
app.on('color', () => editor.styleChanged());
// Clicking anything outside the canvas/options bar (layers panel, toolbar, tabs, menus) finishes editing.
document.addEventListener('pointerdown', (e) => {
  const t = e.target as HTMLElement;
  if (editor.active && !t.closest('#stage, #options')) editor.commit();
}, true);
app.on('tool', () => { if (app.toolId !== 'text') editor.commit(); });

export class TextTool implements Tool {
  cursor = 'text';
  private pending: Pt | null = null;
  private alt = false;
  down(p: Pt, e?: PointerEvent) {
    if (editor.active) { editor.commit(); this.pending = null; return; } // click-away just finishes editing
    this.pending = p; this.alt = !!e?.altKey;
  }
  private shapeOutlineAt(p: Pt): { cmds: Cmd[]; s: number } | null {
    const tol = 9 / app.view.zoom;
    let best: { d: number; cmds: Cmd[]; s: number } | null = null;
    for (const l of app.doc.layers) {
      if (!l.shape || !app.doc.isShown(l)) continue;
      const cmds = shapeCmds(l.shape);
      for (const poly of flattenCmds(cmds)) { const r = nearestOnPoly(poly, p.x, p.y); if (r.d <= tol && (!best || r.d < best.d)) best = { d: r.d, cmds: polyToCmds(poly), s: r.s }; }
    }
    return best;
  }
  overlay(ctx: CanvasRenderingContext2D, ts: (x: number, y: number) => [number, number]) {
    const c = editor.previewCanvas();
    if (!c) return;
    const [x0, y0] = ts(0, 0), [x1, y1] = ts(c.width, c.height);
    ctx.drawImage(c, x0, y0, x1 - x0, y1 - y0);
  }
  move() {}
  up() {
    const p = this.pending;
    this.pending = null;
    if (!p) return;
    const hit = [...app.doc.layers].reverse().find((l) => {
      if (!app.doc.isShown(l) || !l.text) return false;
      if (l.text.path) return distanceToTextPath(l.text, p.x, p.y) <= Math.max(l.text.size * 0.8, 8 / app.view.zoom);
      const r = textRect(l.text), pad = 6;
      return p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad;
    });
    if (!hit && !this.alt) {                                                       // click on a shape's outline: type along it (Alt+click for ordinary text)
      const on = this.shapeOutlineAt(p);
      if (on) { setTimeout(() => editor.startOnPath(on.cmds, on.s), 0); return; }
    }
    // Defer so the browser's own mousedown focus handling can't steal focus from the new textarea.
    setTimeout(() => editor.start(hit ?? null, p), 0);
  }
}

const polyToCmds = (p: { pts: [number, number][]; closed: boolean }): Cmd[] => [...p.pts.map((q, i): Cmd => [i ? 'L' : 'M', q[0], q[1]]), ...(p.closed ? ([['Z']] as Cmd[]) : [])];
