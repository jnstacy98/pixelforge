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


// ---------------------------------------------------------------- perspective / distort / warp
export type Pt2 = [number, number];
/** Projective map from the unit square (0,0)-(1,1) onto a quad TL, TR, BR, BL (Heckbert's square-to-quad). */
export function squareToQuad(q: Quad): (u: number, v: number) => Pt2 {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = q;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3, dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  let a, b, c, d, e, f, g, h;
  if (Math.abs(dx3) < 1e-12 && Math.abs(dy3) < 1e-12) { a = x1 - x0; b = x2 - x1; c = x0; d = y1 - y0; e = y2 - y1; f = y0; g = 0; h = 0; }
  else {
    const den = dx1 * dy2 - dx2 * dy1 || 1e-12;
    g = (dx3 * dy2 - dx2 * dy3) / den; h = (dx1 * dy3 - dx3 * dy1) / den;
    a = x1 - x0 + g * x1; b = x3 - x0 + h * x3; c = x0; d = y1 - y0 + g * y1; e = y3 - y0 + h * y3; f = y0;
  }
  return (u, v) => { const w = g * u + h * v + 1; return [(a * u + b * v + c) / w, (d * u + e * v + f) / w]; };
}
/** (N+1)² mesh vertices (row-major, x/y pairs) of a source mapped through a quad. */
export function quadMesh(q: Quad, N: number): Float64Array {
  const f = squareToQuad(q), out = new Float64Array((N + 1) * (N + 1) * 2);
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) { const [x, y] = f(i / N, j / N), k = (j * (N + 1) + i) * 2; out[k] = x; out[k + 1] = y; }
  return out;
}
/** 4×4 control lattice (row-major x/y pairs, 32 numbers) laid on a quad, so the Bézier surface starts out as that quad. */
export function latticeFromQuad(q: Quad): number[] {
  const f = squareToQuad(q), out: number[] = [];
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) out.push(...f(i / 3, j / 3));
  return out;
}
const bern = (t: number): [number, number, number, number] => { const s = 1 - t; return [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t]; };
/** (N+1)² vertices of the bicubic Bézier surface defined by a 4×4 control lattice. */
export function bezierMesh(grid: number[], N: number): Float64Array {
  const out = new Float64Array((N + 1) * (N + 1) * 2);
  for (let j = 0; j <= N; j++) { const bv = bern(j / N); for (let i = 0; i <= N; i++) {
    const bu = bern(i / N); let x = 0, y = 0;
    for (let b = 0; b < 4; b++) for (let a = 0; a < 4; a++) { const w = bu[a] * bv[b], k = (b * 4 + a) * 2; x += w * grid[k]; y += w * grid[k + 1]; }
    const k = (j * (N + 1) + i) * 2; out[k] = x; out[k + 1] = y;
  } }
  return out;
}
export function meshBounds(mesh: Float64Array) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let k = 0; k < mesh.length; k += 2) { x0 = Math.min(x0, mesh[k]); x1 = Math.max(x1, mesh[k]); y0 = Math.min(y0, mesh[k + 1]); y1 = Math.max(y1, mesh[k + 1]); }
  return { x0, y0, x1, y1 };
}

/**
 * Rasterise an sw×sh RGBA source through a warped mesh (N×N cells of two triangles, source coordinates interpolated
 * barycentrically, bilinear sampling, `ss`×`ss` supersampling for smooth silhouettes). Output covers the doc rectangle
 * (ox, oy, ow, oh); pixels the mesh doesn't touch stay transparent.
 */
export function renderMesh(src: Uint8ClampedArray, sw: number, sh: number, mesh: Float64Array, N: number, ox: number, oy: number, ow: number, oh: number, ss = 2): Uint8ClampedArray {
  const acc = new Float32Array(ow * oh * 4), done = new Uint8Array(ow * oh * ss * ss);
  // premultiplied source
  const pm = new Float32Array(sw * sh * 4);
  for (let p = 0; p < sw * sh; p++) { const a = src[p * 4 + 3] / 255; pm[p * 4] = src[p * 4] * a; pm[p * 4 + 1] = src[p * 4 + 1] * a; pm[p * 4 + 2] = src[p * 4 + 2] * a; pm[p * 4 + 3] = a * 255; }
  const fetch = (u: number, v: number, out: Float32Array) => {                            // bilinear, pixel centres at +0.5
    const fx = u - 0.5, fy = v - 0.5, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    out[0] = out[1] = out[2] = out[3] = 0;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const x = Math.min(sw - 1, Math.max(0, x0 + dx)), y = Math.min(sh - 1, Math.max(0, y0 + dy)), w = (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty), i = (y * sw + x) * 4;
      out[0] += pm[i] * w; out[1] += pm[i + 1] * w; out[2] += pm[i + 2] * w; out[3] += pm[i + 3] * w;
    }
  };
  const tmp = new Float32Array(4), inv = 1 / (ss * ss);
  const tri = (ax: number, ay: number, au: number, av: number, bx: number, by: number, bu: number, bv: number, cx: number, cy: number, cu: number, cv: number) => {
    const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(den) < 1e-12) return;
    const minX = Math.max(ox, Math.floor(Math.min(ax, bx, cx))), maxX = Math.min(ox + ow - 1, Math.ceil(Math.max(ax, bx, cx)));
    const minY = Math.max(oy, Math.floor(Math.min(ay, by, cy))), maxY = Math.min(oy + oh - 1, Math.ceil(Math.max(ay, by, cy)));
    const EPS = -1e-9;
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const p = (y - oy) * ow + (x - ox);
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
        const si = p * ss * ss + sy * ss + sx; if (done[si]) continue;
        const px = x + (sx + 0.5) / ss, py = y + (sy + 0.5) / ss;
        const l0 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / den, l1 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / den, l2 = 1 - l0 - l1;
        if (l0 < EPS || l1 < EPS || l2 < EPS) continue;
        done[si] = 1;
        fetch(Math.min(sw, Math.max(0, l0 * au + l1 * bu + l2 * cu)), Math.min(sh, Math.max(0, l0 * av + l1 * bv + l2 * cv)), tmp);
        const o = p * 4; acc[o] += tmp[0] * inv; acc[o + 1] += tmp[1] * inv; acc[o + 2] += tmp[2] * inv; acc[o + 3] += tmp[3] * inv;
      }
    }
  };
  const M = (i: number, j: number) => (j * (N + 1) + i) * 2;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const a = M(i, j), b = M(i + 1, j), c = M(i + 1, j + 1), d = M(i, j + 1), u0 = (i / N) * sw, u1 = ((i + 1) / N) * sw, v0 = (j / N) * sh, v1 = ((j + 1) / N) * sh;
    tri(mesh[a], mesh[a + 1], u0, v0, mesh[b], mesh[b + 1], u1, v0, mesh[c], mesh[c + 1], u1, v1);
    tri(mesh[a], mesh[a + 1], u0, v0, mesh[c], mesh[c + 1], u1, v1, mesh[d], mesh[d + 1], u0, v1);
  }
  const out = new Uint8ClampedArray(ow * oh * 4);
  for (let p = 0; p < ow * oh; p++) {
    const a = acc[p * 4 + 3]; if (a <= 0) continue;
    const k = 255 / a;                                                                  // un-premultiply
    out[p * 4] = acc[p * 4] * k; out[p * 4 + 1] = acc[p * 4 + 1] * k; out[p * 4 + 2] = acc[p * 4 + 2] * k; out[p * 4 + 3] = a;
  }
  return out;
}

