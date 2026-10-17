import { spawn } from 'node:child_process';
import { open, mkdir, rename, unlink, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageMime } from './model-client.js';
import { protocolError } from './ironweave-client.js';

export const dataDirectory = resolve(process.env.IRONWEAVE_DRAMA_DATA_DIR || fileURLToPath(new URL('../data', import.meta.url)));
export const mediaDirectory = resolve(process.env.IRONWEAVE_DRAMA_MEDIA_DIR || join(dataDirectory, 'generated-media'));
export function mediaPath(id, temporary = false, directory = mediaDirectory) {
  if (!/^[a-f0-9-]{36}$/.test(id)) protocolError('媒体操作编号无效。');
  return join(directory, `${id}.${temporary ? 'part' : 'media'}`);
}
export async function createMediaFile(id, directory = mediaDirectory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = mediaPath(id, true, directory);
  // 只清理已持久登记的本次操作残片；不遍历媒体或旧作品目录。
  await unlink(filename).catch(error => { if (error.code !== 'ENOENT') throw error; });
  const file = await open(filename, 'wx', 0o600);
  return { filename, file, async sink(chunk) { let offset = 0; while (offset < chunk.length) { const { bytesWritten } = await file.write(chunk, offset); if (!bytesWritten) throw new Error('文件写入没有进展。'); offset += bytesWritten; } } };
}
export async function publishMedia(id, file, directory = mediaDirectory) {
  try { await file.sync(); } finally { await file.close(); }
  await rename(mediaPath(id, true, directory), mediaPath(id, false, directory));
  await syncPublishedMedia(id, directory);
}
export async function syncPublishedMedia(id, directory = mediaDirectory) {
  const file = await open(mediaPath(id, false, directory), 'r');
  try { await file.sync(); } finally { await file.close(); }
  const parent = await open(directory, 'r'); try { await parent.sync(); } finally { await parent.close(); }
}
export async function verifyFile(filename, meta) {
  if ((await stat(filename)).size !== meta.bytes) protocolError('已保存文件长度不符。');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename, { highWaterMark: 65536 })) hash.update(chunk);
  if (hash.digest('hex') !== meta.sha256) protocolError('已保存文件哈希不符。');
}
async function command(program, args, limit = 65536) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let size = 0, errors = 0; const chunks = []; let failure;
    const stop = message => { failure = new Error(message); child.kill('SIGKILL'); };
    const timer = setTimeout(() => stop('媒体验收超过资源时限。'), 600000);
    child.stdout.on('data', chunk => { size += chunk.length; if (size > limit) stop('媒体验收输出超限。'); else chunks.push(chunk); });
    child.stderr.on('data', chunk => { errors += chunk.length; if (errors > limit) stop('媒体解码错误输出超限。'); });
    child.on('error', () => { clearTimeout(timer); reject(Object.assign(new Error('缺少媒体解码工具；请配置 IRONWEAVE_FFPROBE 和 IRONWEAVE_FFMPEG，文件未确认交付。'), { status: 503 })); });
    child.on('close', code => { clearTimeout(timer); if (failure || code !== 0) reject(failure ?? new Error('完整媒体解码失败；没有发送 ACK。')); else resolvePromise(Buffer.concat(chunks).toString('utf8')); });
  });
}
// EBML 魔数也属于 Matroska；必须解析受限头中的 DocType，不能把 MKV 当 WebM。
function isWebmHeader(bytes) {
  function integer(offset, id = false) {
    let mask = 128, length = 1;
    while (mask && !(bytes[offset] & mask)) { mask >>= 1; length++; }
    if (!mask || length > (id ? 4 : 8) || offset + length > bytes.length) return null;
    let value = id ? bytes[offset] : bytes[offset] & (mask - 1);
    for (let i = 1; i < length; i++) value = value * 256 + bytes[offset + i];
    return Number.isSafeInteger(value) ? { value, length } : null;
  }
  const size = integer(4);
  if (!size || 4 + size.length + size.value > bytes.length) return false;
  let offset = 4 + size.length, docType;
  const end = offset + size.value;
  while (offset < end) {
    const id = integer(offset, true); if (!id) return false; offset += id.length;
    const length = integer(offset); if (!length) return false; offset += length.length;
    if (offset + length.value > end) return false;
    if (id.value === 0x4282) {
      if (docType !== undefined) return false;
      docType = bytes.subarray(offset, offset + length.value).equals(Buffer.from('webm'));
    }
    offset += length.value;
  }
  return docType === true;
}
export async function validateMediaFile(filename, meta) {
  const file = await open(filename, 'r'); let prefix = Buffer.alloc(8192);
  try { const { bytesRead } = await file.read(prefix); prefix = prefix.subarray(0, bytesRead); } finally { await file.close(); }
  const video = meta.mime_type.startsWith('video/');
  const mime = imageMime(prefix) || (prefix.toString('ascii', 4, 8) === 'ftyp' ? 'video/mp4' : prefix.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) && isWebmHeader(prefix) ? 'video/webm' : null);
  if (mime !== meta.mime_type) protocolError('媒体魔数与声明类型不一致。');
  const probe = process.env.IRONWEAVE_FFPROBE || 'ffprobe';
  const initial = JSON.parse(await command(probe, ['-v', 'error', '-max_alloc', '268435456', '-threads', '1', '-probesize', '1048576', '-analyzeduration', '1000000', '-show_entries', 'stream=codec_type,codec_name,width,height', '-of', 'json', filename]));
  if (meta.mime_type === 'video/webm' && initial.streams?.some(stream => stream.codec_type === 'video' ? !['vp8', 'vp9', 'av1'].includes(stream.codec_name) : stream.codec_type === 'audio' && !['opus', 'vorbis'].includes(stream.codec_name))) protocolError('WebM 音视频编码不符合容器类型。');
  const initialVideo = initial.streams?.filter(stream => stream.codec_type === 'video');
  if (initialVideo?.length !== 1 || initialVideo[0].width !== meta.width || initialVideo[0].height !== meta.height || meta.width * meta.height > 64000000) protocolError('解码前尺寸检查失败。');
  const raw = await command(probe, ['-v', 'error', '-max_alloc', '268435456', '-threads', '1', '-count_frames', '-show_entries', 'stream=codec_type,width,height,nb_read_frames,r_frame_rate:format=duration', '-of', 'json', filename]);
  const info = JSON.parse(raw), tracks = info.streams.filter(stream => stream.codec_type === 'video');
  if (tracks.length !== 1) protocolError('媒体须恰好包含一个画面轨道。');
  const stream = tracks[0];
  if (stream.width !== meta.width || stream.height !== meta.height || Number(stream.nb_read_frames) !== (video ? meta.frames : 1)) protocolError('实际解码尺寸或帧数与固定元数据不符。');
  if (video) {
    const [n, d] = stream.r_frame_rate.split('/').map(Number);
    if (n / d !== meta.fps || (meta.duration_ms !== undefined && Math.round(Number(info.format.duration) * 1000) !== meta.duration_ms) || (meta.has_audio !== undefined && info.streams.some(track => track.codec_type === 'audio') !== meta.has_audio)) protocolError('实际视频帧率、时长或音轨不符。');
  }
  if (video) { meta.duration_ms = Math.round(Number(info.format.duration) * 1000); meta.has_audio = info.streams.some(track => track.codec_type === 'audio'); if (!Number.isSafeInteger(meta.duration_ms) || meta.duration_ms <= 0) protocolError('容器时长无效。'); }
  await command(process.env.IRONWEAVE_FFMPEG || 'ffmpeg', ['-v', 'error', '-xerror', '-max_alloc', '268435456', '-threads', '1', '-i', filename, '-map', '0:v:0', '-map', '0:a?', '-f', 'null', '-']);
}
