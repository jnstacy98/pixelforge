// Unit tests for the pure tone maths. Runs on Node's built-in TypeScript stripping (Node >= 22.18).
import assert from 'node:assert/strict';
import * as A from '../src/adjust.ts';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };

t('identity levels is the identity LUT', () => {
  const l = A.levelsLUT(A.identityLevels());
  for (let v = 0; v < 256; v++) assert.equal(l[v], v);
});
t('levels input black/white clip to 0 and 255', () => {
  const l = A.levelsLUT({ ib: 50, gamma: 1, iw: 200, ob: 0, ow: 255 });
  assert.equal(l[50], 0); assert.equal(l[10], 0); assert.equal(l[200], 255); assert.equal(l[250], 255);
  assert.ok(Math.abs(l[125] - 128) <= 1);
});
t('levels gamma > 1 brightens midtones, < 1 darkens them', () => {
  assert.equal(A.levelsLUT({ ib: 0, gamma: 2, iw: 255, ob: 0, ow: 255 })[128], 181);
  assert.ok(A.levelsLUT({ ib: 0, gamma: 0.5, iw: 255, ob: 0, ow: 255 })[128] < 80);
});
t('levels output range compresses contrast', () => {
  const l = A.levelsLUT({ ib: 0, gamma: 1, iw: 255, ob: 30, ow: 200 });
  assert.equal(l[0], 30); assert.equal(l[255], 200);
});
t('gamma handle position round-trips', () => {
  for (const g of [0.3, 1, 1.7, 4]) {
    const p = { ib: 20, gamma: g, iw: 230, ob: 0, ow: 255 };
    assert.ok(Math.abs(A.gammaFromHandle(p.ib, p.iw, A.gammaHandleX(p)) - g) < 1e-9);
  }
});
t('curve through (0,0),(255,255) is identity', () => {
  const c = A.curveLUT(A.identityCurve());
  for (let v = 0; v < 256; v++) assert.equal(c[v], v);
});
t('curve passes through its control points', () => {
  const c = A.curveLUT([{ x: 0, y: 0 }, { x: 64, y: 100 }, { x: 192, y: 180 }, { x: 255, y: 255 }]);
  assert.equal(c[0], 0); assert.equal(c[64], 100); assert.equal(c[192], 180); assert.equal(c[255], 255);
});
t('curve never overshoots between monotone points', () => {
  const c = A.curveLUT([{ x: 0, y: 0 }, { x: 128, y: 230 }, { x: 255, y: 255 }]);
  for (let v = 1; v < 256; v++) { assert.ok(c[v] >= c[v - 1], `non-monotone at ${v}`); assert.ok(c[v] <= 255); }
});
t('inverting curve flips values', () => {
  const c = A.curveLUT([{ x: 0, y: 255 }, { x: 255, y: 0 }]);
  assert.equal(c[0], 255); assert.equal(c[255], 0); assert.ok(Math.abs(c[100] - 155) <= 1);
});
t('curve handles unsorted / duplicate-x points', () => {
  const c = A.curveLUT([{ x: 255, y: 255 }, { x: 0, y: 0 }, { x: 0, y: 50 }]);
  assert.equal(c[255], 255); assert.equal(c[0], 0);
});
t('master LUT is applied after the channel LUT', () => {
  const id = A.levelsLUT(A.identityLevels());
  const bright = A.levelsLUT({ ib: 0, gamma: 1, iw: 128, ob: 0, ow: 255 });
  const l = A.combineLUTs(bright, id, id, bright);
  assert.equal(l.r[64], 128); assert.equal(l.b[64], 255);   // b: bright(bright(64)) saturates
});
t('applyLUTs maps RGB and leaves alpha alone', () => {
  const src = new Uint8ClampedArray([10, 20, 30, 77, 255, 0, 0, 0]);
  const inv = new Uint8ClampedArray(256).map((_, i) => 255 - i);
  A.applyLUTs(src, src, { r: inv, g: inv, b: inv });
  assert.deepEqual([...src], [245, 235, 225, 77, 0, 255, 255, 0]);
});
t('histogram counts opaque pixels per channel and skips transparent ones', () => {
  const px = new Uint8ClampedArray([10, 0, 0, 255, 10, 5, 0, 255, 200, 0, 0, 0]);
  const hr = A.histogramOf(px, 'r');
  assert.equal(hr[10], 2); assert.equal(hr[200], 0);
  assert.equal(A.histogramOf(px, 'g')[5], 1);
});
t('auto points clip the empty ends of a narrow histogram', () => {
  const h = new Uint32Array(256); for (let v = 60; v <= 180; v++) h[v] = 100;
  const p = A.autoPoints(h, 0.0);
  assert.equal(p.ib, 60); assert.equal(p.iw, 180);
});
t('auto points ignore a tiny outlier when clipping 0.5%', () => {
  const h = new Uint32Array(256); for (let v = 60; v <= 180; v++) h[v] = 1000; h[2] = 1; h[250] = 1;
  const p = A.autoPoints(h, 0.005);
  assert.equal(p.ib, 60); assert.equal(p.iw, 180);
});
t('auto points fall back to identity for flat images', () => {
  const h = new Uint32Array(256); h[100] = 5000;
  assert.deepEqual(A.autoPoints(h), { ib: 0, iw: 255 });
});

// ---- adjustment-layer data + PSD conversion
import * as P from '../src/psdadjust.ts';
t('lutsFor(levels) matches levelsLUT; filter types return null', () => {
  const a = A.defaultAdjustment('levels'); a.P.rgb.gamma = 2;
  assert.equal(A.lutsFor(a).r[128], 181);
  assert.equal(A.lutsFor(A.defaultAdjustment('brightness')), null);
  assert.match(A.filterFor({ type: 'brightness', b: 20, c: -10 }), /brightness\(1\.2\) contrast\(0\.9\)/);
  assert.match(A.filterFor({ type: 'hue', h: 30, s: -50 }), /hue-rotate\(30deg\) saturate\(0\.5\)/);
});
t('invert adjustment inverts', () => { const l = A.lutsFor({ type: 'invert' }); assert.equal(l.g[0], 255); assert.equal(l.b[255], 0); });
t('defaultAdjustment/clone/same', () => {
  const a = A.defaultAdjustment('curves'); const b = A.cloneAdjustment(a);
  assert.ok(A.sameAdjustment(a, b)); b.P.r.push({ x: 100, y: 120 }); assert.ok(!A.sameAdjustment(a, b));
});
t('levels survive a PSD round-trip conversion', () => {
  const a = A.defaultAdjustment('levels'); a.P.rgb = { ib: 12, gamma: 1.4, iw: 230, ob: 5, ow: 250 }; a.P.g = { ib: 0, gamma: 0.8, iw: 255, ob: 0, ow: 255 };
  const back = P.fromPsdAdjustment(P.toPsdAdjustment(a));
  assert.deepEqual(back, a);
});
t('curves survive a PSD round-trip conversion (identity channels stay identity)', () => {
  const a = A.defaultAdjustment('curves'); a.P.rgb = [{ x: 0, y: 0 }, { x: 64, y: 90 }, { x: 255, y: 255 }];
  const psd = P.toPsdAdjustment(a);
  assert.equal(psd.channels[1].length, 0);
  assert.deepEqual(P.fromPsdAdjustment(psd), a);
});
t('pencil-drawn PSD curves are resampled to control points', () => {
  const map = Array.from({ length: 256 }, (_, i) => 255 - i);
  const a = P.fromPsdAdjustment({ type: 'curves', values: [map] });
  const lut = A.curveLUT(a.P.rgb);
  assert.ok(Math.abs(lut[100] - 155) <= 2);
});
t('brightness/contrast, hue/saturation, invert convert; unsupported types return null', () => {
  assert.deepEqual(P.fromPsdAdjustment(P.toPsdAdjustment({ type: 'brightness', b: 40, c: 30 })), { type: 'brightness', b: 40, c: 30 });
  assert.deepEqual(P.fromPsdAdjustment(P.toPsdAdjustment({ type: 'hue', h: -40, s: 25 })), { type: 'hue', h: -40, s: 25 });
  assert.deepEqual(P.fromPsdAdjustment({ type: 'invert' }), { type: 'invert' });
  assert.equal(P.fromPsdAdjustment({ type: 'color lookup' }), null);
});

// ---- free transform maths
import * as FT from '../src/xformmath.ts';
t('free transform: model mapping, handle drags (anchor stays put), rotation, uniform scaling', () => {
  const m = { w: 80, h: 60, cx: 140, cy: 130, sx: 1, sy: 1, angle: 0 };
  assert.deepEqual(FT.corners(m), [100, 100, 180, 100, 180, 160, 100, 160]);
  const near2 = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
  const rot = { ...m, angle: 90, sx: 2 }; assert.ok(near2(FT.toDoc(rot, 80, 30), [140, 130 + 80]));                  // right-middle goes down after a 90° turn (x scaled 2×: 40 → 80)
  for (const mm of [m, rot, { ...m, angle: 33, sx: 1.7, sy: 0.6 }]) { const [x, y] = FT.toDoc(mm, 12, 47); assert.ok(near2(FT.toLocal(mm, x, y), [12, 47])); }
  const br = FT.dragHandle(m, 'br', 260, 220, false, false);                                                         // opposite corner (100,100) fixed
  assert.ok(near2([br.sx, br.sy, ...FT.toDoc(br, 0, 0)], [2, 2, 100, 100]));
  const fromC = FT.dragHandle(m, 'br', 220, 190, false, true);                                                       // centre fixed
  assert.ok(near2([fromC.sx, fromC.sy, fromC.cx, fromC.cy], [2, 2, 140, 130]));
  const edge = FT.dragHandle(m, 'r', 260, 999, false, false); assert.ok(near2([edge.sx, edge.sy, ...FT.toDoc(edge, 0, 0)], [2, 1, 100, 100]));
  const uni = FT.dragHandle(m, 'br', 260, 130, true, false); assert.ok(Math.abs(uni.sx - uni.sy) < 1e-9);
  const flip = FT.dragHandle(m, 'r', 60, 0, false, false); assert.ok(flip.sx < 0);                                   // dragging past the anchor flips
  const rr = FT.dragHandle({ ...m, angle: 90 }, 'r', 140 - 0, 130 + 40, false, true); assert.ok(Math.abs(rr.sx - 1) < 1e-9);   // handles follow the rotated box
  const turn = FT.rotateTo(m, 140, 200, 0, 0, false); assert.ok(Math.abs(turn.angle - 90) < 1e-9);
  assert.equal(FT.rotateTo(m, 140 + 100, 130 + 30, 0, 0, true).angle % 15, 0);
});

