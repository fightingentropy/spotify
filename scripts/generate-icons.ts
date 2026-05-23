import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const root = join(import.meta.dir, "..");
const svgPath = join(root, "src/app/icon.svg");
const svg = readFileSync(svgPath);

async function png(size: number) {
  return sharp(svg).resize(size, size).png().toBuffer();
}

const png16 = await png(16);
const png32 = await png(32);
const png48 = await png(48);

writeFileSync(join(root, "src/app/apple-icon.png"), await png(180));
writeFileSync(join(root, "public/apple-icon.png"), await png(180));
writeFileSync(join(root, "public/icon-512.png"), await png(512));

// ICO: PNG entries in a minimal ICO container (Windows Vista+ format).
function buildIco(images: Array<{ size: number; data: Buffer }>) {
  const count = images.length;
  const headerSize = 6 + count * 16;
  let offset = headerSize;
  const entries: Buffer[] = [];

  for (const image of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(image.size === 256 ? 0 : image.size, 0);
    entry.writeUInt8(image.size === 256 ? 0 : image.size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(image.data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += image.data.length;
  }

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);

  return Buffer.concat([header, ...entries, ...images.map((image) => image.data)]);
}

writeFileSync(
  join(root, "src/app/favicon.ico"),
  buildIco([
    { size: 16, data: png16 },
    { size: 32, data: png32 },
    { size: 48, data: png48 },
  ]),
);

console.log("Generated src/app/favicon.ico, apple-icon.png, public/icon-512.png");
