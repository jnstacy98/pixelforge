import './style.css';
import { app } from './state';
import { Doc } from './doc';
import { Viewer, isTyping } from './viewer';
import { initToolbar, initPanels, initStatus, renderOptions, renderLayers, renderTabs, renderStatus, renderHistory, toolKeys } from './ui';
import { importFile, pickFiles, saveAs, OPEN_EXTS, type ExportFormat, type OpenedFile } from './io';
import { applyFilter, clearSelection, fillSelection } from './filters';
import { formDialog } from './dialog';
import { editor } from './texttool';

// ------------------------------------------------------------------ documents
function refresh() {
  renderLayers(); renderHistory(); renderTabs(switchTo, closeDoc); renderStatus();
  document.title = `${app.doc.name}${app.doc.history.dirty ? ' •' : ''} — PixelForge`;
}
let unsubDoc: (() => void) | null = null;
function switchTo(i: number) {
  app.doc = app.docs[i];
  unsubDoc?.();
  unsubDoc = app.doc.on((k) => { if (k !== 'pixels') refresh(); });
  app.doc.history.onChange = () => refresh();
  app.view.attach(app.doc);
  refresh();
}
function addDoc(doc: Doc) { app.docs.push(doc); switchTo(app.docs.length - 1); }
async function closeDoc(i: number) {
  const d = app.docs[i];
  if (d.history.dirty && !confirm(`"${d.name}" has unsaved changes. Close anyway?`)) return;
  app.docs.splice(i, 1);
  if (!app.docs.length) addDoc(Doc.blank(1024, 768, 'Untitled', '#ffffff'));
  else switchTo(Math.min(i, app.docs.length - 1));
}

async function openFiles(files: OpenedFile[]) {
  for (const f of files) {
    try { addDoc(await importFile(f)); }
    catch (e) { app.toast((e as Error).message); }
  }
}

async function newDocument() {
  const v = await formDialog('New Document', [
    { key: 'name', label: 'Name', type: 'text', value: 'Untitled' },
    { key: 'w', label: 'Width (px)', type: 'number', value: 1920, min: 1, max: 16000 },
    { key: 'h', label: 'Height (px)', type: 'number', value: 1080, min: 1, max: 16000 },
    { key: 'bg', label: 'Background', type: 'select', value: 'white', options: [['white', 'White'], ['bg', 'Background color'], ['transparent', 'Transparent']] },
  ], 'Create');
  if (!v) return;
  const bg = v.bg === 'white' ? '#ffffff' : v.bg === 'bg' ? app.bg : null;
  addDoc(Doc.blank(v.w, v.h, v.name || 'Untitled', bg));
}

async function exportAs(fmt: ExportFormat) {
  let quality = 0.92;
  if (fmt === 'jpeg' || fmt === 'webp') {
    const v = await formDialog(`Export ${fmt.toUpperCase()}`, [{ key: 'q', label: 'Quality', type: 'range', value: 92, min: 1, max: 100 }], 'Export');
    if (!v) return;
    quality = v.q / 100;
  }
  try { if (await saveAs(app.doc, fmt, quality)) app.toast(`Saved ${app.doc.name}.${fmt === 'jpeg' ? 'jpg' : fmt}`); }
  catch (e) { app.toast('Save failed: ' + (e as Error).message); }
}

// ------------------------------------------------------------------ filters / image
const filterDialog = async (title: string, fields: Parameters<typeof formDialog>[1], build: (v: any) => string) => {
  const v = await formDialog(title, fields, 'Apply');
  if (v) applyFilter(title, build(v));
};

