// Downloads real, Photoshop-authored PSD fixtures from the (MIT-licensed) ag-psd repository into tests/.psd-fixtures/
// (git-ignored — they are not part of this repo). Usage: node tests/fetch-psd-fixtures.mjs [outdir]
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const out = process.argv[2] ?? new URL('./.psd-fixtures/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const FILES = [
  'read-write/adjustments', 'read-write/effects', 'read-write/masks', 'read-write/stroke', 'read-write/text', 'read-write/text-box',
  'read/blend-mode', 'read/cmyk', 'read/effects', 'read/fill-opacity', 'read/gradient-overlay', 'read/grayscale', 'read/groups', 'read/layer-mask', 'read/layers', 'read/smart-object',
];
let got = 0, failed = 0;
for (const f of FILES) {
  const dest = join(out, f.replace('/', '__') + '.psd');
  if (existsSync(dest)) { got++; continue; }
  const res = await fetch(`https://raw.githubusercontent.com/Agamnentzar/ag-psd/master/test/${f}/src.psd`).catch(() => null);
  if (!res || !res.ok) { console.warn(`could not fetch ${f}`); failed++; continue; }
  writeFileSync(dest, Buffer.from(await res.arrayBuffer())); got++;
}
console.log(`${got}/${FILES.length} fixtures in ${out}${failed ? ` (${failed} failed — are you offline?)` : ''}`);
process.exit(failed && !got ? 1 : 0);
