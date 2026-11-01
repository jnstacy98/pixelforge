export interface TextData {
  content: string; font: string; size: number; bold: boolean; italic: boolean;
  align: 'left' | 'center' | 'right'; color: string; x: number; y: number;
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
  const l = layoutText(t);
  return { x: t.x, y: t.y, w: l.W, h: l.H };
}
export function renderText(canvas: HTMLCanvasElement, t: TextData) {
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
