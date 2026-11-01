// Content-aware fill: PatchMatch-based inpainting (pure; no DOM). Multi-resolution EM in the style of Wexler et al.
// ("Space-time video completion") with Barnes et al.'s PatchMatch for the nearest-neighbour field:
//   for each level (coarse → fine): repeat { find, for every patch touching the hole, its best match among patches that
//   lie entirely outside the hole (PatchMatch);  re-estimate each hole pixel as the weighted vote of the matched patches }.
import { fillMembrane } from './heal.ts';
import { distanceTo } from './fx.ts';

export interface InpaintOptions {
  /** Patch radius in pixels (patch = 2r+1 square). Default 3. */
  patch?: number;
  quality?: 'fast' | 'normal' | 'high';
  seed?: number;
  /** 0..1 progress callback; the function yields to the event loop around it. */
  onProgress?: (frac: number) => void;
  shouldCancel?: () => boolean;
  /** Weight of not-yet-reliable (hole) pixels when comparing patches, early → late. Low early values let known context drive matching. */
  holeWeight?: [number, number];
  /** Cost per squared pixel of source offset: prefers nearby patches (keeps local structure coherent). */
  offsetPenalty?: number;
}

interface Level {
  w: number; h: number;
  img: Float32Array;       // RGBA working image: known pixels exact, hole pixels = current estimate
  hole: Uint8Array;        // 1 = to be filled
  valid: Uint8Array;       // 1 = pixel is the centre of a patch that is fully inside the image and touches no hole pixel
  validList: Int32Array;
  target: Uint8Array;      // 1 = patch centred here overlaps the hole
  targetList: Int32Array;
  holeList: Int32Array;
  nnf: Int32Array;         // per target pixel: source patch centre (x, y)
  dist: Float32Array;      // per target pixel: (weighted) SSD to its matched patch
  cost: Float32Array;      // dist + offset penalty: what PatchMatch minimises

}

/** Final pass: copy-vs-average blend. Source patches with std-dev ≤ SMOOTH_SD keep the average; ≥ TEXTURE_SD copy with weight COPY_MAX. */
const SMOOTH_SD = 4, TEXTURE_SD = 12, COPY_MAX = 0.85;
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
function mulberry32(a: number) { return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Grow a hole mask by `px` pixels (Euclidean). */
export function expandMask(hole: Uint8Array, w: number, h: number, px: number): Uint8Array {
  if (px <= 0) return hole.slice();
  const d = distanceTo(hole, w, h), out = new Uint8Array(hole.length);
  for (let i = 0; i < out.length; i++) out[i] = d[i] <= px ? 1 : 0;
  return out;
}

function makeLevel(w: number, h: number, img: Float32Array, hole: Uint8Array, r: number): Level {
  const n = w * h, win = 2 * r + 1;
  // integral image of the hole, to count hole pixels in any window in O(1)
  const I = new Int32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += hole[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row; } }
  const count = (x0: number, y0: number, x1: number, y1: number) => I[(y1 + 1) * (w + 1) + x1 + 1] - I[y0 * (w + 1) + x1 + 1] - I[(y1 + 1) * (w + 1) + x0] + I[y0 * (w + 1) + x0];
  const valid = new Uint8Array(n), target = new Uint8Array(n), vl: number[] = [], tl: number[] = [], hl: number[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x;
    if (hole[p]) hl.push(p);
    if (x >= r && y >= r && x < w - r && y < h - r && count(x - r, y - r, x + r, y + r) === 0) { valid[p] = 1; vl.push(p); }
    if (count(Math.max(0, x - r), Math.max(0, y - r), Math.min(w - 1, x + r), Math.min(h - 1, y + r)) > 0) { target[p] = 1; tl.push(p); }
  }
  void win;
  return { w, h, img, hole, valid, validList: Int32Array.from(vl), target, targetList: Int32Array.from(tl), holeList: Int32Array.from(hl), nnf: new Int32Array(n * 2), dist: new Float32Array(n), cost: new Float32Array(n) };
}

/** Half-resolution copy; a coarse pixel is a hole only if all of its source pixels are. */
function downsample(w: number, h: number, img: Float32Array, hole: Uint8Array) {
  const cw = (w + 1) >> 1, ch = (h + 1) >> 1, cimg = new Float32Array(cw * ch * 4), chole = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    let n = 0; const s = [0, 0, 0, 0];
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const sx = x * 2 + dx, sy = y * 2 + dy;
      if (sx >= w || sy >= h || hole[sy * w + sx]) continue;
      const i = (sy * w + sx) * 4; s[0] += img[i]; s[1] += img[i + 1]; s[2] += img[i + 2]; s[3] += img[i + 3]; n++;
    }
    const o = y * cw + x;
    if (!n) chole[o] = 1; else { cimg[o * 4] = s[0] / n; cimg[o * 4 + 1] = s[1] / n; cimg[o * 4 + 2] = s[2] / n; cimg[o * 4 + 3] = s[3] / n; }
  }
  return { w: cw, h: ch, img: cimg, hole: chole };
}

