// TIFF reading / writing (pure data in, pure data out; unit-tested) on top of utif2.
import * as UTIFns from 'utif2';
// utif2 is CommonJS: depending on the bundler the API is on the namespace or on its default export.
const UTIF: typeof UTIFns = ((UTIFns as unknown as { default?: typeof UTIFns }).default ?? UTIFns) as typeof UTIFns;

export interface TiffPage { w: number; h: number; rgba: Uint8ClampedArray }

/** Decodes every full-resolution page of a TIFF to 8-bit RGBA (reduced-resolution thumbnails are skipped). */
export function decodeTiff(data: ArrayBuffer): TiffPage[] {
  const ifds = UTIF.decode(data);
  const pages: TiffPage[] = [];
  for (const ifd of ifds) {
    const sub = ifd['t254'] as number[] | undefined;
    if (sub && (sub[0] & 1)) continue;                      // NewSubfileType bit 0 = reduced-resolution version of another page
    UTIF.decodeImage(data, ifd);
    if (!ifd.width || !ifd.height) continue;
    const rgba = new Uint8ClampedArray(UTIF.toRGBA8(ifd));
    const photo = (ifd['t262'] as number[] | undefined)?.[0] ?? 2, samples = (ifd['t277'] as number[] | undefined)?.[0] ?? 1;
    const colourSamples = photo === 5 ? 4 : photo === 2 ? 3 : 1;                 // CMYK / RGB / gray & palette
    if (samples <= colourSamples) for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;   // no alpha channel: fully opaque (utif leaves CMYK's last pixel at 0)
    pages.push({ w: ifd.width, h: ifd.height, rgba });
  }
  if (!pages.length) throw new Error('No readable image in this TIFF');
  return pages;
}

/** Uncompressed 8-bit RGBA TIFF (keeps transparency). */
export function encodeTiff(rgba: Uint8ClampedArray, w: number, h: number): Uint8Array {
  return new Uint8Array(UTIF.encodeImage(new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength), w, h));
}