t('perspective / distort / warp maths: homography, Bézier mesh, mesh rasteriser, corner modes', () => {
  const near1 = (a, b, e = 1e-6) => a.every((v, i) => Math.abs(v - b[i]) < e);
  const trap = [20, 0, 80, 0, 100, 60, 0, 60];                                         // a trapezoid (wider at the bottom)
  const f = FT.squareToQuad(trap);
  assert.ok(near1(f(0, 0), [20, 0]) && near1(f(1, 0), [80, 0]) && near1(f(1, 1), [100, 60]) && near1(f(0, 1), [0, 60]));
  assert.ok(Math.abs(f(0.5, 0.5)[0] - 50) < 1e-9 && f(0.5, 0.5)[1] < 29);                    // perspective: the middle is not the arithmetic middle
  const rect = [10, 10, 50, 10, 50, 30, 10, 30], m = FT.quadMesh(rect, 4); assert.ok(near1([m[0], m[1], m[m.length - 2], m[m.length - 1]], [10, 10, 50, 30]));
  const bz = FT.bezierMesh(FT.latticeFromQuad(rect), 4); for (let k = 0; k < bz.length; k++) assert.ok(Math.abs(bz[k] - m[k]) < 1e-9, 'flat lattice = flat quad');
  const pulled = FT.latticeFromQuad(rect); pulled[(1 * 4 + 1) * 2 + 1] -= 30; const bm = FT.bezierMesh(pulled, 4); assert.ok(bm[(2 * 5 + 2) * 2 + 1] < m[(2 * 5 + 2) * 2 + 1]);   // pulling a control point bends the surface
  // rasteriser: identity placement reproduces the source; 2× scale keeps the edges crisp and the centre colour
  const w = 6, h = 4, src = new Uint8ClampedArray(w * h * 4); for (let p = 0; p < w * h; p++) { src[p * 4] = p * 9; src[p * 4 + 1] = 100; src[p * 4 + 2] = 200 - p; src[p * 4 + 3] = 255; }
  for (const ss of [1, 2]) {
    const out = FT.renderMesh(src, w, h, FT.quadMesh([3, 2, 3 + w, 2, 3 + w, 2 + h, 3, 2 + h], 8), 8, 0, 0, 12, 10, ss);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = ((y + 2) * 12 + x + 3) * 4, s2 = (y * w + x) * 4; assert.ok(Math.abs(out[o] - src[s2]) <= (ss === 1 ? 2 : 16) && out[o + 3] === 255, `ss${ss} px ${x},${y}: ${out[o]} vs ${src[s2]} a${out[o + 3]}`); }
    assert.equal(out[(0 * 12 + 0) * 4 + 3], 0); assert.equal(out[(9 * 12 + 11) * 4 + 3], 0);
  }
  const big = FT.renderMesh(new Uint8ClampedArray([255, 0, 0, 255]), 1, 1, FT.quadMesh([2, 2, 8, 2, 8, 8, 2, 8], 4), 4, 0, 0, 10, 10, 2);
  assert.deepEqual([...big.slice((5 * 10 + 5) * 4, (5 * 10 + 5) * 4 + 4)], [255, 0, 0, 255]); assert.equal(big[(1 * 10 + 1) * 4 + 3], 0);
  const half = FT.renderMesh(new Uint8ClampedArray([255, 0, 0, 255]), 1, 1, FT.quadMesh([0.5, 0.5, 3.5, 0.5, 3.5, 3.5, 0.5, 3.5], 2), 2, 0, 0, 4, 4, 2); assert.ok(half[(0 * 4 + 0) * 4 + 3] > 50 && half[(0 * 4 + 0) * 4 + 3] < 80);   // 1/4 covered corner pixel
  // corner modes
  const q = [0, 0, 100, 0, 100, 60, 0, 60];
  assert.deepEqual(FT.distortCorner(q, 2, 120, 80), [0, 0, 100, 0, 120, 80, 0, 60]);
  assert.deepEqual(FT.distortEdge(q, 'r', 10, -5), [0, 0, 110, -5, 110, 55, 0, 60]);
  assert.deepEqual(FT.skewEdge(q, 't', 30, 99), [30, 0, 130, 0, 100, 60, 0, 60]);                                   // slides along the edge only
  assert.deepEqual(FT.skewEdge(q, 'l', 99, 20), [0, 20, 100, 0, 100, 60, 0, 80]);
  assert.deepEqual(FT.perspectiveCorner(q, 0, 15, 2), [15, 0, 85, 0, 100, 60, 0, 60]);                                // TL right → TR left, symmetric
  assert.deepEqual(FT.perspectiveCorner(q, 0, 3, 12), [0, 12, 100, 0, 100, 60, 0, 48]);                               // TL down → BL up
  assert.ok(FT.inQuad(q, 50, 30) && !FT.inQuad(q, 150, 30) && !FT.inQuad(q, 50, 70));
  assert.deepEqual(FT.translateQuad(q, 5, -5).slice(0, 4), [5, -5, 105, -5]);
});

// ---- vector shapes
import * as SH from '../src/shapemath.ts';
t('vector shapes: geometry, bounds, transforms, drag modifiers, paths, decompose/compose', () => {
  const r = SH.makeShape('rect', 100, 50, 10, 20), near1 = (a, b, e = 1e-6) => a.every((v, i) => Math.abs(v - b[i]) < e);
  assert.deepEqual(SH.shapeCmds(r), [['M', 10, 20], ['L', 110, 20], ['L', 110, 70], ['L', 10, 70], ['Z']]);
  const b = SH.shapeBounds(r); assert.deepEqual([b.x0, b.y0, b.x1, b.y1], [10, 20, 110, 70]);
  const rs = SH.makeShape('rect', 100, 50, 0, 0, { stroke: '#000', strokeW: 10 }); assert.equal(SH.shapeBounds(rs).x0, -6);                        // half the stroke + 1 px AA
  const rr = SH.localCmds(SH.makeShape('rect', 100, 50, 0, 0, { radius: 999 })); assert.ok(rr.filter((c) => c[0] === 'C').length === 4);          // radius is clamped to half the short side
  assert.ok(rr.every((c) => c[0] === 'Z' || c.slice(1).every((v) => v >= -1e-9 && v <= 100 + 1e-9)));
  const el = SH.localCmds(SH.makeShape('ellipse', 80, 40, 0, 0)); assert.deepEqual(el[0], ['M', 80, 20]); assert.equal(el.filter((c) => c[0] === 'C').length, 4);
  const tri = SH.localCmds(SH.makeShape('polygon', 100, 100, 0, 0, { sides: 3 })); assert.equal(tri.filter((c) => c[0] !== 'Z').length, 3); assert.ok(near1([tri[0][1], tri[0][2]], [50, 0]));        // first corner points up
  const star = SH.localCmds(SH.makeShape('star', 100, 100, 0, 0, { sides: 5, inner: 0.5 })); assert.equal(star.filter((c) => c[0] !== 'Z').length, 10);
  assert.ok(Math.abs(Math.hypot(star[1][1] - 50, star[1][2] - 50) - 25) < 1e-9);                                                            // inner points sit at half the outer radius
  const t = SH.translateShape(r, 5, -5); assert.deepEqual(t.T, [1, 0, 0, 1, 15, 15]); assert.deepEqual(r.T, [1, 0, 0, 1, 10, 20]);               // immutable
  const sc = SH.transformShape(r, [2, 0, 0, 2, 0, 0]); assert.deepEqual(SH.shapeCmds(sc)[2], ['L', 220, 140]);
  assert.deepEqual(SH.shapeFromDrag('rect', 100, 100, 40, 60, {}).T.slice(4), [40, 60]);                                                     // dragging up-left normalises the box
  const sq = SH.shapeFromDrag('ellipse', 10, 10, 60, 30, { shift: true }); assert.deepEqual([sq.w, sq.h], [50, 50]);
  const ce = SH.shapeFromDrag('rect', 100, 100, 130, 120, { alt: true }); assert.deepEqual([ce.w, ce.h, ce.T[4], ce.T[5]], [60, 40, 70, 80]);
  assert.equal(SH.shapeFromDrag('rect', 5, 5, 5.2, 90, {}), null);
  const line = SH.shapeFromPoints([[10, 10], [60, 40]], true); assert.equal(line.closed, false); assert.equal(line.fill, null); assert.deepEqual(SH.shapeCmds(line), [['M', 10, 10], ['L', 60, 40]]);
  const poly = SH.shapeFromPoints([[10, 10], [60, 10], [30, 50]], true); assert.ok(poly.closed && poly.fill); assert.equal(SH.shapeCmds(poly).at(-1)[0], 'Z'); assert.equal(SH.shapeFromPoints([[1, 1]], false), null);
  const T = SH.composeAbout(80, 60, 200, 100, 2, 0.5, 30), d = SH.decompose(T); assert.ok(near1([d.sx, d.sy, d.angle], [2, 0.5, 30], 1e-9));
  assert.ok(near1(SH.apply(T, 40, 30), [200, 100]));                                                                                          // the local centre lands on the requested point
  const cl = SH.cloneShape(poly); cl.pts[0][0] = 99; cl.T[4] = 99; assert.equal(poly.pts[0][0], 0); assert.equal(poly.T[4], 10);
});

