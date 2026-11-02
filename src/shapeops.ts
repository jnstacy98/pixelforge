// Boolean operations on vector shapes (Unite / Subtract / Intersect / Exclude) via polygon clipping (pure; unit-tested).
// Curves are flattened to fine polylines, so the result is a compound shape of straight-edged rings.
import * as pcNs from 'polygon-clipping';
import { makeShape, shapeCmds, type Cmd, type ShapeData } from './shapemath.ts';
// polygon-clipping is CommonJS: the API is on the namespace or on its default export depending on the loader
const pc = ((pcNs as unknown as { default?: typeof pcNs }).default ?? pcNs) as typeof pcNs;

export type BoolOp = 'unite' | 'subtract' | 'intersect' | 'exclude';
type Ring = [number, number][];

/** The shape's closed outlines in document coordinates; null if it has an open sub-path. */
export function flattenShape(s: ShapeData, step = 1.5): Ring[] | null {
  const rings: Ring[] = [];
  let cur: Ring = [], closed = true;
  const flush = () => { if (cur.length) { if (!closed) rings.push(Object.assign(cur, { open: true })); else rings.push(cur); } cur = []; };
  let px = 0, py = 0;
  for (const c of shapeCmds(s) as Cmd[]) {
    if (c[0] === 'M') { flush(); closed = false; cur = [[c[1], c[2]]]; px = c[1]; py = c[2]; }
    else if (c[0] === 'L') { cur.push([c[1], c[2]]); px = c[1]; py = c[2]; }
    else if (c[0] === 'C') {
      const len = Math.hypot(c[1] - px, c[2] - py) + Math.hypot(c[3] - c[1], c[4] - c[2]) + Math.hypot(c[5] - c[3], c[6] - c[4]);
      const n = Math.max(6, Math.min(96, Math.ceil(len / step)));
      for (let k = 1; k <= n; k++) { const t = k / n, u = 1 - t; cur.push([u * u * u * px + 3 * u * u * t * c[1] + 3 * u * t * t * c[3] + t * t * t * c[5], u * u * u * py + 3 * u * u * t * c[2] + 3 * u * t * t * c[4] + t * t * t * c[6]]); }
      px = c[5]; py = c[6];
    } else { closed = true; flush(); }
  }
  flush();
  if (rings.some((r) => (r as Ring & { open?: boolean }).open)) return null;
  return rings.filter((r) => r.length >= 3);
}
/** Even-odd region of a shape as polygons-with-holes. */
function region(rings: Ring[]): pcNs.MultiPolygon {
  if (!rings.length) return [];
  const polys = rings.map((r) => [r] as pcNs.Polygon);
  return polys.length === 1 ? polys : pc.xor(polys[0], ...polys.slice(1));
}
/**
 * Combine shapes (listed back-to-front). Unite = all together; Subtract = the first minus the rest; Intersect = where all
 * overlap; Exclude = where an odd number overlap. The result takes the first shape's fill and stroke.
 */
export function combineShapes(op: BoolOp, shapes: ShapeData[]): ShapeData | null {
  if (shapes.length < 2) return null;
  const regs: pcNs.MultiPolygon[] = [];
  for (const s of shapes) { const r = flattenShape(s); if (!r) return null; regs.push(region(r)); }
  let out: pcNs.MultiPolygon;
  const [a, ...rest] = regs;
  if (op === 'unite') out = pc.union(a, ...rest);
  else if (op === 'subtract') out = pc.difference(a, ...rest);
  else if (op === 'intersect') out = pc.intersection(a, ...rest);
  else out = pc.xor(a, ...rest);
  const rings: Ring[] = [];
  for (const poly of out) for (const ring of poly) { const r = ring.slice(0, ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? -1 : undefined) as Ring; if (r.length >= 3) rings.push(r); }
  if (!rings.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rings) for (const [x, y] of r) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const first = shapes[0];
  return makeShape('compound', x1 - x0, y1 - y0, x0, y0, { contours: rings.map((r) => r.map(([x, y]) => [x - x0, y - y0] as [number, number])), fill: first.fill, stroke: first.stroke, strokeW: first.strokeW });
}
/** Area of a compound shape (even-odd), for tests. */
export function compoundArea(s: ShapeData): number {
  const ring = (r: Ring) => Math.abs(r.reduce((a, p, i) => a + (p[0] * r[(i + 1) % r.length][1] - r[(i + 1) % r.length][0] * p[1]), 0) / 2);
  const rs = (s.contours ?? []).map(ring);
  // outer rings add, holes (rings contained in another ring) subtract: polygon-clipping emits outers and holes as separate rings
  return rs.reduce((a, v, i) => a + (isHole(s.contours!, i) ? -v : v), 0);
}
function isHole(contours: Ring[], i: number) {
  const [x, y] = contours[i][0]; let inside = 0;
  contours.forEach((r, j) => { if (j === i) return; let c = false; for (let a = 0, b = r.length - 1; a < r.length; b = a++) if ((r[a][1] > y) !== (r[b][1] > y) && x < ((r[b][0] - r[a][0]) * (y - r[a][1])) / (r[b][1] - r[a][1]) + r[a][0]) c = !c; if (c) inside++; });
  return inside % 2 === 1;
}
