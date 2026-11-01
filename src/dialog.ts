export type Field =
  | { key: string; label: string; type: 'number'; value: number; min?: number; max?: number; step?: number }
  | { key: string; label: string; type: 'range'; value: number; min: number; max: number; step?: number }
  | { key: string; label: string; type: 'text'; value: string }
  | { key: string; label: string; type: 'checkbox'; value: boolean }
  | { key: string; label: string; type: 'select'; value: string; options: [string, string][] };

export type Values = Record<string, any>;

export function formDialog(title: string, fields: Field[], okLabel = 'OK'): Promise<Values | null> {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    const box = document.createElement('form');
    box.className = 'modal';
    box.innerHTML = `<h2></h2>`;
    box.querySelector('h2')!.textContent = title;
    const inputs: Record<string, HTMLInputElement | HTMLSelectElement> = {};
    for (const f of fields) {
      const row = document.createElement('label');
      row.className = 'row';
      const span = document.createElement('span'); span.textContent = f.label; row.append(span);
      let el: HTMLInputElement | HTMLSelectElement;
      if (f.type === 'select') {
        el = document.createElement('select');
        for (const [v, l] of f.options) { const o = document.createElement('option'); o.value = v; o.textContent = l; el.append(o); }
        el.value = f.value;
      } else {
        el = document.createElement('input'); el.type = f.type;
        if (f.type === 'checkbox') el.checked = f.value; else el.value = String(f.value);
        if (f.type === 'number' || f.type === 'range') {
          if (f.min !== undefined) el.min = String(f.min); if (f.max !== undefined) el.max = String(f.max);
          if (f.step !== undefined) el.step = String(f.step);
        }
      }
      el.name = f.key; inputs[f.key] = el; row.append(el);
      if (f.type === 'range') { const out = document.createElement('output'); out.textContent = String(f.value); el.addEventListener('input', () => (out.textContent = (el as HTMLInputElement).value)); row.append(out); }
      box.append(row);
    }
    const btns = document.createElement('div'); btns.className = 'btns';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
    const ok = document.createElement('button'); ok.type = 'submit'; ok.textContent = okLabel; ok.className = 'primary';
    btns.append(cancel, ok); box.append(btns);
    const close = (v: Values | null) => { back.remove(); resolve(v); };
    cancel.onclick = () => close(null);
    back.onmousedown = (e) => { if (e.target === back) close(null); };
    box.onkeydown = (e) => { if (e.key === 'Escape') close(null); };
    box.onsubmit = (e) => {
      e.preventDefault();
      const out: Values = {};
      for (const f of fields) {
        const el = inputs[f.key] as HTMLInputElement;
        out[f.key] = f.type === 'checkbox' ? el.checked : f.type === 'number' || f.type === 'range' ? Number(el.value) : el.value;
      }
      close(out);
    };
    back.append(box); document.body.append(back);
    (box.querySelector('input,select') as HTMLElement | null)?.focus();
  });
}
