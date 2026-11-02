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


// 6d. Levels & Curves
const newGray = async (rgb = [128, 128, 128]) => {
  await page.evaluate((c) => { window.__blank(400, 300); const d = window.__app.doc, l = d.active; l.ctx.fillStyle = `rgb(${c})`; l.ctx.fillRect(0, 0, 400, 300); d.emit('structure'); }, rgb);
  await wait();
};
const gray = async (x = 10, y = 10) => (await lpx2(x, y)).slice(0, 3);
const levels = (c, p) => page.evaluate(([c, p]) => document.querySelector('.adjust-body').__levels.set(c, p), [c, p]);
const curves = (c, pts) => page.evaluate(([c, pts]) => document.querySelector('.adjust-body').__curves.set(c, pts), [c, pts]);

await newGray();
await page.keyboard.press('Control+l'); await page.waitForSelector('.adjust-panel');
await levels('rgb', { gamma: 2 }); await page.waitForTimeout(150);
assert.deepEqual(await gray(), [181, 181, 181]); ok('Levels: live preview applies gamma 2 (128 → 181)');
await page.keyboard.press('Escape'); await wait();
assert.equal(await page.locator('.adjust-panel').count(), 0); assert.deepEqual(await gray(), [128, 128, 128]); ok('Levels: Cancel restores the original pixels');

await page.keyboard.press('Control+l'); await page.waitForSelector('.adjust-panel');
await levels('rgb', { ib: 100, iw: 200 }); await page.waitForTimeout(150);
const lv = await gray(); assert.ok(Math.abs(lv[0] - 71) <= 1, `got ${lv}`); ok('Levels: input black/white points stretch contrast');
await page.click('.adjust-panel button.primary'); await wait();
assert.ok(Math.abs((await gray())[0] - 71) <= 1);
const hl = await page.evaluate(() => window.__app.doc.history.undoLabel); assert.equal(hl, 'Levels'); ok('Levels: OK commits one "Levels" history step');
await page.keyboard.press('Control+z'); await wait();
assert.deepEqual(await gray(), [128, 128, 128]); ok('Levels: undo restores pixels');

// per-channel + Auto in dialog
await newGray([100, 100, 100]);
await page.keyboard.press('Control+l'); await page.waitForSelector('.adjust-panel');
await levels('r', { iw: 200 }); await page.waitForTimeout(150);
const ch = await gray(); assert.ok(ch[0] > 120 && ch[1] === 100 && ch[2] === 100, `got ${ch}`); ok('Levels: red channel adjusts independently');
await page.keyboard.press('Escape'); await wait();

// live preview toggle
await newGray();
await page.keyboard.press('Control+l'); await page.waitForSelector('.adjust-panel');
await levels('rgb', { gamma: 2 }); await page.waitForTimeout(150);
await page.uncheck('.adjust-foot input[type=checkbox]'); await page.waitForTimeout(150);
assert.deepEqual(await gray(), [128, 128, 128]); ok('Levels: unchecking Preview shows the original');
await page.keyboard.press('Escape'); await wait();

// Curves via hook (invert) + OK + undo
await newGray();
await page.keyboard.press('Control+m'); await page.waitForSelector('.curvecanvas');
await curves('rgb', [{ x: 0, y: 255 }, { x: 255, y: 0 }]); await page.waitForTimeout(150);
assert.ok(Math.abs((await gray())[0] - 127) <= 1); ok('Curves: inverting curve flips tones');
await page.keyboard.press('Enter'); await wait();
assert.equal(await page.evaluate(() => window.__app.doc.history.undoLabel), 'Curves'); ok('Curves: Enter commits');
await page.keyboard.press('Control+z'); await wait(); assert.deepEqual(await gray(), [128, 128, 128]); ok('Curves: undo');

// Curves with real mouse: click on the diagonal at x=128 and drag up to 192
await newGray();
await page.keyboard.press('Control+m'); await page.waitForSelector('.curvecanvas');
const cb = await page.locator('.curvecanvas').boundingBox();
const cx = (v) => cb.x + 4 + v, cy = (v) => cb.y + 4 + 255 - v;
await page.mouse.move(cx(128), cy(128)); await page.mouse.down(); await page.mouse.move(cx(128), cy(160), { steps: 4 }); await page.mouse.move(cx(128), cy(192), { steps: 4 }); await page.mouse.up();
await page.waitForTimeout(150);
const cm = await gray(); assert.ok(Math.abs(cm[0] - 192) <= 2, `got ${cm}`); ok('Curves: dragging a point on the graph with the mouse lightens midtones');
await page.mouse.dblclick(cx(128), cy(192)); await page.waitForTimeout(150);
assert.ok(Math.abs((await gray())[0] - 128) <= 1); ok('Curves: double-click removes the point');
await page.keyboard.press('Escape'); await wait();

// Curves per channel
await newGray([100, 100, 100]);
await page.keyboard.press('Control+m'); await page.waitForSelector('.curvecanvas');
await curves('b', [{ x: 0, y: 0 }, { x: 100, y: 200 }, { x: 255, y: 255 }]); await page.waitForTimeout(150);
const cc = await gray(); assert.deepEqual(cc, [100, 100, 200]); ok('Curves: blue channel curve changes only blue');
await page.keyboard.press('Escape'); await wait();

// respects rectangular + irregular selections
await newGray();
await page.evaluate(() => window.__app.doc.setSelection({ x: 0, y: 0, w: 200, h: 300 }));
await page.keyboard.press('Control+m'); await page.waitForSelector('.curvecanvas');
await curves('rgb', [{ x: 0, y: 255 }, { x: 255, y: 0 }]); await page.waitForTimeout(150); await page.keyboard.press('Enter'); await wait();
assert.ok(Math.abs((await gray(50, 50))[0] - 127) <= 1); assert.deepEqual(await gray(300, 50), [128, 128, 128]); ok('Curves: limited to a rectangular selection');
await newGray();
await page.evaluate(() => { const d = window.__app.doc, m = document.createElement('canvas'); m.width = 400; m.height = 300; const x = m.getContext('2d'); x.beginPath(); x.arc(200, 150, 60, 0, 7); x.fill(); d.setSelection({ x: 140, y: 90, w: 120, h: 120 }, m); });
await page.keyboard.press('Control+l'); await page.waitForSelector('.adjust-panel');
await levels('rgb', { gamma: 2 }); await page.waitForTimeout(150); await page.keyboard.press('Enter'); await wait();
assert.deepEqual(await gray(200, 150), [181, 181, 181]); assert.deepEqual(await gray(145, 95), [128, 128, 128]); assert.deepEqual(await gray(10, 10), [128, 128, 128]); ok('Levels: respects a circular selection (corner of its bounds untouched)');

// Auto Levels
await newGray([60, 60, 60]);
await page.evaluate(() => { const l = window.__app.doc.active; l.ctx.fillStyle = 'rgb(180,180,180)'; l.ctx.fillRect(200, 0, 200, 300); });
await page.keyboard.press('Control+Shift+l'); await wait();
const a0 = await gray(50, 50), a1 = await gray(300, 50);
assert.ok(a0[0] <= 5 && a1[0] >= 250, `got ${a0} ${a1}`); ok('Auto Levels stretches a narrow histogram to full range');
assert.equal(await page.evaluate(() => window.__app.doc.history.undoLabel), 'Auto Levels');

// works on a layer mask and leaves pixels alone
await newGray();
await page.evaluate(() => window.__app.doc.addMask('reveal')); await wait();
await page.keyboard.press('Control+l'); await page.waitForSelector('.adjust-panel');
await levels('rgb', { ow: 128 }); await page.waitForTimeout(150); await page.keyboard.press('Enter'); await wait();
const mvm = await page.evaluate(() => ({ mask: window.__app.doc.active.mask.getContext('2d').getImageData(10, 10, 1, 1).data[0], px: [...window.__app.doc.active.ctx.getImageData(10, 10, 1, 1).data.slice(0, 3)] }));
assert.equal(mvm.mask, 128); assert.deepEqual(mvm.px, [128, 128, 128]); ok('Levels edits the layer mask when it is the target');

// shortcuts are suspended while a dialog is open
await newGray();
await page.keyboard.press('Control+l'); await page.waitForSelector('.adjust-panel');
await page.keyboard.press('Control+n'); await wait();
assert.equal(await page.locator('.modal').count(), 0); ok('global shortcuts are suspended while an adjustment dialog is open');
await page.keyboard.press('Escape'); await wait();


// 6e. adjustment layers
const view = async (x = 10, y = 10) => { await page.waitForTimeout(150); return (await px(x, y)).slice(0, 3); };
const addAdj = async (label) => { await page.click('#ladj'); await page.click(`.popup .mi:has-text("${label}")`); };
const adjOf = () => page.evaluate(() => { const l = window.__app.doc.active; return l.adjustment && JSON.parse(JSON.stringify(l.adjustment)); });
const nLayers = () => page.evaluate(() => window.__app.doc.layers.length);
const base0 = (x, y) => page.evaluate(([x, y]) => [...window.__app.doc.layers[0].ctx.getImageData(x, y, 1, 1).data], [x, y]);

await newGray([128, 128, 128]);
await addAdj('Invert'); await wait();
assert.equal(await nLayers(), 2); assert.equal((await adjOf()).type, 'invert'); ok('adjustment layer created from the Layers panel');
assert.deepEqual(await view(), [127, 127, 127]); ok('invert adjustment layer changes the composite');
assert.deepEqual((await base0(10, 10)).slice(0, 3), [128, 128, 128]); ok('…without touching the layer pixels (non-destructive)');
await page.evaluate(() => { const d = window.__app.doc; d.setProp(d.active, 'visible', false); });
assert.deepEqual(await view(), [128, 128, 128]); ok('hiding the adjustment layer restores the original look');
await page.evaluate(() => { const d = window.__app.doc; d.setProp(d.active, 'visible', true); });
for (let k = 0; k < 3; k++) await page.keyboard.press('Control+z');
await wait();
assert.equal(await nLayers(), 1); assert.deepEqual(await view(), [128, 128, 128]); ok('undo removes the adjustment layer');
await page.keyboard.press('Control+Shift+z'); await wait();
assert.equal(await nLayers(), 2); assert.deepEqual(await view(), [127, 127, 127]); ok('redo brings it back');

// Levels adjustment layer: preview, OK, re-edit, cancel
await newGray([128, 128, 128]);
await addAdj('Levels'); await page.waitForSelector('.adjust-panel');
await levels('rgb', { gamma: 2 });
assert.deepEqual(await view(), [181, 181, 181]); ok('Levels adjustment layer: live preview through the compositor');
assert.deepEqual((await base0(10, 10)).slice(0, 3), [128, 128, 128]);
await page.click('.adjust-panel button.primary'); await wait();
assert.deepEqual(await view(), [181, 181, 181]); assert.equal((await adjOf()).P.rgb.gamma, 2);
assert.equal(await page.evaluate(() => window.__app.doc.history.undoLabel), 'Edit Adjustment'); ok('OK commits parameters as one "Edit Adjustment" step');
await page.dblclick('.layer.active .adjicon'); await page.waitForSelector('.adjust-panel');
assert.equal(await page.evaluate(() => document.querySelector('.adjust-body').__levels.P.rgb.gamma), 2); ok('double-click re-opens the dialog with the saved settings');
await levels('rgb', { gamma: 0.5 }); assert.ok((await view())[0] < 100);
await page.keyboard.press('Escape'); await wait();
assert.deepEqual(await view(), [181, 181, 181]); assert.equal((await adjOf()).P.rgb.gamma, 2); ok('Cancel on re-edit keeps the previous parameters');
await page.keyboard.press('Control+z'); await wait();
assert.deepEqual(await view(), [128, 128, 128]); assert.equal((await adjOf()).P.rgb.gamma, 1); ok('undo reverts the adjustment edit');

// fresh layer + Cancel removes it
await newGray();
await addAdj('Curves'); await page.waitForSelector('.curvecanvas');
assert.equal(await nLayers(), 2);
await page.keyboard.press('Escape'); await wait();
assert.equal(await nLayers(), 1); ok('cancelling a brand-new adjustment layer removes it');

// curves adjustment through the dialog
await newGray();
await addAdj('Curves'); await page.waitForSelector('.curvecanvas');
await curves('rgb', [{ x: 0, y: 0 }, { x: 128, y: 200 }, { x: 255, y: 255 }]);
assert.ok(Math.abs((await view())[0] - 200) <= 2); await page.keyboard.press('Enter'); await wait(); ok('Curves adjustment layer');

// opacity of the adjustment layer scales the effect
await newGray([100, 100, 100]);
await addAdj('Invert'); await wait();
await page.evaluate(() => { const d = window.__app.doc; d.setProp(d.active, 'opacity', 0.5); });
const half = await view(); assert.ok(Math.abs(half[0] - 127.5) <= 1.5, `got ${half}`); ok('adjustment layer opacity blends original and adjusted');
await page.evaluate(() => { const d = window.__app.doc; d.setProp(d.active, 'opacity', 1); });

// mask on the adjustment layer limits it; painting targets the mask, not pixels
await page.evaluate(() => { const d = window.__app.doc; d.setSelection({ x: 0, y: 0, w: 200, h: 300 }); window.__app.setFg('#000000'); });
await page.keyboard.press('Alt+Backspace'); await wait();
await page.evaluate(() => window.__app.doc.setSelection(null));
assert.deepEqual(await view(50, 50), [100, 100, 100]); assert.deepEqual(await view(300, 50), [155, 155, 155]); ok('black on the adjustment mask hides the effect there');
await page.evaluate(() => { const a = window.__app; a.setFg('#ffffff'); a.brush.size = 40; a.brush.hardness = 1; a.brush.opacity = 1; a.setTool('brush'); });
await drag([30, 150], [170, 150]); await wait();
assert.deepEqual(await view(100, 150), [155, 155, 155]); ok('painting white on the mask re-applies the effect');
const blank = await page.evaluate(() => { const l = window.__app.doc.active; const d = l.canvas.getContext('2d').getImageData(0, 0, 400, 300).data; let n = 0; for (let i = 3; i < d.length; i += 4) n += d[i]; return n; });
assert.equal(blank, 0); ok('brushing on an adjustment layer never paints pixels');
await page.evaluate(() => window.__app.setTool('move'));

// duplicate keeps the adjustment; merge down applies it to the layer beneath only
await page.evaluate(() => window.__app.doc.duplicateLayer());
assert.equal((await adjOf()).type, 'invert'); ok('duplicate adjustment layer keeps its adjustment');
await page.evaluate(() => window.__app.doc.removeLayer());
await page.evaluate(() => window.__app.doc.mergeDown()); await wait();
assert.equal(await nLayers(), 1); assert.deepEqual((await base0(300, 50)).slice(0, 3), [155, 155, 155]); assert.deepEqual((await base0(50, 50)).slice(0, 3), [100, 100, 100]); ok('merge down bakes the adjustment (through its mask) into the layer below');
await page.keyboard.press('Control+z'); await wait();
assert.equal(await nLayers(), 2); assert.deepEqual((await base0(300, 50)).slice(0, 3), [100, 100, 100]); ok('undo merge restores the adjustment layer');

// cannot merge into an adjustment layer; flatten includes adjustments and is undoable
await page.evaluate(() => window.__app.doc.addLayer('Top'));
await page.evaluate(() => { const d = window.__app.doc; d.mergeDown(d.layers[2]); });
assert.equal(await nLayers(), 3); ok('merging a layer into an adjustment layer is refused');
await page.evaluate(() => window.__app.doc.flatten()); await wait();
assert.equal(await nLayers(), 1); assert.deepEqual((await base0(300, 50)).slice(0, 3), [155, 155, 155]); ok('flatten renders adjustment layers into the result');
await page.keyboard.press('Control+z'); await wait();
assert.equal(await nLayers(), 3); assert.ok(await page.evaluate(() => window.__app.doc.layers.some((l) => l.adjustment))); ok('undo flatten restores all layers');