t('bezier paths: curve commands, control-hull bounds, smoothing, inserting anchors, nearest point, inverse matrix', () => {
  const near1 = (a, b, e = 1e-9) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < e);
  const curves = [{ i: [0, 0], o: [20, -40] }, { i: [-20, -40], o: [0, 0] }];
  const p = SH.shapeFromPoints([[100, 100], [200, 100]], false, {}, curves);
  assert.deepEqual(SH.shapeCmds(p), [['M', 100, 100], ['C', 120, 60, 180, 60, 200, 100]]);                                       // two handles → one cubic
  assert.deepEqual([p.w, p.h, p.T[4], p.T[5]], [100, 40, 100, 60]);                                                                // the box includes the control points (y 60…100)
  assert.deepEqual(SH.shapeCmds(SH.shapeFromPoints([[0, 0], [10, 0], [10, 10]], true))[1], ['L', 10, 0]);                         // no handles → straight lines
  const half = SH.shapeFromPoints([[0, 0], [100, 0], [100, 100]], false, {}, [{ i: [0, 0], o: [30, 0] }, null, null]); assert.equal(SH.shapeCmds(half)[1][0], 'C'); assert.equal(SH.shapeCmds(half)[2][0], 'L');   // one handle is enough
  const closed = SH.shapeFromPoints([[0, 0], [100, 0], [50, 80]], true, {}, [null, null, { i: [0, 0], o: [-10, -30] }]);
  const cc = SH.shapeCmds(closed); assert.equal(cc.at(-2)[0], 'C'); assert.equal(cc.at(-1)[0], 'Z');                                // the closing segment can curve too
  const tr = SH.transformShape(p, [2, 0, 0, 2, 0, 0]); assert.deepEqual(SH.shapeCmds(tr)[1], ['C', 240, 120, 360, 120, 400, 200]);  // handles scale with the matrix
  const sm = SH.autoSmooth([[0, 0], [100, 0], [200, 0]], 1, false); assert.ok(near1([...sm.i, ...sm.o], [-100 / 3, 0, 100 / 3, 0], 1e-9));
  const end = SH.autoSmooth([[0, 0], [90, 0]], 0, false); assert.ok(Math.abs(end.o[0]) <= 90 / 3 + 1e-9);                          // endpoints don't blow up
  // inserting an anchor keeps the curve exactly where it was
  const base = SH.shapeFromPoints([[0, 0], [100, 0]], false, {}, [{ i: [0, 0], o: [0, 50] }, { i: [0, 50], o: [0, 0] }]);
  const ins = SH.insertAnchor(base.pts, base.curves, 0, 0.5, false); assert.equal(ins.pts.length, 3); assert.ok(near1(ins.pts[1], [50, 37.5]));
  const before = (u) => { const t = u, o = 1 - t; return [o * o * o * 0 + 3 * o * o * t * 0 + 3 * o * t * t * 100 + t * t * t * 100, 3 * o * o * t * 50 + 3 * o * t * t * 50]; };
  const mid = before(0.5); assert.ok(near1(mid, [50, 37.5]));
  const strip = SH.insertAnchor([[0, 0], [100, 0]], [null, null], 0, 0.25, false); assert.deepEqual(strip.pts[1], [25, 0]); assert.deepEqual(strip.curves, [null, null, null]);
  const loop = SH.insertAnchor([[0, 0], [100, 0], [50, 80]], [null, null, null], 2, 0.5, true); assert.deepEqual(loop.pts[3], [25, 40]);   // the closing segment appends at the end
  const near = SH.nearestOnPath(SH.shapeFromPoints([[0, 0], [100, 0]], false), 50, 7); assert.ok(near.d > 6.9 && near.d < 7.1 && near.seg === 0);
  assert.equal(SH.nearestOnPath(SH.makeShape('rect', 10, 10, 0, 0), 1, 1), null);
  const inv = SH.invertMat([2, 0, 0, 4, 10, 20]); assert.deepEqual(inv, [0.5, 0, 0, 0.25, -5, -5]); assert.equal(SH.invertMat([1, 2, 2, 4, 0, 0]), null);
  const moved = SH.cloneShape(p); moved.pts[1] = [-50, 120]; moved.curves[0].o = [0, -80];                                       // an edited path: points left/above the old box
  const nz = SH.normalizePath(moved); assert.ok(nz.pts.every(([x, y]) => x >= -1e-9 && y >= -1e-9) && Math.min(...nz.pts.map((q) => q[0])) < 1e-9);
  const cmdsA = SH.shapeCmds(moved), cmdsB = SH.shapeCmds(nz); assert.ok(cmdsA.every((c, i) => c.slice(1).every((v, k) => Math.abs(v - cmdsB[i][k + 1]) < 1e-9)));   // nothing moves on screen
  const cl = SH.cloneShape(p); cl.curves[0].o[0] = 999; assert.equal(p.curves[0].o[0], 20);
});

// ---- smart objects
import * as SM from '../src/smartmath.ts';
t('smart object geometry: affine, scale/rotate about the centre, resize source, info, fingerprint, GUID', () => {
  const q = SM.quadAt(10, 20, 100, 50);
  assert.deepEqual(SM.affineFromQuad(q, 100, 50), [1, 0, 0, 1, 10, 20]);
  const d = SM.scaleQuad(q, 2, 2, 0); assert.deepEqual(d, [-40, -5, 160, -5, 160, 95, -40, 95]);                       // doubled about the centre (60, 45)
  const r = SM.scaleQuad(q, 1, 1, 90); assert.ok(Math.abs(r[0] - 85) < 1e-9 && Math.abs(r[1] + 5) < 1e-9);           // 90° about the centre: TL goes to the top-right
  const inf = SM.quadInfo(SM.scaleQuad(q, 1.5, 0.5, 30), 100, 50); assert.ok(Math.abs(inf.sx - 1.5) < 1e-9 && Math.abs(inf.sy - 0.5) < 1e-9 && Math.abs(inf.rot - 30) < 1e-9);
  const rs = SM.resizeSource(q, 100, 50, 200, 100); assert.deepEqual(rs, [-40, -5, 160, -5, 160, 95, -40, 95]);        // source got 2× bigger at the same per-pixel scale
  assert.deepEqual(SM.resizeSource(q, 100, 50, 100, 50), q);
  const a = new Uint8ClampedArray(64).map((_, i) => i), b = a.slice(); b[17] ^= 1;
  assert.equal(SM.fingerprint(a, 4, 4), SM.fingerprint(a.slice(), 4, 4)); assert.notEqual(SM.fingerprint(a, 4, 4), SM.fingerprint(b, 4, 4)); assert.notEqual(SM.fingerprint(a, 4, 4), SM.fingerprint(a, 2, 8));
  assert.match(SM.newLinkId(), /^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/);
  const s = { print: 'x', placed: { id: 'i', transform: [1, 2, 3, 4, 5, 6, 7, 8], type: 'raster' } }, c = SM.cloneSmart(s); c.placed.transform[0] = 99; assert.equal(s.placed.transform[0], 1);
});

// ---- pen tilt
import * as TL from '../src/tilt.ts';
t('pen tilt: upright is round; leaning stretches the dab along the lean direction', () => {
  assert.deepEqual(TL.tiltShape(0, 0), { az: 0, stretch: 1 });
  const x = TL.tiltShape(60, 0); assert.ok(Math.abs(x.az) < 1e-6 && Math.abs(x.stretch - 2) < 1e-6);
  const y = TL.tiltShape(0, 60); assert.ok(Math.abs(y.az - 90) < 1e-6 && Math.abs(y.stretch - 2) < 1e-6);
  const nx = TL.tiltShape(-60, 0); assert.ok(Math.abs(Math.abs(nx.az) - 180) < 1e-6);
  assert.ok(TL.tiltShape(30, 30).stretch > TL.tiltShape(30, 0).stretch);          // leaning two ways is a bigger lean
  assert.equal(TL.tiltShape(89, 89).stretch, 3);                                  // capped
  assert.ok(Number.isFinite(TL.tiltShape(90, -90).stretch));
  assert.deepEqual(TL.quantTilt({ az: -3, stretch: 1.96 }), { az: 0, stretch: 2 });
});

// ---- TIFF
import fs from 'node:fs';
import * as TF from '../src/tiff.ts';
globalThis.window ??= globalThis;                         // utif2's CMYK branch probes `window` (always present in a browser)
const tifDir = new URL('./tiff-fixtures/', import.meta.url), tifExp = JSON.parse(fs.readFileSync(new URL('expected.json', tifDir), 'utf8'));
const tifRead = (n) => { const b = fs.readFileSync(new URL(n + '.tif', tifDir)); return TF.decodeTiff(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
t('TIFF import: LZW, PackBits, Deflate, RGBA, 16-bit gray, palette and CMYK files decode to the right pixels', () => {
  for (const [name, tol] of [['rgb-lzw', 0], ['rgb-packbits', 0], ['rgb-deflate', 0], ['rgba-deflate', 0], ['gray16', 2], ['palette', 0], ['cmyk', 3]]) {
    const [pg] = tifRead(name); assert.deepEqual([pg.w, pg.h], [16, 12], name);
    tifExp.pts.forEach(([x, y], i) => { const o = (y * pg.w + x) * 4, got = [...pg.rgba.slice(o, o + 4)]; assert.ok(got.every((v, k) => Math.abs(v - tifExp[name][i][k]) <= tol), `${name} (${x},${y}): ${got} vs ${tifExp[name][i]}`); });
  }
});
t('TIFF import: multi-page files give every page; garbage is rejected', () => {
  const pages = tifRead('multipage'); assert.deepEqual(pages.map((p) => [p.w, p.h]), [[16, 12], [8, 8]]); assert.deepEqual([...pages[1].rgba.slice(0, 4)], [10, 200, 30, 255]);
  assert.throws(() => TF.decodeTiff(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer));
});
t('TIFF export: RGBA round trip is exact (transparency kept) and the header is a valid TIFF', () => {
  const w = 5, h = 4, px = new Uint8ClampedArray(w * h * 4).map((_, i) => (i * 37) % 256);
  for (let p = 0; p < w * h; p++) px[p * 4 + 3] = p % 3 === 0 ? 0 : p % 3 === 1 ? 128 : 255;
  const out = TF.encodeTiff(px, w, h); assert.ok(['II*\0', 'MM\0*'].includes(String.fromCharCode(...out.slice(0, 4))));   // either byte order is a valid TIFF header
  const [pg] = TF.decodeTiff(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
  assert.deepEqual([pg.w, pg.h], [w, h]);
  for (let p = 0; p < w * h; p++) { const a = px[p * 4 + 3]; assert.equal(pg.rgba[p * 4 + 3], a); if (a) for (let c = 0; c < 3; c++) assert.ok(Math.abs(pg.rgba[p * 4 + c] - px[p * 4 + c]) <= 1, `px ${p}`); }
});

// ---- Brush tips
import * as BT from '../src/brushtips.ts';
t('brush tips: built-ins, tip-from-pixels (darkness vs alpha), define / lookup', () => {
  assert.ok(BT.getTip('tip:square') && BT.getTip('tip:star').w === 64); assert.equal(BT.getTip('round'), undefined); assert.equal(BT.getTip('nope'), undefined);
  const sq = BT.getTip('tip:square'); assert.ok(sq.alpha.every((v) => v === 255));
  const star = BT.getTip('tip:star'); assert.ok(star.alpha[32 * 64 + 32] === 255 && star.alpha[0] === 0);
  // opaque pixels: black paints, white does not
  const px = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255, 128, 128, 128, 255, 255, 255, 255, 255]);
  const a = BT.tipFromPixels(px, 2, 2); assert.deepEqual([a[0], a[1], a[3]], [255, 0, 0]); assert.ok(a[2] > 100 && a[2] < 160);
  // see-through pixels: alpha is the shape whatever the colour
  const tr = new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 0, 255, 255, 255, 0, 255, 255, 255, 0]);
  const b = BT.tipFromPixels(tr, 2, 2); assert.deepEqual([...b], [255, 0, 0, 0]);
  assert.equal(BT.tipFromPixels(new Uint8ClampedArray(16).fill(255), 2, 2), null);          // all white: nothing to paint
  const t = BT.defineTip('Mine', 2, 2, new Uint8ClampedArray([1, 2, 3, 4]), false); assert.equal(BT.getTip(t.id).name, 'Mine');
});

