import type { Doc } from './doc';
import { composite } from './render';
import { app } from './state';
import { tools, type Pt } from './tools';
import { ctxOf } from './doc';
import { outlineOf } from './selection';

export class Viewer {
  zoom = 1; panX = 0; panY = 0;
  doc: Doc | null = null;
  private wrap = document.createElement('div');
  private canvas = document.createElement('canvas');
  private overlay = document.createElement('canvas');
  private raf = 0;
  private mouse: { x: number; y: number } | null = null;
  private panning: { x: number; y: number; px: number; py: number } | null = null;
  private spaceDown = false;
  private drawing = false;
  private unsub: (() => void) | null = null;
  onStatus: () => void = () => {};
  onTransform: () => void = () => {};

  constructor(private stage: HTMLElement) {
    this.wrap.className = 'docwrap';
    this.canvas.className = 'doccanvas';
    this.overlay.className = 'overlay';
    this.wrap.appendChild(this.canvas);
    stage.append(this.wrap, this.overlay);
    new ResizeObserver(() => { this.sizeOverlay(); this.requestRender(); }).observe(stage);
    stage.addEventListener('pointerdown', (e) => this.onDown(e));
    stage.addEventListener('pointermove', (e) => this.onMove(e));
    stage.addEventListener('pointerup', (e) => this.onUp(e));
    stage.addEventListener('pointercancel', (e) => this.onUp(e));
    stage.addEventListener('pointerleave', () => { this.mouse = null; this.requestRender(); });
    stage.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    window.addEventListener('keydown', (e) => { if (e.code === 'Space' && !isTyping(e)) { this.spaceDown = true; this.updateCursor(); if (e.target === document.body) e.preventDefault(); } });
    window.addEventListener('keyup', (e) => { if (e.code === 'Space') { this.spaceDown = false; this.updateCursor(); } });
    app.on('tool', () => { this.updateCursor(); this.requestRender(); });
    app.on('options', () => this.requestRender());
  }

  attach(doc: Doc) {
    if (this.doc) this.doc.view = { zoom: this.zoom, panX: this.panX, panY: this.panY };
    this.unsub?.();
    this.doc = doc;
    this.canvas.width = doc.width; this.canvas.height = doc.height;
    this.unsub = doc.on((k) => {
      if (this.canvas.width !== doc.width || this.canvas.height !== doc.height) {
        this.canvas.width = doc.width; this.canvas.height = doc.height; this.fit();
      }
      if (k === 'structure' || k === 'pixels') this.requestRender(); else this.drawOverlay();
    });
    this.sizeOverlay();
    if (doc.view) { ({ zoom: this.zoom, panX: this.panX, panY: this.panY } = doc.view); this.applyTransform(); }
    else this.fit();
    this.requestRender();
  }

  private sizeOverlay() {
    const r = this.stage.getBoundingClientRect();
    this.overlay.width = Math.max(1, Math.round(r.width)); this.overlay.height = Math.max(1, Math.round(r.height));
  }

  fit() {
    if (!this.doc) return;
    const r = this.stage.getBoundingClientRect(), pad = 48;
    this.zoom = Math.min((r.width - pad) / this.doc.width, (r.height - pad) / this.doc.height, 1);
    this.zoom = Math.max(0.02, this.zoom);
    this.centerDoc();
  }
  setZoom(z: number) {
    const r = this.stage.getBoundingClientRect();
    this.zoomAt(z / this.zoom, r.left + r.width / 2, r.top + r.height / 2);
  }
  private centerDoc() {
    if (!this.doc) return;
    const r = this.stage.getBoundingClientRect();
    this.panX = (r.width - this.doc.width * this.zoom) / 2;
    this.panY = (r.height - this.doc.height * this.zoom) / 2;
    this.applyTransform();
  }
  zoomAt(factor: number, cx: number, cy: number) {
    const r = this.stage.getBoundingClientRect();
    const nz = Math.max(0.02, Math.min(64, this.zoom * factor));
    const k = nz / this.zoom;
    const lx = cx - r.left, ly = cy - r.top;
    this.panX = lx - (lx - this.panX) * k;
    this.panY = ly - (ly - this.panY) * k;
    this.zoom = nz;
    this.applyTransform();
  }
  private applyTransform() {
    this.wrap.style.width = `${this.doc?.width ?? 0}px`;
    this.wrap.style.height = `${this.doc?.height ?? 0}px`;
    this.wrap.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
    this.canvas.style.imageRendering = this.zoom >= 3 ? 'pixelated' : 'auto';
    this.wrap.style.setProperty('--check', `${Math.max(4, 8 / Math.max(this.zoom, 0.5))}px`);
    this.drawOverlay(); this.onStatus(); this.onTransform();
  }