// brightness / hue adjustment layers (CSS-filter based)
await newGray([100, 100, 100]);
await addAdj('Brightness'); await page.waitForSelector('.adjust-panel');
await page.evaluate(() => document.querySelector('.adjust-body').__sliders.set('b', 50));
assert.ok((await view())[0] > 140); ok('Brightness/Contrast adjustment layer brightens');
await page.keyboard.press('Enter'); await wait();
await newGray([200, 60, 60]);
await addAdj('Hue'); await page.waitForSelector('.adjust-panel');
await page.evaluate(() => document.querySelector('.adjust-body').__sliders.set('h', 120));
const hu = await view(); assert.ok(hu[1] > hu[0], `got ${hu}`); ok('Hue/Saturation adjustment layer rotates red toward green');
await page.keyboard.press('Enter'); await wait();

// PSD round trip keeps editable adjustment layers
await newGray([90, 120, 200]);
await page.evaluate(() => {
  const d = window.__app.doc, A = (t, name, patch) => { const l = d.addAdjustmentLayer(window.__defaultAdj(t), name); patch(l.adjustment); return l; };
  A('levels', 'Lv', (a) => { a.P.rgb = { ib: 10, gamma: 1.6, iw: 240, ob: 5, ow: 250 }; a.P.b = { ib: 0, gamma: 0.8, iw: 255, ob: 0, ow: 255 }; });
  const c = A('curves', 'Cv', (a) => { a.P.rgb = [{ x: 0, y: 0 }, { x: 90, y: 140 }, { x: 255, y: 255 }]; }); c.opacity = 0.6;
  A('invert', 'Inv', () => {}); A('hue', 'Hu', (a) => { a.h = 40; a.s = -20; }); A('brightness', 'Br', (a) => { a.b = 30; a.c = 20; });
});
const rt = await page.evaluate(() => window.__adjRoundtrip());
const by = Object.fromEntries(rt.layers.map((l) => [l.name, l]));
assert.deepEqual(by.Lv.adj.P.rgb, { ib: 10, gamma: 1.6, iw: 240, ob: 5, ow: 250 }); assert.equal(by.Lv.adj.P.b.gamma, 0.8); ok('PSD round-trip: Levels adjustment layer keeps its parameters');
assert.deepEqual(by.Cv.adj.P.rgb, [{ x: 0, y: 0 }, { x: 90, y: 140 }, { x: 255, y: 255 }]); assert.ok(Math.abs(by.Cv.opacity - 0.6) < 0.01); ok('PSD round-trip: Curves adjustment layer keeps points and opacity');
assert.equal(by.Inv.adj.type, 'invert'); assert.deepEqual([by.Hu.adj.h, by.Hu.adj.s], [40, -20]); assert.deepEqual([by.Br.adj.b, by.Br.adj.c], [30, 20]); ok('PSD round-trip: Invert, Hue/Saturation and Brightness/Contrast');
assert.ok(by.Lv.hasMask); assert.equal(rt.notes.length, 0); ok('PSD round-trip: adjustment layers keep a mask and import without warnings');


// 6e2. per-pixel adjustment layers (Posterize, Threshold, Exposure, Vibrance, B&W, Photo Filter, Color Balance, Channel Mixer, Gradient Map)
const pset = (k, v) => page.evaluate(([k, v]) => document.querySelector('.adjust-body').__params.set(k, v), [k, v]);
await newGray([100, 150, 200]);
await addAdj('Posterize'); await page.waitForSelector('.adjust-panel');
await pset('levels', 2);
assert.deepEqual(await view(), [0, 255, 255]); ok('Posterize adjustment layer (2 levels) snaps channels live');
await page.keyboard.press('Enter'); await wait();
assert.equal((await adjOf()).levels, 2); ok('Posterize dialog OK stores its parameters on the layer');
await page.keyboard.press('Control+z'); await wait();
assert.equal((await adjOf()).levels, 4); await page.keyboard.press('Control+z'); await wait();
assert.equal(await nLayers(), 1); ok('undo steps back through the Posterize edit, then the layer creation');

await newGray([100, 150, 200]);
await addAdj('Threshold'); await page.waitForSelector('.adjust-panel');
await pset('level', 140);
assert.deepEqual(await view(), [255, 255, 255]); ok('Threshold adjustment layer (luminance 140 ≥ 140)');
await pset('level', 200);
assert.deepEqual(await view(), [0, 0, 0]); ok('Threshold dialog preview updates as the slider moves');
await page.keyboard.press('Escape'); await wait();
assert.equal(await nLayers(), 1); ok('Cancel on a fresh adjustment layer removes it again');

await newGray([200, 100, 50]);
await addAdj('Channel Mixer'); await page.waitForSelector('.adjust-panel');
await pset('mono', true);
await pset('rows.0.0', 0); await pset('rows.0.1', 100); await pset('rows.0.2', 0);
assert.deepEqual(await view(), [100, 100, 100]); ok('Channel Mixer monochrome with 100% green gives the green channel as grey');
await page.keyboard.press('Enter'); await wait();
// at partial opacity and through a mask the adjusted result blends with what is below
await page.evaluate(() => { window.__app.doc.active.opacity = 0.5; window.__app.doc.emit('structure'); });
const adjHalf = await view(); assert.ok(Math.abs(adjHalf[0] - 150) <= 2 && Math.abs(adjHalf[1] - 100) <= 2, `got ${adjHalf}`); ok('per-pixel adjustment layers honour layer opacity');

await newGray([30, 30, 30]);
await addAdj('Gradient Map'); await page.waitForSelector('.adjust-panel');
await page.evaluate(() => { const g = document.querySelector('.adjust-body').__params.get(); g.stops = [{ x: 0, c: [255, 0, 0], a: 1 }, { x: 1, c: [0, 0, 255], a: 1 }]; document.querySelector('.adjust-body').__params.set('stops', null); });
const gm = await view(); assert.ok(gm[0] > gm[2] && gm[0] > 150, `got ${gm}`); ok('Gradient Map maps dark pixels to the first stop');
await pset('reverse', true);
const gm2 = await view(); assert.ok(gm2[2] > gm2[0], `got ${gm2}`); ok('Gradient Map reverse flips the ramp');
await page.keyboard.press('Enter'); await wait();

await newGray([200, 60, 60]);
await addAdj('Selective Color'); await page.waitForSelector('.adjust-body select');
await page.evaluate(() => document.querySelector('.adjust-body').__params.set('r.0.2', -100));
const sc0 = await view(); assert.ok(sc0[2] > 100 && sc0[0] === 200, `got ${sc0}`); ok('Selective Color: removing yellow from Reds lifts the blue of a red pixel');
await page.evaluate(() => document.querySelector('.adjust-body').__params.set('range', 4));
assert.equal(await page.evaluate(() => document.querySelector('.adjust-body select').value), '4'); ok('Selective Color dialog switches colour range');
await page.keyboard.press('Enter'); await wait();

await newGray([200, 60, 60]);
await addAdj('Color Lookup'); await page.waitForSelector('.adjust-body input[type=file]');
const cubeInv = 'TITLE "Inv"\nLUT_3D_SIZE 2\n' + [0, 1].flatMap((b) => [0, 1].flatMap((g) => [0, 1].map((r) => `${1 - r} ${1 - g} ${1 - b}`))).join('\n') + '\n';
await page.evaluate((t) => document.querySelector('.adjust-body').__params.set('cube', t), cubeInv);
const lk = await view(); assert.ok(Math.abs(lk[0] - 55) <= 2 && Math.abs(lk[1] - 195) <= 2, `got ${lk}`); ok('Color Lookup applies a loaded .cube 3D LUT');
await page.keyboard.press('Enter'); await wait();
const rt3 = await page.evaluate(() => window.__adjRoundtrip());
const lkl = rt3.layers.find((l) => l.adj?.type === 'lookup'); assert.ok(lkl && lkl.adj.size === 2 && lkl.adj.name === 'Inv'); ok('PSD round-trip: Color Lookup keeps its 3D LUT');

// PSD round trip keeps the new types
await newGray([90, 120, 200]);
await page.evaluate(() => {
  const d = window.__app.doc, A = (t, name, patch) => { const l = d.addAdjustmentLayer(window.__defaultAdj(t), name); patch(l.adjustment); return l; };
  A('exposure', 'Ex', (a) => { a.exposure = 1.2; a.gamma = 0.9; }); A('vibrance', 'Vb', (a) => { a.vibrance = 35; });
  A('balance', 'Cb', (a) => { a.mids = [10, -20, 30]; }); A('photo', 'Pf', (a) => { a.color = [20, 120, 220]; a.density = 33; });
  A('gradmap', 'Gm', (a) => { a.stops = [{ x: 0, c: [0, 0, 10], a: 1 }, { x: 1, c: [250, 200, 0], a: 1 }]; });
});
const rt2 = await page.evaluate(() => window.__adjRoundtrip());
const by2 = Object.fromEntries(rt2.layers.map((l) => [l.name, l]));
assert.ok(Math.abs(by2.Ex.adj.exposure - 1.2) < 1e-4); assert.equal(by2.Vb.adj.vibrance, 35); assert.deepEqual(by2.Cb.adj.mids, [10, -20, 30]);
assert.equal(by2.Pf.adj.density, 33); assert.deepEqual(by2.Gm.adj.stops.map((q) => q.c), [[0, 0, 10], [250, 200, 0]]);
assert.equal(rt2.notes.length, 0); ok('PSD round-trip: Exposure, Vibrance, Color Balance, Photo Filter and Gradient Map keep their parameters');

// 6f. clone stamp
const cl = async (fn) => page.evaluate(fn);
const CS = { x: 40, y: 40 };  // red square 50..100 / 50..100 on a white layer
const setupClone = async () => {
  await page.evaluate(() => {
    window.__blank(400, 300); const a = window.__app, d = a.doc, x = d.active.ctx;
    x.fillStyle = '#fff'; x.fillRect(0, 0, 400, 300); x.fillStyle = '#e02020'; x.fillRect(50, 50, 50, 50);
    // a distinctive 2-colour source so offsets can be verified exactly
    x.fillStyle = '#2040e0'; x.fillRect(75, 50, 25, 50); d.emit('structure');
    a.brush.size = 40; a.brush.hardness = 1; a.brush.opacity = 1; a.brush.flow = 1; a.brush.spacing = 0.1;
    a.clone.aligned = true; a.clone.sample = 'layer'; a.clone.src = null; a.clone.offset = null; a.setTool('clone');
  });
  await wait();
};
const L = (x, y) => page.evaluate(([x, y]) => [...window.__app.doc.active.ctx.getImageData(x, y, 1, 1).data], [x, y]);
const altClick = async (x, y) => { const q = await toScreen(x, y); await page.keyboard.down('Alt'); await page.mouse.click(q.x, q.y); await page.keyboard.up('Alt'); await wait(); };

await setupClone();
// painting without a source does nothing and warns
await drag([250, 150], [280, 150]); await wait();
assert.deepEqual((await L(265, 150)).slice(0, 4), [255, 255, 255, 255]); ok('clone stamp without a source paints nothing');
assert.match(await page.evaluate(() => document.getElementById('toast').textContent), /Alt\+click/); ok('…and tells you to Alt+click a source');

// set source at (60,75) (red part), paint at (260,175) => offset (-200,-100)
await altClick(60, 75);
assert.deepEqual(await page.evaluate(() => window.__app.clone.src), { x: 60, y: 75 }); ok('Alt+click sets the clone source');
assert.equal(await page.evaluate(() => window.__app.doc.history.undoLabel === 'Clone Stamp'), false); ok('setting the source does not create a history step');
await drag([260, 175], [300, 175]); await wait();
// dest (260,175) <- source (60,75) red ; dest (290,175) <- source (90,75) blue
assert.deepEqual((await L(260, 175)).slice(0, 3), [224, 32, 32]); ok('clone copies source pixels to the painted position (red)');
assert.deepEqual((await L(290, 175)).slice(0, 3), [32, 64, 224]); ok('the source→destination offset is preserved along the stroke (blue)');
assert.deepEqual((await L(260, 215)).slice(0, 4), [255, 255, 255, 255]); ok('pixels outside the brush are untouched');
assert.deepEqual((await L(60, 75)).slice(0, 3), [224, 32, 32]); ok('the source area itself is unchanged');
assert.equal(await page.evaluate(() => window.__app.doc.history.undoLabel), 'Clone Stamp'); ok('stroke is one "Clone Stamp" history step');
await page.keyboard.press('Control+z'); await wait();
assert.deepEqual((await L(260, 175)).slice(0, 4), [255, 255, 255, 255]); ok('undo removes the cloned stroke');

// aligned vs non-aligned: second stroke 60px lower
await page.keyboard.press('Control+Shift+z'); await wait();
await drag([260, 235], [262, 235]); await wait();         // aligned: source = (60,135) => white
assert.deepEqual((await L(260, 235)).slice(0, 4), [255, 255, 255, 255]); ok('aligned: the offset carries over to the next stroke');
await page.evaluate(() => { window.__app.clone.aligned = false; });
await drag([260, 235], [262, 235]); await wait();         // non-aligned: restarts from source (60,75) => red
assert.deepEqual((await L(260, 235)).slice(0, 3), [224, 32, 32]); ok('non-aligned: every stroke restarts from the source point');

// soft brush feathers the clone edge
await setupClone();
await altClick(60, 75);
await page.evaluate(() => { window.__app.brush.hardness = 0; });
await drag([260, 175], [261, 175]); await wait();
const edge = await L(260, 175 + 17), mid = await L(260, 175);
assert.ok(mid[0] >= 215 && mid[1] <= 60, `mid ${mid}`); assert.ok(edge[1] > 70 && edge[1] < 235, `edge colour ${edge}`); ok('soft brush gives a feathered clone edge');

// sample all layers: clone from the layer below onto a new empty layer
await setupClone();
await page.evaluate(() => window.__app.doc.addLayer('Clone target'));
await altClick(60, 75);
await drag([260, 175], [262, 175]); await wait();
assert.equal((await L(260, 175))[3], 0); ok('Sample: Current layer on an empty layer clones nothing');
await page.evaluate(() => { window.__app.clone.sample = 'all'; });
await drag([260, 175], [262, 175]); await wait();
assert.deepEqual((await L(260, 175)).slice(0, 3), [224, 32, 32]); ok('Sample: All layers clones the visible image onto the active layer');
assert.deepEqual(await page.evaluate(() => [...window.__app.doc.layers[0].ctx.getImageData(260, 175, 1, 1).data]), [255, 255, 255, 255]); ok('…without touching the layer it was sampled from');

// respects an irregular selection
await setupClone();
await altClick(60, 75);
await page.evaluate(() => { const m = document.createElement('canvas'); m.width = 400; m.height = 300; const x = m.getContext('2d'); x.beginPath(); x.arc(270, 175, 15, 0, 7); x.fill(); window.__app.doc.setSelection({ x: 255, y: 160, w: 30, h: 30 }, m); });
await drag([240, 175], [300, 175]); await wait();
assert.deepEqual((await L(270, 175)).slice(0, 3), [32, 64, 224]); assert.deepEqual((await L(250, 175)).slice(0, 3), [255, 255, 255]); ok('clone stamp is limited to the selection');

// clone on a layer mask uses the mask's own pixels
await setupClone();
await page.evaluate(() => { const d = window.__app.doc; d.addMask('reveal'); const m = d.active.mask.getContext('2d'); m.fillStyle = '#000'; m.fillRect(50, 50, 50, 50); d.active.touchMask(); });
await altClick(60, 75);
await drag([260, 175], [262, 175]); await wait();
const mm = await page.evaluate(() => window.__app.doc.active.mask.getContext('2d').getImageData(260, 175, 1, 1).data[0]);
assert.equal(mm, 0); ok('clone stamp on a mask copies mask values (black patch)');
await page.evaluate(() => window.__app.setTool('move'));


// 6g. healing brush + spot healing
const healScene = async (bg, tool) => {
  await page.evaluate(([bg, tool]) => {
    window.__blank(400, 300); const a = window.__app, d = a.doc, x = d.active.ctx;
    x.fillStyle = bg; x.fillRect(0, 0, 400, 300);
    a.brush.size = 60; a.brush.hardness = 0.6; a.brush.opacity = 1; a.brush.flow = 1; a.brush.spacing = 0.1;
    a.clone.aligned = true; a.clone.sample = 'layer'; a.clone.src = null; a.clone.offset = null; a.setTool(tool);
  }, [bg, tool]);
  await wait();
};
const lcol = (x, y) => page.evaluate(([x, y]) => [...window.__app.doc.active.ctx.getImageData(x, y, 1, 1).data], [x, y]);
const dot = (x, y, r, col) => page.evaluate(([x, y, r, col]) => { const d = window.__app.doc, c = d.active.ctx; c.fillStyle = col; c.beginPath(); c.arc(x, y, r, 0, 7); c.fill(); d.emit('structure'); }, [x, y, r, col]);

