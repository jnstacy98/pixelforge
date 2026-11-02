// Performance benchmark on large documents: node tests/perf.mjs [megapixels=12] [--json out.json]
// Measures the operations that run on every interaction (composite, brush stroke, adjustment layers, layer styles, undo ...).
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const mp = Number(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 12);
const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;
const W = Math.round(Math.sqrt(mp * 1e6 * 4 / 3)), H = Math.round(W * 3 / 4);
const srv = spawn('npx', ['vite', 'preview', '--port', '4193', '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('http://localhost:4193/'); await page.waitForSelector('#stage');
const results = {};
const rec = (name, ms) => { results[name] = Math.round(ms * 10) / 10; console.log(`  ${name.padEnd(58)} ${String(Math.round(ms)).padStart(6)} ms`); };
console.log(`PixelForge performance — ${W}×${H} (${(W * H / 1e6).toFixed(1)} MP)`);

const t = (fn, arg) => page.evaluate(async ([fn, arg]) => { const f = new Function('arg', `return (async () => { ${fn} })()`); const t0 = performance.now(); await f(arg); return performance.now() - t0; }, [fn, arg]);
await page.evaluate(([W, H]) => {
  window.__blank(W, H); const a = window.__app, d = a.doc, x = d.layers[0].ctx;
  const g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#345'); g.addColorStop(1, '#fed'); x.fillStyle = g; x.fillRect(0, 0, W, H);
  for (let i = 0; i < 4; i++) { const l = d.addLayer('L' + i); l.ctx.fillStyle = `hsl(${i * 70},60%,50%)`; l.ctx.fillRect(W * (0.1 + i * 0.1), H * 0.2, W * 0.4, H * 0.5); }
  d.emit('structure');
  window.__ctxs = document.createElement('canvas'); window.__ctxs.width = W; window.__ctxs.height = H;
}, [W, H]);
await page.waitForTimeout(500);

const comp = 'const d = window.__app.doc, c = window.__ctxs.getContext("2d"); for (let i = 0; i < 3; i++) window.__composite(d, c);';
rec('composite ×3, 5 plain layers (per frame)', (await t(comp)) / 3);
// blend modes with per-pixel maths
await page.evaluate(() => { const d = window.__app.doc; d.layers[2].blend = 'linear-burn'; d.emit('structure'); });
rec('composite, one layer in a per-pixel blend mode', (await t('const d = window.__app.doc, c = window.__ctxs.getContext("2d"); window.__composite(d, c);')));
await page.evaluate(() => { const d = window.__app.doc; d.layers[2].blend = 'normal'; d.emit('structure'); });
// adjustment layers
await page.evaluate(() => { const d = window.__app.doc; d.addAdjustmentLayer(window.__defaultAdj('levels'), 'Lv'); d.addAdjustmentLayer(window.__defaultAdj('curves'), 'Cv'); d.addAdjustmentLayer(window.__defaultAdj('brightness'), 'Br'); d.emit('structure'); });
for (const [i, nm] of [[0, 'Levels'], [1, 'Curves'], [2, 'Brightness (CSS filter)']]) {
  await page.evaluate((i) => { const d = window.__app.doc, adj = d.layers.filter((x) => x.adjustment); adj.forEach((l, k) => (l.visible = k === i)); d.emit('structure'); }, i);
  rec(`composite with just a ${nm} adjustment layer`, await t('const d = window.__app.doc, c = window.__ctxs.getContext("2d"); window.__composite(d, c);'));
}
await page.evaluate(() => { const d = window.__app.doc; d.layers.filter((x) => x.adjustment).forEach((l) => (l.visible = true)); d.emit('structure'); });
rec('composite with Levels + Curves + Brightness adjustment layers', (await t('const d = window.__app.doc, c = window.__ctxs.getContext("2d"); window.__composite(d, c);')));
await page.evaluate(() => { const d = window.__app.doc; for (const l of d.layers.filter((x) => x.adjustment)) l.visible = false; d.emit('structure'); });
// layer styles
await page.evaluate(() => { const d = window.__app.doc, l = d.layers[1]; l.effects = { dropShadow: { on: true, color: '#000000', opacity: 0.75, blend: 'multiply', angle: 120, distance: 20, spread: 0, size: 30 }, stroke: { on: true, color: '#ff0000', opacity: 1, blend: 'normal', size: 6, position: 'outside' } }; d.emit('structure'); });
rec('composite with a shadow + stroke style (first, uncached)', (await t('const d = window.__app.doc, c = window.__ctxs.getContext("2d"); window.__composite(d, c);')));
rec('…and again (styled render cached)', (await t('const d = window.__app.doc, c = window.__ctxs.getContext("2d"); window.__composite(d, c);')));
await page.evaluate(() => { const d = window.__app.doc; d.layers[1].effects = null; d.emit('structure'); });
// brush stroke
await page.evaluate(() => { const a = window.__app; a.fg = '#ff0000'; Object.assign(a.brush, { size: 60, hardness: 0.7, opacity: 1, flow: 1, spacing: 0.1, tip: 'round', angle: 0, follow: false, tilt: true }); a.doc.select(a.doc.layers[3]); a.setTool('brush'); });
const stroke = await page.evaluate(async ([W, H]) => {
  const st = document.getElementById('stage'), r = st.getBoundingClientRect(), z = window.__app.view;
  const ev = (type, x, y, b) => new PointerEvent(type, { pointerId: 3, pointerType: 'mouse', clientX: r.left + z.panX + x * z.zoom, clientY: r.top + z.panY + y * z.zoom, button: 0, buttons: b, bubbles: true });
  const t0 = performance.now();
  st.dispatchEvent(ev('pointerdown', W * 0.2, H * 0.4, 1));
  const tDown = performance.now() - t0; let worst = 0, frames = 0; const t1 = performance.now();
  for (let i = 0; i < 40; i++) { const m0 = performance.now(); st.dispatchEvent(ev('pointermove', W * 0.2 + i * 40, H * 0.4 + Math.sin(i / 4) * 200, 1)); await new Promise((res) => requestAnimationFrame(res)); const dt = performance.now() - m0; worst = Math.max(worst, dt); frames++; }
  const moves = performance.now() - t1; const t2 = performance.now();
  st.dispatchEvent(ev('pointerup', W * 0.2 + 1600, H * 0.4, 0));
  return { tDown, perFrame: moves / frames, worst, tUp: performance.now() - t2 };
}, [W, H]);
rec('brush: pointer down (stroke start)', stroke.tDown); rec('brush: per move + repaint (avg)', stroke.perFrame); rec('brush: per move + repaint (worst)', stroke.worst); rec('brush: pointer up (commit + history)', stroke.tUp);
rec('undo the stroke', await t('window.__app.doc.history.undo();'));
rec('redo the stroke', await t('window.__app.doc.history.redo();'));
// duplicate layer / merge / flatten
rec('duplicate layer', await t('window.__app.doc.duplicateLayer();'));
rec('merge down', await t('window.__app.doc.mergeDown();'));
rec('flatten image', await t('window.__app.doc.flatten();'));
rec('undo flatten', await t('window.__app.doc.history.undo();'));
// brush stroke with the active layer inside a group and under adjustment layers (the worst realistic case)
await page.evaluate(() => { const d = window.__app.doc; d.addAdjustmentLayer(window.__defaultAdj('levels'), 'Lv2'); d.addAdjustmentLayer(window.__defaultAdj('hue'), 'Hu2'); d.select(d.layers[1]); window.__app.setTool('brush'); });
const stroke2 = await page.evaluate(async ([W, H]) => {
  const st = document.getElementById('stage'), r = st.getBoundingClientRect(), z = window.__app.view;
  const ev = (type, x, y, b) => new PointerEvent(type, { pointerId: 4, pointerType: 'mouse', clientX: r.left + z.panX + x * z.zoom, clientY: r.top + z.panY + y * z.zoom, button: 0, buttons: b, bubbles: true });
  st.dispatchEvent(ev('pointerdown', W * 0.2, H * 0.5, 1)); let worst = 0, sum = 0;
  for (let i = 0; i < 30; i++) { const m0 = performance.now(); st.dispatchEvent(ev('pointermove', W * 0.2 + i * 40, H * 0.5 + Math.sin(i / 4) * 200, 1)); await new Promise((res) => requestAnimationFrame(res)); const dt = performance.now() - m0; worst = Math.max(worst, dt); sum += dt; }
  st.dispatchEvent(ev('pointerup', W * 0.2 + 1200, H * 0.5, 0)); return { avg: sum / 30, worst };
}, [W, H]);
rec('brush under two adjustment layers: per move (avg)', stroke2.avg); rec('brush under two adjustment layers: per move (worst)', stroke2.worst);
const pt = await page.evaluate(() => window.__psdTimes());
rec(`PSD save (encode) — ${(pt.psdBytes / 1e6).toFixed(0)} MB file`, pt.encode); rec('PSD open (decode the same file)', pt.import); rec(`PNG export — ${(pt.pngBytes / 1e6).toFixed(0)} MB file`, pt.png);
console.log(errors.length ? 'page errors: ' + errors.join('\n') : 'no page errors');
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ W, H, results }, null, 1));
await browser.close(); srv.kill();
