import { app } from './state';
import { BI_CHANNELS, BI_LABELS, cloneBlendIf, defaultBlendIf, isBlendIfActive, normalizeRange, type BIChannel, type BlendIf, type Range4 } from './blendif';

let open = false;
export const isBlendIfOpen = () => open;

const STOPS = ['Black', 'Black split', 'White split', 'White'];

/** Layer ▸ Blend If…: hide parts of the layer by its own tones ("This Layer") or the tones beneath it ("Underlying Layer"). */
export function openBlendIf() {
  const doc = app.doc, layer = doc.active;
  if (open || layer.isGroup || layer.adjustment) { if (layer.isGroup || layer.adjustment) app.toast('Blend If works on pixel and text layers'); return; }
  open = true;
  const before = cloneBlendIf(layer.blendIf);
  let draft: BlendIf = cloneBlendIf(layer.blendIf) ?? defaultBlendIf(), ch: BIChannel = 'gray';
  const push = () => { layer.blendIf = isBlendIfActive(draft) ? cloneBlendIf(draft) : null; doc.emit('pixels'); };

  const back = document.createElement('div'); back.className = 'adjust-back';
  const panel = document.createElement('div'); panel.className = 'adjust-panel'; panel.tabIndex = -1;
  const head = document.createElement('h2'); head.textContent = 'Blend If';
  const body = document.createElement('div'); body.className = 'adjust-body';
  const sel = document.createElement('select');
  for (const c of BI_CHANNELS) { const o = document.createElement('option'); o.value = c; o.textContent = BI_LABELS[c]; sel.append(o); }
  sel.onchange = () => { ch = sel.value as BIChannel; build(); };
  const set = (c: BIChannel, which: 'src' | 'dst', i: number, v: number) => {
    const r = [...draft[c][which]] as Range4;
    r[i] = Math.min(255, Math.max(0, Math.round(v)));
    // keep the stops ordered: moving one drags its neighbours along
    for (let k = i + 1; k < 4; k++) r[k] = Math.max(r[k], r[k - 1]);
    for (let k = i - 1; k >= 0; k--) r[k] = Math.min(r[k], r[k + 1]);
    draft[c][which] = normalizeRange(r);
    build(); push();
  };
  const build = () => {
    body.replaceChildren();
    const row = document.createElement('div'); row.className = 'row'; row.append('Channel ', sel); body.append(row);
    for (const [which, title] of [['src', 'This Layer'], ['dst', 'Underlying Layer']] as const) {
      const h = document.createElement('div'); h.className = 'hint'; h.textContent = title; body.append(h);
      const bar = document.createElement('div'); const r = draft[ch][which];
      bar.style.cssText = `height:10px;border:1px solid #555;margin:2px 0 4px;background:linear-gradient(90deg,#000 ${(r[0] / 255) * 100}%,#777 ${(r[1] / 255) * 100}%,#777 ${(r[2] / 255) * 100}%,#fff ${(r[3] / 255) * 100}%)`;
      body.append(bar);
      STOPS.forEach((name, i) => {
        const rg = document.createElement('input'); rg.type = 'range'; rg.min = '0'; rg.max = '255'; rg.value = String(r[i]);
        const n = document.createElement('input'); n.type = 'number'; n.min = '0'; n.max = '255'; n.value = String(r[i]); n.style.width = '64px';
        rg.oninput = () => set(ch, which, i, Number(rg.value));
        n.onchange = () => set(ch, which, i, Number(n.value));
        const line = document.createElement('div'); line.className = 'row';
        const lab = document.createElement('span'); lab.textContent = name; lab.style.width = '90px';
        line.append(lab, rg, n); body.append(line);
      });
    }
  };
  build();
  (body as any).__bi = { get: () => draft, set };

  const close = () => { back.remove(); open = false; };
  const mk = (t: string, cls = '') => { const b = document.createElement('button'); b.type = 'button'; b.textContent = t; if (cls) b.className = cls; return b; };
  const cancel = mk('Cancel'), ok = mk('OK', 'primary'), reset = mk('Reset');
  cancel.onclick = () => { layer.blendIf = cloneBlendIf(before); doc.emit('pixels'); close(); };
  ok.onclick = () => {
    const next = isBlendIfActive(draft) ? cloneBlendIf(draft) : null;
    layer.blendIf = cloneBlendIf(before);
    if (JSON.stringify(next) !== JSON.stringify(before)) doc.setBlendIf(layer, next, before); else doc.emit('structure');
    close();
  };
  reset.onclick = () => { draft = defaultBlendIf(); build(); push(); };
  panel.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Escape') cancel.click(); else if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'BUTTON') ok.click(); };
  head.onpointerdown = (e) => {
    const r = panel.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    head.setPointerCapture(e.pointerId);
    head.onpointermove = (m) => { panel.style.left = `${m.clientX - dx}px`; panel.style.top = `${m.clientY - dy}px`; panel.style.right = 'auto'; };
    head.onpointerup = () => { head.onpointermove = null; head.onpointerup = null; };
  };
  const foot = document.createElement('div'); foot.className = 'adjust-foot';
  const grow = document.createElement('span'); grow.className = 'grow';
  foot.append(reset, grow, cancel, ok);
  panel.append(head, body, foot); back.append(panel); document.body.append(back); panel.focus();
}
