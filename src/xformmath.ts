// Free Transform maths (pure; unit-tested).
import type { Quad } from './smartmath.ts';

/** Pure transform model: source pixel (u, v) → document point = centre + R(angle)·S(sx, sy)·(u − w/2, v − h/2). */
export interface XForm { w: number; h: number; cx: number; cy: number; sx: number; sy: number; angle: number }
export const toDoc = (m: XForm, u: number, v: number): [number, number] => {
  const r = (m.angle * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r), x = (u - m.w / 2) * m.sx, y = (v - m.h / 2) * m.sy;
  return [m.cx + x * c - y * s, m.cy + x * s + y * c];
};
export const toLocal = (m: XForm, X: number, Y: number): [number, number] => {
  const r = (m.angle * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r), dx = X - m.cx, dy = Y - m.cy;
  const x = dx * c + dy * s, y = -dx * s + dy * c;
  return [x / (m.sx || 1e-9) + m.w / 2, y / (m.sy || 1e-9) + m.h / 2];
};
export const corners = (m: XForm): Quad => [...toDoc(m, 0, 0), ...toDoc(m, m.w, 0), ...toDoc(m, m.w, m.h), ...toDoc(m, 0, m.h)] as Quad;
export type Handle = 'tl' | 't' | 'tr' | 'r' | 'br' | 'b' | 'bl' | 'l';
const HP: Record<Handle, [number, number]> = { tl: [0, 0], t: [0.5, 0], tr: [1, 0], r: [1, 0.5], br: [1, 1], b: [0.5, 1], bl: [0, 1], l: [0, 0.5] };
export const HANDLES = Object.keys(HP) as Handle[];
export const handlePos = (m: XForm, h: Handle) => toDoc(m, HP[h][0] * m.w, HP[h][1] * m.h);

/** Drag a handle to (X, Y): the opposite handle (or the centre with `fromCentre`) stays put; `uniform` keeps the aspect ratio. */
export function dragHandle(m: XForm, h: Handle, X: number, Y: number, uniform: boolean, fromCentre: boolean): XForm {
  const [hu, hv] = [HP[h][0] * m.w, HP[h][1] * m.h], [au, av] = fromCentre ? [m.w / 2, m.h / 2] : [m.w - hu, m.h - hv];
  const [Ax, Ay] = toDoc(m, au, av);
  const r = (m.angle * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r), dx = X - Ax, dy = Y - Ay;
  const lx = dx * c + dy * s, ly = -dx * s + dy * c;                       // pointer relative to the anchor, in the box's own axes
  let sx = m.sx, sy = m.sy;
  const xEdge = h !== 't' && h !== 'b', yEdge = h !== 'l' && h !== 'r';
  if (xEdge && Math.abs(hu - au) > 1e-9) sx = lx / (hu - au);
  if (yEdge && Math.abs(hv - av) > 1e-9) sy = ly / (hv - av);
  if (uniform && xEdge && yEdge) { const k = Math.max(Math.abs(sx / m.sx), Math.abs(sy / m.sy)); sx = Math.sign(sx || 1) * Math.abs(m.sx) * k; sy = Math.sign(sy || 1) * Math.abs(m.sy) * k; }
  else if (uniform) { if (!xEdge) sx = Math.sign(m.sx) * Math.abs(sy / m.sy * m.sx); else sy = Math.sign(m.sy) * Math.abs(sx / m.sx * m.sy); }
  const next = { ...m, sx: Math.abs(sx) < 0.01 ? 0.01 * Math.sign(sx || 1) : sx, sy: Math.abs(sy) < 0.01 ? 0.01 * Math.sign(sy || 1) : sy };
  // choose the centre so the anchor stays where it was
  const [px, py] = [(au - m.w / 2) * next.sx, (av - m.h / 2) * next.sy];
  next.cx = Ax - (px * c - py * s); next.cy = Ay - (px * s + py * c);
  return next;
}
export const rotateTo = (m: XForm, X: number, Y: number, startAngle: number, grab: number, snap: boolean): XForm => {
  let a = startAngle + (Math.atan2(Y - m.cy, X - m.cx) * 180) / Math.PI - grab;
  if (snap) a = Math.round(a / 15) * 15;
  return { ...m, angle: a };
};

