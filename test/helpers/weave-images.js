import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { after } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';

// 每个测试进程独占媒体目录；只使用真实 CPU 解码，不改变生产校验。
const directory = mkdtempSync(join(tmpdir(), 'drama-business-media-'));
process.env.IRONWEAVE_DRAMA_MEDIA_DIR = directory;
after(() => rm(directory, { recursive: true, force: true }));

export function png(width = 16, height = 9) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    const output = Buffer.alloc(body.length + 8); output.writeUInt32BE(data.length); body.copy(output, 4); output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4); return output;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height, 255);
  for (let y = 0; y < height; y++) pixels[y * (width * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

export function sendImage(response, bytes) {
  const task = randomUUID(), boundary = 'iw_' + 'd'.repeat(32), ready = new Date().toISOString();
  const meta = { mime_type: 'image/png', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), delivery_ready_at: ready, delivery_expires_at: new Date(Date.parse(ready) + 1800000).toISOString(), delivery_timeout_ms: 1800000 };
  response.writeHead(200, { 'Content-Type': `multipart/mixed; boundary=${boundary}`, 'X-IronWeave-Protocol': '2' });
  const event = (type, seq, extra) => { const data = Buffer.from(JSON.stringify({ type, seq, task_id: task, state: type === 'accepted' ? 'accepted' : 'delivering', ...extra })); response.write(`--${boundary}\r\nContent-Type: application/json\r\nContent-Length: ${data.length}\r\n\r\n`); response.write(data); response.write('\r\n'); };
  event('accepted', 1, { seed: 1, workflow_version: 'cpu-business-fixture' }); event('output_begin', 2, meta);
  response.write(`--${boundary}\r\nContent-Type: image/png\r\nContent-Length: ${bytes.length}\r\n\r\n`); response.write(bytes); response.write('\r\n'); event('output_end', 3, meta); response.end(`--${boundary}--\r\n`);
}

export async function acknowledge(db, request, response, raw) {
  if (!request.url.endsWith('/ack')) return false;
  const row = db.prepare('SELECT * FROM generation_operations WHERE task_id=?').get(request.url.split('/').at(-2));
  assert.equal(row.local_state, 'saved');
  const receipt = JSON.parse(raw), metadata = JSON.parse(row.metadata_json);
  const bytes = await readFile(join(directory, `${row.id}.media`));
  assert.equal(bytes.length, receipt.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), receipt.sha256);
  assert.equal(metadata.sha256, receipt.sha256);
  response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ task_id: row.task_id, state: 'succeeded', ...receipt })); return true;
}

// 测试中的独立人工动作：先断言生成未采用，再经真实采用路由提交。
export async function adoptResult(url, result, kind, targetId = 1) {
  assert.equal(result.operation.adopted, false); assert.equal(result.operation.deliveryConfirmed, true);
  const response = await fetch(`${url}/projects/1/operations/${result.operation.id}/adopt`, { method: 'POST', body: new URLSearchParams({ confirmed: 'yes' }) });
  const adopted = await response.json();
  if (!response.ok) throw Object.assign(new Error(adopted.error), { status: response.status });
  const resource = kind === 'character' ? 'characters' : kind === 'scene' ? 'scenes' : 'looks';
  return { ...result, valid: true, id: adopted.imageId, imageUrl: `/projects/1/${resource}/${targetId}/${kind === 'character' ? 'boards' : 'images'}/${adopted.imageId}` };
}
export async function adoptResponse(url, response, kind, targetId = 1) {
  if (!response.ok) return response;
  const result = await response.json();
  return Response.json(await adoptResult(url, result, kind, targetId));
}
