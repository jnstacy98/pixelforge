// Conversion between PixelForge adjustment data and ag-psd's adjustment-layer structures (pure; unit-tested).
import type { AdjustmentLayer } from 'ag-psd';
import { CHANNELS_ALL, psdColorToRgb, type RGB, type Tri, type GradStop, curveLUT, defaultAdjustment, identityCurve, identityLevels, type AdjustmentData, type CurvePoint, type Channel } from './adjust.ts';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const isIdentityPts = (p: CurvePoint[]) => p.length === 2 && p[0].x === 0 && p[0].y === 0 && p[1].x === 255 && p[1].y === 255;

export function toPsdAdjustment(a: AdjustmentData): AdjustmentLayer {
  switch (a.type) {
    case 'levels':
      return { type: 'levels', channels: CHANNELS_ALL.map((c) => {
        const p = a.P[c];
        return { shadowInput: p.ib, highlightInput: p.iw, shadowOutput: p.ob, highlightOutput: p.ow, midtoneInput: p.gamma };
      }) };
    case 'curves':
      return { type: 'curves', channels: CHANNELS_ALL.map((c) => (isIdentityPts(a.P[c]) ? [] : a.P[c].map((p) => ({ input: p.x, output: p.y })))) };
    case 'invert': return { type: 'invert' };
    case 'brightness':
      return { type: 'brightness/contrast', brightness: Math.round(clamp(a.b * 1.5, -150, 150)), contrast: Math.round(clamp(a.c, -50, 100)), useLegacy: true };
    case 'hue':
      return { type: 'hue/saturation', master: { hue: Math.round(a.h), saturation: Math.round(a.s), lightness: 0 } };
    case 'posterize': return { type: 'posterize', levels: a.levels };
    case 'threshold': return { type: 'threshold', level: a.level };
    case 'exposure': return { type: 'exposure', exposure: a.exposure, offset: a.offset, gamma: a.gamma };
    case 'vibrance': return { type: 'vibrance', vibrance: a.vibrance, saturation: a.saturation };
    case 'bw': return { type: 'black & white', reds: a.w[0], yellows: a.w[1], greens: a.w[2], cyans: a.w[3], blues: a.w[4], magentas: a.w[5],
      useTint: !!a.tint, tintColor: a.tint ? { r: a.tint[0], g: a.tint[1], b: a.tint[2] } : { r: 225, g: 211, b: 179 } };
    case 'photo': return { type: 'photo filter', color: { r: a.color[0], g: a.color[1], b: a.color[2] }, density: a.density / 100, preserveLuminosity: a.lum };
    case 'balance': {
      const v = (t: Tri) => ({ cyanRed: t[0], magentaGreen: t[1], yellowBlue: t[2] });
      return { type: 'color balance', shadows: v(a.shadows), midtones: v(a.mids), highlights: v(a.highs), preserveLuminosity: a.lum };
    }
    case 'mixer': {
      const ch = (r: number[]) => ({ red: r[0], green: r[1], blue: r[2], constant: r[3] });
      return a.mono ? { type: 'channel mixer', monochrome: true, gray: ch(a.rows[0]) }
        : { type: 'channel mixer', monochrome: false, red: ch(a.rows[0]), green: ch(a.rows[1]), blue: ch(a.rows[2]) };
    }
    case 'gradmap': return { type: 'gradient map', gradientType: 'solid', reverse: a.reverse, smoothness: 1,
      colorStops: a.stops.map((s) => ({ location: s.x, midpoint: 0.5, color: { r: s.c[0], g: s.c[1], b: s.c[2] } })),
      opacityStops: a.stops.map((s) => ({ location: s.x, midpoint: 0.5, opacity: s.a })) };
  }
}

