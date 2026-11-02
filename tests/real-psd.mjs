// Diagnostic: import every .psd in a folder with PixelForge, render it, and compare with the flattened preview Photoshop
// stored inside the file. Prints per-file structure, importer warnings and pixel-error metrics.
//   npm run build && node tests/real-psd.mjs <folder-with-psds> [--images <outdir>] [--check budgets.json]
// With --check, exits non-zero if a file's mean error exceeds its budget (a regression guard for Photoshop fidelity).
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const imgIdx = args.indexOf('--images'), imgDir = imgIdx >= 0 ? args[imgIdx + 1] : null, chkIdx = args.indexOf('--check'), chkFile = chkIdx >= 0 ? args[chkIdx + 1] : null;
const dir = args.find((a, i) => !a.startsWith('--') && !(imgIdx >= 0 && i === imgIdx + 1) && !(chkIdx >= 0 && i === chkIdx + 1));
if (!dir) { console.error('usage: node tests/real-psd.mjs <folder> [--images <outdir>]'); process.exit(2); }
if (imgDir) mkdirSync(imgDir, { recursive: true });
const files = readdirSync(dir).filter((f) => /\.ps[db]$/i.test(f)).sort();

const srv = spawn('npx', ['vite', 'preview', '--port', '4190', '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
await page.goto('http://localhost:4190/'); await page.waitForSelector('#stage');

const rows = [];
for (const f of files) {
  const b64 = readFileSync(join(dir, f)).toString('base64');
  const r = await page.evaluate(([b64, f, img]) => window.__psdCompare(b64, f, img), [b64, f, !!imgDir]).catch((e) => ({ name: f, error: 'crash: ' + e.message }));
  if (r.image && imgDir) writeFileSync(join(imgDir, f.replace(/\.ps[db]$/i, '') + '.png'), Buffer.from(r.image.split(',')[1], 'base64'));
  delete r.image; rows.push(r);
}
await browser.close(); srv.kill();

const pad = (s, n) => String(s).padEnd(n);
console.log(`\n${pad('file', 34)} ${pad('size', 11)} ${pad('L/G/A/fx/clip/mask', 20)} ${pad('MAE', 6)} ${pad('>16', 7)} ${pad('>48', 7)} notes`);
for (const r of rows) {
  if (r.error) { console.log(`${pad(r.name, 34)} ${pad(r.size ?? '', 11)} ${pad(r.layers !== undefined ? [r.layers, r.groups, r.adjustments, r.styled, r.clipped, r.masks].join('/') : '', 20)} ERROR: ${r.error}`); continue; }
  console.log(`${pad(r.name, 34)} ${pad(r.size, 11)} ${pad([r.layers, r.groups, r.adjustments, r.styled, r.clipped, r.masks].join('/'), 20)} ${pad(r.mae, 6)} ${pad(r.pctOver16 + '%', 7)} ${pad(r.pctOver48 + '%', 7)} ${r.notes.length ? r.notes.join(' | ') : ''}`);
}
if (pageErrors.length) console.log('\npage errors:\n' + pageErrors.join('\n'));
writeFileSync(join(imgDir ?? '.', imgDir ? 'results.json' : '.real-psd-results.json'), JSON.stringify(rows, null, 1));

if (chkFile) {
  const budgets = JSON.parse(readFileSync(chkFile, 'utf8'));
  let bad = 0;
  console.log('\nbudget check:');
  for (const r of rows) {
    const b = budgets[r.name];
    if (!b) { console.log(`  ?     ${r.name} (no budget)`); continue; }
    if (b.skip) { console.log(`  skip  ${r.name} — ${b.skip}`); if (r.error && !/no flattened preview/.test(r.error)) { console.log(`        but it failed to import: ${r.error}`); bad++; } continue; }
    const ok = !r.error && r.mae <= b.maxMAE;
    console.log(`  ${ok ? 'ok   ' : 'FAIL '} ${r.name}: MAE ${r.mae ?? 'n/a'} (budget ${b.maxMAE})${r.error ? ' — ' + r.error : ''}`);
    if (!ok) bad++;
  }
  if (pageErrors.length) bad++;
  if (bad) { console.error(`\n${bad} file(s) over budget`); process.exit(1); }
  console.log('\nall files within budget');
}