type Item = { label: string; shortcut?: string; action: () => void } | '-';
const menus: { title: string; items: () => Item[] }[] = [
  { title: 'File', items: () => [
    { label: 'New…', shortcut: 'Ctrl+N', action: newDocument },
    { label: 'Open…', shortcut: 'Ctrl+O', action: async () => openFiles(await pickFiles()) },
    '-',
    { label: 'Save as PSD (layers)…', shortcut: 'Ctrl+S', action: () => exportAs('psd') },
    { label: 'Export PNG…', shortcut: 'Ctrl+Shift+S', action: () => exportAs('png') },
    { label: 'Export JPEG…', action: () => exportAs('jpeg') },
    { label: 'Export WebP…', action: () => exportAs('webp') },
    { label: 'Export BMP…', action: () => exportAs('bmp') },
    '-',
    { label: 'Close', shortcut: 'Ctrl+W', action: () => closeDoc(app.docs.indexOf(app.doc)) },
  ] },
  { title: 'Edit', items: () => {
    const h = app.doc.history;
    return [
      { label: h.canUndo ? `Undo ${h.undoLabel}` : 'Undo', shortcut: 'Ctrl+Z', action: () => h.undo() },
      { label: h.canRedo ? `Redo ${h.redoLabel}` : 'Redo', shortcut: 'Ctrl+Shift+Z', action: () => h.redo() },
      '-',
      { label: 'Fill with Foreground', shortcut: 'Alt+Backspace', action: () => fillSelection(app.fg) },
      { label: 'Fill with Background', shortcut: 'Ctrl+Backspace', action: () => fillSelection(app.bg) },
      { label: 'Clear', shortcut: 'Delete', action: clearSelection },
      '-',
      { label: 'Select All', shortcut: 'Ctrl+A', action: () => app.doc.setSelection({ x: 0, y: 0, w: app.doc.width, h: app.doc.height }) },
      { label: 'Deselect', shortcut: 'Ctrl+D', action: () => app.doc.selection && app.doc.setSelection(null) },
    ];
  } },
  { title: 'Image', items: () => [
    { label: 'Image Size…', action: async () => {
      const d = app.doc;
      const v = await formDialog('Image Size', [
        { key: 'w', label: 'Width (px)', type: 'number', value: d.width, min: 1, max: 16000 },
        { key: 'h', label: 'Height (px)', type: 'number', value: d.height, min: 1, max: 16000 },
        { key: 'keep', label: 'Keep proportions', type: 'checkbox', value: true },
      ]);
      if (v) d.resizeImage(v.w, v.keep ? Math.max(1, Math.round((v.w * d.height) / d.width)) : v.h);
    } },
    { label: 'Canvas Size…', action: async () => {
      const d = app.doc;
      const v = await formDialog('Canvas Size (centered)', [
        { key: 'w', label: 'Width (px)', type: 'number', value: d.width, min: 1, max: 16000 },
        { key: 'h', label: 'Height (px)', type: 'number', value: d.height, min: 1, max: 16000 },
      ]);
      if (v) d.resizeCanvas(v.w, v.h);
    } },
    '-',
    { label: 'Rotate 90° Clockwise', action: () => app.doc.rotate90(true) },
    { label: 'Rotate 90° Counter-clockwise', action: () => app.doc.rotate90(false) },
    { label: 'Flip Horizontal', action: () => app.doc.flip(true) },
    { label: 'Flip Vertical', action: () => app.doc.flip(false) },
  ] },
  { title: 'Layer', items: () => [
    { label: 'New Layer', shortcut: 'Ctrl+Shift+N', action: () => app.doc.addLayer() },
    { label: 'Duplicate Layer', shortcut: 'Ctrl+J', action: () => app.doc.duplicateLayer() },
    { label: 'Delete Layer', action: () => app.doc.removeLayer() },
    '-',
    { label: 'Add Layer Mask — Reveal All', action: () => app.doc.addMask('reveal') },
    { label: 'Add Layer Mask — Hide All', action: () => app.doc.addMask('hide') },
    { label: 'Add Layer Mask — From Selection', action: () => app.doc.addMask('selection') },
    { label: app.doc.active.maskEnabled ? 'Disable Layer Mask' : 'Enable Layer Mask', action: () => app.doc.toggleMask() },
    { label: 'Apply Layer Mask', action: () => app.doc.applyMask() },
    { label: 'Delete Layer Mask', action: () => app.doc.deleteMask() },
    '-',
    { label: 'Merge Down', shortcut: 'Ctrl+E', action: () => app.doc.mergeDown() },
    { label: 'Flatten Image', action: () => app.doc.flatten() },
  ] },
  { title: 'Filter', items: () => [
    { label: 'Invert', shortcut: 'Ctrl+I', action: () => applyFilter('Invert', 'invert(1)') },
    { label: 'Desaturate', action: () => applyFilter('Desaturate', 'grayscale(1)') },
    { label: 'Sepia', action: () => applyFilter('Sepia', 'sepia(1)') },
    '-',
    { label: 'Gaussian Blur…', action: () => filterDialog('Gaussian Blur', [{ key: 'r', label: 'Radius (px)', type: 'range', value: 4, min: 0, max: 50, step: 0.5 }], (v) => `blur(${v.r}px)`) },
    { label: 'Brightness / Contrast…', action: () => filterDialog('Brightness / Contrast', [
      { key: 'b', label: 'Brightness', type: 'range', value: 0, min: -100, max: 100 },
      { key: 'c', label: 'Contrast', type: 'range', value: 0, min: -100, max: 100 }], (v) => `brightness(${1 + v.b / 100}) contrast(${1 + v.c / 100})`) },
    { label: 'Hue / Saturation…', action: () => filterDialog('Hue / Saturation', [
      { key: 'h', label: 'Hue', type: 'range', value: 0, min: -180, max: 180 },
      { key: 's', label: 'Saturation', type: 'range', value: 0, min: -100, max: 100 }], (v) => `hue-rotate(${v.h}deg) saturate(${Math.max(0, 1 + v.s / 100)})`) },
  ] },
  { title: 'View', items: () => [
    { label: 'Fit on Screen', shortcut: 'Ctrl+0', action: () => app.view.fit() },
    { label: 'Actual Pixels', shortcut: 'Ctrl+1', action: () => app.view.setZoom(1) },
    { label: 'Zoom In', shortcut: 'Ctrl+=', action: () => app.view.setZoom(app.view.zoom * 1.25) },
    { label: 'Zoom Out', shortcut: 'Ctrl+-', action: () => app.view.setZoom(app.view.zoom / 1.25) },
  ] },
];

