import { build } from 'esbuild';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

const here = new URL('.', import.meta.url).pathname;
const out = `${here}dist/`;
await mkdir(`${out}icons`, { recursive: true });

await build({
  entryPoints: {
    background: `${here}src/background.ts`,
    content: `${here}src/content.ts`,
    sidepanel: `${here}src/sidepanel.ts`,
    options: `${here}src/options.ts`,
    offscreen: `${here}src/offscreen.ts`,
  },
  outdir: out,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome116',
  sourcemap: 'linked',
  minify: true,
  logLevel: 'info',
});

for (const f of ['manifest.json', 'sidepanel.html', 'sidepanel.css', 'options.html', 'offscreen.html', 'theme-boot.js', 'obsidian-logo.svg']) {
  await cp(`${here}src/${f}`, `${out}${f}`);
}
await cp(`${here}src/_locales`, `${out}_locales`, { recursive: true });

// アイコン（黄色の角丸地に濃い縦線＝ハイライトされた行）を PNG で生成
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function icon(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const r = size * 0.2;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const i = y * (size * 4 + 1) + 1 + x * 4;
      // 角丸
      const cx = Math.min(Math.max(x + 0.5, r), size - r);
      const cy = Math.min(Math.max(y + 0.5, r), size - r);
      const inside = (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r;
      if (!inside) continue;
      let [R, G, B] = [255, 205, 40];
      const u = x / size, v = y / size;
      // 3 本の「行」
      const lines = [0.3, 0.5, 0.7];
      for (const ly of lines) {
        if (Math.abs(v - ly) < 0.055 && u > 0.22 && u < (ly === 0.5 ? 0.78 : 0.68)) [R, G, B] = ly === 0.5 ? [40, 40, 48] : [120, 90, 10];
      }
      raw[i] = R; raw[i + 1] = G; raw[i + 2] = B; raw[i + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
for (const s of [16, 48, 128]) await writeFile(`${out}icons/icon${s}.png`, icon(s));
