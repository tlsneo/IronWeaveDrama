import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { deflateSync } from 'node:zlib';

const directory = await mkdtemp(join(tmpdir(), 'drama-image-size-'));
process.env.IRONWEAVE_DRAMA_MEDIA_DIR = directory;
after(() => rm(directory, { recursive: true, force: true }));
const { openDatabase } = await import('../src/database.js');
const { generateResourceImage, resourceRevision, requestedImageSize } = await import('../src/resource-images.js');
const { generateLookImage, findLook, lookInputs } = await import('../src/looks.js');
const { createApp } = await import('../src/app.js');
const { mediaPath } = await import('../src/media-files.js');

function png(width, height) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    const output = Buffer.alloc(body.length + 8); output.writeUInt32BE(data.length); body.copy(output, 4); output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4); return output;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc((width * 3 + 1) * height))), chunk('IEND', Buffer.alloc(0))]);
}
const references = [png(16, 9), png(2, 3), png(4, 3)];
async function fixture(t, kind, reference = false) {
  const db = openDatabase(':memory:'); let app;
  t.after(async () => { if (app) { app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); } else db.close(); });
  db.exec("INSERT INTO projects VALUES(1,'隔离测试','手绘','16:9'); INSERT INTO characters(id,project_id,name,age) VALUES(1,1,'演员',28); INSERT INTO scenes(id,project_id,name) VALUES(1,1,'房间'); INSERT INTO looks(id,project_id,name,character_id,prompt) VALUES(1,1,'定妆',1,'  我的原提示词。  ')");
  const calls = [], control = { legacy: false, wrongSize: false, output: png(1536, 864) }; let acknowledgements = 0;
  const provider = createServer(async (req, res) => {
    const output = control.output;
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    if (req.url.endsWith('/ack')) {
      acknowledgements++; const receipt = JSON.parse(Buffer.concat(chunks));
      const row = db.prepare('SELECT * FROM generation_operations WHERE task_id=?').get(req.url.split('/').at(-2));
      assert.equal(row.local_state, 'saved'); assert.deepEqual(await readFile(mediaPath(row.id)), output);
      if (control.ackRejected) { res.writeHead(422, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'receipt_mismatch', message: 'synthetic mismatch' } })); return; }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ task_id: row.task_id, state: 'succeeded', ...receipt })); return;
    }
    const multipart = req.headers['content-type'].startsWith('multipart/form-data');
    const body = multipart ? await new Response(Buffer.concat(chunks), { headers: { 'Content-Type': req.headers['content-type'] } }).formData() : JSON.parse(Buffer.concat(chunks));
    const files = multipart ? await Promise.all([...body.getAll('image'), ...body.getAll('image[]')].map(async file => Buffer.from(await file.arrayBuffer()))) : [];
    calls.push({ path: req.url, size: multipart ? body.get('size') : body.size, files, single: multipart ? body.has('image') : false });
    if (control.legacy) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ b64_json: references[0].toString('base64') }] })); return; }
    const boundary = 'iw_' + 'f'.repeat(32), task = randomUUID(), ready = new Date().toISOString();
    const meta = { mime_type: 'image/png', bytes: output.length, sha256: createHash('sha256').update(output).digest('hex'), width: control.wrongSize ? 2560 : output.readUInt32BE(16), height: control.wrongSize ? 1440 : output.readUInt32BE(20), delivery_ready_at: ready, delivery_expires_at: new Date(Date.parse(ready) + 1800000).toISOString(), delivery_timeout_ms: 1800000 };
    res.writeHead(200, { 'Content-Type': `multipart/mixed; boundary=${boundary}`, 'X-IronWeave-Protocol': '2' });
    const event = (type, seq, extra) => { const bytes = Buffer.from(JSON.stringify({ task_id: task, type, seq, state: type === 'accepted' ? 'accepted' : 'delivering', ...extra })); res.write(`--${boundary}\r\nContent-Type: application/json\r\nContent-Length: ${bytes.length}\r\n\r\n`); res.write(bytes); res.write('\r\n'); };
    event('accepted', 1, { seed: 1, workflow_version: 'cpu-size-fixture' }); event('output_begin', 2, meta);
    res.write(`--${boundary}\r\nContent-Type: image/png\r\nContent-Length: ${output.length}\r\n\r\n`); res.write(output); res.write('\r\n'); event('output_end', 3, meta); res.end(`--${boundary}--\r\n`);
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => provider.close(resolve)));
  const baseUrl = `http://127.0.0.1:${provider.address().port}/v1`;
  db.prepare("INSERT INTO api_configs(id,name,type,base_url,api_key,model) VALUES(1,'合成',?,?,'synthetic-key','ironweave')").run(reference || kind === 'look' ? 'image_to_image' : 'text_to_image', baseUrl);
  db.exec("INSERT INTO api_protocols(config_id,protocol,test_size) VALUES(1,'ironweave2','1024x1024')");
  if (reference || kind === 'look') db.prepare(`INSERT INTO ${kind === 'scene' ? 'scene_references(scene_id' : 'character_references(character_id'},image,mime,width,height) VALUES(1,?,'image/png',16,9)`).run(references[0]);
  if (kind === 'look') {
    // 故意先插道具、后插服饰；仍须演员、服饰、道具，不跟请求ID排序变化。
    db.exec("INSERT INTO production_assets(id,project_id,kind,name) VALUES(1,1,'props','道具'),(2,1,'costumes','服饰'); INSERT INTO look_assets(look_id,asset_id) VALUES(1,1),(1,2)");
    for (const [id, bytes, width] of [[1,references[2],4],[2,references[1],2]]) db.prepare("INSERT INTO production_asset_images(asset_id,image,mime,width,height) VALUES(?,?,'image/png',?,3)").run(id, bytes, width);
  }
  const generate = (size = '1536x864', duplicate = false) => {
    const fields = { apiConfigId: '1', chargeConfirmed: 'yes', model: 'ironweave', baseUrl };
    const form = extra => { const body = new URLSearchParams({ ...fields, ...extra }); if (size !== null) body.set('size', size); if (duplicate) body.append('size', size); return body; };
    if (kind === 'look') { const look = findLook(db, 1, 1); return generateLookImage(db, 1, 1, form({ revision: String(look.revision), inputRevision: lookInputs(db, 1, look).revision })); }
    const item = db.prepare(`SELECT * FROM ${kind === 'character' ? 'characters' : 'scenes'} WHERE id=1`).get(), project = db.prepare('SELECT * FROM projects WHERE id=1').get();
    return generateResourceImage(kind, db, 1, 1, form({ revision: resourceRevision(kind, item, project), referenceId: reference ? '1' : '' }));
  };
  return { db, calls, control, generate, createApp: () => app = createApp(db), acknowledgements: () => acknowledgements };
}
const decoding = { skip: !(process.env.IRONWEAVE_FFMPEG && process.env.IRONWEAVE_FFPROBE) };
for (const [kind, reference] of [['character',false],['character',true],['scene',false],['scene',true],['look',false]]) {
  test(`protocol2 ${kind}/${reference ? 'reference' : 'text-or-look'} 使用本次1536x864（testSize=1024x1024不影响），请求与expected一致，CPU解码保存确认且不自动采用`, decoding, async t => {
    const f = await fixture(t, kind, reference), result = await f.generate();
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].size, '1536x864'); assert.equal(f.calls[0].path, reference || kind === 'look' ? '/v1/images/edits' : '/v1/images/generations');
    assert.deepEqual(f.calls[0].files, kind === 'look' ? references : reference ? [references[0]] : []);
    assert.equal(f.calls[0].single, reference); assert.equal(f.acknowledgements(), 1);
    assert.equal(result.operation.deliveryConfirmed, true); assert.equal(result.operation.adopted, false);
    const row = f.db.prepare('SELECT * FROM generation_operations').get();
    assert.deepEqual(JSON.parse(row.request_json).expected, { size: '1536x864' }); assert.equal(JSON.parse(row.metadata_json).width, 1536); assert.equal(JSON.parse(row.metadata_json).height, 864);
    assert.equal(f.db.prepare(`SELECT count(*) AS n FROM ${kind === 'character' ? 'character_boards' : kind === 'scene' ? 'scene_images' : 'look_images'}`).get().n, 0);
  });
}
for (const kind of ['character','scene','look']) {
  test(`protocol2 ${kind} 缺失、重复、非法、超限或不匹配本次尺寸在网络请求与操作登记前400`, async t => {
    const f = await fixture(t, kind);
    for (const size of [null, '', '1024x1024', '864x1536', '01536x864', '1536X864', '1536x864\n', '1536 x864', '0x9', '-16x9', '1.6x9', '16e2x900', '9007199254740992x1', '9007199254740991x1', '16000x9000']) {
      await assert.rejects(f.generate(size), { status: 400 }, size ?? 'missing requested size');
    }
    await assert.rejects(f.generate('1536x864', true), { status: 400 });
    if (kind === 'scene') { f.db.exec("UPDATE projects SET aspect_ratio='1:1'"); await assert.rejects(f.generate(null), { status: 400 }); }
    assert.equal(f.calls.length, 0); assert.equal(f.db.prepare('SELECT count(*) AS n FROM generation_operations').get().n, 0);
  });
  test(`旧legacy标签 ${kind} 也必须显式size，单JSON图片响应拒绝且不产生BLOB`, async t => {
    const f = await fixture(t, kind); f.control.legacy = true;
    f.db.exec("UPDATE api_protocols SET protocol='legacy',test_size='1536x864'");
    await assert.rejects(f.generate(null), { status: 400 });
    assert.equal(f.calls.length, 0);
    await assert.rejects(f.generate('1536x864'), { status: 502 });
    assert.equal(f.calls.length, 1); assert.equal(f.acknowledgements(), 0);
    assert.equal(f.db.prepare(`SELECT count(*) AS n FROM ${kind === 'character' ? 'character_boards' : kind === 'scene' ? 'scene_images' : 'look_images'}`).get().n, 0);
  });
}
test('protocol2 请求1536x864不能接受旧2560x1440响应元数据，不保存不ACK', async t => {
  const f = await fixture(t, 'scene'); f.control.wrongSize = true;
  await assert.rejects(f.generate(), { status: 502 }); assert.equal(f.calls[0].size, '1536x864'); assert.equal(f.acknowledgements(), 0);
  const row = f.db.prepare('SELECT * FROM generation_operations').get(); assert.equal(row.metadata_json, null);
});
for (const kind of ['character', 'scene', 'look']) {
  test(`protocol2 ${kind} 另一合法本次尺寸2560x1440也原样请求与保存expected，不写死1536`, decoding, async t => {
    const f = await fixture(t, kind); f.control.output = png(2560, 1440);
    const result = await f.generate('2560x1440'); assert.equal(result.operation.deliveryConfirmed, true);
    assert.equal(f.calls[0].size, '2560x1440');
    assert.deepEqual(JSON.parse(f.db.prepare('SELECT request_json FROM generation_operations').get().request_json).expected, { size: '2560x1440' });
  });
}
test('真实Drama HTTP表单的本次size传至上游，不采用配置测试尺寸；页面字段可编辑且初值为空', decoding, async t => {
  const f = await fixture(t, 'scene'), app = f.createApp();
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.address().port}`;
  for (const [resource, id] of [['characters','character'],['scenes','scene'],['looks','look']]) {
    const html = await (await fetch(`${url}/projects/1?resource=${resource}&${id}=1`)).text();
    const input = html.match(new RegExp(`<input[^>]*id="${id}-image-size"[^>]*>`))?.[0];
    assert.ok(input, `${id} size field`); assert.match(input, /name="size"/); assert.match(input, /required/);
    assert.match(input, /pattern="\[1-9\]\[0-9\]\*x\[1-9\]\[0-9\]\*"/);
    assert.doesNotMatch(input, /hidden|readonly|disabled|value="[^"]+"/);
    assert.match(html, /输出尺寸（宽x高）/); assert.match(html, /Iron 已验证组合/);
  }
  const item = f.db.prepare('SELECT * FROM scenes WHERE id=1').get(), project = f.db.prepare('SELECT * FROM projects WHERE id=1').get();
  const config = f.db.prepare('SELECT base_url FROM api_configs').get();
  const body = new URLSearchParams({ size: '1536x864', apiConfigId: '1', model: 'ironweave', baseUrl: config.base_url, chargeConfirmed: 'yes', revision: resourceRevision('scene', item, project), referenceId: '' });
  const response = await fetch(`${url}/projects/1/scenes/1/generate`, { method: 'POST', body });
  assert.equal(response.status, 200); assert.equal((await response.json()).operation.deliveryConfirmed, true);
  assert.equal(f.calls[0].size, '1536x864');
});

test('尺寸边界包含64,000,000像素，非法类型、空白、非安全整数与比例不符明确400', () => {
  const config = { protocol: 'ironweave2', testSize: '1024x1024' };
  assert.equal(requestedImageSize(config, new URLSearchParams({ size: '8000x8000' }), '1:1'), '8000x8000');
  for (const value of ['8001x8001', ' 8000x8000', '8000x8000\n', '+8000x8000', '８０００x8000', '9007199254740992x9007199254740992']) assert.throws(() => requestedImageSize(config, new URLSearchParams({ size: value }), '1:1'), { status: 400 });
  const file = new FormData(); file.set('size', new Blob(['1536x864']));
  assert.throws(() => requestedImageSize(config, file, '16:9'), { status: 400 });
  for (const [ratio, size] of [['9:16','864x1536'],['21:9','2688x1152'],['4:3','2048x1536'],['3:4','1536x2048'],['1:1','1024x1024']]) assert.equal(requestedImageSize(config, new URLSearchParams({ size }), ratio), size);
});

for (const kind of ['character', 'scene', 'look']) {
  test(`${kind} 已保存但ACK明确拒绝时保留真实拒绝说明，不误称确认未知或自动采用`, decoding, async t => {
    const f = await fixture(t, kind); f.control.ackRejected = true;
    const result = await f.generate();
    assert.equal(result.operation.localState, 'saved'); assert.equal(result.operation.deliveryConfirmed, false);
    assert.match(result.message, /交付确认已拒绝.*receipt_mismatch/); assert.doesNotMatch(result.message, /未确定/);
    assert.equal(f.calls.length, 1); assert.equal(f.acknowledgements(), 1);
    assert.equal(f.db.prepare(`SELECT count(*) AS n FROM ${kind === 'character' ? 'character_boards' : kind === 'scene' ? 'scene_images' : 'look_images'}`).get().n, 0);
  });
}
