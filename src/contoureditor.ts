// Free-form contour editor: drag points on a curve to reshape an effect's falloff (opened from the Layer Style dialog).
import { CONTOUR_NAMES, CONTOUR_PRESETS, addPoint, contourFromPoints, contourLUT, contourPoints, hitPoint, movePoint, removePoint, type CPt, type Contour } from './contour';

let open = false;
export const isContourEditorOpen = () => open;

/**
 * Edit a contour. `onChange` is called live with every change (so the effect previews while you drag); the returned promise
 * resolves with the final contour on OK (undefined = linear) or `null` on Cancel (the caller should restore the original).
 */
export function openContourEditor(initial: Contour | undefined, title: string, onChange: (c: Contour | undefined) => void): Promise<Contour | undefined | null> {
  if (open) return Promise.resolve(null);
  open = true;
  return new Promise((resolve) => {
    const start = contourPoints(initial);
    let pts: CPt[] = start.pts, corner = start.corner, drag = -1;
    const PAD = 6, N = 256;
    const back = document.createElement('div'); back.className = 'adjust-back';
    const panel = document.createElement('div'); panel.className = 'adjust-panel contour-editor'; panel.tabIndex = -1;
    const head = document.createElement('h2'); head.textContent = `Contour Editor — ${title}`;
    const cv = document.createElement('canvas'); cv.width = N + PAD * 2; cv.height = N + PAD * 2; cv.className = 'curvecanvas';
    const readout = document.createElement('div'); readout.className = 'readout'; readout.textContent = ' ';
    const body = document.createElement('div'); body.className = 'adjust-body';
    const pre = document.createElement('select'); pre.innerHTML = '<option value="">Preset…</option>' + CONTOUR_NAMES.map((n) => `<option value="${n}">${n}</option>`).join('');
    const cornerCb = document.createElement('input'); cornerCb.type = 'checkbox'; cornerCb.checked = corner;
    const cornerLabel = document.createElement('label'); cornerLabel.append(cornerCb, ' Corner (straight segments)');
    const row = document.createElement('div'); row.className = 'row'; row.append('Preset ', pre, cornerLabel);
    const hint = document.createElement('div'); hint.className = 'hint'; hint.textContent = 'Click the curve to add a point · drag points · double-click or right-click a point to remove it · input (→) is the effect’s coverage, output (↑) is how strongly it is drawn';
    body.append(row, cv, readout, hint);
    const px = (v: number) => PAD + v, py = (v: number) => PAD + N - 1 - v;

    const current = () => contourFromPoints(pts, corner);
    const lut = () => contourLUT(current() ?? { name: 'Linear' }) ?? Float32Array.from({ length: 256 }, (_, i) => i / 255);
    const draw = () => {
      const x = cv.getContext('2d')!;
      x.fillStyle = '#111'; x.fillRect(0, 0, cv.width, cv.height);
      x.strokeStyle = '#333'; x.lineWidth = 1; x.beginPath();
      for (let g = 0; g <= 4; g++) { const v = Math.min(255, g * 64); x.moveTo(px(v) + .5, PAD); x.lineTo(px(v) + .5, PAD + N); x.moveTo(PAD, py(v) + .5); x.lineTo(PAD + N, py(v) + .5); }
      x.stroke();
      x.setLineDash([3, 3]); x.strokeStyle = '#555'; x.beginPath(); x.moveTo(px(0), py(0)); x.lineTo(px(255), py(255)); x.stroke(); x.setLineDash([]);
      const l = lut();
      x.strokeStyle = '#fff'; x.lineWidth = 2; x.beginPath();
      for (let v = 0; v < 256; v++) { const y = py(l[v] * 255); v ? x.lineTo(px(v), y) : x.moveTo(px(v), y); }
      x.stroke();
      x.fillStyle = '#fff'; x.strokeStyle = '#000'; x.lineWidth = 1;
      pts.forEach((p, i) => { x.fillStyle = i === drag ? '#1a6fd1' : '#fff'; x.fillRect(px(p[0]) - 3, py(p[1]) - 3, 7, 7); x.strokeRect(px(p[0]) - 3.5, py(p[1]) - 3.5, 7, 7); });
    };
    const changed = () => { draw(); onChange(current()); };
    const toVal = (e: PointerEvent | MouseEvent) => ({ x: Math.min(255, Math.max(0, Math.round(e.offsetX - PAD))), y: Math.min(255, Math.max(0, Math.round(N - 1 - (e.offsetY - PAD)))) });
    cv.onpointerdown = (e) => {
      if (e.button === 2) return;
      const v = toVal(e); let i = hitPoint(pts, v.x, v.y);
      if (i < 0) { const r = addPoint(pts, v.x, v.y); if (r.index < 0) return; pts = r.pts; i = r.index; }
      drag = i; try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      cv.onpointermove!(e);
    };
    cv.onpointermove = (e) => {
      const v = toVal(e);
      if (drag < 0) { const i = hitPoint(pts, v.x, v.y); readout.textContent = i >= 0 ? `Input: ${pts[i][0]}   Output: ${pts[i][1]}` : `Input: ${v.x}   Output: ${Math.round(lut()[v.x] * 255)}`; return; }
      pts = movePoint(pts, drag, v.x, v.y); readout.textContent = `Input: ${pts[drag][0]}   Output: ${pts[drag][1]}`; changed();
    };
    cv.onpointerup = () => { drag = -1; draw(); };
    const remove = (e: MouseEvent) => { e.preventDefault(); const v = toVal(e), i = hitPoint(pts, v.x, v.y); if (i > 0 && i < pts.length - 1) { pts = removePoint(pts, i); changed(); } };
    cv.oncontextmenu = remove; cv.ondblclick = remove;
    pre.onchange = () => { if (!pre.value) return; const p = CONTOUR_PRESETS[pre.value]; pts = p.pts.map((q) => [...q] as CPt); corner = !p.smooth; cornerCb.checked = corner; pre.value = ''; changed(); };
    cornerCb.onchange = () => { corner = cornerCb.checked; changed(); };

    const mk = (t: string, cls = '') => { const b = document.createElement('button'); b.type = 'button'; b.textContent = t; if (cls) b.className = cls; return b; };
    const reset = mk('Reset'), cancel = mk('Cancel'), ok = mk('OK', 'primary'), grow = document.createElement('span'); grow.className = 'grow';
    const foot = document.createElement('div'); foot.className = 'adjust-foot'; foot.append(reset, grow, cancel, ok);
    const close = (v: Contour | undefined | null) => { back.remove(); open = false; resolve(v); };
    reset.onclick = () => { pts = [[0, 0], [255, 255]]; corner = false; cornerCb.checked = false; changed(); };
    cancel.onclick = () => close(null);
    ok.onclick = () => close(current());
    panel.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Escape') cancel.click(); else if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'BUTTON' && (e.target as HTMLElement).tagName !== 'SELECT') ok.click(); };
    (panel as unknown as { __contour: unknown }).__contour = { get: () => ({ pts, corner }), set: (p: CPt[], c = false) => { pts = p; corner = c; cornerCb.checked = c; changed(); } };
    panel.append(head, body, foot); back.append(panel); document.body.append(back); panel.focus();
    draw();
  });
}
