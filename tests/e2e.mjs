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


// 6a. layer masks
await page.evaluate(() => { const d = window.__app.doc; d.history; });
const maskInfo = await page.evaluate(async () => {
  const a = window.__app, d = a.doc;
  d.select(d.layers[0]);                       // red-stroke background layer
  d.addMask('reveal');
  const l = d.layers[0];
  const before = [...(() => { const c = document.createElement('canvas'); c.width = d.width; c.height = d.height; const x = c.getContext('2d'); x.drawImage(document.querySelector('.doccanvas'), 0, 0); return x.getImageData(400, 200, 1, 1).data; })()];
  return { hasMask: !!l.mask, editing: l.maskMode, before };
});
assert.equal(maskInfo.hasMask, true); assert.equal(maskInfo.editing, true); ok('add reveal-all mask and target it');
// paint black on the mask over the red stroke -> that part of the layer hides (white background below the stroke would also hide: layer 0 IS the background)
await page.evaluate(() => { const a = window.__app; a.setFg('#000000'); a.brush.size = 60; a.brush.hardness = 1; a.brush.opacity = 1; a.setTool('brush'); });
await drag([380, 200], [420, 200]); await wait();
const hidden = await px(400, 200);
assert.equal(hidden[3], 0, 'masked area should be transparent'); ok('painting black on mask hides layer pixels');
assert.deepEqual((await px(100, 700)).slice(0, 3), [255, 255, 255]); ok('unmasked areas still visible');
const maskPixel = await page.evaluate(() => [...window.__app.doc.layers[0].mask.getContext('2d').getImageData(400, 200, 1, 1).data]);
assert.deepEqual(maskPixel.slice(0, 3), [0, 0, 0]); ok('mask stores grayscale (black = hidden)');
await page.keyboard.press('Control+z'); await wait();
assert.equal((await px(400, 200))[3], 255); ok('undo of mask stroke restores visibility');
await page.keyboard.press('Control+Shift+z'); await wait();
// disable mask shows everything again; PSD roundtrip keeps mask
await page.evaluate(() => window.__app.doc.toggleMask()); await wait();
assert.equal((await px(400, 200))[3], 255); ok('disabling mask reveals pixels');
await page.evaluate(() => window.__app.doc.toggleMask()); await wait();
const mrt = await page.evaluate(async () => (await window.__roundtrip()).mask);
assert.equal(mrt.has, true); assert.equal(mrt.hiddenAtStroke, 0); assert.equal(mrt.visibleElsewhere, 255); ok('PSD round-trip preserves layer mask');
await page.evaluate(() => window.__app.doc.applyMask()); await wait();
assert.equal(await page.evaluate(() => window.__app.doc.layers[0].mask), null); assert.equal((await px(400, 200))[3], 0); ok('apply mask bakes into pixels');
await page.keyboard.press('Control+z'); await wait();
assert.equal(await page.evaluate(() => !!window.__app.doc.layers[0].mask), true); ok('undo apply mask restores mask');

// 6b. text tool
await page.evaluate(() => { const a = window.__app; a.doc.setEditMask(a.doc.layers[0], false); a.setFg('#0000ff'); a.text.size = 80; a.text.bold = true; a.setTool('text'); });
const tp = await toScreen(800, 600); await page.mouse.click(tp.x, tp.y);
await page.waitForSelector('textarea.texteditor'); await page.keyboard.type('Hello\nWorld'); 
await page.keyboard.press('Escape'); await wait(); await wait();
const tl = await page.evaluate(() => { const d = window.__app.doc, l = d.active; let n = 0; const dt = l.canvas.getContext('2d').getImageData(0, 0, d.width, d.height).data; for (let i = 3; i < dt.length; i += 4) if (dt[i]) n++; return { text: l.text && l.text.content, name: l.name, n, layers: d.layers.length }; });
assert.equal(tl.text, 'Hello\nWorld'); assert.ok(tl.n > 500, 'text rendered'); ok(`text layer created ("${tl.name}", ${tl.n} px)`);
// re-edit: click on text, append, commit
const tp2 = await toScreen(830, 640); await page.mouse.click(tp2.x, tp2.y);
await page.waitForSelector('textarea.texteditor');
assert.equal(await page.inputValue('textarea.texteditor'), 'Hello\nWorld'); ok('clicking text re-opens editor with its content');
await page.keyboard.press('Control+End'); await page.keyboard.type('!'); await page.keyboard.press('Control+Enter'); await wait(); await wait();
assert.equal(await page.evaluate(() => window.__app.doc.active.text.content), 'Hello\nWorld!'); ok('text edit commits');
await page.keyboard.press('Control+z'); await wait();
assert.equal(await page.evaluate(() => window.__app.doc.active.text.content), 'Hello\nWorld'); ok('undo text edit');
// font change with no editor open updates active text layer
await page.evaluate(() => { window.__app.text.size = 40; window.__app.emit('textstyle'); }); await wait();
assert.equal(await page.evaluate(() => window.__app.doc.active.text.size), 40); ok('changing text options restyles active text layer');
// move tool moves text position; painting rasterizes
await page.evaluate(() => window.__app.setTool('move')); await drag([900, 650], [950, 700]); await wait();
const mv = await page.evaluate(() => window.__app.doc.active.text);
assert.ok(mv && mv.x > 800, 'text x moved'); ok('move tool keeps text layer editable and updates its position');
await page.evaluate(() => { const a = window.__app; a.setFg('#ff00ff'); a.brush.size = 10; a.setTool('brush'); }); await drag([100, 650], [140, 650]); await wait();
assert.equal(await page.evaluate(() => window.__app.doc.active.text), null); ok('painting on a text layer rasterizes it');
await page.keyboard.press('Control+z'); await wait();
assert.ok(await page.evaluate(() => !!window.__app.doc.active.text)); ok('undo restores editable text');
await page.evaluate(() => window.__app.doc.history.undo()); await page.evaluate(() => window.__app.doc.history.redo());