// texture is kept, brightness comes from the destination
await healScene('#646464', 'heal');
await page.evaluate(() => { const d = window.__app.doc, c = d.active.ctx; for (let y = 50; y < 150; y++) { c.fillStyle = y % 2 ? '#dcdcdc' : '#b4b4b4'; c.fillRect(50, y, 100, 1); } d.emit('structure'); });
await altClick(100, 100);
await drag([300, 200], [301, 200]); await wait();
const col = []; for (let y = 194; y < 206; y++) col.push((await lcol(300, y))[0]);
const hmean = col.reduce((a, b) => a + b) / col.length, hspread = Math.max(...col) - Math.min(...col);
assert.ok(Math.abs(hmean - 100) < 15, `mean ${hmean}`); ok(`healing brush matches the destination brightness (mean ${hmean.toFixed(0)}, source was ~200)`);
assert.ok(hspread >= 25, `spread ${hspread}`); ok(`…while keeping the source texture (stripe contrast ${hspread})`);
assert.equal(await page.evaluate(() => window.__app.doc.history.undoLabel), 'Healing Brush'); ok('one "Healing Brush" history step');
// seamless edge: just inside vs just outside the patch should be close
const inside = (await lcol(300 + 26, 200))[0], outside = (await lcol(300 + 36, 200))[0];
assert.ok(Math.abs(inside - outside) < 22, `edge ${inside} vs ${outside}`); ok('no visible seam at the edge of the patch');
await page.keyboard.press('Control+z'); await wait();
assert.deepEqual((await lcol(300, 200)).slice(0, 3), [100, 100, 100]); ok('undo removes the healed patch');

// blemish removal: no ghost of the destination interior
await healScene('#786e64', 'heal');
await dot(300, 200, 9, '#0a0a0a');
assert.ok((await lcol(300, 200))[0] < 20);
await altClick(100, 100);
await drag([300, 200], [301, 200]); await wait();
const bl = await lcol(300, 200);
assert.ok(Math.abs(bl[0] - 120) <= 5 && Math.abs(bl[1] - 110) <= 5 && Math.abs(bl[2] - 100) <= 5, `got ${bl}`); ok('healing brush removes a dark blemish completely (no ghost)');

// heals relative to what you see: new empty layer, sample all layers
await healScene('#3232c8', 'heal');
await page.evaluate(() => { const d = window.__app.doc, c = d.active.ctx; for (let y = 50; y < 150; y++) { c.fillStyle = y % 2 ? '#e63c3c' : '#c82828'; c.fillRect(50, y, 100, 1); } d.emit('structure'); d.addLayer('Heal layer'); window.__app.clone.sample = 'all'; });
await altClick(100, 100);
await drag([300, 200], [301, 200]); await wait();
const hl2 = await lcol(300, 200);
assert.equal(hl2[3], 255); assert.ok(hl2[2] > 150 && hl2[0] < 90, `got ${hl2}`); ok('Sample: All layers heals onto an empty layer using the visible colours around it');

// spot healing: no source needed, picks a matching area by itself
await healScene('#646464', 'spot');
await page.evaluate(() => { const d = window.__app.doc, c = d.active.ctx; c.fillStyle = '#f0f0f0'; c.fillRect(280, 0, 120, 300); d.emit('structure'); });
await dot(150, 150, 9, '#101010');
await drag([150, 150], [151, 150]);
await page.waitForTimeout(120);
const spotPx = await lcol(150, 150);
assert.ok(Math.abs(spotPx[0] - 100) <= 6, `got ${spotPx}`); ok('spot healing removes a blemish with no source set');
assert.equal(await page.evaluate(() => window.__app.doc.history.undoLabel), 'Spot Healing'); ok('one "Spot Healing" history step');
assert.ok(Math.abs((await lcol(120, 150))[0] - 100) <= 3 && (await lcol(200, 150))[0] <= 106); ok('…and did not pull in the bright strip nearby (matched the grey surroundings)');
await page.keyboard.press('Control+z'); await wait();
assert.ok((await lcol(150, 150))[0] < 30); ok('undo restores the blemish');

// spot healing with nowhere to sample from degrades gracefully
await page.evaluate(() => { window.__blank(60, 60); const a = window.__app, d = a.doc, c = d.active.ctx; c.fillStyle = '#888'; c.fillRect(0, 0, 60, 60); c.fillStyle = '#111'; c.beginPath(); c.arc(30, 30, 6, 0, 7); c.fill(); d.emit('structure'); a.brush.size = 50; a.clone.sample = 'layer'; a.setTool('spot'); });
await wait();
const hbefore = await page.evaluate(() => window.__app.doc.history.undoLabel);
await drag([30, 30], [31, 30]); await wait();
assert.match(await page.evaluate(() => document.getElementById('toast').textContent), /no clean area/i); assert.equal(await page.evaluate(() => window.__app.doc.history.undoLabel), hbefore); ok('spot healing with no usable area warns and changes nothing');
await page.evaluate(() => window.__app.setTool('move'));


// 6h. layer groups
const G = {
  sig: () => page.evaluate(() => window.__app.doc.signature()),
  bad: () => page.evaluate(() => window.__app.doc.validate()),
  byName: (n) => `window.__app.doc.layers.find((l) => l.name === ${JSON.stringify(n)})`,
};
const gx = (expr) => page.evaluate(`(() => { const d = window.__app.doc; ${expr} })()`);
const cpx = async (x, y) => { await page.waitForTimeout(160); return (await px(x, y)).slice(0, 3); };
const near = (a, b, tol = 2) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const rows = () => page.locator('#layerlist .layer').count();

await page.evaluate(() => {
  window.__blank(400, 300); const a = window.__app, d = a.doc;
  d.layers[0].name = 'Base';
  const A = d.addLayer('A'); A.ctx.fillStyle = '#e02020'; A.ctx.fillRect(50, 50, 100, 100);
  const B = d.addLayer('B'); B.ctx.fillStyle = '#2040e0'; B.ctx.fillRect(100, 100, 100, 100);
  d.emit('structure'); a.setTool('move');
});
await wait();
assert.equal(await G.sig(), 'Base,A,B'); assert.equal(await rows(), 3);

// group via the panel: click A, Ctrl+click B, Ctrl+G
const idOf = (n) => gx(`return ${G.byName(n)}.id`);
await page.click(`#layerlist .layer[data-layer="${await idOf('A')}"] .name`);
await page.click(`#layerlist .layer[data-layer="${await idOf('B')}"] .name`, { modifiers: ['Control'] });
await page.keyboard.press('Control+g'); await wait();
assert.equal(await G.sig(), 'Base,[Group 1:A,B]'); assert.deepEqual(await G.bad(), []); ok('Ctrl+click two layers then Ctrl+G groups them');
assert.equal(await page.locator('#layerlist .layer.isgroup').count(), 1); assert.equal(await rows(), 4); ok('the panel shows the group with its indented children');
assert.ok(near(await cpx(60, 60), [224, 32, 32]) && near(await cpx(120, 120), [32, 64, 224]) && near(await cpx(300, 250), [255, 255, 255])); ok('a new Pass Through group does not change the image');
assert.equal(await gx(`return d.active.blend`), 'pass through'); ok('groups default to Pass Through');

// group opacity composites the group as a unit (A hidden under B stays hidden)
await gx(`d.setProp(d.active, 'opacity', 0.5)`);
assert.ok(near(await cpx(60, 60), [239, 143, 143], 3)); assert.ok(near(await cpx(120, 120), [143, 159, 239], 3)); ok('group opacity applies to the flattened group (overlap shows B only, not A through B)');
await gx(`d.setProp(d.active, 'opacity', 1)`);
await gx(`d.setProp(d.active, 'visible', false)`);
assert.ok(near(await cpx(60, 60), [255, 255, 255]) && near(await cpx(120, 120), [255, 255, 255])); ok('hiding a group hides everything inside');
await gx(`d.setProp(d.active, 'visible', true)`);

// group blend mode (multiply over mid-gray base)
await gx(`const b = d.layers[0]; b.ctx.fillStyle = '#808080'; b.ctx.fillRect(0, 0, 400, 300); d.emit('structure')`);
await gx(`d.setProp(d.active, 'blend', 'multiply')`);
assert.ok(near(await cpx(60, 60), [112, 16, 16], 3)); ok('group blend mode (Multiply) is applied to the group as a whole');
await gx(`d.setProp(d.active, 'blend', 'pass through')`);

// group mask
await gx(`d.addMask('reveal'); const m = d.active.mask.getContext('2d'); m.fillStyle = '#000'; m.fillRect(0, 0, 100, 300); d.active.touchMask(); d.emit('structure')`);
assert.ok(near(await cpx(60, 60), [128, 128, 128]) && near(await cpx(120, 120), [32, 64, 224])); ok('a group mask hides the whole group where it is black');
// paint on the group mask with the brush
await page.evaluate(() => { const a = window.__app; a.setFg('#000000'); a.brush.size = 30; a.brush.hardness = 1; a.brush.opacity = 1; a.brush.flow = 1; a.setTool('brush'); });
assert.equal(await gx(`return d.active.maskMode`), true);
await drag([110, 120], [130, 120]); await wait();
assert.ok(near(await cpx(120, 120), [128, 128, 128])); ok('brushing on a selected group paints its mask');
await page.keyboard.press('Control+z'); await wait();
await gx(`d.deleteMask()`); await wait();
assert.equal(await gx(`return !!d.active.mask`), false);

// a group without a mask cannot be painted on
await gx(`d.newGroup(); return 1`);
const baseBefore = await gx(`return Array.from(d.layers[0].ctx.getImageData(10,10,1,1).data)`);
await drag([200, 200], [260, 200]); await wait();
assert.match(await page.evaluate(() => document.getElementById('toast').textContent), /group/i); assert.deepEqual(await gx(`return Array.from(d.layers[0].ctx.getImageData(10,10,1,1).data)`), baseBefore); ok('painting on a group with no mask is refused with a hint');
await page.keyboard.press('Control+z'); await wait();                        // undo New Group
assert.equal(await G.sig(), 'Base,[Group 1:A,B]');

// adjustment inside a group: Pass Through affects everything below, an isolated (Normal) group only its own content
await gx(`const c = d.addLayer('C'); c.parent = null; c.ctx.fillStyle = '#20c040'; c.ctx.fillRect(250, 50, 100, 100); d.emit('structure')`);
await gx(`d.select(${G.byName('C')}); d.addAdjustmentLayer(window.__defaultAdj('invert'), 'Inv'); d.groupLayers([${G.byName('C')}, ${G.byName('Inv')}]); return 1`);
assert.equal(await G.sig(), 'Base,[Group 1:A,B],[Group 2:C,Inv]'); assert.deepEqual(await G.bad(), []);
assert.ok(near(await cpx(10, 250), [127, 127, 127])); assert.ok(near(await cpx(300, 100), [223, 63, 191])); ok('an adjustment in a Pass Through group affects layers outside the group');
await gx(`d.setProp(d.active, 'blend', 'normal')`);
assert.ok(near(await cpx(10, 250), [128, 128, 128])); assert.ok(near(await cpx(300, 100), [223, 63, 191])); ok('…but only the group\'s own contents once the group is isolated (Normal)');
await gx(`d.setProp(d.active, 'blend', 'pass through')`);
await gx(`d.removeLayer(d.active); return 1`); await wait();
assert.equal(await G.sig(), 'Base,[Group 1:A,B]');

// drag & drop in the panel: drop a layer onto a group's middle -> moves inside
await gx(`const e = d.addLayer('E'); e.ctx.fillStyle = '#ffd000'; e.ctx.fillRect(300, 200, 60, 60); d.emit('structure'); return 1`);
assert.equal(await G.sig(), 'Base,[Group 1:A,B],E');
await page.locator(`#layerlist .layer[data-layer="${await idOf('E')}"]`).dragTo(page.locator(`#layerlist .layer.isgroup`), { targetPosition: { x: 120, y: 18 } });
await wait();
assert.equal(await G.sig(), 'Base,[Group 1:A,B,E]'); assert.deepEqual(await G.bad(), []); ok('dragging a layer onto a group in the panel moves it inside');
await page.locator(`#layerlist .layer[data-layer="${await idOf('E')}"]`).dragTo(page.locator(`#layerlist .layer[data-layer="${await idOf('Base')}"]`), { targetPosition: { x: 120, y: 30 } });
await wait();
assert.equal(await G.sig(), 'E,Base,[Group 1:A,B]'); ok('dragging below the bottom layer reorders to the bottom (and out of the group)');
await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z'); await wait();
assert.equal(await G.sig(), 'Base,[Group 1:A,B],E'); ok('undo reverses both panel moves');
await gx(`d.moveNode(${G.byName('E')}, ${G.byName('Group 1')}, 'inside')`); await wait();
// a group cannot be moved into itself
assert.equal(await gx(`return d.moveNode(${G.byName('Group 1')}, ${G.byName('A')}, 'above')`), false); ok('moving a group into its own contents is refused');

// collapse / expand
await page.locator('#layerlist .layer.isgroup .arrow').click(); await wait();
assert.equal(await rows(), 2); await page.locator('#layerlist .layer.isgroup .arrow').click(); await wait(); assert.equal(await rows(), 5); ok('collapse arrow hides and shows a group\'s rows');

// new layers land inside the active layer's group
await gx(`d.select(${G.byName('A')}); const n = d.addLayer('N'); return n.parent && n.parent.name`).then((p) => assert.equal(p, 'Group 1')); ok('a new layer is created inside the active layer\'s group');
await gx(`d.removeLayer(${G.byName('N')}); return 1`);

// move tool on a group moves everything inside
await gx(`d.select(${G.byName('Group 1')}); return 1`);
await page.evaluate(() => window.__app.setTool('move'));
const mb = await gx(`return [Array.from(${G.byName('A')}.ctx.getImageData(60,60,1,1).data), Array.from(${G.byName('B')}.ctx.getImageData(110,110,1,1).data)]`);
await drag([75, 75], [135, 105]); await wait();
const ma = await gx(`return [Array.from(${G.byName('A')}.ctx.getImageData(120,90,1,1).data), Array.from(${G.byName('B')}.ctx.getImageData(170,140,1,1).data), Array.from(${G.byName('A')}.ctx.getImageData(60,60,1,1).data)]`);
assert.deepEqual(ma[0].slice(0, 3), mb[0].slice(0, 3)); assert.deepEqual(ma[1].slice(0, 3), mb[1].slice(0, 3)); assert.equal(ma[2][3], 0); ok('the Move tool on a group moves every layer inside it');
await page.keyboard.press('Control+z'); await wait();
assert.deepEqual(await gx(`return Array.from(${G.byName('A')}.ctx.getImageData(60,60,1,1).data).slice(0,3)`), mb[0].slice(0, 3)); ok('undo moves the group contents back');

// duplicate / merge / ungroup / delete — with undo
const before = await cpx(120, 120);
await gx(`d.select(${G.byName('Group 1')}); d.duplicateLayer(); return 1`);
assert.equal(await G.sig(), 'Base,[Group 1:A,B,E],[Group 1 copy:A,B,E]'); assert.deepEqual(await G.bad(), []); ok('duplicating a group copies its whole contents');
await page.keyboard.press('Control+z'); await wait();
await gx(`d.select(${G.byName('Group 1')}); d.mergeGroup(); return 1`); await wait();
assert.equal(await G.sig(), 'Base,Group 1'); assert.deepEqual(near(await cpx(120, 120), before, 2), true); ok('Merge Group flattens it into one layer without changing the image');
await page.keyboard.press('Control+z'); await wait();
assert.equal(await G.sig(), 'Base,[Group 1:A,B,E]'); ok('undo Merge Group restores the group');
await page.keyboard.press('Control+Shift+g'); await wait();
assert.equal(await G.sig(), 'Base,A,B,E'); assert.deepEqual(await G.bad(), []); ok('Ctrl+Shift+G ungroups');
await page.keyboard.press('Control+z'); await wait();
await gx(`d.removeLayer(${G.byName('Group 1')}); return 1`); await wait();
assert.equal(await G.sig(), 'Base'); ok('deleting a group deletes its contents');
await page.keyboard.press('Control+z'); await wait();
assert.equal(await G.sig(), 'Base,[Group 1:A,B,E]'); assert.deepEqual(await G.bad(), []); ok('undo delete group brings the group and its layers back');
assert.equal(await gx(`d.removeLayer(d.layers[0]); const n = d.leafCount; return n`) >= 1, true);
await page.keyboard.press('Control+z'); await wait();

