// Help menu: user guide, keyboard shortcuts, update checker, About.
import { app } from './state';
import type { UpdateStatus } from './io';

const REPO = 'https://github.com/jnstacy98/pixelforge';
const RELEASES = `${REPO}/releases`;

const openLink = (url: string) => (window.native?.openExternal ? window.native.openExternal(url) : void window.open(url, '_blank', 'noopener'));

// ------------------------------------------------------------------ content
interface Topic { title: string; body: string[] }   // body: paragraphs; a line starting with "• " is a bullet

export const GUIDE: Topic[] = [
  { title: 'Getting started', body: [
    'PixelForge opens and saves layered PSD files and edits PNG, JPEG, WebP, GIF, BMP, AVIF, ICO, SVG and TIFF images.',
    '• File ▸ New (Ctrl+N) starts a blank document; File ▸ Open (Ctrl+O) opens files — or just drag them onto the window.',
    '• Ctrl+S saves a layered PSD, Ctrl+Shift+S exports a PNG. Export JPEG, WebP, BMP and TIFF from the File menu.',
    '• Several documents can be open at once; switch between them with the tabs above the canvas.',
    '• Everything is undoable — watch the History panel, and use Ctrl+Z / Ctrl+Shift+Z.',
  ] },
  { title: 'Tools & brushes', body: [
    'Pick tools from the tool bar or with a key: V move, M marquee, L lasso, Q quick selection, W magic wand, B brush, S clone stamp, J healing brush, K spot healing, P patch, E eraser, G bucket, D gradient, T text, I eyedropper, H hand.',
    '• Settings for the active tool (size, hardness, opacity…) appear in the options bar. [ and ] change the brush size.',
    '• X swaps the foreground and background colours; D resets them to black and white.',
    '• Hold Space and drag to pan; use View ▸ Zoom In / Out, Fit on Screen (Ctrl+0) and Actual Pixels (Ctrl+1).',
  ] },
  { title: 'Layers, groups & masks', body: [
    '• The Layers panel lets you add, duplicate, reorder (drag), merge down (Ctrl+E), rename (double-click) and set opacity and blend mode.',
    '• Ctrl+click or Shift+click to select several layers, then Ctrl+G to group them. Ctrl+Shift+G ungroups.',
    '• Layer ▸ Add Layer Mask lets you hide parts of a layer non-destructively: paint white to reveal, black to hide.',
    '• Ctrl+Alt+G makes a clipping mask. Layer ▸ Layer Style adds shadows, strokes, glows and more; Blend If controls how a layer blends with those below.',
    '• File ▸ Import Layers from File (or Shift+drop) merges another document\'s layers into the open one.',
  ] },
  { title: 'Selections & retouching', body: [
    '• Make selections with the marquee, lasso, quick selection or magic wand. Shift adds, Alt subtracts. Ctrl+A selects all, Ctrl+D deselects, Ctrl+Shift+I inverts.',
    '• Healing Brush, Spot Healing and Patch repair blemishes; Alt+click sets the source for the clone and healing tools.',
    '• Edit ▸ Content-Aware Fill (Shift+F5) fills a selection with new content built from its surroundings.',
  ] },
  { title: 'Adjustments & filters', body: [
    '• Adjust ▸ Levels (Ctrl+L), Curves (Ctrl+M), Brightness/Contrast, Hue/Saturation, Invert (Ctrl+I) and more apply directly to the active layer.',
    '• For non-destructive edits use Layer ▸ New Adjustment Layer, which you can edit, mask or hide at any time.',
    '• Convert a layer to a Smart Object (Layer menu) so filters stay editable and the original pixels are kept.',
  ] },
  { title: 'Customising the workspace', body: [
    '• Drag the tool bar by its grip to dock it on any edge, or float it. The options bar can go top or bottom.',
    '• Drag the panel column by its grip to dock it left or right; drag the Layers / History titles to reorder them.',
    '• View ▸ Customize Toolbar lets you show, hide and reorder tools. View ▸ Reset Toolbars & Panels restores the defaults.',
  ] },
  { title: 'Updating PixelForge', body: [
    '• Choose Help ▸ Check for Updates… at any time. PixelForge also checks quietly a few seconds after it starts.',
    '• When a new version is available you can download it, then Restart & Install. If you choose Later, it installs the next time you close PixelForge.',
    '• Your documents and settings are never touched by an update.',
    '• The portable .exe cannot update itself — Check for Updates opens the download page instead; download the new portable exe from there.',
  ] },
  { title: 'Troubleshooting', body: [
    '• Large images feel slow? Close other documents, and flatten or merge layers you no longer need to edit.',
    '• Windows SmartScreen warning when installing? Choose More info ▸ Run anyway. The installer is not code-signed yet.',
    '• To uninstall, use Windows Settings ▸ Apps ▸ PixelForge ▸ Uninstall.',
    '• Found a bug or have an idea? Help ▸ Report a Problem opens the issue tracker.',
  ] },
];