// 6c. selections: ellipse, lasso, wand, modifiers, inverse, move, feather
await page.evaluate(() => window.__blank(400, 300));
await wait();
const sel = () => page.evaluate(() => { const d = window.__app.doc; return { has: !!d.selection, irregular: !!d.selMask, b: d.selection && { ...d.selection } }; });
const selA = (x, y) => page.evaluate(([x, y]) => { const m = window.__app.doc.selMask; return m ? m.getContext('2d').getImageData(x, y, 1, 1).data[3] : -1; }, [x, y]);
const lpx2 = (x, y) => page.evaluate(([x, y]) => [...window.__app.doc.active.ctx.getImageData(x, y, 1, 1).data], [x, y]);
const withKeys = async (keys, fn) => { for (const k of keys) await page.keyboard.down(k); await fn(); for (const k of keys.reverse()) await page.keyboard.up(k); };

// ellipse marquee + painting is clipped to the ellipse
await page.evaluate(() => { const a = window.__app; a.marquee.shape = 'ellipse'; a.setTool('marquee'); });
await drag([100, 50], [300, 250]); await wait();
let s0 = await sel(); assert.ok(s0.has && s0.irregular); assert.ok(Math.abs(s0.b.w - 200) <= 2); ok('ellipse marquee creates an irregular selection');
assert.equal(await selA(200, 150), 255); assert.equal(await selA(105, 55), 0); ok('selection mask is inside/outside as an ellipse should be');
await page.evaluate(() => { const a = window.__app; a.setFg('#ff0000'); a.brush.size = 20; a.brush.hardness = 1; a.brush.opacity = 1; a.brush.flow = 1; a.setTool('brush'); });
await drag([90, 60], [310, 60]); await wait();
assert.deepEqual((await lpx2(200, 60)).slice(0, 3), [255, 0, 0]); assert.equal((await lpx2(105, 60))[3] === 255 && (await lpx2(105, 60))[1] === 255, true); ok('brush is clipped to an elliptical selection');
await page.keyboard.press('Control+z'); await wait();                       // undo stroke
await page.keyboard.press('Control+z'); await wait();                       // undo selection
assert.equal((await sel()).has, false); ok('undo removes the selection');
await page.keyboard.press('Control+Shift+z'); await wait();
assert.equal((await sel()).irregular, true); ok('redo restores the elliptical selection');

// inverse + fill
await page.keyboard.press('Control+Shift+i'); await wait();
assert.equal(await selA(200, 150), 0); assert.equal(await selA(5, 5), 255); ok('inverse selection flips the mask');
await page.evaluate(() => window.__app.setFg('#00ff00'));
await page.keyboard.press('Alt+Backspace'); await wait();
assert.deepEqual((await lpx2(5, 5)).slice(0, 3), [0, 255, 0]); assert.equal((await lpx2(200, 150))[3] === 255 && (await lpx2(200, 150))[0] === 255, true); ok('fill respects inverse selection (outside filled, ellipse untouched)');
await page.keyboard.press('Control+d'); await wait();
assert.equal((await sel()).has, false); ok('deselect');

