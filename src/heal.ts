// Healing maths (pure; no DOM). Seamless-clone style: keep the source's texture, but take colour/lighting
// from the destination's surroundings by smoothly interpolating the boundary colour difference inward.

/**
 * Fill unknown pixels of a 3-channel field by smooth interpolation of the known ones
 * (push-pull pyramid for a global fill, then Gauss-Seidel relaxation towards a harmonic surface).
 * `known[p]` is 0/1. Known pixels are returned unchanged. With no known pixels the result is all zeros.
 */
export function fillMembrane(field: Float32Array, known: Uint8Array, w: number, h: number, relax = 12): Float32Array {
  const n = w * h;
  type Level = { w: number; h: number; sv: Float32Array; sw: Float32Array };
  const sv0 = new Float32Array(n * 3), sw0 = new Float32Array(n);
  for (let p = 0; p < n; p++) if (known[p]) { sw0[p] = 1; sv0[p * 3] = field[p * 3]; sv0[p * 3 + 1] = field[p * 3 + 1]; sv0[p * 3 + 2] = field[p * 3 + 2]; }
  const lv: Level[] = [{ w, h, sv: sv0, sw: sw0 }];
  while (lv[lv.length - 1].w > 1 || lv[lv.length - 1].h > 1) {
    const c = lv[lv.length - 1], nw = (c.w + 1) >> 1, nh = (c.h + 1) >> 1;
    const sv = new Float32Array(nw * nh * 3), sw = new Float32Array(nw * nh);
    for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
      const s = y * c.w + x, d = (y >> 1) * nw + (x >> 1);
      sw[d] += c.sw[s]; sv[d * 3] += c.sv[s * 3]; sv[d * 3 + 1] += c.sv[s * 3 + 1]; sv[d * 3 + 2] += c.sv[s * 3 + 2];
    }
    lv.push({ w: nw, h: nh, sv, sw });
  }
  if (lv[lv.length - 1].sw[0] === 0) return new Float32Array(n * 3);
  let coarse: Float32Array | null = null;
  for (let l = lv.length - 1; l >= 0; l--) {
    const L = lv[l], out = new Float32Array(L.w * L.h * 3), up = l + 1 < lv.length ? lv[l + 1] : null;
    for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) {
      const p = y * L.w + x;
      if (L.sw[p] > 0) { const k = 1 / L.sw[p]; out[p * 3] = L.sv[p * 3] * k; out[p * 3 + 1] = L.sv[p * 3 + 1] * k; out[p * 3 + 2] = L.sv[p * 3 + 2] * k; }
      else if (coarse && up) {
        const u = Math.min(up.w - 1, Math.max(0, (x + 0.5) / 2 - 0.5)), v = Math.min(up.h - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
        const x0 = Math.floor(u), y0 = Math.floor(v), x1 = Math.min(up.w - 1, x0 + 1), y1 = Math.min(up.h - 1, y0 + 1), fx = u - x0, fy = v - y0;
        for (let c = 0; c < 3; c++) {
          out[p * 3 + c] = (coarse[(y0 * up.w + x0) * 3 + c] * (1 - fx) + coarse[(y0 * up.w + x1) * 3 + c] * fx) * (1 - fy)
            + (coarse[(y1 * up.w + x0) * 3 + c] * (1 - fx) + coarse[(y1 * up.w + x1) * 3 + c] * fx) * fy;
        }
      }
    }
    coarse = out;
  }
  const res = coarse!;
  for (let it = 0; it < relax; it++) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (known[p]) continue;
      const l = x > 0 ? p - 1 : p, r = x < w - 1 ? p + 1 : p, u = y > 0 ? p - w : p, d = y < h - 1 ? p + w : p;
      for (let c = 0; c < 3; c++) res[p * 3 + c] = (res[l * 3 + c] + res[r * 3 + c] + res[u * 3 + c] + res[d * 3 + c]) / 4;
    }
  }
  return res;
}

/** Coverage (0-255 alpha) at or below this counts as "outside the brushed area" (boundary samples). */
export const COVER_THRESHOLD = 5;

/**
 * Heal: for every covered pixel, output the source pixel plus a smooth correction that makes the patch's colours
 * meet the destination at the edge of the covered area. `dst`/`src` are RGBA (un-premultiplied) for the same
 * w*h region (src already shifted by the clone offset); `cov` is RGBA whose alpha is brush coverage.
 * Returns RGBA with alpha = coverage × source alpha (0 outside the covered area).
 */
export function healPatch(dst: Uint8ClampedArray, src: Uint8ClampedArray, cov: Uint8ClampedArray, w: number, h: number): Uint8ClampedArray {
  const n = w * h, diff = new Float32Array(n * 3), known = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    if (cov[i + 3] <= COVER_THRESHOLD && dst[i + 3] > 8 && src[i + 3] > 8) {
      known[p] = 1;
      diff[p * 3] = dst[i] - src[i]; diff[p * 3 + 1] = dst[i + 1] - src[i + 1]; diff[p * 3 + 2] = dst[i + 2] - src[i + 2];
    }
  }
  const D = fillMembrane(diff, known, w, h);
  const out = new Uint8ClampedArray(n * 4);
  for (let p = 0; p < n; p++) {
    const i = p * 4, a = cov[i + 3];
    if (a <= COVER_THRESHOLD) continue;
    out[i] = src[i] + D[p * 3]; out[i + 1] = src[i + 1] + D[p * 3 + 1]; out[i + 2] = src[i + 2] + D[p * 3 + 2];
    out[i + 3] = Math.round((a * src[i + 3]) / 255);
  }
  return out;
}

/**
 * Spot healing: choose the candidate offset whose source ring best matches the destination ring around the
 * brushed area. `area` is RGBA of the document rectangle starting at (ax, ay) with width aw; `dst`/`cov` describe
 * the region r (RGBA, r.w*r.h). Returns the best [dx, dy] or null when no candidate is usable.
 */
export function chooseSpotOffset(
  area: Uint8ClampedArray, aw: number, ah: number, ax: number, ay: number,
  dst: Uint8ClampedArray, cov: Uint8ClampedArray, r: { x: number; y: number; w: number; h: number },
  cands: [number, number][],
): [number, number] | null {
  let best: [number, number] | null = null, bestCost = Infinity;
  for (const [dx, dy] of cands) {
    let cost = 0, count = 0, bad = false;
    for (let y = 0; y < r.h && !bad; y += 2) for (let x = 0; x < r.w; x += 2) {
      const i = (y * r.w + x) * 4;
      if (cov[i + 3] > COVER_THRESHOLD || dst[i + 3] <= 8) continue;
      const sx = r.x + x + dx - ax, sy = r.y + y + dy - ay;
      if (sx < 0 || sy < 0 || sx >= aw || sy >= ah) { bad = true; break; }
      const j = (sy * aw + sx) * 4;
      if (area[j + 3] <= 8) { cost += 3 * 255 * 255; count++; continue; }
      const a = dst[i] - area[j], b = dst[i + 1] - area[j + 1], c = dst[i + 2] - area[j + 2];
      cost += a * a + b * b + c * c; count++;
    }
    if (bad || count < 8) continue;
    cost /= count;
    if (cost < bestCost) { bestCost = cost; best = [dx, dy]; }
  }
  return best;
}
