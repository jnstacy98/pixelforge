// Movable / customizable toolbars: dock the tool bar to any edge or float it, move the options bar
// top/bottom, show/hide and reorder tools. The layout is remembered in localStorage.
import { TOOLS, setToolbarTools } from './ui';
import { DOCKS, PANEL_IDS, clampFloat, defaultLayout, dockFromPoint, moveItem, sanitizeLayout, visibleTools, type BarLayout, type Dock } from './layoutmath';

const KEY = 'pixelforge.layout';
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const ids = TOOLS.map((t) => t.id as string);
let layout: BarLayout = defaultLayout(ids);

function load() {
  try { layout = sanitizeLayout(JSON.parse(localStorage.getItem(KEY) ?? 'null'), ids); } catch { layout = defaultLayout(ids); }
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(layout)); } catch { /* storage unavailable */ } }

export function apply() {
  const bar = $('toolbar'), p = layout.toolbar;
  bar.classList.remove('dock-left', 'dock-right', 'dock-top', 'dock-bottom', 'float', 'dragging');
  bar.classList.add(p.dock === 'float' ? 'float' : 'dock-' + p.dock);
  const host = p.dock === 'float' ? document.body : $('dock-' + p.dock);
  if (bar.parentElement !== host) host.append(bar);
  if (p.dock === 'float') {
    const c = clampFloat(p.x, p.y, bar.offsetWidth, bar.offsetHeight, innerWidth, innerHeight);
    bar.style.left = c.x + 'px'; bar.style.top = c.y + 'px';
  } else { bar.style.left = bar.style.top = ''; }
  const opts = $('options'), oh = $('dock-' + layout.options);
  if (opts.parentElement !== oh) oh.append(opts);
  const pan = $('panels'), ph = $('dock-' + layout.panels);
  if (pan.parentElement !== ph) ph.append(pan);
  pan.classList.toggle('on-left', layout.panels === 'left');
  for (const id of layout.panelOrder) pan.append($(id)); // grip stays first, sections follow in order
  setToolbarTools(visibleTools(layout));
}

const commit = () => { save(); apply(); };
export const getLayout = () => layout;
export function dockToolbar(d: Dock | 'float') {
  layout.toolbar = { ...layout.toolbar, dock: d };
  if (d === 'float') { const r = $('toolbar').getBoundingClientRect(); layout.toolbar.x = r.left + 20; layout.toolbar.y = r.top + 20; }
  commit();
}
export function setOptionsDock(d: 'top' | 'bottom') { layout.options = d; commit(); }
export function setPanelsDock(d: 'left' | 'right') { layout.panels = d; commit(); }
export function movePanel(id: string, before: string | null) {
  const rest = layout.panelOrder.filter((x) => x !== id), i = before ? rest.indexOf(before) : rest.length;
  rest.splice(i < 0 ? rest.length : i, 0, id); layout.panelOrder = rest; commit();
}
export function resetLayout() { layout = defaultLayout(ids); commit(); }
export function setToolVisible(id: string, on: boolean) {
  const hidden = new Set(layout.hidden);
  if (on) hidden.delete(id); else if (visibleTools(layout).length > 1) hidden.add(id);
  layout.hidden = [...hidden]; commit();
}
export function moveTool(id: string, delta: number) {
  const i = layout.order.indexOf(id); if (i < 0) return;
  layout.order = moveItem(layout.order, i, i + delta); commit();
}

