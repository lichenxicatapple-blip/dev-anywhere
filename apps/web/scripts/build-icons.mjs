import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(HERE, "../public");
const SRC = resolve(PUBLIC, "brand-icon.svg");

const PNG_TARGETS = [
  { name: "apple-touch-icon-180x180.png", size: 180 },
  { name: "maskable-icon-512x512.png", size: 512 },
];
const FAVICON_SIZES = [16, 32, 48];

function renderPng(svg, size) {
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: size } });
  return resvg.render().asPng();
}

// ICO header (6B) + ICONDIRENTRY (16B/each) + 内联 PNG 帧。
// 现代 ICO 允许 PNG payload (不必转 BMP), 见 https://en.wikipedia.org/wiki/ICO_(file_format)。
function packIco(pngs, sizes) {
  const N = pngs.length;
  const headerSize = 6 + N * 16;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(N, 4);

  const entries = Buffer.alloc(N * 16);
  let offset = headerSize;
  pngs.forEach((png, i) => {
    const ePos = i * 16;
    // 单字节宽/高字段, 256 必须写 0; 当前 sizes 都 < 256 不会撞到。
    entries.writeUInt8(sizes[i], ePos + 0);
    entries.writeUInt8(sizes[i], ePos + 1);
    entries.writeUInt8(0, ePos + 2);
    entries.writeUInt8(0, ePos + 3);
    entries.writeUInt16LE(1, ePos + 4);
    entries.writeUInt16LE(32, ePos + 6);
    entries.writeUInt32LE(png.length, ePos + 8);
    entries.writeUInt32LE(offset, ePos + 12);
    offset += png.length;
  });

  return Buffer.concat([header, entries, ...pngs]);
}

const svg = readFileSync(SRC, "utf-8");

for (const { name, size } of PNG_TARGETS) {
  const png = renderPng(svg, size);
  writeFileSync(resolve(PUBLIC, name), png);
  console.log(`wrote ${name} (${size}x${size}, ${png.length} bytes)`);
}

const faviconPngs = FAVICON_SIZES.map((s) => renderPng(svg, s));
const ico = packIco(faviconPngs, FAVICON_SIZES);
writeFileSync(resolve(PUBLIC, "favicon.ico"), ico);
console.log(`wrote favicon.ico (${FAVICON_SIZES.join("/")} px, ${ico.length} bytes)`);
