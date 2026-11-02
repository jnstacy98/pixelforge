// Vector shape layers: geometry as exact path commands (pure; unit-tested). A shape lives in its own local box
// (0,0)–(w,h); `T` is the affine matrix [a b c d e f] taking local points to document points, so moving, scaling and
// rotating a shape never degrades it — the layer's pixels are simply re-rendered from this data.
export type ShapeKind = 'rect' | 'ellipse' | 'polygon' | 'star' | 'path' | 'compound';
export interface Handles { i: [number, number]; o: [number, number] }
export type Mat = [number, number, number, number, number, number];
export interface ShapeData {
  kind: ShapeKind;
  w: number; h: number;
  T: Mat;
  radius: number;            // rect corner radius (px, local)
  sides: number;             // polygon corners / star points
  inner: number;             // star inner radius as a fraction of the outer (0.1…0.95)
  pts: [number, number][];   // path anchor points (local)
  /** Bézier handles per anchor, as offsets from it (null = corner). Same length as `pts` when present. */
  curves?: (Handles | null)[];
  /** Compound shapes (results of Combine Shapes): closed polygon rings in local coordinates, filled with the even-odd rule. */
  contours?: [number, number][][];
  closed: boolean;
  fill: string | null;
  stroke: string | null;
  strokeW: number;
}
export type Cmd = ['M', number, number] | ['L', number, number] | ['C', number, number, number, number, number, number] | ['Z'];
export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];
const K = 0.5522847498;      // cubic Bézier circle constant

