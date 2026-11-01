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

// 7. open PNG via file drop path
const png = await page.evaluate(async () => (await window.__openPng()));
assert.equal(png.w, 64); ok('PNG import creates document');

await page.screenshot({ path: 'tests/screenshot.png' });
console.log(errors.length ? `\nConsole errors:\n${errors.join('\n')}` : '\nNo console errors');
await browser.close(); srv.kill();
process.exit(errors.length ? 1 : 0);
