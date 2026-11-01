import { app } from './state';
import type { Doc, Layer } from './doc';
import type { Pt, Tool } from './tools';
import { LINE_HEIGHT, fontCss, layoutText, textRect, type TextData } from './text';

/** Inline editor: a transparent <textarea> placed over the canvas while a text layer is being typed. */
class TextEditor {
  private ta: HTMLTextAreaElement | null = null;
  private layer: Layer | null = null;
  private doc: Doc | null = null;
  private data!: TextData;
  private syncing = false;

  get active() { return !!this.ta; }

  start(layer: Layer | null, p: { x: number; y: number }) {
    this.commit();
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
    } else {
      const t = app.text;
      this.data = { ...t, content: '', color: app.fg, x: Math.round(p.x), y: Math.round(p.y - (t.size * LINE_HEIGHT) / 2) };
    }
    const ta = (this.ta = document.createElement('textarea'));
    ta.className = 'texteditor';
    ta.spellcheck = false;
    ta.value = this.data.content;
    ta.addEventListener('input', () => { this.data.content = ta.value; this.reposition(); });
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); this.commit(); }
    });
    document.getElementById('stage')!.append(ta);
    this.reposition();
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  /** Match the textarea to the current text style, zoom and pan. */
  reposition() {
    const ta = this.ta;
    if (!ta) return;
    const d = this.data, z = app.view.zoom;
    const { W, H } = layoutText({ ...d, content: ta.value || ' ' });
    Object.assign(ta.style, {
      left: `${app.view.panX + d.x * z}px`, top: `${app.view.panY + d.y * z}px`,
      width: `${Math.ceil(W * z) + 24}px`, height: `${Math.ceil(H * z) + 2}px`,
      font: fontCss(d, z), lineHeight: `${d.size * LINE_HEIGHT * z}px`, color: d.color, textAlign: d.align,
    });
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
      if (!next.content.trim() && doc.layers.length > 1) doc.removeLayer(layer);
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
  down(p: Pt) {
    if (editor.active) { editor.commit(); this.pending = null; return; } // click-away just finishes editing
    this.pending = p;
  }
  move() {}
  up() {
    const p = this.pending;
    this.pending = null;
    if (!p) return;
    const hit = [...app.doc.layers].reverse().find((l) => {
      if (!l.visible || !l.text) return false;
      const r = textRect(l.text), pad = 6;
      return p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad;
    });
    // Defer so the browser's own mousedown focus handling can't steal focus from the new textarea.
    setTimeout(() => editor.start(hit ?? null, p), 0);
  }
}