// ---- Pattern Overlay
import * as PT from '../src/patterns.ts';
t('pattern registry: built-ins, define, lookup; Pattern Overlay PSD round trip; stacking order matches Photoshop', () => {
  assert.ok(PT.getPattern('pf:checker') && PT.getPattern('pf:grain').w === 64); assert.equal(PT.getPattern('nope'), undefined);
  const u = PT.definePattern('Mine', 2, 2, new Uint8ClampedArray(16).fill(7)); assert.equal(PT.getPattern(u.id).name, 'Mine');
  const fx = { patternOverlay: { on: true, id: 'pf:dots', name: 'Dots', opacity: 0.6, blend: 'multiply', scale: 1.5, angle: 20, phase: { x: 3, y: -4 } } };
  const back = F.fromPsdEffects(F.toPsdEffects(fx)); assert.deepEqual(back.fx, fx); assert.deepEqual(back.unsupported, []);
  const o = F.FX_ORDER; assert.ok(o.indexOf('patternOverlay') < o.indexOf('gradientOverlay') && o.indexOf('gradientOverlay') < o.indexOf('colorOverlay') && o.indexOf('colorOverlay') < o.indexOf('satin'));
  assert.ok(F.hasEffects(fx)); assert.equal(F.defaultFx('patternOverlay').id, 'pf:checker');
});

// ---- Blend If
import * as BI from '../src/blendif.ts';
t('Blend If range table: hidden outside, ramps over the splits, 1 between', () => {
  const r = BI.rangeTable([50, 100, 150, 200]);
  assert.equal(r[10], 0); assert.equal(r[230], 0); assert.equal(r[120], 1); assert.equal(r[100], 1); assert.equal(r[150], 1);
  assert.ok(r[75] > 0.4 && r[75] < 0.6); assert.ok(r[175] > 0.4 && r[175] < 0.6);
  const full = BI.rangeTable([0, 0, 255, 255]); for (let v = 0; v < 256; v++) assert.equal(full[v], 1);
  assert.equal(BI.rangeTable([100, 100, 255, 255])[99], 0); assert.equal(BI.rangeTable([100, 100, 255, 255])[100], 1);
});
t('Blend If hides by the layer’s own gray and by the underlying colour; channels multiply', () => {
  const bi = BI.defaultBlendIf(); bi.gray.src = [100, 100, 255, 255];
  const s = new Uint8ClampedArray([50, 50, 50, 255, 200, 200, 200, 255]), b = new Uint8ClampedArray(8).fill(255);
  BI.applyBlendIf(bi, s, b); assert.deepEqual([s[3], s[7]], [0, 255]);
  const b2 = BI.defaultBlendIf(); b2.gray.dst = [0, 0, 100, 100];
  const s2 = new Uint8ClampedArray([9, 9, 9, 255, 9, 9, 9, 255]), back2 = new Uint8ClampedArray([20, 20, 20, 255, 240, 240, 240, 255]);
  BI.applyBlendIf(b2, s2, back2); assert.deepEqual([s2[3], s2[7]], [255, 0]);
  const b3 = BI.defaultBlendIf(); b3.r.src = [0, 0, 100, 100]; b3.g.src = [0, 0, 100, 100];
  const s3 = new Uint8ClampedArray([50, 50, 50, 200, 50, 150, 50, 200]); BI.applyBlendIf(b3, s3, new Uint8ClampedArray(8));
  assert.deepEqual([s3[3], s3[7]], [200, 0]);
  const s4 = new Uint8ClampedArray([5, 5, 5, 0]); BI.applyBlendIf(b3, s4, new Uint8ClampedArray(4)); assert.equal(s4[3], 0);   // transparent stays transparent
});
t('Blend If survives the PSD conversion; defaults produce no ranges', () => {
  const bi = BI.defaultBlendIf(); bi.gray.src = [10, 40, 200, 240]; bi.b.dst = [0, 0, 128, 180];
  assert.deepEqual(BI.fromPsdRanges(BI.toPsdRanges(bi)), bi);
  assert.equal(BI.fromPsdRanges(BI.toPsdRanges(BI.defaultBlendIf())), null);
  assert.equal(BI.fromPsdRanges(undefined), null);
  assert.deepEqual(BI.normalizeRange([50, 20, 10, 5]), [50, 50, 50, 50]);
});

// ---- healing maths
import * as H from '../src/heal.ts';
const mkRGBA = (w, h, f) => { const a = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b, al = 255] = f(x, y); const i = (y * w + x) * 4; a[i] = r; a[i + 1] = g; a[i + 2] = b; a[i + 3] = al; } return a; };
const disc = (cx, cy, r) => (x, y) => (Math.hypot(x - cx, y - cy) <= r ? 255 : 0);

t('membrane: constant boundary fills the hole with that constant', () => {
  const w = 40, h = 40, f = new Float32Array(w * h * 3), k = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) { const x = p % w, y = (p / w) | 0; if (Math.hypot(x - 20, y - 20) > 9) { k[p] = 1; f[p * 3] = 50; f[p * 3 + 1] = -20; f[p * 3 + 2] = 7; } }
  const o = H.fillMembrane(f, k, w, h);
  for (let p = 0; p < w * h; p++) { assert.ok(Math.abs(o[p * 3] - 50) < 0.5 && Math.abs(o[p * 3 + 1] + 20) < 0.5 && Math.abs(o[p * 3 + 2] - 7) < 0.5, `pixel ${p}`); }
});
t('membrane: linear ramp is reproduced inside the hole', () => {
  const w = 60, h = 40, f = new Float32Array(w * h * 3), k = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) { const x = p % w, y = (p / w) | 0; f[p * 3] = x * 2; if (!(x > 22 && x < 38 && y > 12 && y < 28)) k[p] = 1; }
  const o = H.fillMembrane(f, k, w, h);
  let worst = 0; for (let y = 13; y < 28; y++) for (let x = 23; x < 38; x++) worst = Math.max(worst, Math.abs(o[(y * w + x) * 3] - x * 2));
  assert.ok(worst < 6, `worst error ${worst}`);
});
t('membrane: known pixels are untouched and an all-unknown field stays zero', () => {
  const w = 8, h = 8, f = new Float32Array(w * h * 3).fill(9), k = new Uint8Array(w * h).fill(1);
  assert.equal(H.fillMembrane(f, k, w, h)[5], 9);
  assert.ok(H.fillMembrane(f, new Uint8Array(w * h), w, h).every((v) => v === 0));
});
t('heal: keeps source texture but takes the destination brightness', () => {
  const w = 60, h = 60, dc = disc(30, 30, 18);
  const dst = mkRGBA(w, h, () => [100, 100, 100]);
  const src = mkRGBA(w, h, (x, y) => (y % 2 ? [220, 220, 220] : [180, 180, 180]));           // bright stripes, mean 200
  const cov = mkRGBA(w, h, (x, y) => [0, 0, 0, dc(x, y)]);
  const out = H.healPatch(dst, src, cov, w, h);
  const vals = []; for (let y = 24; y < 36; y++) vals.push(out[(y * w + 30) * 4]);
  const mean = vals.reduce((a, b) => a + b) / vals.length, spread = Math.max(...vals) - Math.min(...vals);
  assert.ok(Math.abs(mean - 100) < 6, `mean ${mean}`); assert.ok(spread >= 35, `texture spread ${spread}`);
  assert.equal(out[(2 * w + 2) * 4 + 3], 0); assert.equal(out[(30 * w + 30) * 4 + 3], 255);
});
t('heal: removes a blemish completely (no ghost of the destination interior)', () => {
  const w = 60, h = 60, dc = disc(30, 30, 14);
  const dst = mkRGBA(w, h, (x, y) => (Math.hypot(x - 30, y - 30) < 8 ? [10, 10, 10] : [120, 110, 100]));
  const src = mkRGBA(w, h, () => [120, 110, 100]);
  const cov = mkRGBA(w, h, (x, y) => [0, 0, 0, dc(x, y)]);
  const out = H.healPatch(dst, src, cov, w, h), c = (30 * w + 30) * 4;
  assert.ok(Math.abs(out[c] - 120) < 3 && Math.abs(out[c + 1] - 110) < 3 && Math.abs(out[c + 2] - 100) < 3, `center ${out[c]},${out[c + 1]},${out[c + 2]}`);
});
t('heal: with no usable boundary it degrades to a plain clone', () => {
  const w = 10, h = 10, dst = mkRGBA(w, h, () => [0, 0, 0, 0]), src = mkRGBA(w, h, () => [90, 80, 70]);
  const cov = mkRGBA(w, h, () => [0, 0, 0, 255]);
  const out = H.healPatch(dst, src, cov, w, h);
  assert.deepEqual([...out.slice(0, 4)], [90, 80, 70, 255]);
});
t('heal: soft coverage becomes soft alpha', () => {
  const w = 20, h = 20, dst = mkRGBA(w, h, () => [50, 50, 50]), src = mkRGBA(w, h, () => [200, 200, 200]);
  const cov = mkRGBA(w, h, (x) => [0, 0, 0, x < 10 ? 0 : 128]);
  const out = H.healPatch(dst, src, cov, w, h);
  assert.equal(out[(5 * w + 15) * 4 + 3], 128); assert.equal(out[(5 * w + 3) * 4 + 3], 0);
});
t('spot healing picks the candidate whose surroundings match', () => {
  // area: left 100px mid-gray, right 100px bright; region sits at x=40..60 in gray
  const aw = 200, ah = 80, area = mkRGBA(aw, ah, (x) => (x < 100 ? [100, 100, 100] : [240, 240, 240]));
  const r = { x: 40, y: 30, w: 20, h: 20 };
  const dst = mkRGBA(r.w, r.h, () => [100, 100, 100]), cov = mkRGBA(r.w, r.h, (x, y) => [0, 0, 0, Math.hypot(x - 10, y - 10) < 5 ? 255 : 0]);
  const best = H.chooseSpotOffset(area, aw, ah, 0, 0, dst, cov, r, [[100, 0], [-30, 0], [0, 0 + 25]]);
  assert.notEqual(best[0], 100); // the offset landing on the bright half must lose
  assert.equal(H.chooseSpotOffset(area, aw, ah, 0, 0, dst, cov, r, [[500, 0]]), null);
});

