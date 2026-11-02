// Vector shape layers: geometry as exact path commands (pure; unit-tested). A shape lives in its own local box
// (0,0)–(w,h); `T` is the affine matrix [a b c d e f] taking local points to document points, so moving, scaling and
// rotating a shape never degrades it — the layer's pixels are simply re-rendered from this data.
export type ShapeKind = 'rect' | 'ellipse' | 'polygon' | 'star' | 'path';
export type Mat = [number, number, number, number, number, number];
export interface ShapeData {
  kind: ShapeKind;
  w: number; h: number;
  T: Mat;
  radius: number;            // rect corner radius (px, local)
  sides: number;             // polygon corners / star points
  inner: number;             // star inner radius as a fraction of the outer (0.1…0.95)
  pts: [number, number][];   // path points (local)
  closed: boolean;
  fill: string | null;
  stroke: string | null;
  strokeW: number;
}
export type Cmd = ['M', number, number] | ['L', number, number] | ['C', number, number, number, number, number, number] | ['Z'];
export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];
const K = 0.5522847498;      // cubic Bézier circle constant

export const cloneShape = (s: ShapeData | null): ShapeData | null => (s ? { ...s, T: [...s.T] as Mat, pts: s.pts.map((p) => [...p] as [number, number]) } : null);
export const SHAPE_LABELS: Record<ShapeKind, string> = { rect: 'Rectangle', ellipse: 'Ellipse', polygon: 'Polygon', star: 'Star', path: 'Path' };

export function makeShape(kind: ShapeKind, w: number, h: number, x: number, y: number, style: Partial<ShapeData> = {}): ShapeData {
  return { kind, w, h, T: [1, 0, 0, 1, x, y], radius: 0, sides: 5, inner: 0.5, pts: [], closed: true, fill: '#3a7bd5', stroke: null, strokeW: 4, ...style };
}

/** Geometry in local coordinates. */
export function localCmds(s: ShapeData): Cmd[] {
  const { w, h } = s, out: Cmd[] = [];
  switch (s.kind) {
    case 'rect': {
      const r = Math.max(0, Math.min(s.radius, w / 2, h / 2));
      if (r < 0.01) return [['M', 0, 0], ['L', w, 0], ['L', w, h], ['L', 0, h], ['Z']];
      const k = r * (1 - K);
      return [['M', r, 0], ['L', w - r, 0], ['C', w - k, 0, w, k, w, r], ['L', w, h - r], ['C', w, h - k, w - k, h, w - r, h], ['L', r, h], ['C', k, h, 0, h - k, 0, h - r], ['L', 0, r], ['C', 0, k, k, 0, r, 0], ['Z']];
    }
    case 'ellipse': {
      const cx = w / 2, cy = h / 2, rx = w / 2, ry = h / 2, kx = rx * K, ky = ry * K;
      return [['M', cx + rx, cy], ['C', cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry], ['C', cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy], ['C', cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry], ['C', cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy], ['Z']];
    }
    case 'polygon': case 'star': {
      const n = Math.max(3, Math.min(60, Math.round(s.sides))), star = s.kind === 'star', cx = w / 2, cy = h / 2, rx = w / 2, ry = h / 2, inner = Math.max(0.05, Math.min(0.98, s.inner));
      const count = star ? n * 2 : n;
      for (let i = 0; i < count; i++) {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / count, f = star && i % 2 ? inner : 1;
        out.push([i ? 'L' : 'M', cx + Math.cos(a) * rx * f, cy + Math.sin(a) * ry * f]);
      }
      out.push(['Z']);
      return out;
    }
    case 'path': {
      s.pts.forEach(([x, y], i) => out.push([i ? 'L' : 'M', x, y]));
      if (s.closed && s.pts.length > 2) out.push(['Z']);
      return out;
    }
  }
}
export const apply = (m: Mat, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
/** Geometry in document coordinates. */
export function shapeCmds(s: ShapeData): Cmd[] {
  return localCmds(s).map((c): Cmd => {
    if (c[0] === 'Z') return c;
    if (c[0] === 'C') { const [a, b] = apply(s.T, c[1], c[2]), [d, e] = apply(s.T, c[3], c[4]), [f, g] = apply(s.T, c[5], c[6]); return ['C', a, b, d, e, f, g]; }
    const [x, y] = apply(s.T, c[1], c[2]); return [c[0], x, y];
  });
}
/** Bounding box of the control polygon (an over-estimate for curves), grown by half the stroke. */
export function shapeBounds(s: ShapeData) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of shapeCmds(s)) for (let i = 1; i < c.length; i += 2) { const x = c[i] as number, y = c[i + 1] as number; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const g = s.stroke ? s.strokeW / 2 + 1 : 0;
  return { x0: x0 - g, y0: y0 - g, x1: x1 + g, y1: y1 + g };
}
/** Compose a matrix (applied after the shape's own transform). */
export function transformShape(s: ShapeData, M: Mat): ShapeData {
  const T = s.T, n: Mat = [M[0] * T[0] + M[2] * T[1], M[1] * T[0] + M[3] * T[1], M[0] * T[2] + M[2] * T[3], M[1] * T[2] + M[3] * T[3], M[0] * T[4] + M[2] * T[5] + M[4], M[1] * T[4] + M[3] * T[5] + M[5]];
  return { ...cloneShape(s)!, T: n };
}
export const translateShape = (s: ShapeData, dx: number, dy: number) => transformShape(s, [1, 0, 0, 1, dx, dy]);

