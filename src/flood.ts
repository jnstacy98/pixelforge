import type { Rect } from './doc';

/**
 * Flood-select pixels similar to the seed. Returns a w*h array of 0/1.
 * `allowed` (optional) restricts which pixels may match; `b` restricts the search region.
 */
export function floodSelect(
  d: Uint8ClampedArray, w: number, h: number, sx: number, sy: number,
  tol: number, contiguous: boolean, b: Rect, allowed: Uint8Array | null = null,
): Uint8Array {
  const out = new Uint8Array(w * h);
  const o = (sy * w + sx) * 4;
  const t0 = d[o], t1 = d[o + 1], t2 = d[o + 2], t3 = d[o + 3];
  const match = (p: number) => {
    if (allowed && !allowed[p]) return false;
    const i = p * 4;
    return Math.abs(d[i] - t0) <= tol && Math.abs(d[i + 1] - t1) <= tol && Math.abs(d[i + 2] - t2) <= tol && Math.abs(d[i + 3] - t3) <= tol;
  };
  const x0 = b.x, x1 = b.x + b.w, y0 = b.y, y1 = b.y + b.h;
  if (sx < x0 || sx >= x1 || sy < y0 || sy >= y1 || !match(sy * w + sx)) return out;
  if (!contiguous) {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (match(y * w + x)) out[y * w + x] = 1;
    return out;
  }
  const stack = [sx, sy];
  while (stack.length) {
    const y = stack.pop()!; let x = stack.pop()!;
    while (x >= x0 && !out[y * w + x] && match(y * w + x)) x--;
    x++;
    let up = false, down = false;
    while (x < x1 && !out[y * w + x] && match(y * w + x)) {
      out[y * w + x] = 1;
      if (y > y0) { const m = !out[(y - 1) * w + x] && match((y - 1) * w + x); if (m && !up) { stack.push(x, y - 1); up = true; } else if (!m) up = false; }
      if (y < y1 - 1) { const m = !out[(y + 1) * w + x] && match((y + 1) * w + x); if (m && !down) { stack.push(x, y + 1); down = true; } else if (!m) down = false; }
      x++;
    }
  }
  return out;
}