// flatten renders groups
await gx(`d.flatten(); return 1`); await wait();
assert.equal(await G.sig(), 'Background'); assert.ok(near(await cpx(120, 120), before, 2)); ok('Flatten Image renders groups into one layer');
await page.keyboard.press('Control+z'); await wait();
assert.equal(await G.sig(), 'Base,[Group 1:A,B,E]'); ok('undo flatten restores the groups');

// PSD round-trip with nested groups, masks, blend modes, hidden and collapsed state
await page.evaluate(() => {
  window.__blank(400, 300); const a = window.__app, d = a.doc;
  d.layers[0].name = 'Base'; d.layers[0].ctx.fillStyle = '#c8c8c8'; d.layers[0].ctx.fillRect(0, 0, 400, 300);
  const mk = (n, col, x, y) => { const l = d.addLayer(n); l.ctx.fillStyle = col; l.ctx.fillRect(x, y, 90, 90); return l; };
  const X = mk('X', '#e02020', 30, 30), Y = mk('Y', '#2040e0', 90, 90), Z = mk('Z', '#20c040', 250, 40);
  const inner = d.groupLayers([Y, Z]); inner.name = 'Inner'; inner.opacity = 0.7;
  const outer = d.groupLayers([X, inner]); outer.name = 'Outer'; outer.opacity = 0.8; outer.blend = 'multiply'; outer.collapsed = true;
  d.select(outer); d.addMask('reveal'); const mx = outer.mask.getContext('2d'); mx.fillStyle = '#000'; mx.fillRect(0, 0, 60, 300); outer.touchMask();
  const hid = mk('Hid', '#000000', 300, 200); hid.visible = false; d.emit('structure');
});
await wait();
const pts = [[10, 10], [45, 45], [100, 100], [130, 130], [280, 70], [330, 230]];
const gr = await page.evaluate((pts) => window.__groupRoundtrip(pts), pts);
assert.equal(gr.sigAfter, gr.sigBefore); assert.deepEqual(gr.problems, []); ok(`PSD round-trip keeps nested group structure (${gr.sigAfter})`);
assert.deepEqual(gr.groupsAfter, gr.groupsBefore); ok('…with each group\'s opacity, blend mode, visibility, mask and open/collapsed state');
for (let i = 0; i < pts.length; i++) assert.ok(near(gr.after[i], gr.before[i], 2), `pixel ${pts[i]}: ${gr.before[i]} vs ${gr.after[i]}`);
ok('…and the composite image is identical after re-import');

// randomized stress test: invariants hold after every operation, and undo/redo walk the exact same structures
const stress = await page.evaluate(() => {
  const total = { problems: [], undoBad: 0, steps: 0, origOK: true, redoOK: true, groups: 0, ops: 0 };
  for (const seed0 of [12345, 777, 20240601]) {
    window.__blank(80, 60); const a = window.__app, d = a.doc;
    const stressCtx = Object.assign(document.createElement('canvas'), { width: 80, height: 60 }).getContext('2d');
    d.layers[0].name = 'L0';
    for (let i = 1; i < 6; i++) { const l = d.addLayer('L' + i); l.ctx.fillStyle = `hsl(${i * 55},70%,50%)`; l.ctx.fillRect(i * 8, i * 5, 20, 20); }
    let seed = seed0; const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    const start = d.history.depth, sigs = { [start]: d.signature() };
    for (let i = 0; i < 85; i++) {                        // 85 ops + 6 setup steps stay under the 100-step history cap
      const all = d.layers, groups = all.filter((l) => l.isGroup), kind = pick(['group', 'group', 'ungroup', 'move', 'move', 'move', 'delete', 'dup', 'newgroup', 'addlayer', 'merge', 'clip', 'clip']);
      d.select(pick(all));
      try {
        if (kind === 'group') { const k = 1 + Math.floor(rnd() * 3), sel = [pick(all)]; for (let j = 1; j < k; j++) sel.push(pick(all.filter((l) => l.parent === sel[0].parent))); d.groupLayers(sel); }
        else if (kind === 'ungroup' && groups.length) d.ungroup(pick(groups));
        else if (kind === 'move') d.moveNode(pick(all), pick(all), pick(['above', 'below', 'inside']));
        else if (kind === 'delete') d.removeLayer(pick(all));
        else if (kind === 'dup') d.duplicateLayer(pick(all));
        else if (kind === 'newgroup') d.newGroup();
        else if (kind === 'addlayer') d.addLayer('N' + i);
        else if (kind === 'merge') { const g = groups.length ? pick(groups) : null; if (g && rnd() < 0.5) d.mergeGroup(g); else d.mergeDown(pick(all)); }
      else if (kind === 'clip') { const t = pick(all); d.select(t); rnd() < 0.2 && d.clipStackOf(t).length ? d.mergeClipStack(t) : d.toggleClip(); }
      window.__composite(d, stressCtx);
      } catch (e) { total.problems.push(`seed ${seed0} op ${i} ${kind} threw ${e}`); }
      const v = d.validate(); if (v.length) total.problems.push(`seed ${seed0} after op ${i} (${kind}): ${v.join('; ')}`);
      sigs[d.history.depth] = d.signature(); total.ops++;
    }
    const end = d.history.depth, finalSig = d.signature();
    while (d.history.depth > start) {                    // undo everything: each step must land on the structure recorded at that depth
      d.history.undo(); const dep = d.history.depth, v = d.validate();
      if (v.length) total.problems.push(`seed ${seed0} undo to ${dep}: ${v.join('; ')}`);
      if (d.signature() !== sigs[dep]) total.undoBad++;
    }
    if (d.signature() !== sigs[start]) total.origOK = false;
    while (d.history.depth < end) { d.history.redo(); const v = d.validate(); if (v.length) total.problems.push(`seed ${seed0} redo: ${v.join('; ')}`); }
    if (d.signature() !== finalSig) total.redoOK = false;
    total.steps += end - start; total.groups += d.layers.filter((l) => l.isGroup).length;
  }
  return total;
});
assert.deepEqual(stress.problems, []); ok(`stress: ${stress.ops} random group/ungroup/move/delete/duplicate/merge operations across 3 seeds kept the stack valid (${stress.steps} undoable steps)`);
assert.equal(stress.undoBad, 0); assert.equal(stress.origOK, true); ok('stress: undoing every step restored exactly the structure recorded before it');
assert.equal(stress.redoOK, true); ok('stress: redoing everything reproduces the final structure');


// 6i. clipping masks
const clipScene = async () => {
  await page.evaluate(() => {
    window.__blank(400, 300); const a = window.__app, d = a.doc;
    d.layers[0].name = 'Base';
    const S = d.addLayer('Shape'); S.ctx.fillStyle = '#e02020'; S.ctx.beginPath(); S.ctx.arc(150, 150, 60, 0, 7); S.ctx.fill();
    const P = d.addLayer('Paint'); P.ctx.fillStyle = '#2040e0'; P.ctx.fillRect(0, 0, 400, 300);
    d.emit('structure'); a.setTool('move');
  });
  await wait();
};
const IN = [150, 150], OUT = [320, 150];
await clipScene();
assert.ok(near(await cpx(...IN), [32, 64, 224]) && near(await cpx(...OUT), [32, 64, 224])); ok('before clipping, the top layer covers everything');
await page.keyboard.press('Control+Alt+g'); await wait();
assert.equal(await gx(`return d.active.clipped`), true);
assert.ok(near(await cpx(...IN), [32, 64, 224]) && near(await cpx(...OUT), [255, 255, 255])); ok('Ctrl+Alt+G clips the layer to the shape of the layer below');
assert.equal(await page.locator('#layerlist .layer.clipped').count(), 1); assert.equal(await page.locator('#layerlist .layer.clipbase').count(), 1); ok('the panel marks the clipped layer (indented ↳) and underlines its base');
await page.keyboard.press('Control+Alt+g'); await wait();
assert.ok(near(await cpx(...OUT), [32, 64, 224])); ok('Ctrl+Alt+G again releases the clipping mask');
await page.keyboard.press('Control+z'); await wait();
assert.ok(near(await cpx(...OUT), [255, 255, 255])); await page.keyboard.press('Control+Shift+z'); await wait(); assert.ok(near(await cpx(...OUT), [32, 64, 224])); await page.keyboard.press('Control+z'); await wait(); ok('clipping and releasing are undoable');
assert.equal(await G.sig(), 'Base,Shape,Paint^');

// blend mode of a clipped layer works against the base, and only inside it
await gx(`d.setProp(d.active, 'blend', 'multiply')`);
assert.ok(near(await cpx(...IN), [28, 8, 28], 3)); assert.ok(near(await cpx(...OUT), [255, 255, 255])); ok('a clipped layer\'s blend mode (Multiply) blends with the base and is cut to its shape');
await gx(`d.setProp(d.active, 'blend', 'normal')`);

// the base's opacity applies to the whole stack
await gx(`d.setProp(${G.byName('Shape')}, 'opacity', 0.5)`);
assert.ok(near(await cpx(...IN), [143, 159, 239], 3)); assert.ok(near(await cpx(...OUT), [255, 255, 255])); ok('the base\'s opacity applies to the base and its clipped layers together');
await gx(`d.setProp(${G.byName('Shape')}, 'opacity', 1)`);

// hiding
await gx(`d.setProp(${G.byName('Shape')}, 'visible', false)`);
assert.ok(near(await cpx(...IN), [255, 255, 255])); ok('hiding the base hides the layers clipped to it');
await gx(`d.setProp(${G.byName('Shape')}, 'visible', true); d.setProp(${G.byName('Paint')}, 'visible', false)`);
assert.ok(near(await cpx(...IN), [224, 32, 32])); ok('hiding a clipped layer only hides that layer');
await gx(`d.setProp(${G.byName('Paint')}, 'visible', true)`);

// the base's own mask also cuts the clipped layers
await gx(`d.select(${G.byName('Shape')}); d.addMask('reveal'); const m = d.active.mask.getContext('2d'); m.fillStyle = '#000'; m.fillRect(0, 0, 150, 300); d.active.touchMask(); d.emit('structure'); d.select(${G.byName('Paint')})`);
assert.ok(near(await cpx(110, 150), [255, 255, 255]) && near(await cpx(190, 150), [32, 64, 224])); ok('a mask on the base layer also hides the clipped layers');
await gx(`d.select(${G.byName('Shape')}); d.deleteMask(); d.select(${G.byName('Paint')})`);

// several clipped layers
await gx(`d.select(${G.byName('Paint')}); const P2 = d.addLayer('Paint2'); P2.ctx.fillStyle = '#20c040'; P2.ctx.fillRect(100, 100, 300, 200); d.emit('structure'); d.setClipped([P2], true)`);
assert.equal(await G.sig(), 'Base,Shape,Paint^,Paint2^');
assert.ok(near(await cpx(...IN), [32, 192, 64], 3)); assert.ok(near(await cpx(...OUT), [255, 255, 255])); assert.ok(near(await cpx(95, 150), [32, 64, 224])); ok('several layers can be clipped to the same base (upper ones stack over lower ones)');

// clipping an adjustment layer limits it to the base
await gx(`d.removeLayer(${G.byName('Paint2')}); d.removeLayer(${G.byName('Paint')}); d.select(${G.byName('Shape')}); d.addAdjustmentLayer(window.__defaultAdj('invert'), 'Inv'); d.setClipped([d.active], true)`);
await wait();
assert.ok(near(await cpx(...IN), [31, 223, 223], 3)); assert.ok(near(await cpx(...OUT), [255, 255, 255])); ok('a clipped adjustment layer (Invert) only affects the layer it is clipped to');
await gx(`d.setClipped([d.active], false)`);
assert.ok(near(await cpx(...OUT), [0, 0, 0])); ok('…whereas an unclipped one inverts everything below');
await gx(`d.removeLayer(${G.byName('Inv')})`);

// paint on a clipped layer: the layer keeps the paint, the image shows only the clipped part
await gx(`d.select(${G.byName('Shape')}); const n = d.addLayer('Brush'); d.setClipped([n], true); return 1`);
await page.evaluate(() => { const a = window.__app; a.setFg('#20c040'); a.brush.size = 40; a.brush.hardness = 1; a.brush.opacity = 1; a.brush.flow = 1; a.setTool('brush'); });
await drag([20, 150], [380, 150]); await wait();
assert.ok(near(await cpx(...IN), [32, 192, 64], 3)); assert.ok(near(await cpx(...OUT), [255, 255, 255])); ok('painting on a clipped layer shows only inside the base');
assert.equal(await gx(`return ${G.byName('Brush')}.ctx.getImageData(320,150,1,1).data[3]`), 255); ok('…but the paint is still on the layer (clipping is non-destructive)');
await page.evaluate(() => window.__app.setTool('move'));

// clipped group, bottom-layer edge case, duplicate keeps the flag
await gx(`d.select(${G.byName('Brush')}); const g = d.groupLayers([${G.byName('Brush')}]); d.setClipped([g], true); return 1`);
assert.equal(await G.sig(), 'Base,Shape,[Group 1^:Brush^]'); assert.deepEqual(await G.bad(), []);
assert.ok(near(await cpx(...IN), [32, 192, 64], 3)); assert.ok(near(await cpx(...OUT), [255, 255, 255])); ok('a group can be clipped too');
await gx(`d.ungroup(d.active); d.setClipped([${G.byName('Brush')}], true)`);
await gx(`d.setClipped([d.layers[0]], true)`); await wait();
assert.ok(near(await cpx(...OUT), [255, 255, 255])); assert.equal(await page.locator('#layerlist .layer.clipped').count(), 1); ok('a clipped layer with nothing below it renders normally (and is not shown as clipped)');
await gx(`d.setClipped([d.layers[0]], false); d.select(${G.byName('Brush')}); d.duplicateLayer()`);
assert.equal(await G.sig(), 'Base,Shape,Brush^,Brush copy^'); ok('duplicating a clipped layer keeps it clipped');
await gx(`d.removeLayer(${G.byName('Brush copy')})`);

// Merge Down of a clipped layer bakes only the clipped part into its base; Merge Clipping Mask flattens the stack
await gx(`const P = d.addLayer('Paint'); P.ctx.fillStyle = '#2040e0'; P.ctx.fillRect(0, 0, 400, 300); d.emit('structure'); d.setClipped([P], true); d.removeLayer(${G.byName('Brush')}); d.select(P)`);
assert.equal(await G.sig(), 'Base,Shape,Paint^');
const preMerge = [await cpx(...IN), await cpx(...OUT)];
await gx(`d.mergeDown()`); await wait();
assert.equal(await G.sig(), 'Base,Shape'); assert.ok(near(await cpx(...IN), preMerge[0]) && near(await cpx(...OUT), [255, 255, 255])); ok('Merge Down of a clipped layer paints only inside its base');
assert.equal(await gx(`return ${G.byName('Shape')}.ctx.getImageData(320,150,1,1).data[3]`), 0); ok('…leaving the base transparent outside its shape');
await page.keyboard.press('Control+z'); await wait();
assert.equal(await G.sig(), 'Base,Shape,Paint^');
await gx(`const P2 = d.addLayer('Paint2'); P2.ctx.fillStyle = 'rgba(255,255,0,0.5)'; P2.ctx.fillRect(100, 100, 120, 120); d.setClipped([P2], true); d.setProp(${G.byName('Shape')}, 'opacity', 0.7)`);
const preStack = [await cpx(...IN), await cpx(130, 130), await cpx(...OUT)];
await gx(`d.mergeClipStack(${G.byName('Shape')})`); await wait();
assert.equal(await G.sig(), 'Base,Shape');
assert.ok(near(await cpx(...IN), preStack[0], 2) && near(await cpx(130, 130), preStack[1], 2) && near(await cpx(...OUT), preStack[2], 2)); ok('Merge Clipping Mask flattens the stack without changing the image');
assert.equal(await gx(`return Math.round(${G.byName('Shape')}.opacity * 100)`), 70); ok('…keeping the base\'s opacity on the merged layer');
await page.keyboard.press('Control+z'); await wait();
assert.equal(await G.sig(), 'Base,Shape,Paint^,Paint2^'); ok('undo restores the whole stack');
// merging a normal layer into a clipped one is refused
await gx(`d.select(${G.byName('Paint2')}); const top = d.addLayer('Top'); d.mergeDown(top); return 1`);
assert.equal(await G.sig(), 'Base,Shape,Paint^,Paint2^,Top'); ok('merging an unclipped layer down into a clipped one is refused');