// magic wand: select / add / subtract
await page.evaluate(() => { const d = window.__app.doc, l = d.active; l.ctx.fillStyle = '#fff'; l.ctx.fillRect(0, 0, 400, 300); l.ctx.fillStyle = '#f00'; l.ctx.fillRect(0, 0, 200, 300); l.ctx.fillStyle = '#00f'; l.ctx.fillRect(200, 0, 200, 300); d.emit('structure'); });
await page.evaluate(() => { const a = window.__app; a.fill.tolerance = 10; a.fill.contiguous = true; a.setTool('wand'); });
const clickAt = async (x, y) => { const q = await toScreen(x, y); await page.mouse.click(q.x, q.y); await wait(); };
await clickAt(50, 50);
assert.equal(await selA(50, 50), 255); assert.equal(await selA(350, 50), 0); ok('magic wand selects the clicked color region');
await withKeys(['Shift'], () => clickAt(350, 50));
assert.equal(await selA(50, 50), 255); assert.equal(await selA(350, 50), 255); ok('Shift+click adds to the selection');
await withKeys(['Alt'], () => clickAt(50, 50));
assert.equal(await selA(50, 50), 0); assert.equal(await selA(350, 50), 255); ok('Alt+click subtracts from the selection');
await withKeys(['Shift', 'Alt'], () => clickAt(350, 50));
assert.equal((await sel()).has, true); assert.equal(await selA(350, 50), 255); ok('Shift+Alt intersect keeps the overlap');

// lasso
await page.keyboard.press('Control+d'); await wait();
await page.evaluate(() => window.__app.setTool('lasso'));
const lp = [[60, 40], [340, 40], [200, 260]]; const sp = await Promise.all(lp.map((q) => toScreen(...q)));
await page.mouse.move(sp[0].x, sp[0].y); await page.mouse.down();
await page.mouse.move(sp[1].x, sp[1].y, { steps: 8 }); await page.mouse.move(sp[2].x, sp[2].y, { steps: 8 }); await page.mouse.up(); await wait();
assert.equal(await selA(200, 100), 255); assert.equal(await selA(40, 250), 0); ok('lasso selects the drawn polygon');

// filter limited to selection (invert inside the lasso triangle only)
await page.keyboard.press('Control+i'); await wait();
assert.deepEqual((await lpx2(120, 60)).slice(0, 3), [0, 255, 255]); assert.deepEqual((await lpx2(40, 250)).slice(0, 3), [255, 0, 0]); ok('filter applies only inside an irregular selection');
await page.keyboard.press('Control+z'); await wait();

// feather
await page.evaluate(() => window.__app.doc.setSelection({ x: 100, y: 100, w: 100, h: 100 })); await wait();
const featherOk = await page.evaluate(() => window.__feather(10));
assert.ok(featherOk.edge > 0 && featherOk.edge < 255 && featherOk.center === 255); ok('feather produces soft selection edges');
await page.keyboard.press('Control+d'); await wait();

// move with irregular selection + add layer mask from it
await page.evaluate(() => { const d = window.__app.doc, l = d.active; l.ctx.fillStyle = '#fff'; l.ctx.fillRect(0, 0, 400, 300); l.ctx.fillStyle = '#f00'; l.ctx.beginPath(); l.ctx.arc(100, 150, 40, 0, 7); l.ctx.fill(); d.emit('structure'); });
await page.evaluate(() => { window.__app.fill.tolerance = 10; window.__app.setTool('wand'); }); await clickAt(100, 150);
assert.equal(await selA(100, 150), 255); assert.equal(await selA(10, 10), 0);
await page.evaluate(() => window.__app.setTool('move')); await drag([100, 150], [150, 150]); await wait();
assert.deepEqual((await lpx2(150, 150)).slice(0, 3), [255, 0, 0]); assert.equal((await lpx2(70, 150))[3], 0); assert.deepEqual((await lpx2(10, 10)).slice(0, 4), [255, 255, 255, 255]); ok('move tool drags only the selected (circular) pixels, leaving a hole');
assert.equal(await selA(150, 150), 255); assert.equal(await selA(100, 150), 0); ok('selection follows the moved pixels');
await page.keyboard.press('Control+z'); await wait();
assert.deepEqual((await lpx2(100, 150)).slice(0, 3), [255, 0, 0]); assert.equal(await selA(100, 150), 255); ok('undo move restores pixels and selection');
await page.evaluate(() => window.__app.doc.addMask('selection')); await wait();
const mk = await page.evaluate(() => { const m = window.__app.doc.active.mask.getContext('2d'); return { inside: m.getImageData(100, 150, 1, 1).data[0], outside: m.getImageData(300, 50, 1, 1).data[0] }; });
assert.equal(mk.inside, 255); assert.equal(mk.outside, 0); ok('layer mask from an irregular selection');

// 7. open PNG via file drop path
const png = await page.evaluate(async () => (await window.__openPng()));
assert.equal(png.w, 64); ok('PNG import creates document');

await page.screenshot({ path: 'tests/screenshot.png' });
console.log(errors.length ? `\nConsole errors:\n${errors.join('\n')}` : '\nNo console errors');
await browser.close(); srv.kill();
process.exit(errors.length ? 1 : 0);