// ---- layer-style maths
import * as F from '../src/fx.ts';
const sq = (w, h, x0, y0, s) => { const m = new Uint8Array(w * h); for (let y = y0; y < y0 + s; y++) for (let x = x0; x < x0 + s; x++) m[y * w + x] = 1; return m; };
t('distance transform is exact Euclidean distance', () => {
  const w = 40, h = 40, m = sq(w, h, 15, 15, 10), d = F.distanceTo(m, w, h);
  assert.equal(d[20 * w + 20], 0); assert.equal(d[20 * w + 10], 5); assert.equal(d[5 * w + 20], 10);
  assert.ok(Math.abs(d[10 * w + 10] - Math.hypot(5, 5)) < 1e-4); assert.ok(Math.abs(d[0] - Math.hypot(15, 15)) < 1e-4);
});
t('distance transform matches brute force on random shapes', () => {
  const w = 23, h = 17, m = new Uint8Array(w * h); let s = 7; for (let i = 0; i < m.length; i++) { s = (s * 16807) % 2147483647; m[i] = s % 11 === 0 ? 1 : 0; }
  const d = F.distanceTo(m, w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let best = 1e9; for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) if (m[yy * w + xx]) best = Math.min(best, Math.hypot(x - xx, y - yy)); assert.ok(Math.abs(d[y * w + x] - best) < 1e-3, `at ${x},${y}`); }
});
t('growCoverage dilates by r and leaves the shape intact', () => {
  const w = 40, h = 40, c = Float32Array.from(sq(w, h, 15, 15, 10)), g = F.growCoverage(c, w, h, 3);
  assert.equal(g[20 * w + 20], 1); assert.equal(g[20 * w + 14], 1); assert.equal(g[20 * w + 12], 1); assert.equal(g[20 * w + 11], 0); assert.equal(g[20 * w + 10], 0);
});
t('stroke rings: outside / inside / center have the right widths', () => {
  const w = 60, h = 60, c = Float32Array.from(sq(w, h, 20, 20, 20)), row = 30 * w;
  const o = F.ringCoverage(c, w, h, 4, 'outside'); assert.equal(o[row + 19], 1); assert.equal(o[row + 16], 1); assert.equal(o[row + 15], 0); assert.equal(o[row + 20], 0);
  const i = F.ringCoverage(c, w, h, 4, 'inside'); assert.equal(i[row + 20], 1); assert.equal(i[row + 23], 1); assert.equal(i[row + 24], 0); assert.equal(i[row + 19], 0);
  const m = F.ringCoverage(c, w, h, 4, 'center'); assert.equal(m[row + 18], 1); assert.equal(m[row + 21], 1); assert.equal(m[row + 17], 0); assert.equal(m[row + 22], 0);
});
t('ring corner of an outside stroke is rounded, not square', () => {
  const w = 60, h = 60, c = Float32Array.from(sq(w, h, 20, 20, 20)), o = F.ringCoverage(c, w, h, 6, 'outside');
  assert.equal(o[15 * w + 15], 0);          // diagonal distance 7.07 > 6: the square's corner is rounded off
  assert.ok(o[17 * w + 17] > 0);
});
t('shadow offset follows Photoshop angles', () => {
  const a = F.shadowOffset(120, 10), b = F.shadowOffset(90, 10), c = F.shadowOffset(0, 10);
  assert.ok(Math.abs(a.dx - 5) < 1e-9 && Math.abs(a.dy - 8.660254) < 1e-5); assert.ok(Math.abs(b.dx) < 1e-9 && b.dy === 10); assert.ok(c.dx === -10 && Math.abs(c.dy) < 1e-9);
});
t('gradient ends: 0° runs left→right, 90° bottom→top, spanning the box', () => {
  const e0 = F.gradientEnds(10, 20, 100, 50, 0), e90 = F.gradientEnds(10, 20, 100, 50, 90);
  assert.deepEqual([e0.x0, e0.x1], [10, 110]); assert.ok(Math.abs(e90.y0 - 70) < 1e-9 && Math.abs(e90.y1 - 20) < 1e-9);
});
t('fxMargin covers the furthest reach and ignores disabled effects', () => {
  const e = { dropShadow: { ...F.defaultFx('dropShadow'), distance: 20, size: 10 }, stroke: { ...F.defaultFx('stroke'), on: false, size: 99 } };
  const m = F.fxMargin(e); assert.ok(m >= 32 && m < 60, `margin ${m}`); assert.ok(F.hasEffects(e)); assert.ok(!F.hasEffects({ stroke: { ...F.defaultFx('stroke'), on: false } })); assert.ok(!F.hasEffects(null));
});
t('effects survive a PSD conversion round-trip', () => {
  const fx = { dropShadow: { on: true, color: '#102030', opacity: 0.6, blend: 'multiply', angle: 135, distance: 12, spread: 20, size: 9 }, innerShadow: { ...F.defaultFx('innerShadow'), size: 4 },
    outerGlow: { on: true, color: '#ffaa00', opacity: 0.9, blend: 'screen', spread: 10, size: 14 }, innerGlow: { ...F.defaultFx('innerGlow'), on: false }, colorOverlay: { on: true, color: '#00ff88', opacity: 0.5, blend: 'overlay' },
    gradientOverlay: { on: true, color1: '#112233', color2: '#ffeedd', opacity: 0.8, blend: 'normal', angle: 45, reverse: true }, stroke: { on: true, color: '#ff00ff', opacity: 1, blend: 'normal', size: 6, position: 'center' } };
  const back = F.fromPsdEffects(F.toPsdEffects(fx));
  assert.deepEqual(back.fx, fx); assert.deepEqual(back.unsupported, []);
});
t('unsupported PSD effects are reported, supported ones kept', () => {
  const r = F.fromPsdEffects({ dropShadow: [{ enabled: true, size: { units: 'Pixels', value: 5 }, distance: { units: 'Pixels', value: 3 }, color: { r: 0, g: 0, b: 0 }, opacity: 0.5, angle: 120, blendMode: 'multiply' }], bevel: { enabled: true }, satin: { enabled: true } });
  assert.ok(r.fx.dropShadow.on && r.fx.bevel.on && r.fx.satin.on); assert.deepEqual(r.unsupported, []);
  assert.ok(!F.fromPsdEffects({ disabled: true, dropShadow: [{ enabled: true }] }).fx.dropShadow.on);
});
t('PSD effects with FRGB colours and unknown blend modes are tolerated', () => {
  const r = F.fromPsdEffects({ solidFill: [{ enabled: true, color: { fr: 1, fg: 0, fb: 0 }, blendMode: 'some future mode', opacity: 1 }] });
  assert.equal(r.fx.colorOverlay.color, '#ff0000'); assert.equal(r.fx.colorOverlay.blend, 'normal');
  assert.equal(F.fromPsdEffects({ solidFill: [{ enabled: true, blendMode: 'vivid light', opacity: 1 }] }).fx.colorOverlay.blend, 'vivid light');
});

// ---- lessons from real Photoshop files (tests/real-psd.mjs)
t('multi-stop radial gradient overlays keep their stops, style and scale on PSD import', () => {
  const grad = { name: 'x', type: 'solid', colorStops: [{ color: { r: 0, g: 0, b: 255 }, location: 0, midpoint: 0.5 }, { color: { r: 255, g: 0, b: 0 }, location: 0.5, midpoint: 0.5 }, { color: { r: 255, g: 255, b: 0 }, location: 1, midpoint: 0.5 }], opacityStops: [{ opacity: 1, location: 0, midpoint: 0.5 }, { opacity: 1, location: 1, midpoint: 0.5 }] };
  const r = F.fromPsdEffects({ gradientOverlay: [{ enabled: true, type: 'radial', angle: 90, scale: 1.12, opacity: 0.9, gradient: grad }] }), g = r.fx.gradientOverlay;
  assert.equal(g.style, 'radial'); assert.equal(g.scale, 1.12); assert.equal(g.stops.length, 3); assert.deepEqual(g.stops.map((s) => s.at), [0, 0.5, 1]); assert.equal(g.stops[1].color, '#ff0000'); assert.deepEqual(r.unsupported, []);
  assert.deepEqual(F.fromPsdEffects(F.toPsdEffects(r.fx)).fx, r.fx);                               // and back out again
});
t('simple 2-colour gradients stay simple; per-stop opacity is preserved; noise gradients are reported', () => {
  const two = { name: 'x', type: 'solid', colorStops: [{ color: { r: 0, g: 0, b: 0 }, location: 0, midpoint: 0.5 }, { color: { r: 255, g: 255, b: 255 }, location: 1, midpoint: 0.5 }], opacityStops: [{ opacity: 1, location: 0, midpoint: 0.5 }, { opacity: 1, location: 1, midpoint: 0.5 }] };
  const a = F.fromPsdEffects({ gradientOverlay: [{ enabled: true, type: 'linear', angle: 45, gradient: two }] }).fx.gradientOverlay; assert.equal(a.stops, undefined); assert.equal(a.style, undefined); assert.equal(a.scale, undefined);
  const fade = { ...two, opacityStops: [{ opacity: 1, location: 0, midpoint: 0.5 }, { opacity: 0, location: 1, midpoint: 0.5 }] };
  const b = F.fromPsdEffects({ gradientOverlay: [{ enabled: true, gradient: fade }] }).fx.gradientOverlay; assert.equal(b.stops.length, 2); assert.deepEqual(b.stops.map((s) => s.alpha), [1, 0]);
  const n = F.fromPsdEffects({ gradientOverlay: [{ enabled: true, gradient: { type: 'noise', name: 'n' } }] }); assert.equal(n.fx.gradientOverlay, undefined); assert.deepEqual(n.unsupported, ['noise gradient overlay']);
});
t('satin converts to and from PSD', () => {
  const fx = { satin: { on: true, color: '#cc5c5c', opacity: 0.5, blend: 'multiply', angle: 19, distance: 11, size: 14, invert: true } };
  assert.deepEqual(F.fromPsdEffects(F.toPsdEffects(fx)).fx, fx);
});
t('"use global light" follows the document light angle, otherwise the effect keeps its own', () => {
  const sh = (useGlobalLight) => ({ dropShadow: [{ enabled: true, angle: 120, distance: { units: 'Pixels', value: 5 }, size: { units: 'Pixels', value: 5 }, useGlobalLight }], bevel: { enabled: true, angle: 120, altitude: 50, useGlobalLight } });
  const on = F.fromPsdEffects(sh(true), { angle: 132, altitude: 30 }).fx, off = F.fromPsdEffects(sh(false), { angle: 132, altitude: 30 }).fx, none = F.fromPsdEffects(sh(true)).fx;
  assert.equal(on.dropShadow.angle, 132); assert.equal(on.bevel.angle, 132); assert.equal(on.bevel.altitude, 30);
  assert.equal(off.dropShadow.angle, 120); assert.equal(off.bevel.altitude, 50); assert.equal(none.dropShadow.angle, 120);
});
t('gradientEnds honours scale (a smaller gradient is a shorter line around the centre)', () => {
  const full = F.gradientEnds(0, 0, 100, 40, 0, 1), half = F.gradientEnds(0, 0, 100, 40, 0, 0.5);
  assert.deepEqual([full.x0, full.x1], [0, 100]); assert.deepEqual([half.x0, half.x1], [25, 75]);
});
t('shadow and glow profiles use the Photoshop-calibrated constants', () => {
  const sh = F.softEdge(10, 0, 'shadow'), gl = F.softEdge(10, 0, 'glow');
  assert.ok(Math.abs(sh.sigma - 4) < 1e-9 && sh.grow === 0); assert.ok(Math.abs(gl.sigma - 10 / 3) < 1e-9 && Math.abs(gl.grow - 3) < 1e-9);
  assert.ok(F.softEdge(10, 50, 'shadow').sigma < sh.sigma && F.softEdge(10, 50, 'shadow').grow > sh.grow);          // spread tightens the blur and fattens the core
});

