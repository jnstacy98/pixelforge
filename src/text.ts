import type { Cmd } from './shapemath';
import { flattenCmds, nearestOnPoly, placeGlyphs } from './textpath';

export interface TextData {
  content: string; font: string; size: number; bold: boolean; italic: boolean;
  align: 'left' | 'center' | 'right'; color: string; x: number; y: number;
  /** Text on a path: the outline (relative to x, y, so moving the layer moves it), where the text starts along it and which side it runs on. */
  path?: { cmds: Cmd[] }; pathOffset?: number; pathFlip?: boolean;
}
export const FONTS: [string, string][] = [
  ['Arial', 'Arial, Helvetica, sans-serif'], ['Segoe UI', '"Segoe UI", system-ui, sans-serif'], ['Verdana', 'Verdana, Geneva, sans-serif'],
  ['Georgia', 'Georgia, serif'], ['Times New Roman', '"Times New Roman", Times, serif'], ['Courier New', '"Courier New", monospace'],
  ['Impact', 'Impact, Charcoal, sans-serif'], ['Comic Sans MS', '"Comic Sans MS", cursive'], ['System UI', 'system-ui, sans-serif'], ['Monospace', 'monospace'],
];
export const LINE_HEIGHT = 1.25;

const measure = document.createElement('canvas').getContext('2d')!;
export const fontCss = (t: Pick<TextData, 'italic' | 'bold' | 'size' | 'font'>, scale = 1) =>
  `${t.italic ? 'italic ' : ''}${t.bold ? 'bold ' : ''}${t.size * scale}px ${t.font}`;

export function layoutText(t: TextData) {
  measure.font = fontCss(t);
  const lines = t.content.split('\n');
  const widths = lines.map((l) => measure.measureText(l).width);
  const lh = t.size * LINE_HEIGHT;
  return { lines, widths, W: Math.max(1, ...widths), H: lines.length * lh, lh };
}
export function textRect(t: TextData) {
  if (t.path) {                                                         // the path's bounding box, grown by the type size
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of t.path.cmds) for (let i = 1; i < c.length; i += 2) { x0 = Math.min(x0, c[i] as number); x1 = Math.max(x1, c[i] as number); y0 = Math.min(y0, c[i + 1] as number); y1 = Math.max(y1, c[i + 1] as number); }
    return { x: t.x + x0 - t.size, y: t.y + y0 - t.size, w: x1 - x0 + 2 * t.size, h: y1 - y0 + 2 * t.size };
  }
  const l = layoutText(t);
  return { x: t.x, y: t.y, w: l.W, h: l.H };
}
/** The path's flattened polyline in document coordinates (its longest sub-path). */
export function textPathPoly(t: TextData) {
  if (!t.path) return null;
  const polys = flattenCmds(t.path.cmds.map((c) => (c[0] === 'Z' ? c : c[0] === 'C' ? ['C', c[1] + t.x, c[2] + t.y, c[3] + t.x, c[4] + t.y, c[5] + t.x, c[6] + t.y] : [c[0], c[1] + t.x, c[2] + t.y]) as Cmd));
  const len = (p: { pts: [number, number][] }) => p.pts.reduce((a, q, i) => (i ? a + Math.hypot(q[0] - p.pts[i - 1][0], q[1] - p.pts[i - 1][1]) : 0), 0);
  return polys.sort((a, b) => len(b) - len(a))[0] ?? null;
}
/** Distance from a document point to the text's path (for hit-testing). */
export function distanceToTextPath(t: TextData, x: number, y: number) { const p = textPathPoly(t); return p ? nearestOnPoly(p, x, y).d : Infinity; }
function renderPathText(canvas: HTMLCanvasElement, t: TextData) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const poly = textPathPoly(t), text = t.content.replace(/\s*\n\s*/g, ' ');
  if (!poly || !text.trim()) return;
  measure.font = fontCss(t);
  const chars = [...text], adv = chars.map((_, i) => measure.measureText(chars.slice(0, i + 1).join('')).width - (i ? measure.measureText(chars.slice(0, i).join('')).width : 0));
  ctx.font = fontCss(t); ctx.fillStyle = t.color; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  for (const g of placeGlyphs(adv, poly, { offset: t.pathOffset ?? 0, align: t.align, flip: t.pathFlip })) {
    ctx.save(); ctx.translate(g.x, g.y); ctx.rotate(g.angle); ctx.fillText(chars[g.ch], -g.adv / 2, 0); ctx.restore();
  }
}
export function renderText(canvas: HTMLCanvasElement, t: TextData) {
  if (t.path) return renderPathText(canvas, t);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const { lines, widths, W, lh } = layoutText(t);
  ctx.font = fontCss(t);
  ctx.fillStyle = t.color;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  lines.forEach((line, i) => {
    const off = t.align === 'center' ? (W - widths[i]) / 2 : t.align === 'right' ? W - widths[i] : 0;
    ctx.fillText(line, t.x + off, t.y + lh * (i + 0.5));
  });
}
export const textLabel = (t: Pick<TextData, 'content'>) => (t.content.split('\n')[0].trim() || 'Text').slice(0, 28);