export const SHORTCUTS: [string, [string, string][]][] = [
  ['Tools', [['V', 'Move'], ['M', 'Marquee'], ['L', 'Lasso (press again: freehand ⇄ polygonal)'], ['Q', 'Quick selection'], ['W', 'Magic wand'], ['B', 'Brush'], ['S', 'Clone stamp'], ['J', 'Healing brush'], ['P', 'Patch'], ['K', 'Spot healing'], ['E', 'Eraser'], ['G', 'Bucket'], ['D', 'Gradient'], ['T', 'Text'], ['I', 'Eyedropper'], ['H', 'Hand'], ['[  ]', 'Brush size smaller / larger'], ['X', 'Swap foreground / background'], ['Space + drag', 'Pan']]],
  ['File', [['Ctrl+N', 'New document'], ['Ctrl+O', 'Open'], ['Ctrl+S', 'Save as PSD'], ['Ctrl+Shift+S', 'Export PNG'], ['Ctrl+W', 'Close']]],
  ['Edit', [['Ctrl+Z', 'Undo'], ['Ctrl+Shift+Z / Ctrl+Y', 'Redo'], ['Ctrl+T', 'Free transform'], ['Shift+F5', 'Content-aware fill'], ['Ctrl+A', 'Select all'], ['Ctrl+D', 'Deselect'], ['Ctrl+Shift+I', 'Invert selection']]],
  ['Layers', [['Ctrl+Shift+N', 'New layer'], ['Ctrl+J', 'Duplicate layer'], ['Ctrl+G', 'Group layers'], ['Ctrl+Shift+G', 'Ungroup'], ['Ctrl+Alt+G', 'Clipping mask'], ['Ctrl+E', 'Merge down']]],
  ['Adjust & View', [['Ctrl+L', 'Levels'], ['Ctrl+M', 'Curves'], ['Ctrl+Shift+L', 'Auto levels'], ['Ctrl+I', 'Invert'], ['Ctrl+0', 'Fit on screen'], ['Ctrl+1', 'Actual pixels'], ['Ctrl+ =  /  Ctrl+ -', 'Zoom in / out']]],
];

// ------------------------------------------------------------------ dialog plumbing
function modal(title: string, wide = false) {
  const back = document.createElement('div'); back.className = 'modal-back';
  const box = document.createElement('div'); box.className = 'modal help-modal' + (wide ? ' wide' : '');
  box.tabIndex = -1;
  const h = document.createElement('h2'); h.textContent = title; box.append(h);
  const body = document.createElement('div'); body.className = 'help-body'; box.append(body);
  const btns = document.createElement('div'); btns.className = 'btns'; box.append(btns);
  let onClose: (() => void) | null = null;
  const close = () => { back.remove(); onClose?.(); };
  back.onmousedown = (e) => { if (e.target === back) close(); };
  box.onkeydown = (e) => { if (e.key === 'Escape') close(); };
  const button = (label: string, fn: () => void, primary = false) => {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = label; if (primary) b.className = 'primary';
    b.onclick = fn; btns.append(b); return b;
  };
  back.append(box); document.body.append(back); box.focus();
  return { box, body, btns, close, button, set onClose(f: () => void) { onClose = f; } };
}

const link = (text: string, url: string) => {
  const a = document.createElement('a'); a.textContent = text; a.href = url; a.className = 'help-link';
  a.onclick = (e) => { e.preventDefault(); openLink(url); };
  return a;
};

function renderTopic(into: HTMLElement, t: Topic) {
  into.innerHTML = '';
  const h = document.createElement('h3'); h.textContent = t.title; into.append(h);
  let ul: HTMLUListElement | null = null;
  for (const line of t.body) {
    if (line.startsWith('• ')) {
      if (!ul) { ul = document.createElement('ul'); into.append(ul); }
      const li = document.createElement('li'); li.textContent = line.slice(2); ul.append(li);
    } else { ul = null; const p = document.createElement('p'); p.textContent = line; into.append(p); }
  }
}

// ------------------------------------------------------------------ user guide
export function openGuide(topic = 0) {
  const m = modal('PixelForge User Guide', true);
  const wrap = document.createElement('div'); wrap.className = 'guide';
  const nav = document.createElement('nav'); const page = document.createElement('div'); page.className = 'page';
  wrap.append(nav, page); m.body.append(wrap);
  const items: HTMLElement[] = [];
  const show = (i: number) => { items.forEach((el, j) => el.classList.toggle('on', i === j)); renderTopic(page, GUIDE[i]); page.scrollTop = 0; };
  GUIDE.forEach((t, i) => { const el = document.createElement('div'); el.className = 'topic'; el.textContent = t.title; el.onclick = () => show(i); nav.append(el); items.push(el); });
  show(topic);
  m.button('Keyboard Shortcuts', () => { m.close(); openShortcuts(); });
  m.button('Full documentation online', () => openLink(`${REPO}#readme`));
  m.button('Close', m.close, true);
}