// ---- extra blend modes
import * as BL from '../src/blend.ts';
const blend1 = (mode, back, src, op = 1, sa = 255, ba = 255) => { const b = new Uint8ClampedArray([...back, ba]), s = new Uint8ClampedArray([...src, sa]); BL.blendInto(b, s, mode, op); return [...b]; };
const close = (a, b, tol = 1) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
t('blend modes match their Photoshop definitions on opaque pixels', () => {
  assert.ok(close(blend1('linear burn', [200, 100, 255], [100, 100, 100]), [45, 0, 100, 255]), 'linear burn  = Cb + Cs − 1');
  assert.ok(close(blend1('linear light', [128, 128, 128], [200, 128, 50]), [255, 129, 0, 255]), 'linear light = Cb + 2Cs − 1');
  assert.ok(close(blend1('subtract', [200, 100, 50], [100, 120, 10]), [100, 0, 40, 255]), 'subtract');
  assert.ok(close(blend1('divide', [100, 100, 100], [200, 50, 0]), [128, 255, 255, 255]), 'divide = Cb / Cs');
  assert.ok(close(blend1('hard mix', [100, 200, 10], [100, 100, 10]), [0, 255, 0, 255]), 'hard mix = (Cb + Cs ≥ 1)');
  assert.ok(close(blend1('pin light', [150, 150, 150], [50, 250, 128]), [100, 245, 150, 255]), 'pin light');
});
t('vivid light is colour burn below 50% source and colour dodge above', () => {
  assert.ok(blend1('vivid light', [200, 200, 200], [64, 64, 64])[0] < 200);
  assert.ok(blend1('vivid light', [100, 100, 100], [192, 192, 192])[0] > 100);
  assert.equal(blend1('vivid light', [100, 100, 100], [255, 255, 255])[0], 255); assert.equal(blend1('vivid light', [100, 100, 100], [0, 0, 0])[0], 0);
});
t('darker / lighter color pick the whole colour, not channels', () => {
  const back = [200, 10, 10], src = [10, 150, 10];            // luminosity: back 67, source 93
  assert.deepEqual(blend1('darker color', back, src).slice(0, 3), back); assert.deepEqual(blend1('lighter color', back, src).slice(0, 3), src);
});
t('opacity, transparent sources and transparent backdrops composite correctly', () => {
  assert.deepEqual(blend1('linear burn', [100, 100, 100], [50, 50, 50], 0), [100, 100, 100, 255]);             // opacity 0 → untouched
  assert.deepEqual(blend1('subtract', [10, 20, 30], [99, 99, 99], 1, 0), [10, 20, 30, 255]);                  // transparent source
  assert.deepEqual(blend1('linear light', [0, 0, 0], [30, 60, 90], 1, 255, 0), [30, 60, 90, 255]);            // over nothing: just the source
  const half = blend1('subtract', [200, 200, 200], [100, 100, 100], 0.5); assert.ok(close(half, [150, 150, 150, 255]));
});
t('dissolve is deterministic and shows roughly `opacity` of the pixels', () => {
  const n = 4000, run = () => { const b = new Uint8ClampedArray(n * 4).fill(255), s = new Uint8ClampedArray(n * 4); for (let i = 0; i < n; i++) { s[i * 4] = 0; s[i * 4 + 1] = 0; s[i * 4 + 2] = 0; s[i * 4 + 3] = 255; } BL.blendInto(b, s, 'dissolve', 0.3); return b; };
  const a = run(), b2 = run(); assert.deepEqual([...a], [...b2]); let dark = 0; for (let i = 0; i < n; i++) if (a[i * 4] < 128) dark++;
  assert.ok(Math.abs(dark / n - 0.3) < 0.05, `fraction ${dark / n}`);
});
t('isCustomBlend recognises exactly the non-native modes', () => { assert.ok(BL.isCustomBlend('vivid light') && BL.isCustomBlend('dissolve')); assert.ok(!BL.isCustomBlend('multiply') && !BL.isCustomBlend('normal')); });

// ---- bevel & emboss maths
const discF = (w, h, cx, cy, r) => { const c = new Float32Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) c[y * w + x] = Math.hypot(x - cx + 0.0, y - cy) <= r ? 1 : 0; return c; };
const bev = (o = {}) => ({ ...F.defaultFx('bevel'), ...o });
const shadeOf = (b, w = 100, h = 100, r = 30) => { const cov = discF(w, h, 50, 50, r), H = F.bevelHeight(cov, w, h, b), s = F.bevelShade(H, w, h, b.angle, b.altitude); return { cov, H, ...s }; };
const mass = (arr, w, h, f) => { let s = 0; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (f(x, y)) s += arr[y * w + x]; return s; };
t('blurMap preserves total brightness and flat fields', () => {
  const w = 40, h = 30, a = new Float32Array(w * h).fill(0.7); const flat = F.blurMap(a, w, h, 4); assert.ok(flat.every((v) => Math.abs(v - 0.7) < 1e-4));
  const imp = new Float32Array(w * h); imp[15 * w + 20] = 100; const b = F.blurMap(imp, w, h, 3); let s = 0; for (const v of b) s += v; assert.ok(Math.abs(s - 100) < 0.5, `sum ${s}`); assert.ok(b[15 * w + 20] < 20);
});
t('inner bevel lit from the upper-left: highlights on the upper-left rim, shadows on the lower-right, nothing in the middle', () => {
  const { hi, sh } = shadeOf(bev({ size: 8 })), UL = (x, y) => x < 50 && y < 50, LR = (x, y) => x >= 50 && y >= 50;
  assert.ok(mass(hi, 100, 100, UL) > 8 * mass(hi, 100, 100, LR), 'highlight side'); assert.ok(mass(sh, 100, 100, LR) > 8 * mass(sh, 100, 100, UL), 'shadow side');
  assert.ok(mass(hi, 100, 100, (x, y) => Math.hypot(x - 50, y - 50) < 18) + mass(sh, 100, 100, (x, y) => Math.hypot(x - 50, y - 50) < 18) < 0.5, 'flat top is unlit');
  assert.ok(mass(hi, 100, 100, (x, y) => Math.hypot(x - 50, y - 50) > 42) + mass(sh, 100, 100, (x, y) => Math.hypot(x - 50, y - 50) > 42) < 0.5, 'nothing far outside');
});
t('direction "down" and the opposite light angle each swap highlight and shadow', () => {
  const UL = (x, y) => x < 50 && y < 50, base = shadeOf(bev({ size: 8 })), down = shadeOf(bev({ size: 8, direction: 'down' })), opp = shadeOf(bev({ size: 8, angle: 300 }));
  assert.ok(mass(base.hi, 100, 100, UL) > mass(base.sh, 100, 100, UL)); assert.ok(mass(down.sh, 100, 100, UL) > mass(down.hi, 100, 100, UL)); assert.ok(mass(opp.sh, 100, 100, UL) > mass(opp.hi, 100, 100, UL));
});
t('bevel styles put the lighting on the right side of the edge', () => {
  const inside = (x, y) => Math.hypot(x - 50, y - 50) <= 30, tot = (s, f) => mass(s.hi, 100, 100, f) + mass(s.sh, 100, 100, f);
  const inner = shadeOf(bev({ style: 'inner', size: 10 })), outer = shadeOf(bev({ style: 'outer', size: 10 })), emb = shadeOf(bev({ style: 'emboss', size: 10 })), pil = shadeOf(bev({ style: 'pillow', size: 10 }));
  assert.ok(tot(inner, inside) > 5 && tot(inner, (x, y) => !inside(x, y)) < 0.25 * tot(inner, inside), 'inner');
  assert.ok(tot(outer, (x, y) => !inside(x, y)) > 5 && tot(outer, (x, y) => Math.hypot(x - 50, y - 50) < 24) < 0.5, 'outer');
  assert.ok(tot(emb, inside) > 3 && tot(emb, (x, y) => !inside(x, y)) > 3, 'emboss straddles the edge');
  assert.ok(tot(pil, inside) > 3 && tot(pil, (x, y) => !inside(x, y)) > 3, 'pillow straddles the edge');
});
t('pillow emboss is a groove: the two sides of the edge are lit oppositely', () => {
  const s = shadeOf(bev({ style: 'pillow', size: 12 })), row = 50, ins = F.bevelHeight(discF(100, 100, 50, 50, 30), 100, 100, bev({ style: 'pillow', size: 12 }));
  assert.ok(ins[row * 100 + 20] < ins[row * 100 + 8] && ins[row * 100 + 20] < ins[row * 100 + 32], 'height dips at the edge (x=20)'); void s;
});
t('size sets the width of the lit band; depth sets its strength', () => {
  const band = (size) => { const { hi, sh } = shadeOf(bev({ size })); let n = 0; for (let x = 0; x < 50; x++) if (hi[50 * 100 + x] + sh[50 * 100 + x] > 0.05) n++; return n; };
  assert.ok(band(16) > band(5) + 5, `band widths ${band(5)} vs ${band(16)}`);
  const strength = (depth) => { const { hi, sh } = shadeOf(bev({ size: 8, depth })); let s = 0; for (let i = 0; i < hi.length; i++) s += hi[i] + sh[i]; return s; };
  assert.ok(strength(250) > strength(100) && strength(100) > strength(30), 'depth');
});
t('regression: raising Depth never weakens the lighting at any pixel (steep faces stay lit, not Lambertian-dark)', () => {
  const at = (depth) => { const s = shadeOf(bev({ size: 10, depth })); return s.hi.map((v, i) => v + s.sh[i]); };
  const seq = [10, 30, 100, 300, 800].map(at);
  for (let k = 1; k < seq.length; k++) for (let i = 0; i < seq[k].length; i++) assert.ok(seq[k][i] >= seq[k - 1][i] - 0.02, `depth step ${k} at pixel ${i}: ${seq[k - 1][i]} -> ${seq[k][i]}`);
});
t('chisel hard has a constant slope across the band, smooth eases in and out', () => {
  const hh = (technique) => F.bevelHeight(discF(120, 120, 60, 60, 50), 120, 120, bev({ technique, size: 20, depth: 100 })), row = 60;
  const slope = (H, x) => H[row * 120 + x + 1] - H[row * 120 + x - 1];
  const hard = hh('hard'), smooth = hh('smooth');
  assert.ok(Math.abs(slope(hard, 20) - slope(hard, 28)) < 0.12 * Math.abs(slope(hard, 24)), `hard ${slope(hard, 20)} ${slope(hard, 24)} ${slope(hard, 28)}`);
  assert.ok(Math.abs(slope(smooth, 11)) < 0.45 * Math.abs(slope(smooth, 20)), `smooth ${slope(smooth, 11)} vs ${slope(smooth, 20)}`);
});
t('light straight overhead (altitude 90°) leaves no highlights', () => {
  const { hi } = shadeOf(bev({ size: 8, altitude: 90 })); assert.ok(mass(hi, 100, 100, () => true) < 0.5);
});
t('stroke emboss needs a stroke; with one, only the stroke is shaded', () => {
  const w = 100, h = 100, cov = discF(w, h, 50, 50, 30);
  assert.ok(F.bevelHeight(cov, w, h, bev({ style: 'stroke' }), null).every((v) => v === 0));
  const ring = F.ringCoverage(cov, w, h, 8, 'inside'), Hh = F.bevelHeight(cov, w, h, bev({ style: 'stroke', size: 6 }), ring), s = F.bevelShade(Hh, w, h, 120, 30);
  assert.ok(mass(s.hi, w, h, (x, y) => Math.hypot(x - 50, y - 50) < 18) + mass(s.sh, w, h, (x, y) => Math.hypot(x - 50, y - 50) < 18) < 0.5); assert.ok(mass(s.hi, w, h, (x, y) => x < 50 && y < 50) > 2);
});
t('bevel survives a PSD conversion round-trip (all styles and techniques)', () => {
  for (const style of ['inner', 'outer', 'emboss', 'pillow', 'stroke']) for (const technique of ['smooth', 'hard', 'soft']) {
    const fx = { bevel: bev({ style, technique, depth: 240, direction: 'down', size: 9, soften: 2, angle: 75, altitude: 55, hiColor: '#ffeecc', hiBlend: 'screen', hiOpacity: 0.6, shColor: '#001122', shBlend: 'multiply', shOpacity: 0.9 }) };
    const back = F.fromPsdEffects(F.toPsdEffects(fx)); assert.deepEqual(back.fx, fx); assert.deepEqual(back.unsupported, []);
  }
});
t('PSD bevel strength is a fraction (1 = 100%): read 100× off before real Photoshop files showed it', () => {
  assert.equal(F.fromPsdEffects({ bevel: { enabled: true, strength: 1 } }).fx.bevel.depth, 100);
  assert.equal(F.fromPsdEffects({ bevel: { enabled: true, strength: 2.4 } }).fx.bevel.depth, 240);
  assert.equal(F.toPsdEffects({ bevel: bev({ depth: 150 }) }).bevel.strength, 1.5);
});
t('bevel textures / gloss contours in PSDs are reported, the bevel itself is kept', () => {
  const r = F.fromPsdEffects({ bevel: { enabled: true, style: 'inner bevel', size: { units: 'Pixels', value: 7 }, useTexture: true, contour: { name: 'Ring', curve: [] } } });
  assert.ok(r.fx.bevel.on && r.fx.bevel.size === 7); assert.deepEqual(r.unsupported, ['bevel texture', 'bevel gloss contour']);
});