// ---------------------------------------------------------------- dragging the grips
const hints = DOCKS.map((d) => { const h = document.createElement('div'); h.className = 'dockhint ' + d; h.dataset.dock = d; document.body.append(h); return h; });
function showHints(active: Dock | null | false, only?: Dock[]) {
  hints.forEach((h) => { const d = h.dataset.dock as Dock; h.classList.toggle('show', active !== false && (!only || only.includes(d))); h.classList.toggle('hot', d === active); });
}
/** Drag the panel column by its grip to the left or right half; drag a panel header to reorder panels. */
function initPanelDrag() {
  const pan = $('panels');
  const grip = document.createElement('div');
  grip.className = 'pgrip'; grip.title = 'Drag to dock the panels on the left or right (right-click for a menu)';
  pan.prepend(grip);
  grip.onpointerdown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); grip.setPointerCapture(e.pointerId);
    const sx = e.clientX, sy = e.clientY; let moved = false, zone: Dock = layout.panels;
    grip.classList.add('dragging');
    grip.onpointermove = (ev) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
      moved = true; zone = ev.clientX < innerWidth / 2 ? 'left' : 'right'; showHints(zone, ['left', 'right']);
    };
    grip.onpointerup = grip.onpointercancel = () => {
      grip.onpointermove = grip.onpointerup = grip.onpointercancel = null; grip.classList.remove('dragging'); showHints(false);
      if (moved && zone !== layout.panels) setPanelsDock(zone as 'left' | 'right');
    };
  };
  const menu = (e: MouseEvent) => {
    e.preventDefault();
    popup(e.clientX, e.clientY, [
      { label: 'Dock Panels Left', check: layout.panels === 'left', action: () => setPanelsDock('left') },
      { label: 'Dock Panels Right', check: layout.panels === 'right', action: () => setPanelsDock('right') }, '-',
      { label: 'Reset Toolbars & Panels', action: resetLayout },
    ]);
  };
  grip.addEventListener('contextmenu', menu);
  // reorder: drag a panel's title bar over another panel
  pan.addEventListener('pointerdown', (e) => {
    const h = (e.target as HTMLElement).closest('h3'); const sec = h?.parentElement as HTMLElement | null | undefined;
    if (!h || !sec || e.button !== 0 || !PANEL_IDS.includes(sec.id)) return;
    const sx = e.clientX, sy = e.clientY; let moved = false, target: HTMLElement | null = null, after = false;
    const clear = () => pan.querySelectorAll('.dz-above,.dz-below').forEach((x) => x.classList.remove('dz-above', 'dz-below'));
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
      moved = true; clear(); target = null;
      for (const o of layout.panelOrder) {
        if (o === sec.id) continue;
        const r = $(o).getBoundingClientRect();
        if (ev.clientY >= r.top && ev.clientY <= r.bottom) { target = $(o); after = ev.clientY > (r.top + r.bottom) / 2; target.classList.add(after ? 'dz-below' : 'dz-above'); }
      }
    };
    const up = () => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up); clear();
      if (!moved || !target) return;
      const order = layout.panelOrder, i = order.indexOf(target.id);
      movePanel(sec.id, after ? order[i + 1] === sec.id ? order[i + 2] ?? null : order[i + 1] ?? null : target.id);
    };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  });
}

/** Drag the options bar by its grip: the top or bottom half of the window decides where it docks. */
function initOptionsGrip() {
  const opts = $('options');
  const grip = document.createElement('div');
  grip.className = 'grip'; grip.title = 'Drag to move the options bar to the top or bottom of the window';
  opts.prepend(grip);
  grip.onpointerdown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); grip.setPointerCapture(e.pointerId);
    const sx = e.clientX, sy = e.clientY; let moved = false, zone: Dock = layout.options;
    grip.classList.add('dragging');
    grip.onpointermove = (ev) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
      moved = true; zone = ev.clientY < innerHeight / 2 ? 'top' : 'bottom'; showHints(zone, ['top', 'bottom']);
    };
    grip.onpointerup = grip.onpointercancel = () => {
      grip.onpointermove = grip.onpointerup = grip.onpointercancel = null; grip.classList.remove('dragging'); showHints(false);
      if (moved && zone !== layout.options) setOptionsDock(zone as 'top' | 'bottom');
    };
  };
}

function initGrip() {
  const bar = $('toolbar');
  const grip = document.createElement('div');
  grip.className = 'grip'; grip.title = 'Drag to move the toolbar — drop on a window edge to dock it, elsewhere to float it (double-click to reset)';
  bar.prepend(grip);
  grip.ondblclick = () => resetLayout();
  grip.onpointerdown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); grip.setPointerCapture(e.pointerId);
    const r = bar.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top, sx = e.clientX, sy = e.clientY;
    let moved = false, zone: Dock | null = null;
    grip.onpointermove = (ev) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
      if (!moved) { moved = true; bar.classList.remove('dock-left', 'dock-right', 'dock-top', 'dock-bottom'); bar.classList.add('float', 'dragging'); }
      bar.style.left = ev.clientX - dx + 'px'; bar.style.top = ev.clientY - dy + 'px';
      zone = dockFromPoint(ev.clientX, ev.clientY, innerWidth, innerHeight);
      showHints(zone);
    };
    grip.onpointerup = grip.onpointercancel = (ev) => {
      grip.onpointermove = grip.onpointerup = grip.onpointercancel = null;
      showHints(false);
      if (!moved) return;
      layout.toolbar = zone ? { ...layout.toolbar, dock: zone } : { dock: 'float', x: ev.clientX - dx, y: ev.clientY - dy };
      commit();
    };
  };
}

