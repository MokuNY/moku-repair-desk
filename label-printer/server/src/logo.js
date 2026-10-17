// Turn the shop logo PNG into a Zebra GRF graphic sized for a box in printer dots.

import fs from 'node:fs';
import { decodePng } from './png.js';

const cache = new Map();

/**
 * @param {string} path PNG file
 * @param {number} boxW max width in dots
 * @param {number} boxH max height in dots
 * @param {{ threshold?: number, dither?: boolean }} opts
 * @returns {{ width: number, height: number, bytesPerRow: number, hex: string } | null}
 */
export function logoGraphic(path, boxW, boxH, { threshold = 128, dither = false } = {}) {
  if (!path || !fs.existsSync(path)) return null;
  const stat = fs.statSync(path);
  const key = `${path}|${stat.mtimeMs}|${boxW}x${boxH}|${threshold}|${dither}`;
  if (cache.has(key)) return cache.get(key);

  const img = decodePng(fs.readFileSync(path));
  const lum = toLuminance(img); // 0 = black, 255 = white (alpha flattened on white)
  const cropped = cropToInk(lum, img.width, img.height, threshold);

  const scale = Math.min(boxW / cropped.width, boxH / cropped.height);
  const w = Math.max(1, Math.floor(cropped.width * scale));
  const h = Math.max(1, Math.floor(cropped.height * scale));
  const resized = resizeArea(cropped.data, cropped.width, cropped.height, w, h);
  const bits = dither ? floydSteinberg(resized, w, h, threshold) : resized.map((v) => (v < threshold ? 1 : 0));

  const bytesPerRow = Math.ceil(w / 8);
  const bytes = Buffer.alloc(bytesPerRow * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (bits[y * w + x]) bytes[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  const out = { width: w, height: h, bytesPerRow, hex: bytes.toString('hex').toUpperCase() };
  cache.set(key, out);
  return out;
}

function toLuminance({ width, height, rgba }) {
  const out = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const a = rgba[i * 4 + 3] / 255;
    const l = 0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2];
    out[i] = l * a + 255 * (1 - a);
  }
  return out;
}

/** Trim white/transparent margins so the logo uses the whole box. */
function cropToInk(lum, w, h, threshold) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (lum[y * w + x] < threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return { data: lum, width: w, height: h }; // blank image
  const cw = x1 - x0 + 1;
  const ch = y1 - y0 + 1;
  const data = new Float32Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) data[y * cw + x] = lum[(y + y0) * w + x + x0];
  }
  return { data, width: cw, height: ch };
}

/** Box-filter resample (area average) — keeps thin strokes from vanishing. */
function resizeArea(src, sw, sh, dw, dh) {
  const out = new Float32Array(dw * dh);
  const fx = sw / dw;
  const fy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy0 = y * fy, sy1 = sy0 + fy;
    for (let x = 0; x < dw; x++) {
      const sx0 = x * fx, sx1 = sx0 + fx;
      let sum = 0, area = 0;
      for (let yy = Math.floor(sy0); yy < Math.min(sh, Math.ceil(sy1)); yy++) {
        const wy = Math.min(yy + 1, sy1) - Math.max(yy, sy0);
        for (let xx = Math.floor(sx0); xx < Math.min(sw, Math.ceil(sx1)); xx++) {
          const wx = Math.min(xx + 1, sx1) - Math.max(xx, sx0);
          sum += src[yy * sw + xx] * wx * wy;
          area += wx * wy;
        }
      }
      out[y * dw + x] = area ? sum / area : 255;
    }
  }
  return out;
}

function floydSteinberg(lum, w, h, threshold) {
  const buf = Float32Array.from(lum);
  const bits = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const old = buf[i];
      const black = old < threshold;
      bits[i] = black ? 1 : 0;
      const err = old - (black ? 0 : 255);
      if (x + 1 < w) buf[i + 1] += (err * 7) / 16;
      if (y + 1 < h) {
        if (x > 0) buf[i + w - 1] += (err * 3) / 16;
        buf[i + w] += (err * 5) / 16;
        if (x + 1 < w) buf[i + w + 1] += err / 16;
      }
    }
  }
  return bits;
}
