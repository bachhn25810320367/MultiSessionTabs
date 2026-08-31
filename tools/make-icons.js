"use strict";

// Generates icons/icon{16,32,48,128}.png without any dependency.
// Design: brand-blue (#1d4ed8) rounded square with two stacked white
// "session tabs" (the back one semi-transparent) to suggest multiple sessions.
// Usage: node tools/make-icons.js

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const BRAND = [29, 78, 216]; // #1d4ed8
const WHITE = [255, 255, 255];
const SIZES = [16, 32, 48, 128];
const SS = 4; // supersampling factor per axis

let crcTable;

main();

function main() {
  const outDir = path.resolve(__dirname, "..", "icons");
  fs.mkdirSync(outDir, { recursive: true });
  for (const size of SIZES) {
    const file = path.join(outDir, `icon${size}.png`);
    fs.writeFileSync(file, encodePNG(size, size, draw(size, size)));
    verifyPNG(file);
    console.log(`wrote ${file}`);
  }
}

// --- drawing ---------------------------------------------------------------

function insideRoundedRect(x, y, x0, y0, x1, y1, r) {
  const dx = Math.max(x0 - x, 0, x - x1);
  const dy = Math.max(y0 - y, 0, y - y1);
  return dx * dx + dy * dy <= r * r;
}

function draw(width, height) {
  // Shape predicates in normalized [0,1] coordinates.
  const shapes = [
    { test: (x, y) => insideRoundedRect(x, y, 0, 0, 1, 1, 0.22), color: BRAND, alpha: 1 },
    { test: (x, y) => insideRoundedRect(x, y, 0.22, 0.16, 0.78, 0.58, 0.1), color: WHITE, alpha: 0.45 },
    { test: (x, y) => insideRoundedRect(x, y, 0.22, 0.32, 0.78, 0.84, 0.1), color: WHITE, alpha: 1 }
  ];

  const pixels = Buffer.alloc(width * height * 4);
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / width;
          const y = (py + (sy + 0.5) / SS) / height;
          let cr = 0, cg = 0, cb = 0, ca = 0;
          for (const shape of shapes) {
            if (shape.test(x, y)) {
              cr = shape.color[0] * shape.alpha + cr * (1 - shape.alpha);
              cg = shape.color[1] * shape.alpha + cg * (1 - shape.alpha);
              cb = shape.color[2] * shape.alpha + cb * (1 - shape.alpha);
              ca = Math.max(ca, shape.alpha);
            }
          }
          r += cr; g += cg; b += cb; a += ca;
        }
      }
      const n = SS * SS;
      const o = (py * width + px) * 4;
      pixels[o] = Math.round(r / n);
      pixels[o + 1] = Math.round(g / n);
      pixels[o + 2] = Math.round(b / n);
      pixels[o + 3] = Math.round((a / n) * 255);
    }
  }
  return pixels;
}

// --- minimal PNG encoding --------------------------------------------------

function encodePNG(width, height, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  // bytes 10-12: compression, filter, interlace all 0

  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    pixels.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Sanity check: re-read the file and validate chunk CRCs and dimensions.
function verifyPNG(file) {
  const buf = fs.readFileSync(file);
  if (!buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    throw new Error(`${file}: bad signature`);
  }
  let offset = 8;
  let width = 0, height = 0;
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const expected = buf.readUInt32BE(dataStart + length);
    const actual = crc32(buf.subarray(offset + 4, dataStart + length));
    if (expected !== actual) throw new Error(`${file}: CRC mismatch in ${type}`);
    if (type === "IHDR") {
      width = buf.readUInt32BE(dataStart);
      height = buf.readUInt32BE(dataStart + 4);
    }
    offset = dataStart + length + 4;
  }
  if (path.basename(file) !== `icon${width}.png` || width !== height) {
    throw new Error(`${file}: unexpected dimensions ${width}x${height}`);
  }
}
