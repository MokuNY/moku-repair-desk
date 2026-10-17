// Small PNG decoder (Node built-ins only) — enough for a logo file.
// Supports non-interlaced PNGs: grayscale, RGB, palette, gray+alpha, RGBA,
// bit depths 1/2/4/8/16. Returns 8-bit RGBA.

import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** @returns {{ width: number, height: number, rgba: Uint8Array }} */
export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('Logo is not a PNG file.');

  let off = 8;
  let ihdr = null;
  let palette = null;
  let trns = null;
  const idat = [];

  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    off += 12 + len;
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }

  if (!ihdr) throw new Error('PNG has no header.');
  const { width, height, depth, colorType, interlace } = ihdr;
  if (interlace) throw new Error('Interlaced PNGs are not supported — re-export the logo without interlacing.');
  const channels = CHANNELS[colorType];
  if (!channels) throw new Error(`Unsupported PNG colour type ${colorType}.`);

  const bitsPerPixel = channels * depth;
  const bpp = Math.max(1, bitsPerPixel >> 3); // bytes per pixel for filtering
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(stride * height);

  // Undo scanline filters.
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      switch (filter) {
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: v += paeth(a, b, c); break;
        default: break;
      }
      out[x] = v & 0xff;
    }
    prev = out;
  }

  // Expand to RGBA8.
  const rgba = new Uint8Array(width * height * 4);
  const sample = (row, i) => {
    // i-th sample in the row, scaled to 0..255
    if (depth === 8) return row[i];
    if (depth === 16) return row[i * 2];
    const perByte = 8 / depth;
    const byte = row[Math.floor(i / perByte)];
    const shift = 8 - depth * ((i % perByte) + 1);
    const v = (byte >> shift) & ((1 << depth) - 1);
    return colorType === 3 ? v : Math.round((v * 255) / ((1 << depth) - 1));
  };

  for (let y = 0; y < height; y++) {
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      let r, g, b, a = 255;
      if (colorType === 3) {
        const idx = sample(row, x);
        r = palette[idx * 3];
        g = palette[idx * 3 + 1];
        b = palette[idx * 3 + 2];
        if (trns && idx < trns.length) a = trns[idx];
      } else {
        const s = (k) => sample(row, x * channels + k);
        if (colorType === 0) {
          r = g = b = s(0);
        } else if (colorType === 4) {
          r = g = b = s(0);
          a = s(1);
        } else if (colorType === 2) {
          r = s(0); g = s(1); b = s(2);
        } else {
          r = s(0); g = s(1); b = s(2); a = s(3);
        }
      }
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = a;
    }
  }
  return { width, height, rgba };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}
