// Photoshop blend modes the canvas has no native operator for. Pure per-pixel maths (unit-tested in Node).
// Formulas follow the W3C Compositing spec's general form:  αo = αs + αb(1−αs);  co·αo = (1−αs)αb·Cb + (1−αb)αs·Cs + αsαb·B(Cb,Cs)

export const CUSTOM_BLENDS = ['linear burn', 'linear light', 'vivid light', 'pin light', 'hard mix', 'subtract', 'divide', 'darker color', 'lighter color', 'dissolve'] as const;
export type CustomBlend = (typeof CUSTOM_BLENDS)[number];
export const isCustomBlend = (id: string): id is CustomBlend => (CUSTOM_BLENDS as readonly string[]).includes(id);

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lum = (r: number, g: number, b: number) => 0.3 * r + 0.59 * g + 0.11 * b;

/** Separable blend function B(Cb, Cs) for one channel (all 0-1). */
export function blendChannel(mode: CustomBlend, cb: number, cs: number): number {
  switch (mode) {
    case 'linear burn': return clamp01(cb + cs - 1);
    case 'linear light': return clamp01(cb + 2 * cs - 1);
    case 'vivid light':
      if (cs <= 0.5) { const s = 2 * cs; return s <= 0 ? 0 : clamp01(1 - (1 - cb) / s); }              // colour burn
      { const s = 2 * (cs - 0.5); return s >= 1 ? 1 : clamp01(cb / (1 - s)); }                          // colour dodge
    case 'pin light': return cs < 0.5 ? Math.min(cb, 2 * cs) : Math.max(cb, 2 * (cs - 0.5));
    case 'hard mix': return cb + cs >= 1 ? 1 : 0;
    case 'subtract': return clamp01(cb - cs);
    case 'divide': return cs <= 0 ? 1 : clamp01(cb / cs);
    default: return cs;
  }
}

/** Deterministic per-pixel noise in [0,1) for Dissolve. */
const noise = (i: number) => { let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return (h >>> 0) / 4294967296; };

/**
 * Blend `source` (RGBA, straight alpha) over `backdrop` (RGBA, straight alpha, modified in place) with `mode` at `opacity`.
 * Both arrays describe the same w×h region.
 */
export function blendInto(backdrop: Uint8ClampedArray, source: Uint8ClampedArray, mode: CustomBlend, opacity: number): void {
  for (let i = 0; i < backdrop.length; i += 4) {
    let as = (source[i + 3] / 255) * opacity;
    if (mode === 'dissolve') as = noise(i >> 2) < as ? 1 : 0;                      // each pixel either fully shows or not at all
    if (as <= 0) continue;
    const ab = backdrop[i + 3] / 255, ao = as + ab - as * ab;
    const sr = source[i] / 255, sg = source[i + 1] / 255, sb = source[i + 2] / 255, br = backdrop[i] / 255, bg = backdrop[i + 1] / 255, bb = backdrop[i + 2] / 255;
    let mr: number, mg: number, mb: number;
    if (mode === 'darker color' || mode === 'lighter color') {                       // non-separable: pick the whole darker / lighter colour
      const pickSource = mode === 'darker color' ? lum(sr, sg, sb) < lum(br, bg, bb) : lum(sr, sg, sb) > lum(br, bg, bb);
      [mr, mg, mb] = pickSource ? [sr, sg, sb] : [br, bg, bb];
    } else if (mode === 'dissolve') { mr = sr; mg = sg; mb = sb; }
    else { mr = blendChannel(mode, br, sr); mg = blendChannel(mode, bg, sg); mb = blendChannel(mode, bb, sb); }
    const k1 = (1 - as) * ab, k2 = (1 - ab) * as, k3 = as * ab;
    backdrop[i] = ((k1 * br + k2 * sr + k3 * mr) / ao) * 255;
    backdrop[i + 1] = ((k1 * bg + k2 * sg + k3 * mg) / ao) * 255;
    backdrop[i + 2] = ((k1 * bb + k2 * sb + k3 * mb) / ao) * 255;
    backdrop[i + 3] = ao * 255;
  }
}