// PSD round-trip keeps clipping (including inside groups) and the picture
await page.evaluate(() => {
  window.__blank(400, 300); const a = window.__app, d = a.doc;
  d.layers[0].name = 'Base';
  const mk = (n, col, fn) => { const l = d.addLayer(n); l.ctx.fillStyle = col; fn(l.ctx); return l; };
  const S = mk('Shape', '#e02020', (c) => { c.beginPath(); c.arc(150, 150, 60, 0, 7); c.fill(); });
  const P1 = mk('Stripes', '#2040e0', (c) => { for (let y = 0; y < 300; y += 20) c.fillRect(0, y, 400, 10); }); P1.blend = 'multiply';
  const P2 = mk('Glow', '#ffee55', (c) => { c.beginPath(); c.arc(120, 120, 50, 0, 7); c.fill(); }); P2.opacity = 0.6;
  d.setClipped([P1, P2], true);
  const Free = mk('Free', '#20c040', (c) => c.fillRect(300, 200, 60, 60));
  const S2 = mk('Shape2', '#aa30cc', (c) => c.fillRect(250, 40, 100, 80));
  const P3 = mk('Dots', '#ffffff', (c) => { for (let x = 250; x < 350; x += 16) { c.beginPath(); c.arc(x, 80, 6, 0, 7); c.fill(); } }); d.setClipped([P3], true);
  const grp = d.groupLayers([S2, P3]); grp.name = 'Box';
  d.select(S); d.addMask('reveal'); const m = S.mask.getContext('2d'); m.fillStyle = '#000'; m.fillRect(0, 0, 100, 300); S.touchMask();
  d.emit('structure');
});
await wait();
const cpts = [[150, 150], [190, 100], [110, 150], [320, 220], [300, 80], [60, 60]];
const cg = await page.evaluate((pts) => window.__groupRoundtrip(pts), cpts);
assert.equal(cg.sigAfter, cg.sigBefore); assert.deepEqual(cg.clippedAfter, cg.clippedBefore); assert.deepEqual(cg.clippedBefore.sort(), ['Dots', 'Glow', 'Stripes']); ok(`PSD round-trip keeps clipping flags (${cg.sigAfter})`);
for (let i = 0; i < cpts.length; i++) assert.ok(near(cg.after[i], cg.before[i], 2), `pixel ${cpts[i]}: ${cg.before[i]} vs ${cg.after[i]}`);
ok('…and the composite image is identical after re-import');


// 6j. layer styles
const styleScene = async () => {
  await page.evaluate(() => {
    window.__blank(400, 300); const a = window.__app, d = a.doc;
    d.layers[0].name = 'Base';
    const B = d.addLayer('Box'); B.ctx.fillStyle = '#e02020'; B.ctx.fillRect(100, 100, 100, 100);
    d.emit('structure'); a.setTool('move');
  });
  await wait();
};
const RED = [224, 32, 32], WHITE = [255, 255, 255];
const fxSet = async (kind, patch) => { await page.evaluate(([k, p]) => document.querySelector('.fx-panel').__fx.set(k, p), [kind, patch]); await page.waitForTimeout(200); };
const fxOpen = async (label) => { await page.click('#lfx'); await page.click(`.popup .mi:has-text("${label}")`); await page.waitForSelector('.fx-panel'); };
const fxOK = async () => { await page.click('.fx-panel button.primary'); await wait(); };
const dark = (c) => 255 - c[0];

await styleScene();
// hard drop shadow
await fxOpen('Drop Shadow');
await fxSet('dropShadow', { on: true, color: '#000000', opacity: 1, blend: 'normal', angle: 90, distance: 20, spread: 0, size: 0 });
assert.ok(near(await cpx(150, 210), [0, 0, 0]) && near(await cpx(150, 230), WHITE) && near(await cpx(150, 95), WHITE) && near(await cpx(50, 150), WHITE) && near(await cpx(150, 150), RED)); ok('drop shadow: offset by angle & distance, under the layer, nowhere else');
assert.equal(await gx(`return ${G.byName('Box')}.effects.dropShadow.on`), true); ok('the effect is previewed live on the layer');
await fxOK();
assert.equal(await page.evaluate(() => window.__app.doc.history.undoLabel), 'Layer Style'); assert.equal(await page.locator('#layerlist .fxbadge').count(), 1); ok('OK commits one "Layer Style" undo step and the panel shows an fx badge');

// soft shadow profile: opaque at the edge, fading to nothing by `size`
await gx(`${G.byName('Box')}.effects.dropShadow.size = 12; ${G.byName('Box')}.effects.dropShadow.distance = 0; d.emit('structure')`);
const sA = dark(await cpx(150, 201)), sB = dark(await cpx(150, 206)), sC = dark(await cpx(150, 211)), sD = dark(await cpx(150, 216));
assert.ok(sA > 60 && sA < 170 && sA > sB && sB > sC && sC >= sD && sD < 12, `profile ${sA} ${sB} ${sC} ${sD}`); ok(`soft shadow is about half strength at the edge and fades smoothly to nothing, like Photoshop's (${sA} → ${sB} → ${sC} → ${sD})`);

// fill opacity 0: the pixels vanish, effects stay, and the shadow is knocked out under the layer
await gx(`${G.byName('Box')}.effects.dropShadow.size = 0; ${G.byName('Box')}.effects.dropShadow.distance = 20; d.setProp(${G.byName('Box')}, 'fillOpacity', 0)`);
assert.ok(near(await cpx(150, 150), WHITE) && near(await cpx(150, 210), [0, 0, 0])); ok('Fill 0%: layer pixels disappear but the shadow stays (and is knocked out beneath the layer)');
await gx(`d.setProp(${G.byName('Box')}, 'fillOpacity', 1)`);
// layer opacity scales effects as well
await gx(`d.setProp(${G.byName('Box')}, 'opacity', 0.5)`);
assert.ok(near(await cpx(150, 210), [128, 128, 128], 3)); ok('layer Opacity scales the effects too');
await gx(`d.setProp(${G.byName('Box')}, 'opacity', 1)`);

// strokes
await gx(`${G.byName('Box')}.effects = { stroke: { on: true, color: '#0000ff', opacity: 1, blend: 'normal', size: 5, position: 'outside' } }; d.emit('structure')`);
assert.ok(near(await cpx(95, 150), [0, 0, 255]) && near(await cpx(99, 150), [0, 0, 255]) && near(await cpx(93, 150), WHITE) && near(await cpx(101, 150), RED)); ok('stroke (outside, 5px): exactly 5px wide outside the edge, nothing over the fill');
assert.ok(near(await cpx(96, 96), WHITE, 255)); const corner = await cpx(95, 95); assert.ok(near(corner, WHITE, 40), `corner ${corner}`); ok('outside stroke has rounded corners');
await gx(`${G.byName('Box')}.effects.stroke.position = 'inside'; d.emit('structure')`);
assert.ok(near(await cpx(101, 150), [0, 0, 255]) && near(await cpx(104, 150), [0, 0, 255]) && near(await cpx(106, 150), RED) && near(await cpx(98, 150), WHITE)); ok('stroke (inside) stays within the shape');
await gx(`${G.byName('Box')}.effects.stroke.position = 'center'; ${G.byName('Box')}.effects.stroke.size = 6; d.emit('structure')`);
assert.ok(near(await cpx(98, 150), [0, 0, 255]) && near(await cpx(102, 150), [0, 0, 255]) && near(await cpx(95, 150), WHITE) && near(await cpx(106, 150), RED)); ok('stroke (center) straddles the edge');

// overlays
await gx(`${G.byName('Box')}.effects = { colorOverlay: { on: true, color: '#00ff00', opacity: 1, blend: 'normal' } }; d.emit('structure')`);
assert.ok(near(await cpx(150, 150), [0, 255, 0]) && near(await cpx(50, 150), WHITE)); ok('color overlay recolours the layer within its shape only');
await gx(`${G.byName('Box')}.effects.colorOverlay.opacity = 0.5; d.emit('structure')`);
assert.ok(near(await cpx(150, 150), [112, 143, 16], 3)); ok('color overlay opacity blends with the layer');
await gx(`${G.byName('Box')}.effects.colorOverlay.opacity = 1; ${G.byName('Box')}.effects.colorOverlay.blend = 'multiply'; ${G.byName('Box')}.effects.colorOverlay.color = '#8080ff'; d.emit('structure')`);
assert.ok(near(await cpx(150, 150), [112, 16, 32], 4)); ok('color overlay honours its blend mode (Multiply with the layer pixels)');
await gx(`${G.byName('Box')}.effects = { gradientOverlay: { on: true, color1: '#000000', color2: '#ffffff', opacity: 1, blend: 'normal', angle: 0, reverse: false } }; d.emit('structure')`);
const gradL = await cpx(103, 150), gradR = await cpx(197, 150); assert.ok(gradL[0] < 30 && gradR[0] > 225); ok('gradient overlay runs across the layer along its angle');
await gx(`${G.byName('Box')}.effects.gradientOverlay.reverse = true; d.emit('structure')`);
assert.ok((await cpx(103, 150))[0] > 225 && (await cpx(197, 150))[0] < 30); ok('…and can be reversed');

// glows and inner shadow
await gx(`${G.byName('Box')}.effects = { outerGlow: { on: true, color: '#ffff00', opacity: 1, blend: 'normal', spread: 0, size: 10 } }; d.emit('structure')`);
const og1 = await cpx(99, 150), og2 = await cpx(60, 150); assert.ok(og1[2] < 90 && og1[0] > 200 && near(og2, WHITE), `glow ${og1} / ${og2}`); assert.ok(near(await cpx(150, 150), RED)); ok('outer glow hugs the outside edge and fades away');
await gx(`${G.byName('Box')}.effects = { innerGlow: { on: true, color: '#ffffff', opacity: 1, blend: 'normal', spread: 0, size: 20 } }; d.emit('structure')`);
const ig1 = await cpx(101, 150), ig2 = await cpx(150, 150); assert.ok(ig1[1] > 150 && near(ig2, RED), `inner glow ${ig1} / ${ig2}`); ok('inner glow lightens the inside edge only');
await gx(`${G.byName('Box')}.effects = { innerShadow: { on: true, color: '#000000', opacity: 1, blend: 'normal', angle: 90, distance: 15, spread: 0, size: 0 } }; d.emit('structure')`);
assert.ok(near(await cpx(150, 105), [0, 0, 0]) && near(await cpx(150, 190), RED) && near(await cpx(150, 210), WHITE)); ok('inner shadow falls inside the top edge for a light from above');

// effects follow the layer's mask, move with the layer, and track pixel edits (cache invalidation)
await gx(`${G.byName('Box')}.effects = { dropShadow: { on: true, color: '#000000', opacity: 1, blend: 'normal', angle: 90, distance: 20, spread: 0, size: 0 } }; d.select(${G.byName('Box')}); d.addMask('reveal'); const m = d.active.mask.getContext('2d'); m.fillStyle = '#000'; m.fillRect(0, 0, 150, 300); d.active.touchMask(); d.emit('structure'); d.editMask = 0; d.setEditMask(d.active, false)`);
assert.ok(near(await cpx(120, 210), WHITE) && near(await cpx(180, 210), [0, 0, 0])); ok('the shadow follows the masked shape (nothing below the hidden half)');
await gx(`d.deleteMask()`);
await page.evaluate(() => window.__app.setTool('move'));
await drag([150, 150], [200, 150]); await wait();
assert.ok(near(await cpx(230, 210), [0, 0, 0]) && near(await cpx(120, 210), WHITE)); ok('moving a styled layer moves its effects with it');
await page.keyboard.press('Control+z'); await wait();
assert.ok(near(await cpx(120, 210), [0, 0, 0]) && near(await cpx(230, 210), WHITE)); ok('undoing the move restores the effect position');
await page.evaluate(() => { const a = window.__app; a.setFg('#20c040'); a.brush.size = 20; a.brush.hardness = 1; a.brush.opacity = 1; a.brush.flow = 1; a.setTool('brush'); });
await drag([300, 100], [320, 100]); await wait();
assert.ok(near(await cpx(310, 123), [0, 0, 0])); ok('painting on a styled layer updates its shadow');
await page.keyboard.press('Control+z'); await wait();
assert.ok(near(await cpx(310, 123), WHITE)); ok('…and undoing the stroke removes the stale shadow (cache invalidates)');
await page.evaluate(() => window.__app.setTool('move'));

// copy / paste / clear via the Layer menu
const menu = async (title, item) => { await page.locator(`#menubar .menu .title:text-is("${title}")`).click(); await page.locator(`#menubar .menu.open .mi:has-text("${item}")`).click(); await wait(); };
await gx(`d.select(${G.byName('Box')})`);
await menu('Layer', 'Copy Layer Style');
await gx(`const n = d.addLayer('Other'); n.ctx.fillStyle = '#2040e0'; n.ctx.fillRect(250, 40, 60, 60); d.emit('structure')`);
assert.ok(near(await cpx(280, 110), WHITE)); await menu('Layer', 'Paste Layer Style');
assert.ok(near(await cpx(280, 110), [0, 0, 0])); ok('Copy / Paste Layer Style transfers effects between layers');
await menu('Layer', 'Clear Layer Style');
assert.ok(near(await cpx(280, 110), WHITE)); assert.equal(await gx(`return ${G.byName('Other')}.effects`), null); ok('Clear Layer Style removes them');
await page.keyboard.press('Control+z'); await wait();
assert.ok(near(await cpx(280, 110), [0, 0, 0])); await gx(`d.removeLayer(${G.byName('Other')})`);

// Cancel restores; Merge Down bakes the styles
await gx(`d.select(${G.byName('Box')})`);
await fxOpen('Layer Style');
await fxSet('stroke', { on: true, color: '#0000ff', size: 8, position: 'outside' });
assert.ok(near(await cpx(96, 150), [0, 0, 255])); await page.keyboard.press('Escape'); await wait();
assert.ok(near(await cpx(96, 150), WHITE)); assert.equal(await page.locator('.fx-panel').count(), 0); ok('Cancel throws away the preview');
const pre = [await cpx(150, 210), await cpx(150, 150), await cpx(60, 60)];
await gx(`d.mergeDown()`); await wait();
assert.equal(await G.sig(), 'Base'); assert.ok(near(await cpx(150, 210), pre[0], 2) && near(await cpx(150, 150), pre[1], 2)); ok('Merge Down bakes the layer style into the pixels');
await page.keyboard.press('Control+z'); await wait();
assert.equal(await G.sig(), 'Base,Box'); assert.ok(await gx(`return !!${G.byName('Box')}.effects.dropShadow`)); ok('…and undo brings the style back');

// text layer + stroke
await page.evaluate(() => { window.__blank(400, 300); const a = window.__app; a.text.size = 120; a.text.bold = true; a.doc.createTextLayer({ ...a.text, content: 'Fx', color: '#ffffff', x: 40, y: 60 }); });
await gx(`d.setEffects(d.active, { stroke: { on: true, color: '#0000ff', opacity: 1, blend: 'normal', size: 4, position: 'outside' }, dropShadow: { on: true, color: '#000000', opacity: 0.8, blend: 'normal', angle: 120, distance: 8, spread: 0, size: 6 } })`);
await wait();
const blue = await page.evaluate(() => { const c = document.querySelector('.doccanvas'), x = document.createElement('canvas'); x.width = c.width; x.height = c.height; const t = x.getContext('2d'); t.drawImage(c, 0, 0); const d = t.getImageData(0, 0, x.width, x.height).data; let n = 0, k = 0; for (let i = 0; i < d.length; i += 4) { if (d[i + 2] > 200 && d[i] < 60 && d[i + 1] < 60) n++; if (d[i] < 120 && d[i] === d[i + 1]) k++; } return { n, k }; });
assert.ok(blue.n > 400 && blue.k > 300, JSON.stringify(blue)); ok('styles apply to text layers (outlined, shadowed text)');

