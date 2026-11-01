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
console.log(`\n${n} unit tests passed`);