// ---------------------------------------------------------------- context menu
function popup(x: number, y: number, items: ('-' | { label: string; action: () => void; check?: boolean })[]) {
  document.querySelectorAll('.popup.tbmenu').forEach((p) => p.remove());
  const el = document.createElement('div'); el.className = 'popup tbmenu';
  for (const it of items) {
    if (it === '-') { const s = document.createElement('div'); s.className = 'sep'; el.append(s); continue; }
    const row = document.createElement('div'); row.className = 'mi'; row.textContent = (it.check ? '✓ ' : '') + it.label;
    row.onclick = () => { el.remove(); it.action(); };
    el.append(row);
  }
  el.style.left = Math.min(x, innerWidth - 220) + 'px'; el.style.top = Math.min(y, innerHeight - items.length * 28) + 'px';
  document.body.append(el);
  const away = (e: Event) => { if (!el.contains(e.target as Node)) { el.remove(); removeEventListener('mousedown', away, true); } };
  addEventListener('mousedown', away, true);
}
function toolbarMenu(e: MouseEvent) {
  e.preventDefault();
  const d = layout.toolbar.dock;
  popup(e.clientX, e.clientY, [
    { label: 'Customize Toolbar…', action: openCustomize }, '-',
    ...DOCKS.map((k) => ({ label: 'Dock ' + k[0].toUpperCase() + k.slice(1), check: d === k, action: () => dockToolbar(k) })),
    { label: 'Floating', check: d === 'float', action: () => dockToolbar('float') }, '-',
    { label: layout.options === 'top' ? 'Move Options Bar to Bottom' : 'Move Options Bar to Top', action: () => setOptionsDock(layout.options === 'top' ? 'bottom' : 'top') },
    { label: 'Reset Toolbars & Panels', action: resetLayout },
  ]);
}
function optionsMenu(e: MouseEvent) {
  const t = e.target as HTMLElement;
  if (t.closest('input,select,textarea')) return; // keep the native menu on form controls
  e.preventDefault();
  popup(e.clientX, e.clientY, [
    { label: layout.options === 'top' ? 'Move Options Bar to Bottom' : 'Move Options Bar to Top', action: () => setOptionsDock(layout.options === 'top' ? 'bottom' : 'top') },
    { label: 'Customize Toolbar…', action: openCustomize },
    { label: 'Reset Toolbars & Panels', action: resetLayout },
  ]);
}

// ---------------------------------------------------------------- customize dialog
export function openCustomize() {
  if (document.querySelector('.tbcust')) return;
  const back = document.createElement('div'); back.className = 'modal-back tbcust';
  const box = document.createElement('div'); box.className = 'modal'; box.style.minWidth = '380px';
  box.innerHTML = '<h2>Customize Toolbar</h2><div class="hint" style="color:var(--dim)">Tick the tools to show; use the arrows to change their order. Hidden tools keep their keyboard shortcuts.</div><div class="cust-list"></div><div class="btns"></div>';
  const list = box.querySelector('.cust-list') as HTMLElement, btns = box.querySelector('.btns') as HTMLElement;
  const byId = new Map(TOOLS.map((t) => [t.id as string, t]));
  const render = () => {
    list.innerHTML = '';
    const vis = visibleTools(layout);
    layout.order.forEach((id, i) => {
      const t = byId.get(id)!;
      const row = document.createElement('div'); row.className = 'cust-row'; row.dataset.tool = id;
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !layout.hidden.includes(id);
      cb.disabled = cb.checked && vis.length <= 1;
      cb.onchange = () => { setToolVisible(id, cb.checked); render(); };
      const ic = document.createElement('span'); ic.className = 'tool'; ic.innerHTML = t.icon;
      const nm = document.createElement('span'); nm.className = 'grow'; nm.textContent = `${t.label.replace(/ \(.*/, '')} (${t.key})`;
      const up = document.createElement('button'); up.textContent = '▲'; up.title = 'Move up'; up.disabled = i === 0; up.onclick = () => { moveTool(id, -1); render(); };
      const dn = document.createElement('button'); dn.textContent = '▼'; dn.title = 'Move down'; dn.disabled = i === layout.order.length - 1; dn.onclick = () => { moveTool(id, 1); render(); };
      row.append(cb, ic, nm, up, dn); list.append(row);
    });
  };
  const reset = document.createElement('button'); reset.textContent = 'Reset'; reset.onclick = () => { resetLayout(); render(); };
  const done = document.createElement('button'); done.textContent = 'Done'; done.className = 'primary';
  const close = () => { back.remove(); removeEventListener('keydown', esc, true); };
  const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  done.onclick = close; back.onmousedown = (e) => { if (e.target === back) close(); }; addEventListener('keydown', esc, true);
  btns.append(reset, done); render();
  back.append(box); document.body.append(back);
}

export function initLayout() {
  load();
  initGrip(); initOptionsGrip(); initPanelDrag();
  $('toolbar').addEventListener('contextmenu', toolbarMenu);
  $('options').addEventListener('contextmenu', optionsMenu);
  addEventListener('resize', () => { if (layout.toolbar.dock === 'float') apply(); });
  apply();
}