/** A shape dragged out from (x0,y0) to (x1,y1). Shift = square / circle, Alt = from the centre. */
export function shapeFromDrag(kind: Exclude<ShapeKind, 'path'>, x0: number, y0: number, x1: number, y1: number, o: { shift?: boolean; alt?: boolean }, style: Partial<ShapeData> = {}): ShapeData | null {
  let dx = x1 - x0, dy = y1 - y0;
  if (o.shift) { const m = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx || 1) * m; dy = Math.sign(dy || 1) * m; }
  let bx = x0, by = y0, bw = dx, bh = dy;
  if (o.alt) { bx = x0 - dx; by = y0 - dy; bw = dx * 2; bh = dy * 2; }
  if (bw < 0) { bx += bw; bw = -bw; }
  if (bh < 0) { by += bh; bh = -bh; }
  if (bw < 1 || bh < 1) return null;
  return makeShape(kind, bw, bh, bx, by, style);
}
/** A path through document points (a line is a two-point open path). */
export function shapeFromPoints(pts: [number, number][], closed: boolean, style: Partial<ShapeData> = {}): ShapeData | null {
  if (pts.length < 2) return null;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]), x0 = Math.min(...xs), y0 = Math.min(...ys);
  const local = pts.map(([x, y]) => [x - x0, y - y0] as [number, number]);
  return makeShape('path', Math.max(...xs) - x0, Math.max(...ys) - y0, x0, y0, { pts: local, closed: closed && pts.length > 2, fill: closed && pts.length > 2 ? '#3a7bd5' : null, stroke: '#000000', strokeW: 4, ...style });
}
/** Decompose T (rotation + scale, no skew) for the Free Transform model. */
export function decompose(T: Mat) { return { sx: Math.hypot(T[0], T[1]), sy: Math.hypot(T[2], T[3]), angle: (Math.atan2(T[1], T[0]) * 180) / Math.PI }; }
/** Matrix from rotation/scale about a local centre that should land at (cx, cy). */
export function composeAbout(w: number, h: number, cx: number, cy: number, sx: number, sy: number, angleDeg: number): Mat {
  const r = (angleDeg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r), a = c * sx, b = s * sx, cc = -s * sy, d = c * sy;
  return [a, b, cc, d, cx - (a * w / 2 + cc * h / 2), cy - (b * w / 2 + d * h / 2)];
}
