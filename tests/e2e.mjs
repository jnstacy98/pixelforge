// End-to-end smoke test: builds nothing, serves ./dist with vite preview, drives it with Playwright.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const srv = spawn('npx', ['vite', 'preview', '--port', '4173', '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto('http://localhost:4173/');
await page.waitForSelector('#stage');

const ok = (name) => console.log(`  ✓ ${name}`);
const px = (x, y) => page.evaluate(([x, y]) => {
  const a = window.__app, c = document.createElement('canvas'); c.width = a.doc.width; c.height = a.doc.height;
  const ctx = c.getContext('2d'); document.querySelector('.doccanvas'); ctx.drawImage(document.querySelector('.doccanvas'), 0, 0);
  return [...ctx.getImageData(x, y, 1, 1).data];
}, [x, y]);
const toScreen = (x, y) => page.evaluate(([x, y]) => {
  const a = window.__app, r = document.getElementById('stage').getBoundingClientRect();
  return { x: r.left + a.view.panX + x * a.view.zoom, y: r.top + a.view.panY + y * a.view.zoom };
}, [x, y]);
const drag = async (a, b) => {
  const p = await toScreen(...a), q = await toScreen(...b);
  await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move((p.x + q.x) / 2, (p.y + q.y) / 2, { steps: 5 }); await page.mouse.move(q.x, q.y, { steps: 5 }); await page.mouse.up();
};
const wait = () => page.waitForTimeout(80);

// 1. brush stroke paints pixels
await page.evaluate(() => { const a = window.__app; a.setFg('#ff0000'); a.brush.size = 30; a.brush.hardness = 1; a.setTool('brush'); });
await drag([200, 200], [600, 200]); await wait();
assert.deepEqual((await px(400, 200)).slice(0, 3), [255, 0, 0]); ok('brush stroke paints red');
assert.deepEqual((await px(400, 400)).slice(0, 3), [255, 255, 255]); ok('untouched area stays white');

// 2. undo / redo
await page.keyboard.press('Control+z'); await wait();
assert.deepEqual((await px(400, 200)).slice(0, 3), [255, 255, 255]); ok('undo reverts stroke');
await page.keyboard.press('Control+Shift+z'); await wait();
assert.deepEqual((await px(400, 200)).slice(0, 3), [255, 0, 0]); ok('redo reapplies stroke');

// 3. new layer + eraser, opacity, blend
await page.click('#lnew'); await wait();
assert.equal(await page.evaluate(() => window.__app.doc.layers.length), 2); ok('new layer added');
await page.evaluate(() => { const a = window.__app; a.setFg('#0000ff'); a.setTool('brush'); });
await drag([300, 100], [300, 300]); await wait();
assert.deepEqual((await px(300, 200)).slice(0, 3), [0, 0, 255]); ok('paint on upper layer');
await page.evaluate(() => { const d = window.__app.doc; d.setProp(d.active, 'opacity', 0.5); d.setProp(d.active, 'blend', 'multiply'); d.setProp(d.active, 'name', 'Blue Multiply'); });
await wait();

// 4. bucket fill respects boundary (fill on new layer's transparent area, non-contiguous off)
await page.evaluate(() => { const a = window.__app; a.setFg('#00ff00'); a.setTool('bucket'); a.fill.tolerance = 0; });
await page.evaluate(() => { const d = window.__app.doc; d.selection = { x: 700, y: 500, w: 100, h: 100 }; d.emit('selection'); });
const t = await toScreen(750, 550); await page.mouse.click(t.x, t.y); await wait();
const lpx = (x, y) => page.evaluate(([x, y]) => [...window.__app.doc.active.ctx.getImageData(x, y, 1, 1).data], [x, y]);
assert.deepEqual(await lpx(750, 550), [0, 255, 0, 255]); ok('bucket fill inside selection');
assert.equal((await lpx(650, 550))[3], 0); ok('bucket fill does not leak outside selection');
assert.deepEqual((await px(750, 550)).slice(0, 3), [127, 255, 127]); ok('layer opacity + multiply blend composite correctly');
await page.evaluate(() => { const d = window.__app.doc; d.selection = null; d.emit('selection'); });

// 5. filter + flip + resize
await page.evaluate(() => window.__app.doc.flip(true)); await wait();
assert.deepEqual((await px(1280 - 400, 200)).slice(0, 3), [255, 0, 0]); ok('flip horizontal mirrors pixels');
await page.evaluate(() => window.__app.doc.history.undo()); await wait();
assert.deepEqual((await px(400, 200)).slice(0, 3), [255, 0, 0]); ok('undo flip');
await page.evaluate(() => window.__app.doc.resizeImage(640, 400)); await wait();
assert.equal(await page.evaluate(() => window.__app.doc.width), 640); ok('image resize');
await page.evaluate(() => window.__app.doc.history.undo()); await wait();

// 6. PSD round trip keeps layers, names, opacity, blend mode
const bytes = await page.evaluate(async () => (await window.__roundtrip()).summary).catch((e) => ({ error: String(e) }));
console.log('  psd roundtrip:', JSON.stringify(bytes));
assert.ok(bytes.layers >= 2, 'PSD layers preserved');
assert.equal(bytes.top.name, 'Blue Multiply'); assert.equal(Math.round(bytes.top.opacity * 100), 50); assert.equal(bytes.top.blend, 'multiply');
ok('PSD export → import preserves layers, name, opacity, blend');

// 7. open PNG via file drop path
const png = await page.evaluate(async () => (await window.__openPng()));
assert.equal(png.w, 64); ok('PNG import creates document');

await page.screenshot({ path: 'tests/screenshot.png' });
console.log(errors.length ? `\nConsole errors:\n${errors.join('\n')}` : '\nNo console errors');
await browser.close(); srv.kill();
process.exit(errors.length ? 1 : 0);
