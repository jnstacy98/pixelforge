// Conversion between PixelForge adjustment data and ag-psd's adjustment-layer structures (pure; unit-tested).
import type { AdjustmentLayer } from 'ag-psd';
import { CHANNELS_ALL, curveLUT, defaultAdjustment, identityCurve, identityLevels, type AdjustmentData, type CurvePoint, type Channel } from './adjust.ts';

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
    default: return null;
  }
}
export { identityLevels, identityCurve, curveLUT };
