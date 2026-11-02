// Blend If (Layer Style ▸ Blending Options): hide parts of a layer depending on its own or the underlying tonal values.
// Pure maths + PSD conversion (unit-tested).
export type BIChannel = 'gray' | 'r' | 'g' | 'b';
/** Four stops per slider: [black, black-split, white-split, white]. Opacity ramps 0→1 over [0]..[1], is 1 over [1]..[2], 1→0 over [2]..[3]. */
export type Range4 = [number, number, number, number];
export interface BlendIfRange { src: Range4; dst: Range4 }
export type BlendIf = Record<BIChannel, BlendIfRange>;
export const BI_CHANNELS: BIChannel[] = ['gray', 'r', 'g', 'b'];
export const BI_LABELS: Record<BIChannel, string> = { gray: 'Gray', r: 'Red', g: 'Green', b: 'Blue' };
export const FULL_RANGE = (): Range4 => [0, 0, 255, 255];

export const defaultBlendIf = (): BlendIf => ({
  gray: { src: FULL_RANGE(), dst: FULL_RANGE() }, r: { src: FULL_RANGE(), dst: FULL_RANGE() },
  g: { src: FULL_RANGE(), dst: FULL_RANGE() }, b: { src: FULL_RANGE(), dst: FULL_RANGE() },
});
export const cloneBlendIf = (b: BlendIf | null): BlendIf | null => (b ? JSON.parse(JSON.stringify(b)) : null);
const isFull = (r: Range4) => r[0] === 0 && r[1] === 0 && r[2] === 255 && r[3] === 255;
export const isBlendIfActive = (b: BlendIf | null | undefined): b is BlendIf =>
  !!b && BI_CHANNELS.some((c) => !isFull(b[c].src) || !isFull(b[c].dst));

/** 256-entry table: how much of a pixel with this value remains visible (0..1). */
export function rangeTable(r: Range4): Float32Array {
  const t = new Float32Array(256), [a, b, c, d] = r;
  for (let v = 0; v < 256; v++) {
    let f = 1;
    if (v < a || v > d) f = 0;
    else if (v < b) f = (v - a + 1) / (b - a + 1);
    else if (v > c) f = (d - v + 1) / (d - c + 1);
    t[v] = f;
  }
  return t;
}
export const normalizeRange = (r: Range4): Range4 => {
  const [a, b, c, d] = r.map((v) => Math.min(255, Math.max(0, Math.round(v))));
  const b2 = Math.max(a, b), c2 = Math.max(b2, c), d2 = Math.max(c2, d);
  return [a, b2, c2, d2];
};

/**
 * Multiplies `src`'s alpha by the Blend If factor, computed per pixel from the layer's own colour and the backdrop's.
 * `src` and `back` are RGBA arrays of the same size.
 */
export function applyBlendIf(bi: BlendIf, src: Uint8ClampedArray, back: Uint8ClampedArray): void {
  const tabs = BI_CHANNELS.map((c) => ({ c, s: isFull(bi[c].src) ? null : rangeTable(bi[c].src), d: isFull(bi[c].dst) ? null : rangeTable(bi[c].dst) }));
  for (let i = 0; i < src.length; i += 4) {
    if (!src[i + 3]) continue;
    const sr = src[i], sg = src[i + 1], sb = src[i + 2], dr = back[i], dg = back[i + 1], db = back[i + 2];
    let f = 1;
    for (const t of tabs) {
      if (t.s) f *= t.c === 'gray' ? t.s[Math.round(0.3 * sr + 0.59 * sg + 0.11 * sb)] : t.s[t.c === 'r' ? sr : t.c === 'g' ? sg : sb];
      if (t.d) f *= t.c === 'gray' ? t.d[Math.round(0.3 * dr + 0.59 * dg + 0.11 * db)] : t.d[t.c === 'r' ? dr : t.c === 'g' ? dg : db];
      if (f === 0) break;
    }
    if (f < 1) src[i + 3] = Math.round(src[i + 3] * f);
  }
}

// ---- PSD conversion
export interface PsdBlendingRanges { compositeGrayBlendSource: number[]; compositeGraphBlendDestinationRange: number[]; ranges: { sourceRange: number[]; destRange: number[] }[] }
export function toPsdRanges(b: BlendIf): PsdBlendingRanges {
  return {
    compositeGrayBlendSource: [...b.gray.src], compositeGraphBlendDestinationRange: [...b.gray.dst],
    ranges: (['r', 'g', 'b'] as const).map((c) => ({ sourceRange: [...b[c].src], destRange: [...b[c].dst] })),
  };
}
export function fromPsdRanges(p: PsdBlendingRanges | undefined): BlendIf | null {
  if (!p) return null;
  const ok = (r?: number[]): Range4 => (r && r.length >= 4 ? normalizeRange([r[0], r[1], r[2], r[3]]) : FULL_RANGE());
  const b = defaultBlendIf();
  b.gray = { src: ok(p.compositeGrayBlendSource), dst: ok(p.compositeGraphBlendDestinationRange) };
  (['r', 'g', 'b'] as const).forEach((c, i) => { const r = p.ranges?.[i]; if (r) b[c] = { src: ok(r.sourceRange), dst: ok(r.destRange) }; });
  return isBlendIfActive(b) ? b : null;
}