// PSD round-trip of every supported effect + fill opacity
await page.evaluate(() => {
  window.__blank(400, 300); const a = window.__app, d = a.doc; d.layers[0].name = 'Base';
  const mk = (n, x, y, col) => { const l = d.addLayer(n); l.ctx.fillStyle = col; l.ctx.fillRect(x, y, 70, 70); return l; };
  const A = mk('A', 30, 30, '#e02020'), Bx = mk('B', 150, 30, '#2040e0'), C = mk('C', 270, 30, '#20c040'), D = mk('D', 30, 160, '#ffd000');
  A.effects = { dropShadow: { on: true, color: '#102030', opacity: 0.6, blend: 'multiply', angle: 135, distance: 12, spread: 20, size: 9 }, stroke: { on: true, color: '#ff00ff', opacity: 1, blend: 'normal', size: 4, position: 'center' } };
  Bx.effects = { outerGlow: { on: true, color: '#ffaa00', opacity: 0.9, blend: 'screen', spread: 10, size: 14 }, innerShadow: { on: true, color: '#000000', opacity: 0.7, blend: 'multiply', angle: 90, distance: 6, spread: 0, size: 5 } };
  C.effects = { colorOverlay: { on: true, color: '#00ff88', opacity: 0.5, blend: 'normal' }, innerGlow: { on: true, color: '#ffffff', opacity: 0.8, blend: 'screen', spread: 0, size: 10 } }; C.fillOpacity = 0.6;
  D.effects = { gradientOverlay: { on: true, color1: '#112233', color2: '#ffeedd', opacity: 0.9, blend: 'normal', angle: 45, reverse: true } };
  d.emit('structure');
});
await wait();
const fr = await page.evaluate(() => window.__fxRoundtrip([[60, 60], [185, 60], [300, 60], [60, 200], [45, 120], [160, 45], [20, 20], [100, 200]]));
assert.deepEqual(fr.fxAfter, fr.fxBefore); assert.deepEqual(fr.notes, []); ok('PSD round-trip preserves every effect parameter and Fill opacity');
for (let i = 0; i < fr.before.length; i++) assert.ok(near(fr.after[i], fr.before[i], 3), `pixel ${i}: ${fr.before[i]} vs ${fr.after[i]}`);
ok('…and the composite (with effects) is identical after re-import');

// speed: a small styled layer on a 12-megapixel canvas
const perf = await page.evaluate(() => {
  window.__blank(4000, 3000); const a = window.__app, d = a.doc; const l = d.addLayer('Small'); l.ctx.fillStyle = '#e02020'; l.ctx.fillRect(1500, 1200, 300, 200);
  l.effects = { dropShadow: { on: true, color: '#000000', opacity: 0.7, blend: 'multiply', angle: 120, distance: 20, spread: 0, size: 25 }, stroke: { on: true, color: '#0000ff', opacity: 1, blend: 'normal', size: 6, position: 'outside' } };
  const c = document.createElement('canvas'); c.width = 4000; c.height = 3000; const cx = c.getContext('2d', { willReadFrequently: true });
  const t = () => { const t0 = performance.now(); window.__composite(d, cx); return Math.round(performance.now() - t0); };
  const first = t(), second = t(); d.emit('pixels'); const afterEdit = t();
  return { first, second, afterEdit };
});
assert.ok(perf.first < 2500 && perf.second < perf.first, JSON.stringify(perf)); ok(`styles on a 12 MP canvas: first render ${perf.first} ms, cached ${perf.second} ms`);


// 6k. content-aware fill
const cafScene = async () => {
  await page.evaluate(() => {
    window.__blank(400, 300); const a = window.__app, d = a.doc, x = d.layers[0].ctx;
    const stripe = (px, py) => ((((px + py) / 14) | 0) % 2 ? '#d8c9a0' : '#5b7a52');
    for (let py = 0; py < 300; py++) for (let px = 0; px < 400; px += 1) { x.fillStyle = stripe(px, py); x.fillRect(px, py, 1, 1); }
    window.__stripe = stripe;
    x.fillStyle = '#e02020'; x.beginPath(); x.arc(200, 150, 42, 0, 7); x.fill();           // the "object" to remove
    d.emit('structure'); a.setTool('move');
  });
  await wait();
};
const setEllipseSel = (cx, cy, r) => page.evaluate(([cx, cy, r]) => { const d = window.__app.doc, m = document.createElement('canvas'); m.width = d.width; m.height = d.height; const c = m.getContext('2d'); c.beginPath(); c.arc(cx, cy, r, 0, 7); c.fill(); d.setSelection({ x: cx - r, y: cy - r, w: 2 * r, h: 2 * r }, m); }, [cx, cy, r]);
const redCount = (x0, y0, w, h) => page.evaluate(([x0, y0, w, h]) => { const d = window.__app.doc.layers[0].ctx.getImageData(x0, y0, w, h).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 150 && d[i + 1] < 90 && d[i + 2] < 90) n++; return n; }, [x0, y0, w, h]);
const bgError = () => page.evaluate(() => { const l = window.__app.doc.layers[0], d = l.ctx.getImageData(150, 100, 100, 100).data; let e = 0, n = 0; for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) { if (Math.hypot(x - 50, y - 50) > 50) continue; const t = window.__stripe(x + 150, y + 100); const tr = parseInt(t.slice(1, 3), 16), tg = parseInt(t.slice(3, 5), 16), tb = parseInt(t.slice(5, 7), 16); const i = (y * 100 + x) * 4; e += Math.abs(d[i] - tr) + Math.abs(d[i + 1] - tg) + Math.abs(d[i + 2] - tb); n += 3; } return e / n; });

await cafScene();
assert.ok(await redCount(150, 100, 100, 100) > 4000); ok('scene: a red object sits on diagonal stripes');
await page.evaluate(() => window.__app.doc.setSelection(null));
assert.equal(await page.evaluate(() => window.__caf({ expand: 3, sample: 'layer', quality: 'normal' })), false);
assert.match(await page.evaluate(() => document.getElementById('toast').textContent), /selection/i); ok('Content-Aware Fill without a selection explains what to do');

await setEllipseSel(200, 150, 52);
const t0 = Date.now();
const cafP = page.evaluate(() => window.__caf({ expand: 4, sample: 'layer', quality: 'normal' }));
await page.waitForSelector('.caf-overlay', { timeout: 3000 }).catch(() => {});
const finished = await cafP; const cafMs = Date.now() - t0;
assert.equal(finished, true); assert.equal(await page.locator('.caf-overlay').count(), 0); ok(`fill completes and the progress overlay goes away (${cafMs} ms)`);
assert.equal(await redCount(150, 100, 100, 100), 0); ok('the object is gone');
const err = await bgError(); assert.ok(err < 40, `background error ${err}`); ok(`the hole is filled with the surrounding stripes (mean error vs the true background: ${err.toFixed(1)} / 255)`);
await wait(); await page.screenshot({ path: 'tests/caf-after.png' });
assert.equal(await page.evaluate(() => window.__app.doc.history.undoLabel), 'Content-Aware Fill'); assert.equal(await page.evaluate(() => !!window.__app.doc.selection), true); ok('one undo step; the selection is kept');
const outsideBad = await page.evaluate(() => { const l = window.__app.doc.layers[0], d = l.ctx.getImageData(0, 0, 400, 300).data; let bad = 0; for (let y = 0; y < 300; y++) for (let x = 0; x < 400; x++) { if (Math.hypot(x - 200, y - 150) < 58) continue; const t = window.__stripe(x, y), i = (y * 400 + x) * 4; if (Math.abs(d[i] - parseInt(t.slice(1, 3), 16)) > 2) bad++; } return bad; });
assert.equal(outsideBad, 0); ok('pixels outside the selection are untouched');
await page.keyboard.press('Control+z'); await wait();
assert.ok(await redCount(150, 100, 100, 100) > 4000); ok('undo brings the object back');
await page.keyboard.press('Control+Shift+z'); await wait();
assert.equal(await redCount(150, 100, 100, 100), 0); ok('redo removes it again');

// the dialog path: Edit menu + Shift+F5 shortcut
await cafScene(); await setEllipseSel(200, 150, 52);
await page.locator('#menubar .menu .title:text-is("Edit")').click(); await page.locator('#menubar .menu.open .mi:has-text("Content-Aware Fill")').click();
await page.waitForSelector('.modal'); assert.match(await page.locator('.modal h2').textContent(), /Content-Aware Fill/); ok('Edit ▸ Content-Aware Fill… opens its options dialog');
await page.locator('.modal select[name=quality]').selectOption('fast'); await page.locator('.modal button.primary').click();
await page.waitForFunction(() => !document.querySelector('.caf-overlay') && document.getElementById('toast').textContent.includes('finished'), null, { timeout: 20000 });
assert.equal(await redCount(150, 100, 100, 100), 0); ok('…and fills the selection when confirmed (Fast quality)');
await cafScene(); await setEllipseSel(200, 150, 52);
await page.keyboard.press('Shift+F5'); await page.waitForSelector('.modal'); await page.keyboard.press('Escape'); await wait();
assert.ok(await redCount(150, 100, 100, 100) > 4000); ok('Shift+F5 opens the dialog; Escape leaves the image untouched');

// cancel mid-way applies nothing
await cafScene(); await setEllipseSel(200, 150, 70);
const cancelP = page.evaluate(() => window.__caf({ expand: 3, sample: 'layer', quality: 'high' }));
await page.waitForSelector('.caf-overlay'); await page.click('.caf-overlay button');
assert.equal(await cancelP, false); assert.ok(await redCount(150, 100, 100, 100) > 4000); assert.equal(await page.locator('.caf-overlay').count(), 0); ok('Cancel stops the fill and leaves the image unchanged');
assert.match(await page.evaluate(() => document.getElementById('toast').textContent), /cancel/i);

// sample all layers: the object lives on its own layer above a textured background
await page.evaluate(() => {
  window.__blank(400, 300); const a = window.__app, d = a.doc, x = d.layers[0].ctx;
  const stripe = (px, py) => ((((px + py) / 14) | 0) % 2 ? '#d8c9a0' : '#5b7a52'); window.__stripe = stripe;
  for (let py = 0; py < 300; py++) for (let px = 0; px < 400; px++) { x.fillStyle = stripe(px, py); x.fillRect(px, py, 1, 1); }
  const o = d.addLayer('Object'); o.ctx.fillStyle = '#e02020'; o.ctx.beginPath(); o.ctx.arc(200, 150, 42, 0, 7); o.ctx.fill(); d.emit('structure');
});
await setEllipseSel(200, 150, 52);
assert.equal(await page.evaluate(() => window.__caf({ expand: 4, sample: 'all', quality: 'normal' })), true); await wait();
const lay = await page.evaluate(() => { const d = window.__app.doc, o = d.layers[1].ctx.getImageData(200, 150, 1, 1).data, b = d.layers[0].ctx.getImageData(200, 150, 1, 1).data; return { objAlpha: o[3], objRed: o[0] > 150 && o[1] < 90, bg: Array.from(b) }; });
assert.equal(lay.objAlpha, 255); assert.equal(lay.objRed, false); ok('Sample: All layers writes the fill onto the active layer, using the visible image as the source');
assert.equal(await page.evaluate(() => { const l = window.__app.doc.layers[0], d = l.ctx.getImageData(200, 150, 1, 1).data, t = window.__stripe(200, 150); return Math.abs(d[0] - parseInt(t.slice(1, 3), 16)); }), 0); ok('…and the background layer below is not modified');

// groups are refused
await gx(`d.newGroup(); return 1`);
assert.equal(await page.evaluate(() => window.__caf({ expand: 3, sample: 'layer', quality: 'fast' })), false); assert.match(await page.evaluate(() => document.getElementById('toast').textContent), /group/i); ok('Content-Aware Fill on a group is refused with a hint');
await page.keyboard.press('Control+z'); await wait();


// regression guard: a textured scene (grain + picket fence) with a large object removed — measured against the true background
const cafQuality = await page.evaluate(async () => {
  const W = 900, H = 560;
  const scene = (withObject) => {
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const x = cv.getContext('2d', { willReadFrequently: true });
    let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const sky = x.createLinearGradient(0, 0, 0, 250); sky.addColorStop(0, '#7fb8e6'); sky.addColorStop(1, '#d6ecf7'); x.fillStyle = sky; x.fillRect(0, 0, W, 250);
    x.fillStyle = '#8fb08a'; x.beginPath(); x.moveTo(0, 230); x.bezierCurveTo(200, 170, 420, 250, 650, 190); x.bezierCurveTo(780, 160, 860, 200, 900, 190); x.lineTo(900, 300); x.lineTo(0, 300); x.fill();
    x.fillStyle = '#5b9a45'; x.fillRect(0, 280, W, H - 280);
    const img = x.getImageData(0, 280, W, H - 280), px = img.data;
    for (let i = 0; i < px.length; i += 4) { const n = (rnd() - 0.5) * 46, row = ((i / 4) / W) | 0; px[i] += n * 0.8 - row * 0.05; px[i + 1] += n; px[i + 2] += n * 0.6; }
    x.putImageData(img, 0, 280);
    for (let k = 0; k < 2600; k++) { x.strokeStyle = `rgba(${40 + rnd() * 40},${110 + rnd() * 70},${40 + rnd() * 30},.55)`; x.lineWidth = 1.2; const gx = rnd() * W, gy = 285 + rnd() * (H - 285); x.beginPath(); x.moveTo(gx, gy); x.lineTo(gx + (rnd() - 0.5) * 6, gy - 8 - rnd() * 10); x.stroke(); }
    for (let fx = 20; fx < W; fx += 46) { x.fillStyle = '#e9dfc9'; x.fillRect(fx, 300, 30, 150); x.fillStyle = '#cfc2a6'; x.fillRect(fx + 26, 300, 4, 150); x.beginPath(); x.moveTo(fx, 300); x.lineTo(fx + 15, 280); x.lineTo(fx + 30, 300); x.fill(); }
    x.fillStyle = '#b8aa8c'; x.fillRect(0, 330, W, 10); x.fillRect(0, 410, W, 10);
    if (withObject) { x.fillStyle = '#ff7b1a'; x.beginPath(); x.ellipse(430, 405, 120, 62, 0, 0, 7); x.fill(); x.fillStyle = '#222'; x.beginPath(); x.arc(360, 470, 28, 0, 7); x.arc(505, 470, 28, 0, 7); x.fill(); x.fillStyle = '#ffd24d'; x.fillRect(395, 330, 70, 55); }
    return x.getImageData(0, 0, W, H);
  };
  window.__blank(W, H); const d = window.__app.doc, truth = scene(false);
  d.layers[0].ctx.putImageData(scene(true), 0, 0);
  const m = document.createElement('canvas'); m.width = W; m.height = H; const c = m.getContext('2d');
  c.beginPath(); [[300, 320], [500, 318], [575, 380], [560, 480], [510, 505], [350, 505], [300, 470], [295, 385]].forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.closePath(); c.fill();
  const mask = c.getImageData(0, 0, W, H).data;
  d.setSelection({ x: 295, y: 318, w: 280, h: 187 }, m);
  const t0 = performance.now(); await window.__caf({ expand: 4, sample: 'layer', quality: 'high' }); const ms = Math.round(performance.now() - t0);
  const got = d.layers[0].ctx.getImageData(0, 0, W, H);
  const blur = (img) => { const c1 = document.createElement('canvas'); c1.width = W; c1.height = H; c1.getContext('2d').putImageData(img, 0, 0); const c2 = document.createElement('canvas'); c2.width = W; c2.height = H; const x2 = c2.getContext('2d', { willReadFrequently: true }); x2.filter = 'blur(4px)'; x2.drawImage(c1, 0, 0); return x2.getImageData(0, 0, W, H).data; };
  const bl = blur(got), bt = blur(truth); let e = 0, n = 0, stray = 0, orange = 0;
  for (let i = 0; i < mask.length; i += 4) if (mask[i + 3] > 127) {
    e += Math.abs(bl[i] - bt[i]) + Math.abs(bl[i + 1] - bt[i + 1]) + Math.abs(bl[i + 2] - bt[i + 2]); n += 3;
    const y = ((i / 4) / W) | 0, r = got.data[i], g = got.data[i + 1], b2 = got.data[i + 2];
    if (y > 300 && r > 120 && r < 170 && g > 160 && g < 195 && b2 > 120 && b2 < 160 && Math.abs(r - 143) < 20) stray++;
    if (r > 220 && g > 90 && g < 160 && b2 < 70) orange++;
  }
  return { ms, struct: e / n, stray, orange };
});
assert.equal(cafQuality.orange, 0, `object pixels left: ${cafQuality.orange}`); ok('textured scene: no trace of the removed object remains');
assert.ok(cafQuality.stray < 300, `stray foreign-colour pixels: ${cafQuality.stray}`); ok(`…no foreign patch is pasted in from elsewhere (${cafQuality.stray} stray px; the unweighted version produced >1000)`);
assert.ok(cafQuality.struct < 22, `structural error ${cafQuality.struct}`); ok(`…and the structure matches the true background (low-pass error ${cafQuality.struct.toFixed(1)}/255, ${(cafQuality.ms / 1000).toFixed(1)} s for a 280×187 region at High quality)`);
await page.screenshot({ path: 'tests/caf-after2.png' });