// ---- 4-corner modes (corners 0..3 = TL, TR, BR, BL)
const sub = (a: Pt2, b: Pt2): Pt2 => [a[0] - b[0], a[1] - b[1]];
const unit = (v: Pt2): Pt2 => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; };
const P = (q: Quad, i: number): Pt2 => [q[i * 2], q[i * 2 + 1]];
const moved = (q: Quad, i: number, d: Pt2): Quad => { const o = [...q] as Quad; o[i * 2] += d[0]; o[i * 2 + 1] += d[1]; return o; };
/** Distort: the grabbed corner follows the pointer. */
export const distortCorner = (q0: Quad, i: number, x: number, y: number): Quad => moved(q0, i, [x - q0[i * 2], y - q0[i * 2 + 1]]);
/** Distort: an edge handle (t/r/b/l) moves its two corners together. */
export const EDGE_CORNERS: Record<'t' | 'r' | 'b' | 'l', [number, number]> = { t: [0, 1], r: [1, 2], b: [3, 2], l: [0, 3] };
export function distortEdge(q0: Quad, e: 't' | 'r' | 'b' | 'l', dx: number, dy: number): Quad { const [a, b] = EDGE_CORNERS[e]; return moved(moved(q0, a, [dx, dy]), b, [dx, dy]); }
/** Skew: an edge slides along its own direction, taking its corners with it. */
export function skewEdge(q0: Quad, e: 't' | 'r' | 'b' | 'l', dx: number, dy: number): Quad {
  const [a, b] = EDGE_CORNERS[e], dir = unit(e === 't' || e === 'b' ? sub(P(q0, 1), P(q0, 0)) : sub(P(q0, 3), P(q0, 0))), k = dx * dir[0] + dy * dir[1];
  return moved(moved(q0, a, [dir[0] * k, dir[1] * k]), b, [dir[0] * k, dir[1] * k]);
}
/** Perspective: the grabbed corner and its neighbour on the dominant axis move symmetrically (towards / away from each other). */
export function perspectiveCorner(q0: Quad, i: number, x: number, y: number): Quad {
  const horizNb = [1, 0, 3, 2][i], vertNb = [3, 2, 1, 0][i], d = sub([x, y], P(q0, i));
  const h = unit(sub(P(q0, horizNb), P(q0, i))), v = unit(sub(P(q0, vertNb), P(q0, i)));
  const det = h[0] * v[1] - h[1] * v[0] || 1e-12, ch = (d[0] * v[1] - d[1] * v[0]) / det, cv = (h[0] * d[1] - h[1] * d[0]) / det;   // d = ch·h + cv·v
  if (Math.abs(ch) >= Math.abs(cv)) return moved(moved(q0, i, [h[0] * ch, h[1] * ch]), horizNb, [-h[0] * ch, -h[1] * ch]);
  return moved(moved(q0, i, [v[0] * cv, v[1] * cv]), vertNb, [-v[0] * cv, -v[1] * cv]);
}
export const translateQuad = (q: Quad, dx: number, dy: number): Quad => q.map((v, i) => v + (i % 2 ? dy : dx)) as Quad;
export const translateGrid = (g: number[], dx: number, dy: number) => g.map((v, i) => v + (i % 2 ? dy : dx));
/** Point inside a convex quad? */
export function inQuad(q: Quad, x: number, y: number): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) { const a = P(q, i), b = P(q, (i + 1) % 4), c = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]); if (c) { const s = Math.sign(c); if (sign && s !== sign) return false; sign = s; } }
  return true;
}
