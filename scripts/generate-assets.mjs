import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

// Run `npm run assets` to regenerate the checked-in brand images from the SVGs.
// Install a Japanese system font (Yu Gothic, Meiryo, or Noto Sans CJK JP) before
// regenerating the OG image. The deployment uses the checked-in PNG, so it never
// depends on fonts installed on the build server.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(projectRoot, "public");
const iconsRoot = path.join(publicRoot, "icons");
await mkdir(iconsRoot, { recursive: true });

const iconSvg = await readFile(path.join(publicRoot, "icon.svg"), "utf8");
const opaqueIconSvg = iconSvg
  .replace('rx="112"', 'rx="0"')
  .replace(/\s*<rect data-border="true"[^>]+\/>/, "");

const iconDefinitions = [
  { name: "icon-192.png", size: 192, svg: iconSvg },
  { name: "icon-512.png", size: 512, svg: iconSvg },
  { name: "maskable-512.png", size: 512, svg: opaqueIconSvg },
  { name: "apple-touch-icon.png", size: 180, svg: opaqueIconSvg },
];

for (const { name, size, svg } of iconDefinitions) {
  await sharp(Buffer.from(svg), { density: 192 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toFile(path.join(iconsRoot, name));
  console.info(`Generated public/icons/${name} (${size}×${size})`);
}

// ICO supports PNG image payloads. Include multiple exact sizes for crisp
// Windows/browser favicons without adding another asset-generation dependency.
const faviconSizes = [16, 32, 48, 64, 256];
const pngFrames = await Promise.all(
  faviconSizes.map((size) =>
    sharp(Buffer.from(iconSvg), { density: 192 })
      .resize(size, size)
      .png({ compressionLevel: 9 })
      .toBuffer(),
  ),
);
const icoHeader = Buffer.alloc(6 + faviconSizes.length * 16);
icoHeader.writeUInt16LE(0, 0);
icoHeader.writeUInt16LE(1, 2);
icoHeader.writeUInt16LE(faviconSizes.length, 4);
let frameOffset = icoHeader.length;
for (let index = 0; index < faviconSizes.length; index += 1) {
  const entryOffset = 6 + index * 16;
  const sizeByte = faviconSizes[index] === 256 ? 0 : faviconSizes[index];
  icoHeader.writeUInt8(sizeByte, entryOffset);
  icoHeader.writeUInt8(sizeByte, entryOffset + 1);
  icoHeader.writeUInt16LE(1, entryOffset + 4);
  icoHeader.writeUInt16LE(32, entryOffset + 6);
  icoHeader.writeUInt32LE(pngFrames[index].length, entryOffset + 8);
  icoHeader.writeUInt32LE(frameOffset, entryOffset + 12);
  frameOffset += pngFrames[index].length;
}
await writeFile(path.join(publicRoot, "favicon.ico"), Buffer.concat([icoHeader, ...pngFrames]));
console.info(`Generated public/favicon.ico (${faviconSizes.join(", ")}px)`);

await sharp(path.join(publicRoot, "og.svg"), { density: 144 })
  .resize(1200, 630)
  .png({ compressionLevel: 9 })
  .toFile(path.join(publicRoot, "og.png"));
console.info("Generated public/og.png (1200×630)");

for (const { name, size } of iconDefinitions) {
  const metadata = await sharp(path.join(iconsRoot, name)).metadata();
  if (metadata.width !== size || metadata.height !== size || metadata.format !== "png") {
    throw new Error(`Unexpected generated icon dimensions: ${name}`);
  }
}
const ogMetadata = await sharp(path.join(publicRoot, "og.png")).metadata();
if (ogMetadata.width !== 1200 || ogMetadata.height !== 630 || ogMetadata.format !== "png") {
  throw new Error("Unexpected generated OG image dimensions");
}
console.info("Asset dimensions verified. Visually inspect Japanese text in public/og.png after regeneration.");