  toDoc(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.stage.getBoundingClientRect();
    return { x: (e.clientX - r.left - this.panX) / this.zoom, y: (e.clientY - r.top - this.panY) / this.zoom };
  }
  get cursorDoc() { return this.mouse ? this.toDoc({ clientX: this.mouse.x + this.stage.getBoundingClientRect().left, clientY: this.mouse.y + this.stage.getBoundingClientRect().top }) : null; }

  private pt(e: PointerEvent): Pt {
    const d = this.toDoc(e);
    return { x: d.x, y: d.y, pressure: e.pointerType === 'pen' ? e.pressure : 1 };
  }
  private handMode(e: PointerEvent) { return e.button === 1 || this.spaceDown || app.toolId === 'hand'; }

  private onDown(e: PointerEvent) {
    if (!this.doc || (e.target as HTMLElement).tagName === 'TEXTAREA') return;
    this.stage.setPointerCapture(e.pointerId);
    if (this.handMode(e)) {
      this.panning = { x: e.clientX, y: e.clientY, px: this.panX, py: this.panY };
      this.stage.style.cursor = 'grabbing'; return;
    }
    if (e.button !== 0) return;
    this.drawing = true;
    tools[app.toolId].down(this.pt(e), e);
  }
  private onMove(e: PointerEvent) {
    if ((e.target as HTMLElement).tagName === 'TEXTAREA' && !this.drawing && !this.panning) return;
    const r = this.stage.getBoundingClientRect();
    this.mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
    if (this.panning) {
      this.panX = this.panning.px + e.clientX - this.panning.x;
      this.panY = this.panning.py + e.clientY - this.panning.y;
      this.applyTransform(); return;
    }
    if (this.drawing) {
      const evs = e.getCoalescedEvents?.() ?? [];
      for (const ce of evs.length ? evs : [e]) tools[app.toolId].move(this.pt(ce), ce);
    }
    this.onStatus();
    if (tools[app.toolId].brushCursor || tools[app.toolId].trackHover) this.drawOverlay();
  }
  private onUp(e: PointerEvent) {
    if ((e.target as HTMLElement).tagName === 'TEXTAREA' && !this.drawing && !this.panning) return;
    if (this.panning) { this.panning = null; this.updateCursor(); return; }
    if (this.drawing) { this.drawing = false; tools[app.toolId].up(this.pt(e), e); }
  }
  private onWheel(e: WheelEvent) {
    e.preventDefault();
    this.zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX, e.clientY);
  }
  updateCursor() {
    const t = tools[app.toolId];
    this.stage.style.cursor = this.spaceDown || app.toolId === 'hand' ? 'grab' : t.cursor;
  }

  requestRender() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      if (!this.doc) return;
      composite(this.doc, ctxOf(this.canvas));
      this.drawOverlay();
    });
  }

  drawOverlay() {
    const ctx = this.overlay.getContext('2d')!;
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    const doc = this.doc;
    if (!doc) return;
    const ts = (x: number, y: number): [number, number] => [x * this.zoom + this.panX, y * this.zoom + this.panY];
    if (doc.selection && doc.selMask) {
      const sh = doc.selShift ?? { dx: 0, dy: 0 };
      ctx.save(); ctx.imageSmoothingEnabled = false;
      ctx.drawImage(outlineOf(doc.selMask), (sh.dx) * this.zoom + this.panX, sh.dy * this.zoom + this.panY, doc.width * this.zoom, doc.height * this.zoom);
      ctx.restore();
    } else if (doc.selection) {
      const s = doc.selection;
      const [x, y] = ts(s.x, s.y);
      const w = s.w * this.zoom, h = s.h * this.zoom;
      ctx.save();
      ctx.lineWidth = 1; ctx.setLineDash([5, 5]);
      ctx.strokeStyle = '#000'; ctx.strokeRect(x + 0.5, y + 0.5, w, h);
      ctx.strokeStyle = '#fff'; ctx.lineDashOffset = 5; ctx.strokeRect(x + 0.5, y + 0.5, w, h);
      ctx.restore();
    }
    tools[app.toolId].overlay?.(ctx, ts);
    if (this.mouse && tools[app.toolId].brushCursor && !this.panning && !this.spaceDown) {
      const r = Math.max(1, ((tools[app.toolId].cursorSize?.() ?? app.brush.size) * this.zoom) / 2);
      ctx.save(); ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(0,0,0,.85)'; ctx.beginPath(); ctx.arc(this.mouse.x, this.mouse.y, r, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.beginPath(); ctx.arc(this.mouse.x, this.mouse.y, r + 1, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
  }
}

export function isTyping(e: Event) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}
