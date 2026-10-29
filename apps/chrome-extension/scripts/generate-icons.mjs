import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

const directory = new URL('../extension/icons/', import.meta.url);
const sizes = [16, 32, 48, 128];
const samples = 4;

function roundedRect(x, y, left, top, width, height, radius) {
  const dx = Math.max(left + radius - x, 0, x - (left + width - radius));
  const dy = Math.max(top + radius - y, 0, y - (top + height - radius));
  return dx * dx + dy * dy <= radius * radius;
}

function polygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [ax, ay] = points[i], [bx, by] = points[j];
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

function colorAt(x, y) {
  if (!roundedRect(x, y, 4, 4, 120, 120, 28)) return [0, 0, 0, 0];
  const blend = (x + y) / 256;
  let color = [Math.round(87 - 30 * blend), Math.round(89 - 28 * blend), Math.round(235 - 28 * blend), 255];
  if (roundedRect(x, y, 24, 28, 76, 57, 17)
    || polygon(x, y, [[35, 75], [35, 99], [60, 79]])) color = [255, 255, 255, 255];
  for (const center of [44, 63, 82]) {
    if ((x - center) ** 2 + (y - 56) ** 2 <= 5 ** 2) color = [83, 82, 220, 255];
  }
  // The dark outline separates the pointer from the white speech bubble at toolbar sizes.
  if (polygon(x, y, [[74, 65], [111, 89], [96, 93], [89, 109]])) color = [49, 46, 129, 255];
  if (polygon(x, y, [[80, 74], [101, 88], [91, 90], [88, 100]])) color = [103, 232, 249, 255];
  return color;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const result = Buffer.alloc(body.length + 8);
  result.writeUInt32BE(data.length, 0);
  body.copy(result, 4);
  result.writeUInt32BE(crc32(body), result.length - 4);
  return result;
}

function render(size) {
  const pixels = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sum = [0, 0, 0, 0];
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const color = colorAt((x + (sx + 0.5) / samples) * 128 / size, (y + (sy + 0.5) / samples) * 128 / size);
          for (let channel = 0; channel < 3; channel++) sum[channel] += color[channel] * color[3] / 255;
          sum[3] += color[3];
        }
      }
      const offset = y * (size * 4 + 1) + 1 + x * 4;
      for (let channel = 0; channel < 3; channel++) pixels[offset + channel] = sum[3] ? Math.round(sum[channel] * 255 / sum[3]) : 0;
      pixels[offset + 3] = Math.round(sum[3] / samples ** 2);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

await mkdir(directory, { recursive: true });
for (const size of sizes) await writeFile(new URL(`icon-${size}.png`, directory), render(size));
console.log(`Generated Chrome extension icons: ${sizes.join(', ')}px.`);