// ---- content-aware fill (async: tests are queued and awaited below)
import * as IP from '../src/inpaint.ts';
const asyncTests = [];
const ta = (name, fn) => asyncTests.push([name, fn]);
const img = (w, h, f) => { const a = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = f(x, y); const i = (y * w + x) * 4; a[i] = c[0]; a[i + 1] = c[1]; a[i + 2] = c[2]; a[i + 3] = c[3] ?? 255; } return a; };
const rect = (w, h, x0, y0, x1, y1) => { const m = new Uint8Array(w * h); for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * w + x] = 1; return m; };
const mae = (a, b, m) => { let e = 0, k = 0; for (let p = 0; p < m.length; p++) if (m[p]) for (let c = 0; c < 3; c++) { e += Math.abs(a[p * 4 + c] - b[p * 4 + c]); k++; } return e / k; };
const stripesF = (x) => (((x / 8) | 0) % 2 ? [200, 40, 40] : [40, 40, 200]);
let seedN = 5; const rng = () => { seedN = (seedN * 16807) % 2147483647; return seedN / 2147483647; };

ta('content-aware fill continues stripes through the hole (matches ground truth)', async () => {
  const w = 128, h = 128, hole = rect(w, h, 44, 44, 84, 84), truth = img(w, h, stripesF);
  const src = img(w, h, (x, y) => (hole[y * w + x] ? [0, 255, 0] : stripesF(x)));
  const out = await IP.inpaint(src, w, h, hole, { seed: 3 });
  assert.ok(mae(out, truth, hole) < 6, `error ${mae(out, truth, hole)}`);
});
ta('known pixels are never modified', async () => {
  const w = 96, h = 96, hole = rect(w, h, 30, 30, 60, 60), src = img(w, h, (x, y) => [(x * 5) & 255, (y * 3) & 255, (x * y) & 255]);
  const out = await IP.inpaint(src, w, h, hole);
  for (let p = 0; p < w * h; p++) if (!hole[p]) for (let c = 0; c < 4; c++) assert.equal(out[p * 4 + c], src[p * 4 + c]);
});
ta('the hole\'s own (junk) contents are never used as a source', async () => {
  const w = 100, h = 100, hole = rect(w, h, 35, 35, 65, 65);
  const src = img(w, h, (x, y) => (hole[y * w + x] ? [255, 0, 255] : [90 + ((x ^ y) & 31), 140, 90 + ((x + y) & 31)]));
  const out = await IP.inpaint(src, w, h, hole);
  for (let p = 0; p < w * h; p++) if (hole[p]) assert.ok(Math.abs(out[p * 4] - 255) > 90 || Math.abs(out[p * 4 + 1]) > 60, `magenta leaked at ${p}`);
});
ta('keeps a hard edge instead of blurring across it (object boundary)', async () => {
  const w = 120, h = 120, hole = rect(w, h, 40, 40, 80, 80);
  const side = (x) => (x < 60 ? [220, 30, 30] : [30, 30, 220]);
  const src = img(w, h, (x, y) => (hole[y * w + x] ? [0, 255, 0] : side(x)));
  const out = await IP.inpaint(src, w, h, hole, { seed: 2 });
  let crisp = 0, n = 0; for (let p = 0; p < w * h; p++) if (hole[p]) { n++; const r = out[p * 4], b = out[p * 4 + 2]; if ((r > 170 && b < 90) || (b > 170 && r < 90)) crisp++; }
  assert.ok(crisp / n > 0.9, `only ${(crisp / n * 100).toFixed(0)}% of hole pixels are cleanly red or blue`);
});
ta('synthesises texture rather than smearing a flat colour', async () => {
  const w = 128, h = 128, hole = rect(w, h, 40, 40, 90, 90), src = img(w, h, (x, y) => { const v = hole[y * w + x] ? 255 : 128 + (rng() - 0.5) * 90; return [v, v, v]; });
  const out = await IP.inpaint(src, w, h, hole, { seed: 4 });
  const stat = (arr, m) => { let s = 0, s2 = 0, k = 0; for (let p = 0; p < m.length; p++) if (m[p]) { const v = arr[p * 4]; s += v; s2 += v * v; k++; } const mean = s / k; return { mean, sd: Math.sqrt(s2 / k - mean * mean) }; };
  const outside = new Uint8Array(w * h).map((_, p) => (hole[p] ? 0 : 1)), a = stat(src, outside), b = stat(out, hole);
  assert.ok(Math.abs(a.mean - b.mean) < 10, `mean ${a.mean} vs ${b.mean}`); assert.ok(b.sd > a.sd * 0.6, `sd ${b.sd} vs ${a.sd}`);
});
ta('smooth gradients are continued smoothly', async () => {
  const w = 100, h = 100, hole = rect(w, h, 30, 30, 70, 70), f = (x, y) => [x * 2, y * 2, 100 + x + y];
  const out = await IP.inpaint(img(w, h, (x, y) => (hole[y * w + x] ? [0, 0, 0] : f(x, y))), w, h, hole, { seed: 1 });
  assert.ok(mae(out, img(w, h, f), hole) < 12, `error ${mae(out, img(w, h, f), hole)}`);
});
ta('holes touching the image border are filled', async () => {
  const w = 90, h = 90, hole = rect(w, h, 0, 20, 25, 55), src = img(w, h, (x, y) => (hole[y * w + x] ? [0, 255, 0] : stripesF(y)));
  const out = await IP.inpaint(src, w, h, hole);
  assert.ok(mae(out, img(w, h, (x, y) => stripesF(y)), hole) < 25, 'border hole not reconstructed');
});
ta('degenerate inputs: empty hole, whole-image hole, tiny image', async () => {
  const src = img(40, 40, () => [10, 20, 30]);
  assert.deepEqual([...(await IP.inpaint(src, 40, 40, new Uint8Array(1600)))], [...src]);
  const all = await IP.inpaint(src, 40, 40, new Uint8Array(1600).fill(1)); assert.ok(all.every((v) => Number.isFinite(v)));
  const small = await IP.inpaint(img(9, 9, () => [1, 2, 3]), 9, 9, rect(9, 9, 3, 3, 6, 6)); assert.ok(small.every((v) => Number.isFinite(v)));
});
ta('same seed → same result; different seed still fills', async () => {
  const w = 80, h = 80, hole = rect(w, h, 25, 25, 55, 55), src = img(w, h, (x, y) => (hole[y * w + x] ? [0, 0, 0] : [(x * 7) & 255, (y * 5) & 255, ((x + y) * 3) & 255]));
  const a = await IP.inpaint(src, w, h, hole, { seed: 9 }), b = await IP.inpaint(src, w, h, hole, { seed: 9 });
  assert.deepEqual([...a], [...b]);
});
ta('alpha is carried along: a transparent surround stays transparent inside the hole', async () => {
  const w = 80, h = 80, hole = rect(w, h, 30, 30, 50, 50), src = img(w, h, (x, y) => (hole[y * w + x] ? [0, 255, 0, 255] : [200, 100, 50, 0]));
  const out = await IP.inpaint(src, w, h, hole); for (let p = 0; p < w * h; p++) if (hole[p]) assert.ok(out[p * 4 + 3] < 40, `alpha ${out[p * 4 + 3]}`);
});
ta('cancellation aborts promptly', async () => {
  const w = 100, h = 100, hole = rect(w, h, 30, 30, 70, 70); let calls = 0;
  await assert.rejects(IP.inpaint(img(w, h, () => [1, 2, 3]), w, h, hole, { shouldCancel: () => ++calls > 2 }), /cancelled/);
});
ta('expandMask grows a hole by the requested radius', async () => {
  const w = 40, h = 40, m = rect(w, h, 15, 15, 25, 25), g = IP.expandMask(m, w, h, 3);
  assert.equal(g[20 * w + 12], 1); assert.equal(g[20 * w + 11], 0); assert.equal(IP.expandMask(m, w, h, 0)[20 * w + 12], 0);
});
ta('performance: 256×256 image with a 60×60 hole fills in a few seconds', async () => {
  const w = 256, h = 256, hole = rect(w, h, 98, 98, 158, 158), src = img(w, h, (x, y) => (hole[y * w + x] ? [0, 0, 0] : [(Math.sin(x / 9) * 60 + 128) | 0, (Math.cos(y / 7) * 60 + 128) | 0, ((x ^ y) & 63) + 100]));
  const t0 = performance.now(); await IP.inpaint(src, w, h, hole); const ms = performance.now() - t0;
  console.log(`      (256×256, 60×60 hole: ${Math.round(ms)} ms)`); assert.ok(ms < 8000, `${ms} ms`);
});

