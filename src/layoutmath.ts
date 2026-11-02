// Pure maths for the movable / customizable toolbars (no DOM, unit-tested).
export type Dock = 'left' | 'right' | 'top' | 'bottom';
export type ToolbarPlace = { dock: Dock | 'float'; x: number; y: number };
export type OptionsDock = 'top' | 'bottom';
export interface BarLayout {
  toolbar: ToolbarPlace;
  order: string[];     // tool ids, in display order (hidden ones included so they keep a slot)
  hidden: string[];    // tool ids not shown
  options: OptionsDock;
  panels: 'left' | 'right';   // side the panel column is docked to
  panelOrder: string[];       // panel section ids, top to bottom
}

export const DOCKS: Dock[] = ['left', 'right', 'top', 'bottom'];

export const PANEL_IDS = ['layerpanel', 'historypanel'];

export function defaultLayout(toolIds: string[]): BarLayout {
  return { toolbar: { dock: 'left', x: 80, y: 120 }, order: [...toolIds], hidden: [], options: 'top', panels: 'right', panelOrder: [...PANEL_IDS] };
}

/** Keep the known ids of `raw` in their stored order, then append any missing ones. */
export function sanitizeOrder(raw: unknown, known: string[]): string[] {
  const k = new Set(known), out: string[] = [];
  if (Array.isArray(raw)) for (const id of raw) if (typeof id === 'string' && k.has(id) && !out.includes(id)) out.push(id);
  for (const id of known) if (!out.includes(id)) out.push(id);
  return out;
}

/** Repair a stored layout: drop unknown tools, append new ones, validate every field. */
export function sanitizeLayout(raw: unknown, toolIds: string[]): BarLayout {
  const d = defaultLayout(toolIds);
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Record<string, any>;
  const known = new Set(toolIds);
  const order = sanitizeOrder(r.order, toolIds);
  const hidden = Array.isArray(r.hidden) ? [...new Set(r.hidden.filter((id: unknown): id is string => typeof id === 'string' && known.has(id)))] : [];
  // never allow an empty toolbar: it could not be grabbed or customized again
  if (hidden.length >= order.length) hidden.length = 0;
  const tb = r.toolbar ?? {};
  const dock = tb.dock === 'float' || DOCKS.includes(tb.dock) ? tb.dock : d.toolbar.dock;
  const num = (v: unknown, f: number) => (typeof v === 'number' && isFinite(v) ? v : f);
  return {
    toolbar: { dock, x: num(tb.x, d.toolbar.x), y: num(tb.y, d.toolbar.y) },
    order, hidden, options: r.options === 'bottom' ? 'bottom' : 'top',
    panels: r.panels === 'left' ? 'left' : 'right', panelOrder: sanitizeOrder(r.panelOrder, PANEL_IDS),
  };
}

/** Which dock does a pointer position belong to? Returns null in the middle (=> float). */
export function dockFromPoint(x: number, y: number, w: number, h: number, edge = 70): Dock | null {
  const dl = x, dr = w - x, dt = y, db = h - y;
  const m = Math.min(dl, dr, dt, db);
  if (m > edge) return null;
  if (m === dl) return 'left';
  if (m === dr) return 'right';
  if (m === dt) return 'top';
  return 'bottom';
}

/** Move the item at index `from` so it ends up at index `to` (both in the final array). */
export function moveItem<T>(arr: T[], from: number, to: number): T[] {
  if (from < 0 || from >= arr.length) return arr.slice();
  const out = arr.slice();
  const [it] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, it);
  return out;
}

export const visibleTools = (l: BarLayout) => l.order.filter((id) => !l.hidden.includes(id));

/** Keep a floating bar fully reachable inside the window. */
export function clampFloat(x: number, y: number, bw: number, bh: number, w: number, h: number) {
  return { x: Math.max(0, Math.min(Math.max(0, w - bw), x)), y: Math.max(0, Math.min(Math.max(0, h - bh), y)) };
}