// 6l. patch tool
const patchScene = async (mode = 'source', blend = true) => {
  await page.evaluate(([mode, blend]) => {
    window.__blank(400, 300); const a = window.__app, d = a.doc, x = d.layers[0].ctx;
    const img = x.createImageData(400, 300), px = img.data;
    for (let y = 0; y < 300; y++) for (let xx = 0; xx < 400; xx++) {
      const h = (((xx * 73856093) ^ (y * 19349663)) >>> 0) % 256, n = (h / 255 - 0.5) * 28, i = (y * 400 + xx) * 4, base = xx < 200 ? [120, 110, 100] : [170, 160, 150];
      px[i] = base[0] + n; px[i + 1] = base[1] + n; px[i + 2] = base[2] + n; px[i + 3] = 255;
    }
    x.putImageData(img, 0, 0);
    x.fillStyle = '#281e1e'; x.beginPath(); x.arc(100, 150, 12, 0, 7); x.fill();          // the blemish
    d.emit('structure'); d.setSelection(null);
    a.patch.mode = mode; a.patch.blend = blend; a.clone.sample = 'layer'; a.setTool('patch');
  }, [mode, blend]);
  await wait();
};
const lassoAround = async (cx, cy, r, key) => {
  const pts = Array.from({ length: 14 }, (_, i) => [cx + Math.cos((i / 14) * Math.PI * 2) * r, cy + Math.sin((i / 14) * Math.PI * 2) * r]);
  const sp = await Promise.all(pts.map((q) => toScreen(...q)));
  if (key) await page.keyboard.down(key);
  await page.mouse.move(sp[0].x, sp[0].y); await page.mouse.down();
  for (const q of sp.slice(1)) await page.mouse.move(q.x, q.y, { steps: 2 });
  await page.mouse.up(); if (key) await page.keyboard.up(key); await wait();
};
const discStats = (cx, cy, r) => page.evaluate(([cx, cy, r]) => { const d = window.__app.doc.layers[0].ctx.getImageData(cx - r, cy - r, 2 * r + 1, 2 * r + 1).data; let s = 0, s2 = 0, k = 0, mn = 255; for (let y = 0; y <= 2 * r; y++) for (let x = 0; x <= 2 * r; x++) { if (Math.hypot(x - r, y - r) > r) continue; const v = d[(y * (2 * r + 1) + x) * 4]; s += v; s2 += v * v; k++; if (v < mn) mn = v; } const m = s / k; return { mean: m, sd: Math.sqrt(Math.max(0, s2 / k - m * m)), min: mn }; }, [cx, cy, r]);

await patchScene();
assert.ok((await discStats(100, 150, 8)).mean < 60); ok('scene: a dark blemish on a textured, darker left half; the right half is brighter');
await lassoAround(100, 150, 26);
const sel0 = await page.evaluate(() => ({ ...window.__app.doc.selection, irregular: !!window.__app.doc.selMask }));
assert.ok(sel0.w > 40 && sel0.w < 60 && sel0.irregular); ok('the Patch tool draws a freehand selection around the blemish');

// drag the outline onto a clean (but brighter) area: preview first, blended result on release
const pFrom = await toScreen(100, 150), pTo = await toScreen(300, 150);
await page.mouse.move(pFrom.x, pFrom.y); await page.mouse.down(); await page.mouse.move((pFrom.x + pTo.x) / 2, pFrom.y, { steps: 6 }); await page.mouse.move(pTo.x, pTo.y, { steps: 6 });
const live = await cpx(100, 150); assert.ok(live[0] > 140, `preview ${live}`); ok('while dragging, the selection shows a live preview of the source');
await page.mouse.up(); await wait(); await wait();
const patched = await discStats(100, 150, 14);
assert.ok(patched.min > 80, `blemish still there (min ${patched.min})`); ok('on release the blemish is gone');
assert.ok(Math.abs(patched.mean - 120) < 16, `mean ${patched.mean}`); ok(`the patch takes on the surrounding tone, not the brighter source (mean ${patched.mean.toFixed(0)} vs source ~170)`);
assert.ok(patched.sd > 3, `sd ${patched.sd}`); ok('…while keeping the source texture (it is not a flat smear)');
assert.equal(await page.evaluate(() => window.__app.doc.history.undoLabel), 'Patch'); assert.ok(near([await page.evaluate(() => Math.round(window.__app.doc.selection.x))], [sel0.x], 2)); ok('one "Patch" undo step; the selection stays on the repaired area');
await page.keyboard.press('Control+z'); await wait();
assert.ok((await discStats(100, 150, 8)).mean < 60); ok('undo brings the blemish back');
await page.keyboard.press('Control+Shift+z'); await wait();

// without "Match tone & texture" it is a plain copy (brighter)
await patchScene('source', false); await lassoAround(100, 150, 26);
await drag([100, 150], [300, 150]); await wait();
assert.ok((await discStats(100, 150, 14)).mean > 150); ok('with "Match tone" off the patch is a plain copy of the source (stays bright)');

// destination mode: copy a marked area elsewhere; the selection moves with it, all one undo step
await patchScene('dest', true);
await page.evaluate(() => { const c = window.__app.doc.layers[0].ctx; c.fillStyle = '#d02020'; c.fillRect(50, 50, 24, 24); });
await lassoAround(62, 62, 22);
const origSelX = await page.evaluate(() => window.__app.doc.selection.x);
await drag([62, 62], [112, 162]); await wait(); await wait();
const copyPx = await page.evaluate(() => Array.from(window.__app.doc.layers[0].ctx.getImageData(112, 162, 1, 1).data)), origPx = await page.evaluate(() => Array.from(window.__app.doc.layers[0].ctx.getImageData(62, 62, 1, 1).data));
assert.ok(copyPx[0] > 150 && copyPx[1] < 100, `copy ${copyPx}`); assert.ok(origPx[0] > 150 && origPx[1] < 100); ok('Destination mode: the marked area is copied to the drop point and the original stays');
assert.equal(await page.evaluate(() => Math.round(window.__app.doc.selection.x - 0)), Math.round(origSelX + 50)); ok('…and the selection moved to the new location');
await page.keyboard.press('Control+z'); await wait();
const afterUndo = await page.evaluate(() => ({ px: Array.from(window.__app.doc.layers[0].ctx.getImageData(112, 162, 1, 1).data), selX: window.__app.doc.selection && window.__app.doc.selection.x }));
assert.ok(afterUndo.px[0] < 190 && afterUndo.px[1] > 90); assert.equal(Math.round(afterUndo.selX), Math.round(origSelX)); ok('a single undo removes the copy and returns the selection');

// clicking inside without dragging does nothing; dragging outside draws a new selection (Shift adds)
await patchScene(); await lassoAround(100, 150, 26);
const h0 = await page.evaluate(() => window.__app.doc.history.depth);
const c0 = await toScreen(100, 150); await page.mouse.click(c0.x, c0.y); await wait();
assert.equal(await page.evaluate(() => window.__app.doc.history.depth), h0); ok('a click inside the selection (no drag) changes nothing');
await lassoAround(300, 80, 20); assert.ok(await page.evaluate(() => window.__app.doc.selection.x > 250)); ok('drawing outside the current selection starts a new one');
await lassoAround(100, 150, 20, 'Shift'); assert.ok(await page.evaluate(() => window.__app.doc.selection.x < 120 && window.__app.doc.selection.x + window.__app.doc.selection.w > 300)); ok('Shift adds to the selection');

