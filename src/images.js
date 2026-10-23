import { imageMime } from './model-client.js';

function reject(message) { throw Object.assign(new Error(message), { status: 502 }); }

export function imageDetails(bytes) {
  const mime = imageMime(bytes);
  let width, height;
  if (mime === 'image/png' && bytes.length >= 33 && bytes.toString('ascii', 12, 16) === 'IHDR') {
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
  } else if (mime === 'image/jpeg') {
    let offset = 2;
    while (offset + 3 < bytes.length && bytes[offset] === 255) {
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if ([217, 218].includes(marker)) break;
      if ([216, 1, 208, 209, 210, 211, 212, 213, 214, 215].includes(marker)) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && length >= 8) {
        height = bytes.readUInt16BE(offset + 3);
        width = bytes.readUInt16BE(offset + 5);
        break;
      }
      offset += length;
    }
  } else if (mime === 'image/webp' && bytes.length >= 25) {
    const chunk = bytes.toString('ascii', 12, 16);
    if (chunk === 'VP8X' && bytes.length >= 30) {
      width = bytes.readUIntLE(24, 3) + 1;
      height = bytes.readUIntLE(27, 3) + 1;
    } else if (chunk === 'VP8L' && bytes[20] === 47) {
      const bits = bytes.readUInt32LE(21);
      width = (bits & 16383) + 1;
      height = ((bits >>> 14) & 16383) + 1;
    } else if (chunk === 'VP8 ' && bytes.length >= 30 && bytes.subarray(23, 26).equals(Buffer.from([157, 1, 42]))) {
      width = bytes.readUInt16LE(26) & 16383;
      height = bytes.readUInt16LE(28) & 16383;
    }
  }
  if (!width || !height || width > 16384 || height > 16384 || width * height > 67108864) reject('生成结果不是可识别的安全尺寸 PNG、JPEG 或 WebP 图片。');
  return { mime, width, height };
}