function initMenus() {
  const bar = document.getElementById('menubar')!;
  const close = () => bar.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open'));
  for (const m of menus) {
    const el = document.createElement('div'); el.className = 'menu';
    const t = document.createElement('div'); t.className = 'title'; t.textContent = m.title;
    const drop = document.createElement('div'); drop.className = 'drop';
    const open = () => {
      drop.innerHTML = '';
      for (const it of m.items()) {
        if (it === '-') { const s = document.createElement('div'); s.className = 'sep'; drop.append(s); continue; }
        const row = document.createElement('div'); row.className = 'mi';
        row.innerHTML = '<span></span><span class="sc"></span>';
        (row.children[0] as HTMLElement).textContent = it.label; (row.children[1] as HTMLElement).textContent = it.shortcut ?? '';
        row.onclick = () => { close(); it.action(); };
        drop.append(row);
      }
      close(); el.classList.add('open');
    };
    t.onclick = () => (el.classList.contains('open') ? close() : open());
    t.onmouseenter = () => { if (bar.querySelector('.menu.open')) open(); };
    el.append(t, drop); bar.append(el);
  }
  document.addEventListener('mousedown', (e) => { if (!(e.target as HTMLElement).closest('.menu')) close(); });
}

// ------------------------------------------------------------------ shortcuts
window.addEventListener('keydown', (e) => {
  if (isTyping(e)) return;
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  const doc = app.doc;
  if (mod) {
    const map: Record<string, () => void> = {
      z: () => (e.shiftKey ? doc.history.redo() : doc.history.undo()),
      y: () => doc.history.redo(),
      n: () => (e.shiftKey ? doc.addLayer() : newDocument()),
      o: async () => openFiles(await pickFiles()),
      s: () => exportAs(e.shiftKey ? 'png' : 'psd'),
      w: () => closeDoc(app.docs.indexOf(doc)),
      j: () => doc.duplicateLayer(),
      e: () => doc.mergeDown(),
      a: () => doc.setSelection({ x: 0, y: 0, w: doc.width, h: doc.height }),
      d: () => doc.selection && doc.setSelection(null),
      i: () => applyFilter('Invert', 'invert(1)'),
      '0': () => app.view.fit(), '1': () => app.view.setZoom(1),
      '=': () => app.view.setZoom(app.view.zoom * 1.25), '+': () => app.view.setZoom(app.view.zoom * 1.25), '-': () => app.view.setZoom(app.view.zoom / 1.25),
      backspace: () => fillSelection(app.bg),
    };
    if (map[k]) { e.preventDefault(); map[k](); }
    return;
  }
  if (e.altKey && k === 'backspace') { e.preventDefault(); fillSelection(app.fg); return; }
  if (k === 'delete' || k === 'backspace') { e.preventDefault(); clearSelection(); return; }
  if (k === 'x') return app.swapColors();
  if (k === 'd') { app.fg = '#000000'; app.bg = '#ffffff'; return app.emit('color'); }
  if (k === '[' || k === ']') {
    const b = app.brush; b.size = Math.max(1, Math.min(500, Math.round(b.size * (k === ']' ? 1.15 : 0.87) + (k === ']' ? 1 : -1))));
    renderOptions(); app.emit('options'); return;
  }
  const t = toolKeys[k];
  if (t) app.setTool(t);
});