// a group can't be patched; other tools survived the refactor (eyedropper)
await gx(`d.setSelection(null); d.newGroup(); return 1`); await lassoAround(100, 150, 26);
await drag([100, 150], [300, 150]); await wait();
assert.match(await page.evaluate(() => document.getElementById('toast').textContent), /group/i); ok('patching with a group selected is refused with a hint');
await page.keyboard.press('Control+z'); await wait();
await patchScene(); await page.evaluate(() => { window.__app.setTool('eyedropper'); window.__app.setFg('#000000'); });
const ep = await toScreen(300, 200); await page.mouse.click(ep.x, ep.y); await wait();
const picked = await page.evaluate(() => window.__app.fg), expect = await page.evaluate(() => { const d = window.__app.doc.layers[0].ctx.getImageData(300, 200, 1, 1).data; return '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join(''); });
assert.equal(picked, expect); ok('the eyedropper still picks colours');
await page.evaluate(() => window.__app.setTool('move'));


// 6n. bevel & emboss
const lum = (c) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
const bevelScene = async () => { await styleScene(); await gx(`d.layers[0].ctx.fillStyle = '#969696'; d.layers[0].ctx.fillRect(0, 0, 400, 300); d.emit('structure')`); };
const GRAY = [150, 150, 150];
const setBevel = async (patch) => { await gx(`const b = ${G.byName('Box')}; b.effects = { bevel: Object.assign(window.__defaultFx('bevel'), ${JSON.stringify({ size: 12, ...patch })}) }; d.emit('structure')`); await wait(); };
const bvEdge = async () => ({ left: lum(await cpx(104, 150)), top: lum(await cpx(150, 104)), right: lum(await cpx(196, 150)), bottom: lum(await cpx(150, 196)), mid: lum(await cpx(150, 150)) });

await bevelScene();
await fxOpen('Bevel'); 
assert.match(await page.locator('.fx-controls h3').textContent(), /Bevel & Emboss/); ok('Bevel & Emboss is in the fx menu and the Layer Style dialog');
await fxSet('bevel', { on: true, size: 12, depth: 100, angle: 120, altitude: 30 });
let bvE = await bvEdge();
assert.ok(bvE.left > bvE.mid + 8 && bvE.top > bvE.mid + 8, JSON.stringify(bvE)); assert.ok(bvE.right < bvE.mid - 8 && bvE.bottom < bvE.mid - 8, JSON.stringify(bvE)); ok('inner bevel, light from the upper-left: left & top edges are lit, right & bottom edges are shaded');
assert.ok(near(await cpx(150, 150), RED) && near(await cpx(95, 150), GRAY)); ok('the flat top of the layer and the area outside it are untouched');
await page.selectOption('.fx-controls select >> nth=0', 'emboss'); await page.waitForTimeout(200);
assert.equal(await gx(`return ${G.byName('Box')}.effects.bevel.style`), 'emboss'); ok('the dialog\'s controls edit the bevel live (Style → Emboss)');
await fxOK();

await setBevel({ direction: 'down' }); bvE = await bvEdge();
assert.ok(bvE.left < bvE.mid - 8 && bvE.right > bvE.mid + 8, JSON.stringify(bvE)); ok('direction "Down" presses the surface in: lighting flips');
await setBevel({ angle: 300 }); bvE = await bvEdge();
assert.ok(bvE.left < bvE.mid - 8 && bvE.right > bvE.mid + 8 && bvE.bottom > bvE.mid + 8, JSON.stringify(bvE)); ok('light angle 300° (from the lower-right) flips it the other way');

await setBevel({ style: 'outer' });
assert.ok(near(await cpx(104, 150), RED) && !near(await cpx(96, 150), GRAY, 6) && !near(await cpx(150, 96), GRAY, 6)); ok('outer bevel shades only outside the layer');
await setBevel({ style: 'emboss' });
assert.ok(!near(await cpx(104, 150), RED, 8) && !near(await cpx(96, 150), GRAY, 6)); ok('emboss shades both sides of the edge');
await setBevel({ style: 'pillow' });
const pl = [lum(await cpx(106, 150)), lum(await cpx(94, 150)), lum(await cpx(150, 150))];
assert.ok(!near(await cpx(104, 150), RED, 8) && !near(await cpx(96, 150), GRAY, 6) && near(await cpx(150, 150), RED)); ok('pillow emboss grooves the edge on both sides'); void pl;

// size, depth, altitude, technique
const bvBand = async (size) => { await setBevel({ size, depth: 100 }); let n = 0; const mid = lum(await cpx(150, 150)); for (let x = 100; x < 150; x += 1) if (Math.abs(lum(await cpx(x, 150)) - mid) > 6) n++; return n; };
const b4 = await bvBand(4), b20 = await bvBand(20); assert.ok(b20 > b4 + 6, `${b4} vs ${b20}`); ok(`Size sets the width of the lit band (${b4}px → ${b20}px)`);
const bvStrength = async (depth) => { await setBevel({ size: 12, depth }); const m = await bvEdge(); return Math.abs(m.left - m.mid) + Math.abs(m.right - m.mid); };
const d30 = await bvStrength(8), d100 = await bvStrength(20), d300 = await bvStrength(45); assert.ok(d300 > d100 && d100 > d30, `${d30} ${d100} ${d300}`); ok('Depth scales how strong the lighting is');
await setBevel({ altitude: 90 }); bvE = await bvEdge(); assert.ok(bvE.left <= bvE.mid + 2 && bvE.top <= bvE.mid + 2); ok('light from straight overhead produces no highlights');
await setBevel({ technique: 'smooth', size: 14 }); const bvSm = Math.abs(lum(await cpx(101, 150)) - lum(await cpx(150, 150)));
await setBevel({ technique: 'hard', size: 14 }); const bvHd = Math.abs(lum(await cpx(101, 150)) - lum(await cpx(150, 150)));
assert.ok(bvHd > bvSm + 5, `at the rim: smooth ${bvSm} vs chisel hard ${bvHd}`); ok('Chisel Hard is crisp right at the rim; Smooth eases in gently');
await setBevel({ soften: 0 });

// highlight / shadow controls
await setBevel({ hiOpacity: 0 }); bvE = await bvEdge(); assert.ok(bvE.left <= bvE.mid + 1 && bvE.right < bvE.mid - 8); ok('highlight opacity 0 removes only the highlight');
await setBevel({ shOpacity: 0 }); bvE = await bvEdge(); assert.ok(bvE.right >= bvE.mid - 1 && bvE.left > bvE.mid + 8); ok('shadow opacity 0 removes only the shadow');
await setBevel({ hiColor: '#00ff00', hiOpacity: 1 }); const g1 = await cpx(104, 150); assert.ok(g1[1] - g1[2] > 100); ok('the highlight colour is used (green screen on red)');

// stroke emboss lights only the stroke
await gx(`${G.byName('Box')}.effects = { stroke: { on: true, color: '#0000ff', opacity: 1, blend: 'normal', size: 8, position: 'inside' }, bevel: Object.assign(window.__defaultFx('bevel'), { style: 'stroke', size: 6 }) }; d.emit('structure')`); await wait();
const bvLeft = await cpx(103, 150), bvRight = await cpx(197, 150), BLUE = [0, 0, 255];
assert.ok(near(await cpx(150, 150), RED), 'interior should stay flat red');
assert.ok(lum(bvLeft) > lum(BLUE) + 8 && lum(bvRight) < lum(BLUE) - 8, `ring should be lit left / shaded right: ${bvLeft} ${bvRight}`); ok('Stroke Emboss lights the stroke (lit on the light side, shaded on the other) and leaves the interior flat');
await gx(`${G.byName('Box')}.effects.stroke.on = false; d.emit('structure')`);
assert.ok(near(await cpx(104, 150), RED) && near(await cpx(150, 104), RED)); ok('…and does nothing without a stroke');

// Fill 0 keeps the bevel; bevel on text; stacking with other effects
await setBevel({ size: 12 }); await gx(`d.setProp(${G.byName('Box')}, 'fillOpacity', 0)`);
const f0 = [await cpx(150, 150), await cpx(104, 150), await cpx(196, 150)];
assert.ok(near(f0[0], GRAY) && lum(f0[1]) > lum(GRAY) + 8 && lum(f0[2]) < lum(GRAY) - 8); ok('Fill 0%: the layer pixels vanish but the bevel lighting remains');
await gx(`d.setProp(${G.byName('Box')}, 'fillOpacity', 1)`);
await page.evaluate(() => { window.__blank(300, 200); const a = window.__app; a.text.size = 150; a.text.bold = true; a.doc.createTextLayer({ ...a.text, content: 'B', color: '#ffffff', x: 90, y: 20 }); a.doc.setEffects(a.doc.active, { bevel: window.__defaultFx('bevel'), dropShadow: window.__defaultFx('dropShadow') }); });
await wait();
const bvShaded = await page.evaluate(() => { const c = document.querySelector('.doccanvas'), x = document.createElement('canvas'); x.width = c.width; x.height = c.height; const t = x.getContext('2d'); t.drawImage(c, 0, 0); const d = t.getImageData(0, 0, x.width, x.height).data; let mid = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 60 && d[i] < 225 && Math.abs(d[i] - d[i + 1]) < 4) mid++; return mid; });
assert.ok(bvShaded > 150, `shaded pixels ${bvShaded}`); ok('bevel works on text layers together with a drop shadow');

// PSD round-trip
await page.evaluate(() => {
  window.__blank(400, 300); const a = window.__app, d = a.doc; d.layers[0].ctx.fillStyle = '#969696'; d.layers[0].ctx.fillRect(0, 0, 400, 300);
  const mk = (n, x, y, col) => { const l = d.addLayer(n); l.ctx.fillStyle = col; l.ctx.fillRect(x, y, 80, 80); return l; };
  const A = mk('A', 30, 30, '#e02020'), B2 = mk('B', 160, 30, '#2040e0'), C = mk('C', 290, 30, '#20c040');
  A.effects = { bevel: { ...window.__defaultFx('bevel'), style: 'emboss', technique: 'hard', depth: 180, size: 9, angle: 60, altitude: 45, hiColor: '#ffeecc', shColor: '#001122', hiOpacity: 0.6, shOpacity: 0.9 }, dropShadow: window.__defaultFx('dropShadow') };
  B2.effects = { bevel: { ...window.__defaultFx('bevel'), style: 'outer', direction: 'down', soften: 2, size: 14 } };
  C.effects = { stroke: { ...window.__defaultFx('stroke'), color: '#ffffff', size: 8, position: 'inside' }, bevel: { ...window.__defaultFx('bevel'), style: 'stroke', technique: 'soft', size: 5 } };
  d.emit('structure');
});
await wait();
const bfr = await page.evaluate(() => window.__fxRoundtrip([[40, 60], [34, 34], [200, 70], [160, 60], [300, 70], [292, 60], [20, 20]]));
assert.deepEqual(bfr.fxAfter, bfr.fxBefore); assert.deepEqual(bfr.notes, []); ok('PSD round-trip preserves bevel parameters (styles, techniques, colours) alongside other effects');
for (let i = 0; i < bfr.before.length; i++) assert.ok(near(bfr.after[i], bfr.before[i], 3), `pixel ${i}: ${bfr.before[i]} vs ${bfr.after[i]}`);
ok('…and the composite with bevels is identical after re-import');

// speed
const bperf = await page.evaluate(() => {
  window.__blank(4000, 3000); const a = window.__app, d = a.doc, l = d.addLayer('Small'); l.ctx.fillStyle = '#e02020'; l.ctx.fillRect(1500, 1200, 300, 200);
  l.effects = { bevel: { ...window.__defaultFx('bevel'), size: 14, style: 'emboss' }, dropShadow: window.__defaultFx('dropShadow') };
  const c = document.createElement('canvas'); c.width = 4000; c.height = 3000; const cx = c.getContext('2d', { willReadFrequently: true });
  const t = () => { const t0 = performance.now(); window.__composite(d, cx); return Math.round(performance.now() - t0); };
  return { first: t(), second: t() };
});
assert.ok(bperf.first < 3500 && bperf.second < bperf.first, JSON.stringify(bperf)); ok(`bevel on a 12 MP canvas: first render ${bperf.first} ms, cached ${bperf.second} ms`);


// 6o. lessons from real Photoshop files: backdrop-aware effects, extra blend modes, gradient styles, satin
const rgbOf = (x, y) => cpx(x, y);
const fxScene = async (bg) => {
  await page.evaluate((bg) => {
    window.__blank(400, 300); const a = window.__app, d = a.doc; d.layers[0].name = 'Base'; d.layers[0].ctx.fillStyle = bg; d.layers[0].ctx.fillRect(0, 0, 400, 300);
    const B = d.addLayer('Box'); B.ctx.fillStyle = '#2040e0'; B.ctx.fillRect(100, 100, 100, 100); d.emit('structure'); a.setTool('move');
  }, bg);
  await wait();
};
const fxOn = (patch) => gx(`${G.byName('Box')}.effects = ${JSON.stringify(patch)}; d.emit('structure')`).then(() => wait());

// shadows & glows blend with what is *under* the layer
await fxScene('#ffffff');
await fxOn({ outerGlow: { on: true, color: '#ffffbe', opacity: 1, blend: 'screen', spread: 0, size: 12 } });
assert.ok(near(await rgbOf(97, 150), [255, 255, 255], 2)); ok('a Screen glow is invisible over white (it blends with the backdrop, as in Photoshop)');
await fxScene('#202040');
await fxOn({ outerGlow: { on: true, color: '#ffffbe', opacity: 1, blend: 'screen', spread: 0, size: 12 } });
const glowDark = await rgbOf(97, 150); assert.ok(glowDark[0] > 120 && glowDark[1] > 120, `glow ${glowDark}`); ok('…but clearly lights up a dark backdrop');
await fxScene('#c8c8c8');
await fxOn({ dropShadow: { on: true, color: '#ff8000', opacity: 1, blend: 'multiply', angle: 90, distance: 20, spread: 0, size: 0 } });
assert.ok(near(await rgbOf(150, 210), [200, 100, 0], 3)); ok('a Multiply drop shadow multiplies the backdrop colour (200 × orange = 200,100,0) instead of painting orange over it');
await fxOn({ dropShadow: { on: true, color: '#ff8000', opacity: 1, blend: 'normal', angle: 90, distance: 20, spread: 0, size: 0 } });
assert.ok(near(await rgbOf(150, 210), [255, 128, 0], 3)); ok('…while the same shadow in Normal mode paints it flat');

// extra blend modes in the compositor
await fxScene('#808080');
const blendCase = async (mode, expect, tol = 3) => { await gx(`${G.byName('Box')}.blend = ${JSON.stringify(mode)}; ${G.byName('Box')}.effects = null; d.emit('structure')`); await wait(); const c = await rgbOf(150, 150); assert.ok(near(c, expect, tol), `${mode}: got ${c}, expected ${expect}`); };
await blendCase('linear burn', [0, 0, 97]);        // Cb + Cs − 1 : 128+32−255=0 | 128+64−255=0 | 128+224−255=97
await blendCase('linear light', [0, 1, 255]);      // Cb + 2Cs − 1 clamped
await blendCase('subtract', [96, 64, 0]);          // Cb − Cs
await blendCase('divide', [255, 255, 146]);        // Cb / Cs
await blendCase('hard mix', [0, 0, 255], 3);   // Cb + Cs >= 255 ? 255 : 0
await blendCase('multiply', [16, 32, 112], 4);     // sanity: a native mode still works
ok('Linear Burn, Linear Light, Subtract, Divide and Hard Mix composite per their definitions (and native modes are unaffected)');
await gx(`${G.byName('Box')}.blend = 'normal'; d.emit('structure')`);

// gradient overlays: multi-stop, radial, reflected, per-stop opacity, reverse, scale
await fxScene('#ffffff');
const gradFx = (g) => fxOn({ gradientOverlay: { on: true, color1: '#000000', color2: '#ffffff', opacity: 1, blend: 'normal', angle: 0, reverse: false, ...g } });
await gradFx({ stops: [{ at: 0, color: '#000000', alpha: 1 }, { at: 0.5, color: '#ffffff', alpha: 1 }, { at: 1, color: '#000000', alpha: 1 }] });
const gl3 = [lum(await rgbOf(102, 150)), lum(await rgbOf(150, 150)), lum(await rgbOf(198, 150))]; assert.ok(gl3[0] < 40 && gl3[1] > 215 && gl3[2] < 40, `${gl3}`); ok('a 3-stop gradient (black → white → black) renders all of its stops');
await gradFx({ style: 'radial', stops: [{ at: 0, color: '#ff0000', alpha: 1 }, { at: 1, color: '#0000ff', alpha: 1 }] });
const radC = await rgbOf(150, 150), radE = await rgbOf(102, 150); assert.ok(radC[0] > 220 && radC[2] < 40 && radE[2] > 200 && radE[0] < 50, `${radC} ${radE}`); ok('a radial gradient runs from the centre outwards (red centre → blue edge)');
await gradFx({ style: 'reflected', angle: 0, stops: [{ at: 0, color: '#ffffff', alpha: 1 }, { at: 1, color: '#000000', alpha: 1 }] });
assert.ok(lum(await rgbOf(150, 150)) > 215 && lum(await rgbOf(102, 150)) < 45 && lum(await rgbOf(198, 150)) < 45); ok('a reflected gradient mirrors about the centre');
await gradFx({ style: 'angle', angle: 0 });
assert.ok(lum(await rgbOf(190, 120)) !== lum(await rgbOf(110, 180))); ok('an angle (conic) gradient renders');
await gradFx({ stops: [{ at: 0, color: '#ff0000', alpha: 1 }, { at: 1, color: '#ff0000', alpha: 0 }] });
const fadeL = await rgbOf(103, 150), fadeR = await rgbOf(197, 150); assert.ok(fadeL[0] > 200 && fadeL[2] < 60 && fadeR[2] > 160 && fadeR[0] < 90, `${fadeL} ${fadeR}`); ok('per-stop opacity fades the overlay out to the layer\'s own colour');
await gradFx({ reverse: true }); assert.ok(lum(await rgbOf(103, 150)) > 215 && lum(await rgbOf(197, 150)) < 40); ok('Reverse flips the gradient');
await gradFx({ scale: 0.5 }); assert.ok(lum(await rgbOf(110, 150)) < 15 && lum(await rgbOf(190, 150)) > 240); ok('Scale 50% compresses the gradient into the middle of the layer');

// satin
await fxScene('#ffffff');
await fxOn({ satin: { on: true, color: '#000000', opacity: 1, blend: 'normal', angle: 0, distance: 25, size: 10, invert: false } });
const satIn = [lum(await rgbOf(150, 150)), lum(await rgbOf(125, 150)), lum(await rgbOf(175, 150))];
await fxOn({ satin: { on: true, color: '#000000', opacity: 1, blend: 'normal', angle: 0, distance: 25, size: 10, invert: true } });
const satInv = [lum(await rgbOf(150, 150)), lum(await rgbOf(125, 150)), lum(await rgbOf(175, 150))];
const base = lum([32, 64, 224]);
assert.ok(satIn.some((v) => Math.abs(v - base) > 15) && satInv.some((v) => Math.abs(v - base) > 15), `${satIn} / ${satInv}`); assert.ok(satIn.some((v, i) => Math.abs(v - satInv[i]) > 20)); ok('Satin shades the interior, and Invert reverses the effect');
assert.ok(near(await rgbOf(60, 150), [255, 255, 255], 1)); ok('…without touching anything outside the shape');
await fxOpen('Satin'); assert.match(await page.locator('.fx-controls h3').textContent(), /Satin/); await page.keyboard.press('Escape'); await wait(); ok('Satin is in the Layer Style dialog');

// 6p. content-aware move / extend
const cmScene = async (mode) => {
  await page.evaluate((mode) => {
    window.__blank(400, 300); const a = window.__app, d = a.doc, x = d.layers[0].ctx;
    const img = x.createImageData(400, 300), px = img.data;
    for (let y = 0; y < 300; y++) for (let xx = 0; xx < 400; xx++) {
      const h = (((xx * 73856093) ^ (y * 19349663)) >>> 0) % 256, n = (h / 255 - 0.5) * 20, i = (y * 400 + xx) * 4, st = (Math.floor(xx / 20) % 2) * 30;
      px[i] = 110 + st + n; px[i + 1] = 120 + st + n; px[i + 2] = 100 + st + n; px[i + 3] = 255;
    }
    x.putImageData(img, 0, 0);
    x.fillStyle = '#d02828'; x.beginPath(); x.arc(100, 150, 16, 0, 7); x.fill();          // the object
    d.emit('structure'); d.setSelection(null);
    a.cmove.mode = mode; a.cmove.blend = true; a.clone.sample = 'layer'; a.setTool('cmove');
  }, mode);
  await wait();
};
const redness = (x, y) => page.evaluate(([x, y]) => { const d = window.__app.doc.layers[0].ctx.getImageData(x - 3, y - 3, 7, 7).data; let r = 0, g = 0; for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; } return (r - g) / (d.length / 4); }, [x, y]);
const dragSel = async (from, to) => {
  const a = await toScreen(...from), b = await toScreen(...to);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move((a.x + b.x) / 2, a.y, { steps: 5 }); await page.mouse.move(b.x, b.y, { steps: 5 }); await page.mouse.up();
  await page.waitForFunction(() => !document.querySelector('.caf-overlay'), null, { timeout: 60000 }); await wait(); await wait();
};
await cmScene('move');
assert.ok(await redness(100, 150) > 40); ok('content-aware move scene: a red object on a striped, textured background');
await lassoAround(100, 150, 28);
await dragSel([100, 150], [300, 150]);
assert.ok(await redness(300, 150) > 40, `moved object at destination (redness ${await redness(300, 150)})`); ok('Content-Aware Move: the object appears at the new position');
assert.ok(Math.abs(await redness(100, 150)) < 12, `old spot redness ${await redness(100, 150)}`); ok('…and the hole it left is filled with background (no red left behind)');
const holeStats = await discStats(100, 150, 18); assert.ok(holeStats.sd > 3 && holeStats.min > 60, `fill sd ${holeStats.sd} min ${holeStats.min}`); ok('…with texture, not a flat smear');
assert.equal(await page.evaluate(() => window.__app.doc.history.undoLabel), 'Content-Aware Move');
await page.keyboard.press('Control+z'); await wait();
assert.ok(await redness(100, 150) > 40 && Math.abs(await redness(300, 150)) < 12); ok('one undo step puts the object back and removes the copy');

await cmScene('extend');
await lassoAround(100, 150, 28);
await dragSel([100, 150], [300, 150]);
assert.ok(await redness(300, 150) > 40 && await redness(100, 150) > 40); ok('Extend mode copies the object and leaves the original in place');
await page.keyboard.press('Control+z'); await wait();
assert.ok(Math.abs(await redness(300, 150)) < 12); ok('undo removes the extended copy');
assert.equal(await page.evaluate(() => !!document.querySelector('[data-tool="cmove"], #tool-cmove')), true); ok('Content-Aware Move is in the toolbox');

// 6p2. Patch tool, Content-Aware mode
await patchScene('content');
await lassoAround(100, 150, 26);
await dragSel([100, 150], [60, 150]);
const cpatch = await discStats(100, 150, 14);
assert.ok(cpatch.min > 70, `blemish still there (min ${cpatch.min})`); ok('Patch (Content-Aware): the blemish is replaced');
assert.ok(Math.abs(cpatch.mean - 120) < 20 && cpatch.sd > 1.5, `mean ${cpatch.mean} sd ${cpatch.sd}`); ok('…with content matching the surroundings (not the brighter far side), not a flat smear');
assert.equal(await page.evaluate(() => window.__app.doc.history.undoLabel), 'Patch');
await page.keyboard.press('Control+z'); await wait();
assert.ok((await discStats(100, 150, 8)).mean < 60); ok('undo restores the blemish');

// 7. open PNG via file drop path
const png = await page.evaluate(async () => (await window.__openPng()));
assert.equal(png.w, 64); ok('PNG import creates document');

await page.screenshot({ path: 'tests/screenshot.png' });
console.log(errors.length ? `\nConsole errors:\n${errors.join('\n')}` : '\nNo console errors');
await browser.close(); srv.kill();
process.exit(errors.length ? 1 : 0);