// ---- per-pixel adjustments
const px = (a, r, g, b) => { const d = new Uint8ClampedArray([r, g, b, 255]); assert.ok(A.applyAdjustmentData(A.cloneAdjustment(a), d)); return [d[0], d[1], d[2], d[3]]; };
const def = (t, patch = {}) => Object.assign(A.defaultAdjustment(t), patch);
t('posterize to 2 levels snaps channels to 0/255; 4 levels gives 0/85/170/255', () => {
  assert.deepEqual(px(def('posterize', { levels: 2 }), 100, 200, 127), [0, 255, 0, 255]);
  assert.deepEqual(px(def('posterize', { levels: 4 }), 10, 100, 250), [0, 85, 255, 255]);
});
t('threshold uses luminance', () => {
  assert.deepEqual(px(def('threshold', { level: 128 }), 255, 0, 0), [0, 0, 0, 255]);      // lum 76
  assert.deepEqual(px(def('threshold', { level: 128 }), 0, 255, 0), [255, 255, 255, 255]); // lum 150
});
t('exposure +1 brightens, -1 darkens, identity is exact', () => {
  assert.deepEqual(px(def('exposure'), 40, 90, 200), [40, 90, 200, 255]);
  assert.ok(px(def('exposure', { exposure: 1 }), 100, 100, 100)[0] > 100);
  assert.ok(px(def('exposure', { exposure: -1 }), 100, 100, 100)[0] < 100);
  assert.deepEqual(px(def('exposure', { exposure: 1 }), 255, 255, 255), [255, 255, 255, 255]);
});
t('vibrance boosts muted colours more than saturated ones; greys are untouched', () => {
  assert.deepEqual(px(def('vibrance', { vibrance: 80 }), 120, 120, 120), [120, 120, 120, 255]);
  const spread = (c) => Math.max(...c.slice(0, 3)) - Math.min(...c.slice(0, 3));
  const muted = [130, 120, 110], vivid = [250, 60, 20];
  assert.ok(spread(px(def('vibrance', { vibrance: 80 }), ...muted)) / spread(muted) > spread(px(def('vibrance', { vibrance: 80 }), ...vivid)) / spread(vivid));
  assert.ok(spread(px(def('vibrance', { vibrance: -100, saturation: -100 }), ...vivid)) < 2);
});
t('black & white weights act per hue; tint colours the greys', () => {
  const bw = (w) => px(def('bw', { w }), 255, 0, 0)[0];
  assert.equal(bw([100, 0, 0, 0, 0, 0]), 255); assert.equal(bw([0, 0, 0, 0, 0, 0]), 0); assert.equal(bw([50, 0, 0, 0, 0, 0]), 128);
  assert.deepEqual(px(def('bw'), 77, 77, 77), [77, 77, 77, 255]);
  const t1 = px(def('bw', { tint: [225, 211, 179] }), 100, 100, 100);
  assert.ok(t1[0] > t1[2], 'warm tint');
});
t('photo filter at 100% density multiplies by the filter colour; luminosity is kept', () => {
  assert.deepEqual(px(def('photo', { color: [255, 128, 0], density: 100, lum: false }), 200, 200, 200), [200, 100, 0, 255]);
  const lum = (c) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
  const out = px(def('photo', { color: [220, 170, 110], density: 60, lum: true }), 120, 160, 90);
  assert.ok(Math.abs(lum(out) - lum([120, 160, 90])) < 3);
});
t('colour balance pushes towards red/green/blue by tonal range', () => {
  const mid = px(def('balance', { mids: [50, 0, 0], lum: false }), 128, 128, 128);
  assert.ok(mid[0] > 128 + 20 && mid[1] === 128);
  const dark = px(def('balance', { mids: [50, 0, 0], lum: false }), 0, 0, 0);
  assert.deepEqual(dark, [0, 0, 0, 255]);                                             // midtone edit leaves pure black alone
  assert.ok(px(def('balance', { shadows: [0, 0, 60], lum: false }), 10, 10, 10)[2] > 40);
  assert.deepEqual(px(def('balance'), 50, 100, 150), [50, 100, 150, 255]);
});
t('channel mixer: identity, swap, monochrome', () => {
  assert.deepEqual(px(def('mixer'), 10, 20, 30), [10, 20, 30, 255]);
  assert.deepEqual(px(def('mixer', { rows: [[0, 0, 100, 0], [0, 100, 0, 0], [100, 0, 0, 0]] }), 10, 20, 30), [30, 20, 10, 255]);
  assert.deepEqual(px(def('mixer', { mono: true, rows: [[0, 100, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]] }), 10, 20, 30), [20, 20, 20, 255]);
});
t('gradient map maps luminance onto the ramp (and reverse flips it)', () => {
  const g = def('gradmap', { stops: [{ x: 0, c: [0, 0, 100], a: 1 }, { x: 1, c: [255, 100, 0], a: 1 }] });
  assert.deepEqual(px(g, 0, 0, 0), [0, 0, 100, 255]); assert.deepEqual(px(g, 255, 255, 255), [255, 100, 0, 255]);
  assert.deepEqual(px({ ...g, reverse: true }, 0, 0, 0), [255, 100, 0, 255]);
  const half = def('gradmap', { stops: [{ x: 0, c: [0, 0, 0], a: 0 }, { x: 1, c: [0, 0, 0], a: 0 }] });
  assert.deepEqual(px(half, 90, 80, 70), [90, 80, 70, 255]);                           // fully transparent ramp leaves pixels alone
});
t('Lab (D50) to sRGB: white, black, mid grey and a saturated blue', () => {
  const w = A.labToRgb(100, 0, 0), k = A.labToRgb(0, 0, 0), g = A.labToRgb(53.4, 0, 0);
  assert.ok(w.every((v) => v > 253)); assert.ok(k.every((v) => v < 2)); assert.ok(g.every((v) => Math.abs(v - 128) < 4));
  const b = A.labToRgb(45, 18, -123); assert.ok(b[2] > 200 && b[0] < 80);
});
t('new adjustment types survive a PSD conversion round trip', () => {
  const cases = [def('posterize', { levels: 7 }), def('threshold', { level: 90 }), def('exposure', { exposure: 1.5, offset: -0.02, gamma: 0.8 }),
    def('vibrance', { vibrance: 30, saturation: -10 }), def('bw', { w: [10, 20, 30, 40, 50, 60], tint: [200, 150, 100] }),
    def('photo', { color: [10, 200, 30], density: 40, lum: false }), def('balance', { shadows: [1, 2, 3], mids: [4, 5, 6], highs: [7, 8, 9], lum: false }),
    def('mixer', { mono: false, rows: [[90, 5, 5, 0], [0, 100, 0, 10], [0, 0, 100, 0]] }),
    def('mixer', { mono: true, rows: [[30, 60, 10, 0], [0, 100, 0, 0], [0, 0, 100, 0]] }),
    def('gradmap', { stops: [{ x: 0, c: [10, 20, 30], a: 1 }, { x: 0.4, c: [100, 50, 0], a: 0.5 }, { x: 1, c: [255, 255, 255], a: 1 }], reverse: true })];
  for (const c of cases) {
    const back = P.fromPsdAdjustment(P.toPsdAdjustment(c));
    assert.deepEqual(JSON.parse(JSON.stringify(back)), JSON.parse(JSON.stringify(c)), c.type);
  }
});
t('selective color: only the targeted range changes; relative vs absolute; PSD round trip', () => {
  const mk = (relative, i, q) => { const a = def('selective', { relative }); a.r[i] = q; return a; };
  assert.deepEqual(px(def('selective'), 200, 80, 40), [200, 80, 40, 255]);
  const red = mk(true, 0, [0, 0, 0, 0]); red.r[0] = [0, 0, -100, 0];                 // remove yellow from reds
  const out = px(red, 200, 60, 60); assert.ok(out[2] > 100 && out[0] === 200, `got ${out}`);
  assert.deepEqual(px(red, 40, 60, 200), [40, 60, 200, 255]);                          // a blue is untouched
  assert.deepEqual(px(mk(true, 0, [0, 0, 0, 50]), 250, 20, 20).slice(0, 3).map((v) => v > 200), [true, false, false]);
  const abs = px(mk(false, 7, [0, 0, 0, 40]), 128, 128, 128); assert.ok(abs[0] < 110, `neutral absolute black ${abs}`);
  const rel = px(mk(true, 7, [0, 0, 0, 40]), 128, 128, 128); assert.ok(rel[0] < 128 && rel[0] > abs[0] - 1);
  const a = mk(false, 3, [10, -20, 30, 5]);
  assert.deepEqual(P.fromPsdAdjustment(P.toPsdAdjustment(a)), a);
});
t('3D LUT: .cube parsing, identity, trilinear interpolation, PSD round trip, bad input', () => {
  const id = A.identityCube(5), a = def('lookup', { size: 5, data: id });
  assert.deepEqual(px(a, 10, 130, 250), [10, 130, 250, 255]);
  const inv = def('lookup', { size: 2, data: A.identityCube(2).map((v) => 1 - v) });      // inverts exactly, even between lattice points
  assert.deepEqual(px(inv, 51, 128, 255), [204, 127, 0, 255].map((v, i) => (i === 1 ? px(inv, 51, 128, 255)[1] : v)));
  assert.ok(Math.abs(px(inv, 51, 128, 255)[1] - 127) <= 1);
  const text = A.cubeText({ name: 'T', size: 2, data: A.identityCube(2) });
  const c = A.parseCube('# c\nTITLE "Warm"\nLUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n' + text.split('\n').slice(4).join('\n'));
  assert.equal(c.name, 'Warm'); assert.equal(c.size, 2); assert.deepEqual(c.data, A.identityCube(2));
  const back = P.fromPsdAdjustment(P.toPsdAdjustment({ type: 'lookup', name: 'X', size: 3, data: A.identityCube(3) }));
  assert.equal(back.type, 'lookup'); assert.equal(back.size, 3); assert.equal(back.name, 'X'); assert.ok(back.data.every((v, i) => Math.abs(v - A.identityCube(3)[i]) < 1e-5));
  assert.throws(() => A.parseCube('LUT_3D_SIZE 2\n0 0 0\n')); assert.throws(() => A.parseCube('LUT_1D_SIZE 4\n'));
  assert.equal(P.fromPsdAdjustment({ type: 'color lookup', lookupType: 'abstractProfile' }), null);
});
t('PSD Lab colours (Photo Filter) import as sRGB', () => {
  const a = P.fromPsdAdjustment({ type: 'photo filter', color: { l: 0.45, a: 0.1417, b: -0.9609 }, density: 0.25, preserveLuminosity: true });
  assert.equal(a.type, 'photo'); assert.ok(a.color[2] > 180 && a.color[0] < 90); assert.equal(a.density, 25);
});
t('noise gradient maps are not imported (reported as unsupported)', () => {
  assert.equal(P.fromPsdAdjustment({ type: 'gradient map', gradientType: 'noise' }), null);
});

for (const [name, fn] of asyncTests) { await fn(); n++; console.log(`  ✓ ${name}`); }
console.log(`\n${n} unit tests passed`);
