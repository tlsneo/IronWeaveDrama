import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { receiveMixed, ironRequest, acknowledge, fetchOutput } from '../src/ironweave-client.js';

const task = '965375ee-5e5a-46bb-b187-23f779f3ddc1', boundary = 'iw_' + 'a'.repeat(32);
const bytes = Buffer.from('synthetic protocol bytes, not a decoded image');
function meta(data = bytes) { return { mime_type: 'image/png', bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'), width: 16, height: 9, delivery_ready_at: new Date().toISOString(), delivery_expires_at: new Date(Date.now() + 1800000).toISOString(), delivery_timeout_ms: 1800000 }; }
function part(type, data) { return Buffer.concat([Buffer.from(`Content-Type: ${type}\r\nContent-Length: ${data.length}\r\n\r\n`), data]); }
function wire({ data = bytes, change = () => {}, ending = '--\r\n', duplicate = false } = {}) {
  const m = meta(data); m.delivery_expires_at = new Date(Date.parse(m.delivery_ready_at) + 1800000).toISOString();
  const events = [{ type: 'accepted', state: 'accepted', task_id: task, seq: 1, seed: 7, workflow_version: 'fixture-v1' }, { type: 'output_begin', state: 'delivering', task_id: task, seq: 2, ...m }, { type: 'output_end', state: 'delivering', task_id: task, seq: 3, ...m }];
  change(events);
  const json = event => Buffer.from(duplicate ? JSON.stringify(event).replace('"seq":1', '"seq":0,"seq":1') : JSON.stringify(event));
  const parts = [part('application/json', json(events[0])), part('application/json', json(events[1])), part(m.mime_type, data), part('application/json', json(events[2]))];
  return Buffer.concat([Buffer.from(`--${boundary}\r\n`), ...parts.flatMap((p, i) => [p, Buffer.from(`\r\n--${boundary}${i === parts.length - 1 ? ending : '\r\n'}`)])]);
}
function response(data, split = 65536, headers = {}) {
  const stream = Readable.from((async function* () { for (let i = 0; i < data.length; i += split) yield data.subarray(i, i + split); })());
  stream.statusCode = 200; stream.headers = { 'content-type': `multipart/mixed; boundary=${boundary}`, 'x-ironweave-protocol': '2', ...headers }; return stream;
}
for (const split of [1, 2, 3, 7, 31, 65536]) test(`protocol 2 任意 ${split} 字节切分、正常 EOF 后交付而不等待 ACK`, async () => {
  const chunks = [], events = [];
  const result = await receiveMixed(response(wire(), split), { expected: { size: '16x9' }, sink: chunk => chunks.push(Buffer.from(chunk)), onEvent: e => events.push(e.type) });
  assert.deepEqual(Buffer.concat(chunks), bytes); assert.deepEqual(events, ['accepted', 'output_begin', 'output_end']); assert.equal(result.bytes, bytes.length); assert.ok(result.peakBufferBytes <= 65536);
});
const bad = [
  ['序号跳跃', e => { e[1].seq = 4; }], ['任务变化', e => { e[1].task_id = '00000000-0000-0000-0000-000000000000'; }],
  ['未知事件', e => { e[1].type = 'completed'; }], ['错误状态', e => { e[1].state = 'running'; }],
  ['非法 seed', e => { e[0].seed = -1; }], ['缺流程版本', e => { delete e[0].workflow_version; }],
  ['固定期限变化', e => { e[2].delivery_expires_at = new Date(Date.parse(e[2].delivery_expires_at) + 1).toISOString(); }],
  ['大小不符', e => { e[1].bytes++; }], ['哈希不符', e => { e[1].sha256 = e[2].sha256 = '0'.repeat(64); }],
  ['不安全整数', e => { e[1].bytes = 9007199254740992; }], ['超限图片', e => { e[1].bytes = 32 * 1024 * 1024 + 1; }],
  ['无效进度', e => { e[1].progress = { current: 2, total: 1, unit: 'steps' }; }], ['假成功', e => { e[2].state = 'succeeded'; }],
  ['视频参数缺失', e => { e[1].mime_type = 'video/webm'; }], ['错误请求尺寸', e => { e[1].width = 15; }],
];
for (const [label, change] of bad) test(`严格拒绝${label}`, async () => { await assert.rejects(receiveMixed(response(wire({ change }), 13), { expected: { size: '16x9' }, sink() {} })); });
for (const cut of [1, 20, 100, 300]) test(`截断 ${cut} 字节不能算完整媒体`, async () => { const data = wire(); await assert.rejects(receiveMixed(response(data.subarray(0, data.length - cut), 11), { sink() {} })); });
test('拒绝未知协议、重复头/JSON键、尾言、关闭标记缺失和超限事件头', async () => {
  for (const [data, headers] of [[wire(), { 'x-ironweave-protocol': '1' }], [wire({ duplicate: true }), {}], [wire({ ending: '--\r\ntrailer' }), {}], [wire({ ending: '\r\n' }), {}], [Buffer.from(wire().toString().replace('Content-Type: application/json', 'Content-Type: application/json\r\nContent-Type: application/json')), {}], [Buffer.from(wire().toString().replace('Content-Type: application/json', `X-Padding: ${'a'.repeat(8200)}\r\nContent-Type: application/json`)), {}]]) await assert.rejects(receiveMixed(response(data, 17, headers), { sink() {} }));
});
test('64 MiB 视频按 64 KiB 增量接收，不按整文件 Buffer 分配', async () => {
  const chunk = Buffer.alloc(65536, 19), count = 1024, hash = createHash('sha256'); for (let i = 0; i < count; i++) hash.update(chunk);
  const m = { ...meta(), mime_type: 'video/webm', bytes: chunk.length * count, sha256: hash.digest('hex'), frames: 124, fps: 24, duration_ms: 5167, has_audio: false }; m.delivery_expires_at = new Date(Date.parse(m.delivery_ready_at) + 1800000).toISOString();
  const event = (type, seq, extra) => part('application/json', Buffer.from(JSON.stringify({ type, task_id: task, seq, state: type === 'accepted' ? 'accepted' : 'delivering', ...extra })));
  const stream = Readable.from((async function* () {
    yield Buffer.from(`--${boundary}\r\n`); yield event('accepted', 1, { seed: 1, workflow_version: 'fixture' }); yield Buffer.from(`\r\n--${boundary}\r\n`); yield event('output_begin', 2, m); yield Buffer.from(`\r\n--${boundary}\r\nContent-Type: video/webm\r\nContent-Length: ${m.bytes}\r\n\r\n`);
    for (let i = 0; i < count; i++) yield chunk;
    yield Buffer.from(`\r\n--${boundary}\r\n`); yield event('output_end', 3, m); yield Buffer.from(`\r\n--${boundary}--\r\n`);
  })()); stream.statusCode = 200; stream.headers = response(Buffer.alloc(0)).headers;
  let received = 0, largest = 0; const before = process.memoryUsage().arrayBuffers;
  const result = await receiveMixed(stream, { expected: { size: '16x9', frames: 124, fps: 24 }, sink(chunk) { received += chunk.length; largest = Math.max(largest, chunk.length); } });
  assert.equal(received, m.bytes); assert.equal(largest, 65536); assert.ok(result.peakBufferBytes <= 65536); assert.ok(process.memoryUsage().arrayBuffers - before < 16 * 1024 * 1024);
});
test('原生 multipart 正确保留 image[] 顺序；ACK 丢失后核对同回执且不本地按期限拒绝', async t => {
  let calls = 0, form, ackType = 'application/json'; const fixed = meta();
  const server = createServer(async (req, res) => {
    if (req.url === '/images/edits') {
      form = await new Request('http://127.0.0.1', { method: 'POST', headers: req.headers, body: Readable.toWeb(req), duplex: 'half' }).formData(); res.writeHead(200); res.end('{}'); return;
    }
    calls++; const chunks = []; for await (const chunk of req) chunks.push(chunk);
    assert.deepEqual(JSON.parse(Buffer.concat(chunks)), { bytes: fixed.bytes, sha256: fixed.sha256 });
    if (calls === 1) { res.destroy(); return; }
    res.setHeader('Content-Type', ackType); res.end(JSON.stringify({ task_id: task, state: 'succeeded', bytes: fixed.bytes, sha256: fixed.sha256 }));
  }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const config = { baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'synthetic-key' }, body = new FormData(); body.set('prompt', '原文'); body.append('image[]', new Blob(['actor']), 'actor.png'); body.append('image[]', new Blob(['costume']), 'costume.png');
  const res = await ironRequest(config, '/images/edits', { body }); for await (const _ of res) {};
  assert.deepEqual(await Promise.all(form.getAll('image[]').map(file => file.text())), ['actor', 'costume']); assert.equal(form.get('prompt'), '原文');
  await assert.rejects(acknowledge(config, task, fixed)); fixed.delivery_expires_at = '2000-01-01T00:00:00.000Z';
  assert.equal((await acknowledge(config, task, fixed)).state, 'succeeded'); assert.equal(calls, 2);
  ackType = 'text/html'; await assert.rejects(acknowledge(config, task, fixed), /JSON/);
  ackType = ['application/json', 'text/html']; await assert.rejects(acknowledge(config, task, fixed), /重复/);
  ackType = 'application/json; charset=utf-8'; assert.equal((await acknowledge(config, task, fixed)).state, 'succeeded');
});
test('整文件 GET 校验任务、固定哈希、长度、期限；截断不通过', async t => {
  const m = meta(); m.delivery_expires_at = new Date(Date.parse(m.delivery_ready_at) + 1800000).toISOString(); let truncate = false;
  const server = createServer((req, res) => { assert.equal(req.method, 'GET'); assert.equal(req.headers.range, undefined); res.writeHead(200, { 'Content-Type': m.mime_type, 'Content-Length': m.bytes, 'X-IronWeave-Protocol': '2', 'X-IronWeave-Task-ID': task, 'X-IronWeave-Sha256': m.sha256, 'X-IronWeave-Delivery-Expires-At': m.delivery_expires_at, 'Accept-Ranges': 'none' }); if (truncate) { res.write(bytes.subarray(0, 3)); res.destroy(); } else res.end(bytes); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const config = { baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'fixture' }; let received = 0;
  await fetchOutput(config, task, m, { expected: { size: '16x9' }, sink: chunk => { received += chunk.length; } }); assert.equal(received, bytes.length);
  truncate = true; await assert.rejects(fetchOutput(config, task, m, { sink() {} }));
});

test('媒体内部跨块 MIME 边界碰撞不能当成合法原流文件', async () => { await assert.rejects(receiveMixed(response(wire({ data: Buffer.from(`before--${boundary}after`) }), 7), { sink() {} }), /边界/); });
