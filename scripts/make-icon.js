'use strict';

/**
 * Renders build/icon.png (1024×1024) without any image dependencies.
 * electron-builder converts this PNG into .icns (macOS) and .ico (Windows).
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 1024;

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuffer, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

function makeIcon() {
  const pixels = Buffer.alloc(SIZE * SIZE * 4);
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const radius = SIZE * 0.225; // outer rounded square
  const ringOuter = SIZE * 0.315;
  const ringInner = ringOuter - SIZE * 0.036;
  const hubRadius = SIZE * 0.062;
  const spokeRadius = SIZE * 0.016;
  const spokeDistance = SIZE * 0.205;

  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const i = (y * SIZE + x) * 4;
      const nx = (x - cx) / (SIZE / 2);
      const ny = (y - cy) / (SIZE / 2);

      // Rounded-square background with a soft diagonal gradient.
      const qx = Math.max(Math.abs(x - cx) - (SIZE / 2 - radius), 0);
      const qy = Math.max(Math.abs(y - cy) - (SIZE / 2 - radius), 0);
      const dist = Math.sqrt(qx * qx + qy * qy);
      const mask = 1 - smoothstep(radius - 1, radius + 1, dist + radius - radius);
      const squareMask = 1 - smoothstep(radius, radius + 2, dist);

      const gradient = mix(0.0, 1.0, (nx + ny + 2) / 4);
      let r = mix(26, 12, gradient);
      let g = mix(29, 14, gradient);
      let b = mix(36, 20, gradient);

      // Warm glow behind the ring.
      const glow = Math.max(0, 1 - Math.sqrt(nx * nx + ny * ny) / 1.15);
      r += glow * 26;
      g += glow * 18;
      b += glow * 6;

      // Film-reel ring.
      const radial = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      const ring = smoothstep(ringInner - 1.5, ringInner + 1.5, radial) * (1 - smoothstep(ringOuter - 1.5, ringOuter + 1.5, radial));
      r = mix(r, 240, ring);
      g = mix(g, 182, ring);
      b = mix(b, 75, ring);

      // Hub.
      const hub = 1 - smoothstep(hubRadius - 1.5, hubRadius + 1.5, radial);
      r = mix(r, 240, hub);
      g = mix(g, 182, hub);
      b = mix(b, 75, hub);

      // Four perforations around the ring.
      for (let k = 0; k < 4; k += 1) {
        const angle = 0; // computed below per position
        void angle;
        const ax = cx + Math.cos((k * Math.PI) / 2) * spokeDistance;
        const ay = cy + Math.sin((k * Math.PI) / 2) * spokeDistance;
        const d = Math.sqrt((x - ax) ** 2 + (y - ay) ** 2);
        const hole = 1 - smoothstep(spokeRadius - 1.5, spokeRadius + 1.5, d);
        r = mix(r, 11, hole);
        g = mix(g, 13, hole);
        b = mix(b, 17, hole);
      }

      // Keep the artwork inside a rounded square on a transparent canvas.
      const alpha = Math.round(squareMask * 255);
      const vignette = 1 - Math.max(0, Math.min(0.35, (Math.sqrt(nx * nx + ny * ny) - 0.55) * 0.4));

      pixels[i] = Math.round(Math.min(255, r * vignette));
      pixels[i + 1] = Math.round(Math.min(255, g * vignette));
      pixels[i + 2] = Math.round(Math.min(255, b * vignette));
      pixels[i + 3] = alpha;
      void mask;
    }
  }

  const outDir = path.join(__dirname, '..', 'build');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'icon.png');
  fs.writeFileSync(outFile, encodePng(SIZE, SIZE, pixels));
  console.log(`Wrote ${outFile}`);
}

makeIcon();
