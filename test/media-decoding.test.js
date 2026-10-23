import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, stat, truncate } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { validateMediaFile, createMediaFile, publishMedia } from '../src/media-files.js';
const exec = promisify(execFile);

test('缺少解码工具明确拒绝，不把魔数匹配当成技术验收成功', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'drama-decoder-missing-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'fixture.png'); await writeFile(file, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
  const previous = process.env.IRONWEAVE_FFPROBE; process.env.IRONWEAVE_FFPROBE = join(directory, 'intentionally-missing-ffprobe');
  try { await assert.rejects(validateMediaFile(file, { mime_type: 'image/png', width: 1, height: 1 }), { status: 503 }); }
  finally { if (previous === undefined) delete process.env.IRONWEAVE_FFPROBE; else process.env.IRONWEAVE_FFPROBE = previous; }
});
test('真实 ffmpeg 合成图片/视频完整解码验收，错误帧数与截断拒绝（无模型/GPU）', { skip: !(process.env.IRONWEAVE_FFMPEG && process.env.IRONWEAVE_FFPROBE) }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'drama-decoder-real-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const png = join(directory, 'synthetic.png'), mp4 = join(directory, 'synthetic.mp4');
  await exec(process.env.IRONWEAVE_FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=16x16:r=6', '-frames:v', '1', '-threads', '1', png], { maxBuffer: 65536 });
  await exec(process.env.IRONWEAVE_FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=16x16:r=6', '-frames:v', '12', '-c:v', 'mpeg4', '-threads', '1', mp4], { maxBuffer: 65536 });
  const { openDatabase } = await import('../src/database.js');
  const { generateOperation } = await import('../src/generation-operations.js');
  const { readApiConfig } = await import('../src/settings.js');
  const db = openDatabase(join(directory, 'real-decoding.sqlite')); t.after(() => db.close());
  let current, acknowledgements = 0, submissions = 0;
  const server = createServer(async (request, response) => {
    for await (const _ of request) {}
    if (request.url.endsWith('/ack')) {
      acknowledgements++;
      const saved = db.prepare('SELECT local_state,metadata_json FROM generation_operations WHERE task_id=?').get(current.task);
      assert.equal(saved.local_state, 'saved'); assert.equal(JSON.parse(saved.metadata_json).sha256, current.meta.sha256);
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ task_id: current.task, state: 'succeeded', bytes: current.meta.bytes, sha256: current.meta.sha256 })); return;
    }
    submissions++;
    const boundary = 'iw_' + 'e'.repeat(32);
    response.writeHead(200, { 'Content-Type': `multipart/mixed; boundary=${boundary}`, 'X-IronWeave-Protocol': '2' });
    const event = (type, seq, extra) => { const bytes = Buffer.from(JSON.stringify({ task_id: current.task, seq, type, state: type === 'accepted' ? 'accepted' : 'delivering', ...extra })); response.write(`--${boundary}\r\nContent-Type: application/json\r\nContent-Length: ${bytes.length}\r\n\r\n`); response.write(bytes); response.write('\r\n'); };
    event('accepted', 1, { seed: 1, workflow_version: 'cpu-fixture' }); event('output_begin', 2, current.meta);
    response.write(`--${boundary}\r\nContent-Type: ${current.meta.mime_type}\r\nContent-Length: ${current.meta.bytes}\r\n\r\n`);
    for await (const chunk of createReadStream(current.file, { highWaterMark: 65536 })) if (!response.write(chunk)) await once(response, 'drain');
    response.write('\r\n'); event('output_end', 3, current.meta); response.end(`--${boundary}--\r\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  for (const [file, mime, extra] of [[png, 'image/png', {}], [mp4, 'video/mp4', { frames: 12, fps: 6, duration_ms: 2000, has_audio: false }]]) {
    const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk);
    const meta = { mime_type: mime, width: 16, height: 16, bytes: (await stat(file)).size, sha256: hash.digest('hex'), ...extra };
    await validateMediaFile(file, meta);
    const ready = new Date().toISOString();
    current = { file, task: randomUUID(), meta: { ...meta, delivery_ready_at: ready, delivery_expires_at: new Date(Date.parse(ready) + 1800000).toISOString(), delivery_timeout_ms: 1800000 } };
    const configId = Number(db.prepare('INSERT INTO api_configs(name,type,base_url,api_key,model) VALUES(?,?,?,?,?)').run('CPU 合成', extra.frames ? 'video' : 'text_to_image', `http://127.0.0.1:${server.address().port}/v1`, 'synthetic-key', 'ironweave').lastInsertRowid);
    db.prepare("INSERT INTO api_protocols(config_id,protocol) VALUES(?,'ironweave2')").run(configId);
    const expected = { size: '16x16', ...(extra.frames ? { frames: extra.frames, fps: extra.fps } : {}) };
    const operation = await generateOperation(db, { projectId: null, kind: 'test', targetId: configId, config: readApiConfig(db, configId), source: { cpuFixture: true }, endpoint: extra.frames ? '/videos/generations' : '/images/generations', expected, body: { model: 'ironweave', prompt: 'CPU fixture only', ...expected } }, { directory });
    assert.equal(operation.deliveryConfirmed, true); assert.equal(operation.localState, 'confirmed');
    assert.equal(JSON.parse(db.prepare('SELECT accepted_json FROM generation_operations WHERE id=?').get(operation.id).accepted_json).workflow_version, 'cpu-fixture');
    await assert.rejects(validateMediaFile(file, { ...meta, width: 15 }));
    if (extra.frames) await assert.rejects(validateMediaFile(file, { ...meta, frames: 13 }));
    await truncate(file, 16); await assert.rejects(validateMediaFile(file, meta));
  }
  assert.equal(submissions, 2); assert.equal(acknowledgements, 2);
});


