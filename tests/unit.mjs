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
  assert.equal(P.fromPsdAdjustment({ type: 'vibrance', vibrance: 20 }), null);
  assert.equal(P.fromPsdAdjustment({ type: 'selective color' }), null);
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
for (const [name, fn] of asyncTests) { await fn(); n++; console.log(`  ✓ ${name}`); }
console.log(`\n${n} unit tests passed`);
