// Pattern library for Pattern Overlay: a registry of tiles keyed by id. Tiles come from built-ins, imported PSD patterns,
// or "Define Pattern" (from the selection / layer). Pure data (RGBA) so it can be unit-tested; canvases are made on demand.
export interface Tile { id: string; name: string; w: number; h: number; data: Uint8ClampedArray }

const registry = new Map<string, Tile>();
export const getPattern = (id: string | undefined) => (id ? registry.get(id) : undefined);
export const allPatterns = () => [...registry.values()];
export function registerPattern(t: Tile): Tile { registry.set(t.id, t); canvasCache.delete(t.id); return t; }
export function unregisterPattern(id: string) { registry.delete(id); canvasCache.delete(id); }
export const hasPattern = (id: string) => registry.has(id);

function make(id: string, name: string, w: number, h: number, f: (x: number, y: number) => [number, number, number, number?]): Tile {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b, a = 255] = f(x, y), i = (y * w + x) * 4; data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a; }
  return { id, name, w, h, data };
}
const hash = (x: number, y: number) => (((x * 73856093) ^ (y * 19349663)) >>> 0) % 256;
const BUILTINS: Tile[] = [
  make('pf:checker', 'Checkerboard', 16, 16, (x, y) => ((x >> 3) + (y >> 3)) & 1 ? [255, 255, 255] : [60, 60, 60]),
  make('pf:stripes', 'Stripes', 8, 8, (x) => (x < 4 ? [255, 255, 255] : [40, 40, 40])),
  make('pf:diagonal', 'Diagonal Lines', 8, 8, (x, y) => ((x + y) & 7) < 3 ? [30, 30, 30] : [235, 235, 235]),
  make('pf:dots', 'Dots', 12, 12, (x, y) => Math.hypot(x - 5.5, y - 5.5) < 3.5 ? [30, 30, 30] : [240, 240, 240]),
  make('pf:grid', 'Grid', 16, 16, (x, y) => (x === 0 || y === 0 ? [60, 60, 60] : [235, 235, 235])),
  make('pf:grain', 'Grain', 64, 64, (x, y) => { const v = 110 + (hash(x, y) / 255) * 90; return [v, v, v]; }),
  make('pf:bricks', 'Bricks', 32, 16, (x, y) => { const row = y >> 3, xx = (x + (row ? 16 : 0)) % 32; return (y & 7) === 0 || xx === 0 ? [220, 215, 205] : [160, 70, 50]; }),
];
for (const b of BUILTINS) registry.set(b.id, b);
export const BUILTIN_IDS = BUILTINS.map((b) => b.id);

const canvasCache = new Map<string, HTMLCanvasElement>();
/** The tile as a canvas (for CanvasPattern). */
export function tileCanvas(id: string): HTMLCanvasElement | null {
  const t = registry.get(id);
  if (!t) return null;
  let c = canvasCache.get(id);
  if (!c) {
    c = document.createElement('canvas'); c.width = t.w; c.height = t.h;
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(t.data), t.w, t.h), 0, 0);
    canvasCache.set(id, c);
  }
  return c;
}
let seq = 0;
/** Define a new pattern from RGBA pixels; returns its tile (id is unique per session + time). */
export function definePattern(name: string, w: number, h: number, data: Uint8ClampedArray): Tile {
  const id = `pf:user-${Date.now().toString(36)}-${seq++}`;
  return registerPattern({ id, name, w, h, data: new Uint8ClampedArray(data) });
}
