// Pen tilt → brush-tip shape (pure; unit-tested).
/**
 * A pen held upright (tilt 0) leaves a round dab; leaning it flattens the contact into an ellipse stretched along the
 * lean direction. `tiltX` / `tiltY` are the PointerEvent angles in degrees (−90…90). Returns the azimuth of the lean
 * (degrees, 0 = towards +x on screen) and the stretch factor (1 = round, capped at 3).
 */
export function tiltShape(tiltX: number, tiltY: number): { az: number; stretch: number } {
  const tx = Math.tan((Math.max(-89, Math.min(89, tiltX)) * Math.PI) / 180), ty = Math.tan((Math.max(-89, Math.min(89, tiltY)) * Math.PI) / 180);
  const lean = Math.atan(Math.hypot(tx, ty));                                   // angle between pen and the surface normal
  if (lean < 0.02) return { az: 0, stretch: 1 };
  return { az: (Math.atan2(ty, tx) * 180) / Math.PI, stretch: Math.min(3, 1 / Math.max(0.3, Math.cos(lean))) };
}
/** Quantises a tilt shape so dabs can share cached stamps. */
export const quantTilt = (t: { az: number; stretch: number }) => ({ az: ((Math.round(t.az / 10) * 10) % 360 + 360) % 360, stretch: Math.round(t.stretch * 10) / 10 });