/** Returns null for adjustment types PixelForge cannot render (vibrance, exposure, selective color, ...). */
export function fromPsdAdjustment(p: AdjustmentLayer): AdjustmentData | null {
  switch (p.type) {
    case 'levels': {
      const d = defaultAdjustment('levels');
      if (d.type !== 'levels') return null;
      CHANNELS_ALL.forEach((c: Channel, i) => {
        const ch = p.channels?.[i];
        if (ch) d.P[c] = { ib: ch.shadowInput, iw: ch.highlightInput, ob: ch.shadowOutput, ow: ch.highlightOutput, gamma: ch.midtoneInput || 1 };
      });
      return d;
    }
    case 'curves': {
      const d = defaultAdjustment('curves');
      if (d.type !== 'curves') return null;
      CHANNELS_ALL.forEach((c: Channel, i) => {
        const pts = p.channels?.[i];
        if (pts && pts.length >= 2) d.P[c] = pts.map((q) => ({ x: q.input, y: q.output })).sort((a, b) => a.x - b.x);
        else if (p.values?.[i]?.length) {              // pencil-drawn curve: resample to control points
          const map = p.values[i]; const out: CurvePoint[] = [];
          for (let x = 0; x < 256; x += 16) out.push({ x, y: map[x] ?? x });
          out.push({ x: 255, y: map[255] ?? 255 });
          d.P[c] = out;
        }
      });
      return d;
    }
    case 'invert': return { type: 'invert' };
    case 'brightness/contrast': return { type: 'brightness', b: Math.round(clamp((p.brightness ?? 0) / 1.5, -100, 100)), c: clamp(p.contrast ?? 0, -100, 100) };
    case 'hue/saturation': return { type: 'hue', h: p.master?.hue ?? 0, s: p.master?.saturation ?? 0 };
    case 'posterize': return { type: 'posterize', levels: clamp(p.levels ?? 4, 2, 255) };
    case 'threshold': return { type: 'threshold', level: clamp(p.level ?? 128, 1, 255) };
    case 'exposure': return { type: 'exposure', exposure: p.exposure ?? 0, offset: p.offset ?? 0, gamma: p.gamma ?? 1 };
    case 'vibrance': return { type: 'vibrance', vibrance: p.vibrance ?? 0, saturation: p.saturation ?? 0 };
    case 'black & white': {
      const d = defaultAdjustment('bw');
      if (d.type !== 'bw') return null;
      d.w = [p.reds ?? 40, p.yellows ?? 60, p.greens ?? 40, p.cyans ?? 60, p.blues ?? 20, p.magentas ?? 80];
      if (p.useTint) d.tint = psdColorToRgb(p.tintColor);
      return d;
    }
    case 'photo filter': return { type: 'photo', color: psdColorToRgb(p.color), density: clamp((p.density ?? 0.25) * 100, 0, 100), lum: p.preserveLuminosity !== false };
    case 'color balance': {
      const t = (v?: { cyanRed: number; magentaGreen: number; yellowBlue: number }): Tri => (v ? [v.cyanRed, v.magentaGreen, v.yellowBlue] : [0, 0, 0]);
      return { type: 'balance', shadows: t(p.shadows), mids: t(p.midtones), highs: t(p.highlights), lum: p.preserveLuminosity !== false };
    }
    case 'channel mixer': {
      const r = (c?: { red: number; green: number; blue: number; constant: number }) => (c ? [c.red, c.green, c.blue, c.constant] : null);
      if (p.monochrome) return { type: 'mixer', mono: true, rows: [r(p.gray) ?? [40, 40, 20, 0], [0, 100, 0, 0], [0, 0, 100, 0]] };
      return { type: 'mixer', mono: false, rows: [r(p.red) ?? [100, 0, 0, 0], r(p.green) ?? [0, 100, 0, 0], r(p.blue) ?? [0, 0, 100, 0]] };
    }
    case 'gradient map': {
      if (p.gradientType !== 'solid' || !p.colorStops?.length) return null;     // noise gradients are not supported
      const ops = (p.opacityStops?.length ? p.opacityStops : [{ location: 0, opacity: 1 }, { location: 1, opacity: 1 }]);
      const opAt = (x: number) => {
        let k = 0; while (k < ops.length - 1 && x > ops[k + 1].location) k++;
        const A = ops[k], B = ops[Math.min(k + 1, ops.length - 1)], u = B.location > A.location ? clamp((x - A.location) / (B.location - A.location), 0, 1) : 0;
        return A.opacity + (B.opacity - A.opacity) * u;
      };
      const stops: GradStop[] = p.colorStops.map((s) => ({ x: s.location, c: psdColorToRgb(s.color) as RGB, a: opAt(s.location) }));
      return { type: 'gradmap', stops, reverse: !!p.reverse };
    }
    default: return null;
  }
}
export { identityLevels, identityCurve, curveLUT };