export const cloneShape = (s: ShapeData | null): ShapeData | null => (s ? { ...s, T: [...s.T] as Mat, pts: s.pts.map((p) => [...p] as [number, number]), ...(s.contours ? { contours: s.contours.map((r) => r.map((p) => [...p] as [number, number])) } : {}), ...(s.curves ? { curves: s.curves.map((c) => (c ? { i: [...c.i] as [number, number], o: [...c.o] as [number, number] } : null)) } : {}) } : null);
export const SHAPE_LABELS: Record<ShapeKind, string> = { rect: 'Rectangle', ellipse: 'Ellipse', polygon: 'Polygon', star: 'Star', path: 'Path', compound: 'Combined Shape' };

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
    case 'compound':
      for (const ring of s.contours ?? []) { ring.forEach(([x, y], i) => out.push([i ? 'L' : 'M', x, y])); if (ring.length) out.push(['Z']); }
      return out;
    case 'path': {
      const n = s.pts.length, closed = s.closed && n > 2, cv = s.curves;
      if (!n) return out;
      out.push(['M', s.pts[0][0], s.pts[0][1]]);
      const seg = (a: number, b: number) => {
        const A = s.pts[a], B = s.pts[b], ho = cv?.[a]?.o, hi = cv?.[b]?.i;
        if (ho || hi) out.push(['C', A[0] + (ho?.[0] ?? 0), A[1] + (ho?.[1] ?? 0), B[0] + (hi?.[0] ?? 0), B[1] + (hi?.[1] ?? 0), B[0], B[1]]);
        else out.push(['L', B[0], B[1]]);
      };
      for (let i = 0; i + 1 < n; i++) seg(i, i + 1);
      if (closed) { seg(n - 1, 0); out.push(['Z']); }
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
/** A path through document points (a line is a two-point open path); `curves` are optional Bézier handles (offsets). */
export function shapeFromPoints(pts: [number, number][], closed: boolean, style: Partial<ShapeData> = {}, curves?: (Handles | null)[]): ShapeData | null {
  if (pts.length < 2) return null;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  curves?.forEach((c, k) => { if (c) for (const h of [c.i, c.o]) { xs.push(pts[k][0] + h[0]); ys.push(pts[k][1] + h[1]); } });   // the box covers the control hull
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  const local = pts.map(([x, y]) => [x - x0, y - y0] as [number, number]);
  const isClosed = closed && pts.length > 2;
  return makeShape('path', Math.max(...xs) - x0, Math.max(...ys) - y0, x0, y0, { pts: local, closed: isClosed, fill: isClosed ? '#3a7bd5' : null, stroke: '#000000', strokeW: 4, ...(curves && curves.some(Boolean) ? { curves: curves.map((c) => c && { i: [...c.i] as [number, number], o: [...c.o] as [number, number] }) } : {}), ...style });
}
/** Inverse of an affine matrix (null if singular). */
export function invertMat(m: Mat): Mat | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return null;
  const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det, z = (v: number) => (v === 0 ? 0 : v);   // (no negative zeros)
  return [z(a), z(b), z(c), z(d), z(-(a * m[4] + c * m[5])), z(-(b * m[4] + d * m[5]))];
}
/** Handles that make anchor `i` a smooth point (tangent parallel to its neighbours' chord, length ⅓ of the shorter side). */
export function autoSmooth(pts: [number, number][], i: number, closed: boolean): Handles {
  const n = pts.length, prev = pts[i > 0 ? i - 1 : closed ? n - 1 : i], next = pts[i + 1 < n ? i + 1 : closed ? 0 : i], p = pts[i];
  let tx = next[0] - prev[0], ty = next[1] - prev[1]; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
  const dp = Math.hypot(p[0] - prev[0], p[1] - prev[1]), dn = Math.hypot(next[0] - p[0], next[1] - p[1]), len = Math.min(dp || dn, dn || dp) / 3;
  return { i: [-tx * len, -ty * len], o: [tx * len, ty * len] };
}
/** Insert an anchor at parameter t of segment i→i+1 (de Casteljau, keeps the curve's shape). Returns the new arrays. */
export function insertAnchor(pts: [number, number][], curves: (Handles | null)[], seg: number, t: number, closed: boolean) {
  const n = pts.length, a = seg, b = (seg + 1) % n, A = pts[a], B = pts[b], ca = curves[a], cb = curves[b];
  const P0 = A, P1: [number, number] = [A[0] + (ca?.o[0] ?? 0), A[1] + (ca?.o[1] ?? 0)], P2: [number, number] = [B[0] + (cb?.i[0] ?? 0), B[1] + (cb?.i[1] ?? 0)], P3 = B;
  const lerp = (p: [number, number], q: [number, number]): [number, number] => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
  const q0 = lerp(P0, P1), q1 = lerp(P1, P2), q2 = lerp(P2, P3), r0 = lerp(q0, q1), r1 = lerp(q1, q2);
  const straight = !ca?.o && !cb?.i, m = straight ? lerp(A, B) : lerp(r0, r1);
  const np = pts.map((p) => [...p] as [number, number]), nc = curves.map((c) => (c ? { i: [...c.i] as [number, number], o: [...c.o] as [number, number] } : null));
  if (!straight) {
    nc[a] = { i: nc[a]?.i ?? [0, 0], o: [q0[0] - A[0], q0[1] - A[1]] };
    nc[b] = { i: [q2[0] - B[0], q2[1] - B[1]], o: nc[b]?.o ?? [0, 0] };
  }
  const at = a + 1;                                                 // closing segment (last → first) appends at the end
  np.splice(at, 0, m); nc.splice(at, 0, straight ? null : { i: [r0[0] - m[0], r0[1] - m[1]], o: [r1[0] - m[0], r1[1] - m[1]] });
  void closed;
  return { pts: np, curves: nc };
}
/** Distance from point to the nearest spot on the path's segments, with the segment index and parameter. */
export function nearestOnPath(s: ShapeData, x: number, y: number): { d: number; seg: number; t: number } | null {
  const n = s.pts.length; if (n < 2) return null;
  const segs = s.closed && n > 2 ? n : n - 1; let best: { d: number; seg: number; t: number } | null = null;
  for (let a = 0; a < segs; a++) {
    const b = (a + 1) % n, A = s.pts[a], B = s.pts[b], ho = s.curves?.[a]?.o, hi = s.curves?.[b]?.i;
    const P1: [number, number] = [A[0] + (ho?.[0] ?? 0), A[1] + (ho?.[1] ?? 0)], P2: [number, number] = [B[0] + (hi?.[0] ?? 0), B[1] + (hi?.[1] ?? 0)];
    for (let k = 0; k <= 24; k++) {
      const t = k / 24, u = 1 - t, px = u * u * u * A[0] + 3 * u * u * t * P1[0] + 3 * u * t * t * P2[0] + t * t * t * B[0], py = u * u * u * A[1] + 3 * u * u * t * P1[1] + 3 * u * t * t * P2[1] + t * t * t * B[1];
      const d = Math.hypot(px - x, py - y); if (!best || d < best.d) best = { d, seg: a, t };
    }
  }
  return best;
}
/** Decompose T (rotation + scale, no skew) for the Free Transform model. */
export function decompose(T: Mat) { return { sx: Math.hypot(T[0], T[1]), sy: Math.hypot(T[2], T[3]), angle: (Math.atan2(T[1], T[0]) * 180) / Math.PI }; }
/** Matrix from rotation/scale about a local centre that should land at (cx, cy). */
export function composeAbout(w: number, h: number, cx: number, cy: number, sx: number, sy: number, angleDeg: number): Mat {
  const r = (angleDeg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r), a = c * sx, b = s * sx, cc = -s * sy, d = c * sy;
  return [a, b, cc, d, cx - (a * w / 2 + cc * h / 2), cy - (b * w / 2 + d * h / 2)];
}

/** Re-fit a path shape's local box to its (edited) anchors and handles, adjusting T so nothing moves on screen. */
export function normalizePath(s: ShapeData): ShapeData {
  const o = cloneShape(s)!;
  if (o.kind !== 'path' || !o.pts.length) return o;
  const xs = o.pts.map((p) => p[0]), ys = o.pts.map((p) => p[1]);
  o.curves?.forEach((c, k) => { if (c) for (const h of [c.i, c.o]) { xs.push(o.pts[k][0] + h[0]); ys.push(o.pts[k][1] + h[1]); } });
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  o.pts = o.pts.map(([x, y]) => [x - x0, y - y0]);
  o.w = Math.max(...xs) - x0; o.h = Math.max(...ys) - y0;
  const T = o.T; o.T = [T[0], T[1], T[2], T[3], T[0] * x0 + T[2] * y0 + T[4], T[1] * x0 + T[3] * y0 + T[5]];
  return o;
}
