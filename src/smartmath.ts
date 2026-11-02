// Smart-object geometry and bookkeeping (pure; unit-tested). A Photoshop placed layer stores its source size and the
// document-space positions of the source's four corners: [TLx,TLy, TRx,TRy, BRx,BRy, BLx,BLy].
import type { Filter, PlacedLayer } from 'ag-psd';
import { cloneFilters, type SmartFilter } from './smartfilters.ts';

export interface LinkedFile { id: string; name: string; type?: string; data: Uint8Array }
export interface SmartInfo {
  placed: PlacedLayer;
  /** Fingerprint of the layer's pixels when the smart object was last rendered; if the pixels change later it has been painted on and is no longer a smart object. */
  print: string;
  /** Smart filters applied (in order) after the source is placed. */
  filters?: SmartFilter[];
  /** Photoshop filters PixelForge can't run: kept so that saving doesn't lose them. */
  rawFilters?: Filter[];
  /** Filter mask (document-sized gray canvas; white = filters apply, black = unfiltered). */
  filterMask?: HTMLCanvasElement;
}
export type Quad = [number, number, number, number, number, number, number, number];

/** Canvas transform (a,b,c,d,e,f) mapping a w×h source rectangle onto the quad (affine part: TL, TR, BL corners). */
export function affineFromQuad(q: Quad, w: number, h: number): [number, number, number, number, number, number] {
  return [(q[2] - q[0]) / w, (q[3] - q[1]) / w, (q[6] - q[0]) / h, (q[7] - q[1]) / h, q[0], q[1]];
}
const centre = (q: Quad) => [(q[0] + q[4]) / 2, (q[1] + q[5]) / 2] as const;

/** The quad scaled by (sx, sy) along its own edges and rotated by `deg`, about its centre. */
export function scaleQuad(q: Quad, sx: number, sy: number, deg: number): Quad {
  const [cx, cy] = centre(q), r = (deg * Math.PI) / 180, co = Math.cos(r), si = Math.sin(r);
  const ux = (q[2] - q[0]) * sx, uy = (q[3] - q[1]) * sx, vx = (q[6] - q[0]) * sy, vy = (q[7] - q[1]) * sy;
  const rot = (x: number, y: number) => [x * co - y * si, x * si + y * co] as const;
  const [rux, ruy] = rot(ux, uy), [rvx, rvy] = rot(vx, vy);
  const tlx = cx - (rux + rvx) / 2, tly = cy - (ruy + rvy) / 2;
  return [tlx, tly, tlx + rux, tly + ruy, tlx + rux + rvx, tly + ruy + rvy, tlx + rvx, tly + rvy];
}
/** After the source's pixel size changes, keep the on-screen scale of one source pixel and the centre. */
export function resizeSource(q: Quad, oldW: number, oldH: number, newW: number, newH: number): Quad {
  return scaleQuad(q, newW / oldW, newH / oldH, 0);
}
/** Quad of a w×h source placed at (x, y) unscaled. */
export const quadAt = (x: number, y: number, w: number, h: number): Quad => [x, y, x + w, y, x + w, y + h, x, y + h];
/** Scale factors (x, y) and rotation (degrees) a quad represents relative to a w×h source. */
export function quadInfo(q: Quad, w: number, h: number) {
  const ux = q[2] - q[0], uy = q[3] - q[1], vx = q[6] - q[0], vy = q[7] - q[1];
  return { sx: Math.hypot(ux, uy) / w, sy: Math.hypot(vx, vy) / h, rot: (Math.atan2(uy, ux) * 180) / Math.PI };
}

/** Cheap fingerprint of pixel data (FNV-1a over a sample of bytes + size). */
export function fingerprint(rgba: Uint8ClampedArray, w: number, h: number): string {
  let hsh = 2166136261 ^ (w * 31 + h);
  const step = rgba.length > 400_000 ? 13 : 1;
  for (let i = 0; i < rgba.length; i += step) { hsh ^= rgba[i]; hsh = Math.imul(hsh, 16777619); }
  return `${w}x${h}:${(hsh >>> 0).toString(16)}`;
}
/** A GUID (PSD linked-file ids must look like one). */
export function newLinkId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const h = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${h(8)}-${h(4)}-4${h(3)}-a${h(3)}-${h(12)}`;
}

export const cloneSmart = (s: SmartInfo | null, cloneCanvas?: (c: HTMLCanvasElement) => HTMLCanvasElement): SmartInfo | null => (s ? { print: s.print, placed: JSON.parse(JSON.stringify(s.placed)), ...(s.filters ? { filters: cloneFilters(s.filters) } : {}), ...(s.rawFilters ? { rawFilters: s.rawFilters } : {}), ...(s.filterMask ? { filterMask: cloneCanvas ? cloneCanvas(s.filterMask) : s.filterMask } : {}) } : null);
