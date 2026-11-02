// Text on a path: arc-length parameterisation and glyph placement (pure; unit-tested).
import type { Cmd } from './shapemath.ts';

export type Pt2 = [number, number];
export interface Poly { pts: Pt2[]; closed: boolean }

/** Flatten path commands into polylines (cubics sampled finely). One entry per sub-path. */
export function flattenCmds(cmds: Cmd[], step = 1.5): Poly[] {
  const out: Poly[] = [];
  let cur: Pt2[] = [], px = 0, py = 0;
  const flush = (closed: boolean) => { if (cur.length > 1) out.push({ pts: cur, closed }); cur = []; };
  for (const c of cmds) {
    if (c[0] === 'M') { flush(false); cur = [[c[1], c[2]]]; px = c[1]; py = c[2]; }
    else if (c[0] === 'L') { cur.push([c[1], c[2]]); px = c[1]; py = c[2]; }
    else if (c[0] === 'C') {
      const len = Math.hypot(c[1] - px, c[2] - py) + Math.hypot(c[3] - c[1], c[4] - c[2]) + Math.hypot(c[5] - c[3], c[6] - c[4]), n = Math.max(6, Math.min(200, Math.ceil(len / step)));
      for (let k = 1; k <= n; k++) { const t = k / n, u = 1 - t; cur.push([u * u * u * px + 3 * u * u * t * c[1] + 3 * u * t * t * c[3] + t * t * t * c[5], u * u * u * py + 3 * u * u * t * c[2] + 3 * u * t * t * c[4] + t * t * t * c[6]]); }
      px = c[5]; py = c[6];
    } else { if (cur.length > 1) cur.push([cur[0][0], cur[0][1]]); flush(true); }
  }
  flush(false);
  return out;
}
/** Cumulative arc length at each vertex. */
export function cumulative(pts: Pt2[]): number[] {
  const out = [0];
  for (let i = 1; i < pts.length; i++) out.push(out[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return out;
}
/** Position and tangent angle (radians) at arc length s; closed paths wrap, open ones return null outside [0, length]. */
export function pointAt(poly: Poly, cum: number[], s: number): { x: number; y: number; angle: number } | null {
  const total = cum[cum.length - 1];
  if (total <= 0) return null;
  if (poly.closed) s = ((s % total) + total) % total; else if (s < 0 || s > total) return null;
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
  const a = poly.pts[lo], b = poly.pts[hi], seg = cum[hi] - cum[lo] || 1, t = (s - cum[lo]) / seg;
  return { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, angle: Math.atan2(b[1] - a[1], b[0] - a[0]) };
}
export const reversePoly = (p: Poly): Poly => ({ pts: [...p.pts].reverse(), closed: p.closed });
/** Distance from a point to a polyline, and the arc length of the nearest spot. */
export function nearestOnPoly(poly: Poly, x: number, y: number): { d: number; s: number } {
  const cum = cumulative(poly.pts); let best = { d: Infinity, s: 0 };
  for (let i = 1; i < poly.pts.length; i++) {
    const a = poly.pts[i - 1], b = poly.pts[i], dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1, t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2));
    const d = Math.hypot(a[0] + dx * t - x, a[1] + dy * t - y);
    if (d < best.d) best = { d, s: cum[i - 1] + Math.sqrt(l2) * t };
  }
  return best;
}

export interface Placed { ch: number; x: number; y: number; angle: number; adv: number }
/**
 * Glyph placements for text whose characters have the given advances. `offset` is where the text starts along the path
 * (left), is centred (centre) or ends (right); `flip` runs the text along the path the other way round (other side).
 */
export function placeGlyphs(advances: number[], poly: Poly, o: { offset: number; align: 'left' | 'center' | 'right'; flip?: boolean }): Placed[] {
  const p = o.flip ? reversePoly(poly) : poly, cum = cumulative(p.pts), total = advances.reduce((a, b) => a + b, 0);
  const start = o.align === 'center' ? o.offset - total / 2 : o.align === 'right' ? o.offset - total : o.offset;
  const out: Placed[] = []; let s = start;
  advances.forEach((adv, i) => {
    const q = pointAt(p, cum, s + adv / 2);
    if (q) out.push({ ch: i, x: q.x, y: q.y, angle: q.angle, adv });
    s += adv;
  });
  return out;
}