test('发布时文件 fsync 失败也关闭句柄，保留残片供同操作恢复', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'drama-publish-sync-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const id = randomUUID(), pending = await createMediaFile(id, directory);
  await pending.sink(Buffer.from('synthetic fixture'));
  t.mock.method(pending.file, 'sync', async () => { throw new Error('synthetic fsync failure'); });
  await assert.rejects(publishMedia(id, pending.file, directory), /synthetic fsync/);
  assert.equal(pending.file.fd, -1); assert.equal((await stat(pending.filename)).size, 17);
});


test('真实 WebM 可解码，Matroska/MPEG4 不能仅凭 EBML 魔数冒充 WebM', { skip: !(process.env.IRONWEAVE_FFMPEG && process.env.IRONWEAVE_FFPROBE) }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'drama-webm-type-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const meta = { mime_type: 'video/webm', width: 16, height: 16, frames: 12, fps: 6, duration_ms: 2000, has_audio: false };
  for (const [name, codec] of [['valid.webm', 'libvpx'], ['not-webm.mkv', 'mpeg4']]) {
    const file = join(directory, name);
    await exec(process.env.IRONWEAVE_FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=16x16:r=6', '-frames:v', '12', '-c:v', codec, '-threads', '1', file], { maxBuffer: 65536 });
    if (name.endsWith('.webm')) await validateMediaFile(file, { ...meta });
    else await assert.rejects(validateMediaFile(file, { ...meta }), /类型/);
  }
});

test('WebM 头截断、重复 DocType 或超限头不能进入解码或 ACK', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'drama-webm-header-')); t.after(() => rm(directory, { recursive: true, force: true }));
  for (const hex of ['1a45dfa3', '1a45dfa3874282846a756e6b', '1a45dfa38e4282847765626d4282847765626d', '1a45dfa301ffffffffffffff']) {
    const file = join(directory, 'invalid.webm'); await writeFile(file, Buffer.from(hex, 'hex'));
    await assert.rejects(validateMediaFile(file, { mime_type: 'video/webm', width: 16, height: 16 }), /类型/);
  }
});