export function openShortcuts() {
  const m = modal('Keyboard Shortcuts', true);
  const grid = document.createElement('div'); grid.className = 'shortcuts';
  for (const [group, rows] of SHORTCUTS) {
    const sec = document.createElement('section'); const h = document.createElement('h3'); h.textContent = group; sec.append(h);
    for (const [k, d] of rows) {
      const r = document.createElement('div'); r.className = 'srow';
      const kk = document.createElement('kbd'); kk.textContent = k; const dd = document.createElement('span'); dd.textContent = d;
      r.append(kk, dd); sec.append(r);
    }
    grid.append(sec);
  }
  m.body.append(grid);
  m.button('Close', m.close, true);
}

// ------------------------------------------------------------------ about
export async function openAbout() {
  const info = await window.native?.info?.();
  const m = modal('About PixelForge');
  const p = document.createElement('p');
  p.textContent = `Version ${info?.version ?? 'web build'}${info ? ` (${info.platform} ${info.arch})` : ''}`;
  const q = document.createElement('p'); q.textContent = 'A Photoshop-inspired image editor with layers, brushes and PSD support. Released under the MIT licence.';
  m.body.append(p, q, link(REPO, REPO));
  m.button('Check for Updates…', () => { m.close(); checkForUpdates(); });
  m.button('OK', m.close, true);
}

// ------------------------------------------------------------------ updates
let updateDialog: ReturnType<typeof modal> | null = null;
let lastUpdate: UpdateStatus | null = null;
let announced = false;

function renderUpdate(s: UpdateStatus) {
  lastUpdate = s;
  const d = updateDialog; if (!d) return;
  d.body.innerHTML = ''; d.btns.innerHTML = '';
  const msg = (t: string) => { const p = document.createElement('p'); p.textContent = t; d.body.append(p); return p; };
  switch (s.state) {
    case 'checking': case 'busy': msg('Checking for updates…'); d.button('Close', d.close); break;
    case 'current': msg('You\'re up to date — this is the newest version of PixelForge.'); d.button('OK', d.close, true); break;
    case 'available':
      msg(`PixelForge ${s.version} is available.`);
      if (s.notes) { const n = document.createElement('div'); n.className = 'notes'; n.textContent = s.notes.replace(/<[^>]+>/g, ''); d.body.append(n); }
      d.button('Release notes', () => openLink(`${RELEASES}/tag/v${s.version}`));
      d.button('Later', d.close);
      d.button('Download update', () => { renderUpdate({ state: 'downloading', percent: 0 }); window.native?.downloadUpdate?.(); }, true);
      break;
    case 'downloading': {
      msg(`Downloading update… ${s.percent}%`);
      const bar = document.createElement('div'); bar.className = 'progress'; const fill = document.createElement('div'); fill.style.width = s.percent + '%'; bar.append(fill); d.body.append(bar);
      d.button('Hide', d.close); break;
    }
    case 'ready':
      msg(`PixelForge ${s.version} is ready to install. Unsaved work will prompt you before PixelForge restarts.`);
      d.button('Later', d.close);
      d.button('Restart & Install', () => { window.native?.installUpdate?.(); }, true);
      break;
    case 'unsupported':
      msg(window.native
        ? (s.portable ? 'The portable version can\'t update itself. Download the newest portable exe from the releases page.' : 'This is a development build, which isn\'t updated automatically. Get the newest installer from the releases page.')
        : 'You\'re running PixelForge in a browser, which always uses the latest deployed version. Reload the page to update.');
      if (window.native) d.button('Open download page', () => openLink(RELEASES), true);
      d.button('Close', d.close);
      break;
    case 'error':
      msg('Couldn\'t check for updates. Check your internet connection and try again.');
      const det = document.createElement('p'); det.className = 'dim'; det.textContent = s.message; d.body.append(det);
      d.button('Download page', () => openLink(RELEASES)); d.button('Try again', () => checkForUpdates(), true);
      break;
  }
}

export async function checkForUpdates() {
  if (updateDialog) updateDialog.close();
  updateDialog = modal('Check for Updates');
  updateDialog.onClose = () => { updateDialog = null; };
  if (!window.native?.checkForUpdates) return renderUpdate({ state: 'unsupported' });
  renderUpdate({ state: 'checking' });
  const r = await window.native.checkForUpdates();
  if (r.state === 'unsupported') renderUpdate(r as UpdateStatus);   // otherwise the answer arrives as an update-status event
}

/** Wire the main process's update events to the UI; also announces a new version once, quietly, as a toast. */
export function initUpdates() {
  window.native?.onUpdateStatus?.((s) => {
    if (updateDialog) return renderUpdate(s);
    if (s.state === 'available' && !announced) { announced = true; app.toast(`PixelForge ${s.version} is available — Help ▸ Check for Updates…`); lastUpdate = s; }
    if (s.state === 'ready') app.toast('Update downloaded — it will install when you close PixelForge');
  });
}
export const pendingUpdate = () => lastUpdate;