// ------------------------------------------------------------------ drag & drop
const dz = document.getElementById('dropzone')!;
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; dz.classList.add('show'); } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; dz.classList.remove('show'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault(); dragDepth = 0; dz.classList.remove('show');
  const files = [...(e.dataTransfer?.files ?? [])].filter((f) => OPEN_EXTS.includes(f.name.split('.').pop()!.toLowerCase()));
  if (!files.length && e.dataTransfer?.files.length) return app.toast('Unsupported file type');
  openFiles(await Promise.all(files.map(async (f) => ({ name: f.name, data: await f.arrayBuffer() }))));
});

// ------------------------------------------------------------------ boot
window.addEventListener('beforeunload', (e) => { if (app.docs.some((d) => d.history.dirty)) e.preventDefault(); });
app.view = new Viewer(document.getElementById('stage')!);
app.view.onStatus = renderStatus;
app.view.onTransform = () => editor.reposition();
initToolbar(); initPanels(); initStatus(); initMenus();
app.on('tool', renderOptions); renderOptions();
app.on('history', refresh);
window.native?.onOpenPath?.((f) => openFiles([{ name: f.name, path: f.path, data: f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.byteLength) as ArrayBuffer }]));
addDoc(Doc.blank(1280, 800, 'Untitled', '#ffffff'));
(window as any).__app = app; // handy for debugging & tests

// Test hooks (used by tests/e2e.mjs; harmless in production)
(window as any).__roundtrip = async () => {
  const { encode, importFile } = await import('./io');
  const data = await encode(app.doc, 'psd');
  const d2 = await importFile({ name: 'rt.psd', data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer });
  const top = d2.layers[d2.layers.length - 1];
  const bg = d2.layers[0];
  const mp = (x: number, y: number) => (bg.mask ? Array.from(bg.mask.getContext('2d')!.getImageData(x, y, 1, 1).data)[0] : -1);
  return {
    summary: { bytes: data.length, layers: d2.layers.length, w: d2.width, top: { name: top.name, opacity: top.opacity, blend: top.blend } },
    mask: { has: !!bg.mask, hiddenAtStroke: mp(400, 200), visibleElsewhere: mp(100, 700) },
  };
};
(window as any).__openPng = async () => {
  const c = document.createElement('canvas'); c.width = 64; c.height = 48;
  const x = c.getContext('2d')!; x.fillStyle = '#f80'; x.fillRect(0, 0, 64, 48);
  const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), 'image/png'));
  const doc = await importFile({ name: 'test.png', data: await blob.arrayBuffer() });
  addDoc(doc);
  return { w: doc.width, h: doc.height, layers: doc.layers.length };
};