export async function inpaint(rgba: Uint8ClampedArray, w: number, h: number, hole: Uint8Array, opts: InpaintOptions = {}): Promise<Uint8ClampedArray> {
  const r = opts.patch ?? 3, area = (2 * r + 1) * (2 * r + 1), rnd = mulberry32(opts.seed ?? 1), quality = opts.quality ?? 'normal';
  const out = new Uint8ClampedArray(rgba);
  let holeCount = 0, bx0 = w, by0 = h, bx1 = -1, by1 = -1;
  for (let p = 0; p < hole.length; p++) if (hole[p]) { holeCount++; const x = p % w, y = (p / w) | 0; if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; }
  if (!holeCount) return out;

  // ---- pyramid: stop when the hole is about one patch thick, or the image gets too small to hold source patches
  const minDim = Math.min(bx1 - bx0 + 1, by1 - by0 + 1);
  const img0 = new Float32Array(w * h * 4);
  for (let i = 0; i < img0.length; i++) img0[i] = rgba[i];
  const base = [{ w, h, img: img0, hole }];
  let levels = Math.max(1, Math.min(5, Math.floor(Math.log2(Math.max(1, minDim) / (2 * r + 1))) + 1));
  while (base.length < levels) {
    const p = base[base.length - 1];
    if (Math.min(p.w, p.h) < 6 * (2 * r + 1)) break;
    base.push(downsample(p.w, p.h, p.img, p.hole));
  }
  levels = base.length;
  const em = quality === 'fast' ? [1, 2, 3] : quality === 'high' ? [3, 4, 6] : [2, 3, 5];     // EM iterations: fine, mid, coarse
  const pmIters = quality === 'fast' ? 2 : quality === 'high' ? 4 : 3;
  const emFor = (l: number) => (l === 0 ? em[0] : l === 1 ? em[1] : em[2]);
  const totalSteps = base.reduce((s, _, l) => s + emFor(l), 0);
  let done = 0;

  const [hw0, hw1] = opts.holeWeight ?? [0.15, 1], lambda = opts.offsetPenalty ?? 0.05;
  let holeW = 1;                                        // current weight of hole (estimated) pixels in patch comparisons
  const pen = (x: number, y: number, sx: number, sy: number) => lambda * ((sx - x) * (sx - x) + (sy - y) * (sy - y));
  const patchDist = (L: Level, tx: number, ty: number, sx: number, sy: number, best: number) => {
    const { w: W, h: H, img, hole: hm } = L;
    let d = 0;
    for (let dy = -r; dy <= r; dy++) {
      const ty2 = Math.min(H - 1, Math.max(0, ty + dy)), tRow = ty2 * W, sRow = (sy + dy) * W;
      for (let dx = -r; dx <= r; dx++) {
        const tx2 = Math.min(W - 1, Math.max(0, tx + dx)), a = (tRow + tx2) * 4, b = (sRow + sx + dx) * 4;
        const d0 = img[a] - img[b], d1 = img[a + 1] - img[b + 1], d2 = img[a + 2] - img[b + 2], d3 = img[a + 3] - img[b + 3];
        d += (hm[tRow + tx2] ? holeW : 1) * (d0 * d0 + d1 * d1 + d2 * d2 + d3 * d3);
      }
      if (d >= best) return d;
    }
    return d;
  };

  let coarse: Level | null = null;
  for (let l = levels - 1; l >= 0; l--) {
    const b = base[l], L = makeLevel(b.w, b.h, b.img, b.hole, r), { w: W, h: H } = L;
    // ---- initial estimate of the hole at this level
    if (!coarse) {
      const field = new Float32Array(W * H * 3), known = new Uint8Array(W * H);
      for (let p = 0; p < W * H; p++) if (!L.hole[p]) { known[p] = 1; field[p * 3] = L.img[p * 4]; field[p * 3 + 1] = L.img[p * 4 + 1]; field[p * 3 + 2] = L.img[p * 4 + 2]; }
      const f = fillMembrane(field, known, W, H);
      for (const p of L.holeList) { L.img[p * 4] = f[p * 3]; L.img[p * 4 + 1] = f[p * 3 + 1]; L.img[p * 4 + 2] = f[p * 3 + 2]; L.img[p * 4 + 3] = 255; }
    } else {
      const C = coarse;
      for (const p of L.holeList) {                                        // bilinear upsample of the coarse estimate
        const x = p % W, y = (p / W) | 0, u = Math.min(C.w - 1, Math.max(0, (x + 0.5) / 2 - 0.5)), v = Math.min(C.h - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
        const x0 = Math.floor(u), y0 = Math.floor(v), x1 = Math.min(C.w - 1, x0 + 1), y1 = Math.min(C.h - 1, y0 + 1), fx = u - x0, fy = v - y0;
        for (let c = 0; c < 4; c++) L.img[p * 4 + c] = (C.img[(y0 * C.w + x0) * 4 + c] * (1 - fx) + C.img[(y0 * C.w + x1) * 4 + c] * fx) * (1 - fy) + (C.img[(y1 * C.w + x0) * 4 + c] * (1 - fx) + C.img[(y1 * C.w + x1) * 4 + c] * fx) * fy;
      }
    }
    if (!L.validList.length) { coarse = L; done += emFor(l); continue; }       // nothing to copy from at this level: keep the smooth estimate

    // ---- initialise the nearest-neighbour field (upsampled from the coarser level where possible)
    const randomValid = () => L.validList[(rnd() * L.validList.length) | 0];
    for (const p of L.targetList) {
      let sx = -1, sy = -1;
      if (coarse) {
        const C = coarse, x = p % W, y = (p / W) | 0, cp = (y >> 1) * C.w + (x >> 1);
        if (C.target[cp]) { sx = C.nnf[cp * 2] * 2 + (x & 1); sy = C.nnf[cp * 2 + 1] * 2 + (y & 1); }
      }
      if (sx < 0 || sx >= W || sy < 0 || sy >= H || !L.valid[sy * W + sx]) { const q = randomValid(); sx = q % W; sy = (q / W) | 0; }
      L.nnf[p * 2] = sx; L.nnf[p * 2 + 1] = sy;
      const x = p % W, y = (p / W) | 0;
      L.dist[p] = patchDist(L, x, y, sx, sy, Infinity); L.cost[p] = L.dist[p] + pen(x, y, sx, sy);
    }

    const maxRad = Math.max(8, Math.min(Math.max(W, H), l === 0 ? 96 : 256));
    for (let it = 0; it < emFor(l); it++) {
      const finalPass = l === 0 && it === emFor(0) - 1;
      holeW = hw0 + (hw1 - hw0) * Math.min(1, done / Math.max(1, totalSteps - 1));
      // ---- PatchMatch: propagation + random search, alternating scan direction
      for (let k = 0; k < pmIters; k++) {
        const rev = (k & 1) === 1, dir = rev ? 1 : -1, list = L.targetList, n = list.length;
        for (let i = 0; i < n; i++) {
          const p = list[rev ? n - 1 - i : i], x = p % W, y = (p / W) | 0;
          let bxs = L.nnf[p * 2], bys = L.nnf[p * 2 + 1], bd = L.cost[p], bdist = L.dist[p];
          const tryCand = (cx: number, cy: number) => {
            if (cx < r || cy < r || cx >= W - r || cy >= H - r || !L.valid[cy * W + cx]) return;
            const pn = pen(x, y, cx, cy);
            if (pn >= bd) return;
            const d = patchDist(L, x, y, cx, cy, bd - pn);
            if (d + pn < bd) { bd = d + pn; bdist = d; bxs = cx; bys = cy; }
          };
          const nx = x + dir, ny = y + dir;                                  // propagate from the neighbours already visited this sweep
          if (nx >= 0 && nx < W) { const q = y * W + nx; if (L.target[q]) tryCand(L.nnf[q * 2] - dir, L.nnf[q * 2 + 1]); }
          if (ny >= 0 && ny < H) { const q = ny * W + x; if (L.target[q]) tryCand(L.nnf[q * 2], L.nnf[q * 2 + 1] - dir); }
          for (let rad = maxRad; rad >= 1; rad >>= 1) tryCand(bxs + ((rnd() * 2 - 1) * rad | 0), bys + ((rnd() * 2 - 1) * rad | 0));
          L.nnf[p * 2] = bxs; L.nnf[p * 2 + 1] = bys; L.dist[p] = bdist; L.cost[p] = bd;
        }
        if (opts.shouldCancel?.()) throw new Error('cancelled');
        await tick();
      }
      // ---- re-estimate: every hole pixel is the weighted average of what the patches covering it say it should be
      const sample: number[] = [];
      const stride = Math.max(1, (L.targetList.length / 3000) | 0);
      for (let i = 0; i < L.targetList.length; i += stride) sample.push(L.dist[L.targetList[i]] / (area * 4));
      sample.sort((a, b) => a - b);
      const s = Math.max(1, sample[Math.floor(sample.length * 0.75)] ?? 1), inv = 1 / (2 * s);
      const next = new Float32Array(L.holeList.length * 4);
      for (let hi = 0; hi < L.holeList.length; hi++) {
        const p = L.holeList[hi], x = p % W, y = (p / W) | 0;
        let sw = 0, a0 = 0, a1 = 0, a2 = 0, a3 = 0;
        for (let dy = -r; dy <= r; dy++) {
          const py = y + dy; if (py < 0 || py >= H) continue;
          for (let dx = -r; dx <= r; dx++) {
            const px = x + dx; if (px < 0 || px >= W) continue;
            const q = py * W + px; if (!L.target[q]) continue;
            const wgt = Math.exp(-(L.dist[q] / (area * 4)) * inv), sx = L.nnf[q * 2] - dx, sy = L.nnf[q * 2 + 1] - dy, o = (sy * W + sx) * 4;
            sw += wgt; a0 += wgt * L.img[o]; a1 += wgt * L.img[o + 1]; a2 += wgt * L.img[o + 2]; a3 += wgt * L.img[o + 3];
          }
        }
        if (sw > 0) {
          next[hi * 4] = a0 / sw; next[hi * 4 + 1] = a1 / sw; next[hi * 4 + 2] = a2 / sw; next[hi * 4 + 3] = a3 / sw;
          if (finalPass) {
            // Averaging many patch votes smooths texture, so on the very last pass lean towards copying the matched pixel
            // itself — but only where its source patch is textured (grain, noise, edges). Smooth gradients keep the average,
            // which avoids tiny steps between copied pixels.
            const sx = L.nnf[p * 2], sy = L.nnf[p * 2 + 1], o = (sy * W + sx) * 4;
            let s0 = 0, s1 = 0, s2 = 0, q0 = 0, q1 = 0, q2 = 0;
            for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
              const q = ((sy + dy) * W + sx + dx) * 4, v0 = L.img[q], v1 = L.img[q + 1], v2 = L.img[q + 2];
              s0 += v0; s1 += v1; s2 += v2; q0 += v0 * v0; q1 += v1 * v1; q2 += v2 * v2;
            }
            const sd = Math.sqrt(Math.max(0, (q0 / area - (s0 / area) ** 2 + q1 / area - (s1 / area) ** 2 + q2 / area - (s2 / area) ** 2) / 3));
            const k = Math.min(1, Math.max(0, (sd - SMOOTH_SD) / (TEXTURE_SD - SMOOTH_SD))) * COPY_MAX;
            for (let c = 0; c < 3; c++) next[hi * 4 + c] = next[hi * 4 + c] * (1 - k) + L.img[o + c] * k;
          }
        } else { const o = p * 4; next[hi * 4] = L.img[o]; next[hi * 4 + 1] = L.img[o + 1]; next[hi * 4 + 2] = L.img[o + 2]; next[hi * 4 + 3] = L.img[o + 3]; }
      }
      for (let hi = 0; hi < L.holeList.length; hi++) { const o = L.holeList[hi] * 4; L.img[o] = next[hi * 4]; L.img[o + 1] = next[hi * 4 + 1]; L.img[o + 2] = next[hi * 4 + 2]; L.img[o + 3] = next[hi * 4 + 3]; }
      // patch distances changed with the new estimates
      holeW = hw0 + (hw1 - hw0) * Math.min(1, (done + 1) / Math.max(1, totalSteps - 1));       // trust the estimates more as we go
      for (const p of L.targetList) { const x = p % W, y = (p / W) | 0; L.dist[p] = patchDist(L, x, y, L.nnf[p * 2], L.nnf[p * 2 + 1], Infinity); L.cost[p] = L.dist[p] + pen(x, y, L.nnf[p * 2], L.nnf[p * 2 + 1]); }
      done++;
      opts.onProgress?.(done / totalSteps);
      if (opts.shouldCancel?.()) throw new Error('cancelled');
      await tick();
    }
    coarse = L;
  }
  const fin = coarse!;
  for (const p of fin.holeList) for (let c = 0; c < 4; c++) out[p * 4 + c] = Math.round(fin.img[p * 4 + c]);
  return out;
}
