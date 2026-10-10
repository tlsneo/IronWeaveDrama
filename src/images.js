import { lookup } from 'node:dns/promises';
import { isIP, BlockList } from 'node:net';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { imageMime } from './model-client.js';

function reject(message) { throw Object.assign(new Error(message), { status: 502 }); }

const privateNetworks = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10], ['198.18.0.0', 15], ['224.0.0.0', 3]]) privateNetworks.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['::ffff:0:0', 96], ['::', 96]]) privateNetworks.addSubnet(address, prefix, 'ipv6');

export async function loadImage(source, baseUrl) {
  if (source.startsWith('data:')) return Buffer.from(source.slice(source.indexOf(',') + 1), 'base64');
  const url = new URL(source);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  try { addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true }); }
  catch { reject('图片地址无法解析；生成请求可能已计费，没有自动重试。'); }
  const sameOrigin = url.origin === new URL(baseUrl).origin;
  if (!addresses.length || (!sameOrigin && addresses.some(item => privateNetworks.check(item.address, item.family === 6 ? 'ipv6' : 'ipv4')))) reject('图片地址指向未配置的内网地址，已拒绝下载。');
  // 连接固定到已检查的地址，防止二次 DNS 解析绕过内网检查。
  return new Promise((resolve, rejectPromise) => {
    const request = (url.protocol === 'https:' ? httpsGet : httpGet)(url, {
      lookup: (_hostname, options, callback) => options.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family),
    }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        request.destroy(new Error('image request failed'));
        return;
      }
      let size = 0;
      const chunks = [];
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 32 * 1024 * 1024) request.destroy(new Error('image too large'));
        else chunks.push(chunk);
      });
      response.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
      response.on('error', error => request.destroy(error));
    });
    const timer = setTimeout(() => request.destroy(new Error('image timeout')), 60000);
    request.on('error', () => {
      clearTimeout(timer);
      rejectPromise(Object.assign(new Error('图片下载失败、超时或超过 32 MiB；原角色板不变，生成请求可能已计费，没有自动重试。'), { status: 502 }));
    });
  });
}

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
