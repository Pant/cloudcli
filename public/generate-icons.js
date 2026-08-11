import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const iconsDirectory = fileURLToPath(new URL('./icons/', import.meta.url));
const ordinarySizes = [192, 512];
const maskableSizes = [192, 512];

function iconSvg(size, maskable) {
  const inset = maskable ? Math.round(size * 0.2) : Math.round(size * 0.12);
  const x1 = inset;
  const y1 = Math.round(size * 0.25);
  const x2 = size - inset;
  const y2 = Math.round(size * 0.61);
  const tailX = Math.round(size * 0.43);
  const tailY = size - inset;
  const stroke = Math.round(size * 0.0625);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="#18181b"/>
  <path d="M${x1} ${y1} Q${x1} ${y1 - stroke} ${x1 + stroke} ${y1 - stroke} H${x2 - stroke} Q${x2} ${y1 - stroke} ${x2} ${y1} V${y2 - stroke} Q${x2} ${y2} ${x2 - stroke} ${y2} H${tailX} L${x1} ${tailY} Z" fill="none" stroke="#fff" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
}

async function writeIcon(filename, size, maskable) {
  await sharp(Buffer.from(iconSvg(size, maskable))).png({ compressionLevel: 9, adaptiveFiltering: false }).toFile(path.join(iconsDirectory, filename));
  console.log(`generated icons/${filename}`);
}

await mkdir(iconsDirectory, { recursive: true });
for (const size of ordinarySizes) await writeIcon(`icon-${size}x${size}.png`, size, false);
for (const size of maskableSizes) await writeIcon(`icon-maskable-${size}x${size}.png`, size, true);
await writeIcon('apple-touch-icon-180x180.png', 180, false);
