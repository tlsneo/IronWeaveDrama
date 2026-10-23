import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { openDatabase } from '../src/database.js';
import * as settings from '../src/settings.js';

const base = { name: '隔离设置', type: 'text_to_image', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'synthetic-key', model: 'ironweave' };
function form(values) { const result = new FormData(); for (const [key, value] of Object.entries(values)) result.set(key, value); return result; }
function checkForm(config) { return form({ chargeConfirmed: 'yes', type: config.type, model: config.model, baseUrl: config.baseUrl }); }
function database(t) { const db = openDatabase(':memory:'); t.after(() => { if (db.isOpen) db.close(); }); return db; }
function insert(db, values = {}) { const c = { ...base, ...values }; return Number(db.prepare('INSERT INTO api_configs(name,type,base_url,api_key,model) VALUES(?,?,?,?,?)').run(c.name,c.type,c.baseUrl,c.apiKey,c.model).lastInsertRowid); }

test('新媒体默认 Weave，文字独立 chat，不为文字写入 legacy 标签', t => {
  const db = database(t);
  for (const type of ['text_to_image', 'image_to_image', 'video', 'llm']) {
    const saved = settings.saveApiConfig(db, null, form({ ...base, type, model: type === 'llm' ? 'my-chat' : 'ironweave' }));
    assert.equal(saved.protocol, type === 'llm' ? 'chat' : 'ironweave2');
    assert.equal(settings.readApiConfig(db, saved.id).protocol, saved.protocol);
    const option = db.prepare('SELECT protocol FROM api_protocols WHERE config_id=?').get(saved.id);
    assert.equal(option?.protocol, type === 'llm' ? undefined : 'ironweave2');
  }
});

test('历史标签不控制运行协议；地址、密钥、model、ID 及历史行读取时不改写', t => {
  const db = database(t);
  for (const type of ['text_to_image', 'image_to_image', 'video', 'llm', 'image_edit']) {
    const id = insert(db, { type, model: 'old-model', baseUrl: 'http://127.0.0.1:1/old' });
    db.prepare("INSERT INTO api_protocols(config_id,protocol) VALUES(?,'legacy')").run(id);
    const before = db.prepare('SELECT * FROM api_configs WHERE id=?').get(id);
    const config = settings.readApiConfig(db, id);
    assert.equal(config.protocol, type === 'llm' ? 'chat' : type === 'image_edit' ? 'unsupported' : 'ironweave2');
    assert.equal(config.model, before.model); assert.equal(config.baseUrl, before.base_url); assert.equal(config.apiKey, before.api_key);
    assert.deepEqual(db.prepare('SELECT * FROM api_configs WHERE id=?').get(id), before);
    assert.equal(db.prepare('SELECT protocol FROM api_protocols WHERE config_id=?').get(id).protocol, 'legacy');
  }
});

test('共用配置校验拒绝旧配置而不修改对象；合法代理 /v1 路径可用', t => {
  const db = database(t);
  const valid = { ...base, protocol: 'ironweave2' };
  for (const patch of [{ type: 'llm' }, { type: 'image_edit' }, { protocol: 'legacy' }, { model: 'custom' }, ...['http://127.0.0.1:1', 'https://example.test/notv1', 'file:///v1', 'https://u:p@example.test/v1', 'https://example.test/v1?q=x', 'https://example.test/v1#x'].map(baseUrl => ({ baseUrl }))]) {
    const config = { ...valid, ...patch }, copy = { ...config };
    assert.throws(() => settings.requireWeaveConfig(config), { status: 400 }); assert.deepEqual(config, copy);
  }
  assert.doesNotThrow(() => settings.requireWeaveConfig({ ...valid, baseUrl: 'https://example.test/proxy/v1' }));
  assert.equal(db.prepare('SELECT count(*) AS n FROM api_configs').get().n, 0);
});

test('主动保存拒绝 legacy、遮罩类型、无 /v1 及媒体自定义模型，失败不覆盖原记录', t => {
  const db = database(t), id = insert(db, { model: 'old-model' });
  const before = db.prepare('SELECT * FROM api_configs WHERE id=?').get(id);
  for (const patch of [{ protocol: 'legacy' }, { type: 'image_edit' }, { baseUrl: 'http://127.0.0.1:1' }, { model: 'old-model' }]) {
    assert.throws(() => settings.saveApiConfig(db, id, form({ ...base, ...patch })), { status: 400 });
    assert.deepEqual(db.prepare('SELECT * FROM api_configs WHERE id=?').get(id), before);
  }
  assert.throws(() => settings.saveApiConfig(db, null, form({ ...base, type: 'image_edit' })), { status: 400 });
  const saved = settings.saveApiConfig(db, id, form(base)); assert.equal(saved.id, id); assert.equal(saved.protocol, 'ironweave2');
});

async function transport(t) {
  const directory = await mkdtemp(join(tmpdir(), 'drama-settings-weave-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // 只在独占临时目录生成 CPU 测试媒体，不访问业务 data。
  process.env.IRONWEAVE_DRAMA_MEDIA_DIR = directory;
  const pngPath = join(directory, 'input.png'), videoPath = join(directory, 'output.webm');
  execFileSync(process.env.IRONWEAVE_FFMPEG, ['-v','error','-f','lavfi','-i','color=c=blue:s=16x16','-frames:v','1',pngPath]);
  execFileSync(process.env.IRONWEAVE_FFMPEG, ['-v','error','-f','lavfi','-i','color=c=blue:s=16x16:r=24','-frames:v','24','-c:v','libvpx',videoPath]);
  const png = await readFile(pngPath), video = await readFile(videoPath), requests = [], acks = [];
  const referenceInputs = [png];
  for (const color of ['red', 'green', 'white', 'black']) {
    const filename = join(directory, `${color}.png`);
    execFileSync(process.env.IRONWEAVE_FFMPEG, ['-v','error','-f','lavfi','-i',`color=c=${color}:s=16x16`,'-frames:v','1',filename]);
    referenceInputs.push(await readFile(filename));
  }
  const db = database(t), outputs = new Map(), control = {};
  let redirected = 0;
  const destination = createServer((_req, res) => { redirected++; res.end('{}'); });
  await new Promise(resolve => destination.listen(0,'127.0.0.1',resolve)); t.after(() => new Promise(resolve => destination.close(resolve)));
  const redirectUrl = `http://127.0.0.1:${destination.address().port}/v1/images/generations`;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    if (req.url.endsWith('/ack')) {
      const task = req.url.split('/').at(-2), meta = outputs.get(task);
      const row = db.prepare('SELECT * FROM generation_operations WHERE task_id=?').get(task);
      assert.equal(row.local_state, 'saved');
      const saved = await readFile(join(directory, `${row.id}.media`)); assert.equal(createHash('sha256').update(saved).digest('hex'), meta.sha256);
      acks.push(JSON.parse(bytes)); res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ task_id: task, state:'succeeded', bytes:meta.bytes, sha256:meta.sha256 })); return;
    }
    const body = req.headers['content-type'].startsWith('multipart/') ? await new Response(bytes, { headers: { 'Content-Type':req.headers['content-type'] } }).formData() : JSON.parse(bytes);
    requests.push({ path:req.url, body, protocol:req.headers['x-ironweave-protocol'] });
    if (control.raw !== undefined) { res.writeHead(control.status || 200, { 'Content-Type':'application/json', Location:redirectUrl }); res.end(control.raw); return; }
    const isVideo = req.url.includes('/videos/'), output = isVideo ? video : png;
    const task = randomUUID(), boundary = 'iw_' + 'd'.repeat(32), ready = Date.now();
    const meta = { mime_type:isVideo ? 'video/webm' : 'image/png', bytes:output.length, sha256:createHash('sha256').update(output).digest('hex'), width:16, height:16, delivery_ready_at:new Date(ready).toISOString(), delivery_expires_at:new Date(ready+1800000).toISOString(), delivery_timeout_ms:1800000, ...(isVideo ? { frames:24, fps:24, duration_ms:1000, has_audio:false } : {}) };
    outputs.set(task, meta);
    res.writeHead(200, { 'Content-Type':`multipart/mixed; boundary=${boundary}`, 'X-IronWeave-Protocol':'2' });
    const event = (type, seq, extra) => { const b=Buffer.from(JSON.stringify({ task_id:task, type, seq, state:type === 'accepted' ? 'accepted' : 'delivering', ...extra })); res.write(`--${boundary}\r\nContent-Type: application/json\r\nContent-Length: ${b.length}\r\n\r\n`); res.write(b); res.write('\r\n'); };
    event('accepted',1,{ seed:1, workflow_version:'synthetic' }); event('output_begin',2,meta);
    res.write(`--${boundary}\r\nContent-Type: ${meta.mime_type}\r\nContent-Length: ${output.length}\r\n\r\n`); res.write(output); res.write('\r\n'); event('output_end',3,meta); res.end(`--${boundary}--\r\n`);
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  return { db, png, referenceInputs, requests, acks, control, redirected: () => redirected, baseUrl:`http://127.0.0.1:${server.address().port}/v1` };
}

test('设置测试真实 Weave JSON、双参考有序 image[]、五图视频完整参数，持久保存后 ACK', { skip: !process.env.IRONWEAVE_FFMPEG || !process.env.IRONWEAVE_FFPROBE ? '须显式提供 IRONWEAVE_FFMPEG 和 IRONWEAVE_FFPROBE 以运行 CPU 解码回归' : false }, async t => {
  const f = await transport(t);
  for (const [type, count] of [['text_to_image',0],['image_to_image',2],['video',5],['video',0],['image_to_image',1],['image_to_image',51]]) {
    const saved = settings.saveApiConfig(f.db, null, form({ ...base, type, baseUrl:f.baseUrl, testSize:'16x16', videoProfiles:JSON.stringify([{size:'16x16',frames:24,fps:24}]) }));
    // 历史 legacy 标签不能启用旧 JSON 图片分支，也不能被读取过程改写。
    f.db.prepare("UPDATE api_protocols SET protocol='legacy' WHERE config_id=?").run(saved.id);
    const request = checkForm(saved);
    for (let i=0; i<count; i++) request.append('referenceImages',new File([f.referenceInputs[i % 5]],`chosen-${i}.png`,{type:'image/png'}));
    const prompt = '  第一图人物转身\r\n保留所有参考图顺序。  ';
    if (type === 'video') { request.set('profileIndex','0'); request.set('prompt',prompt); }
    const result = await settings.checkApiConfig(f.db,saved.id,request);
    assert.equal(result.verified,true); assert.equal(result.operation.deliveryConfirmed,true); assert.match(result.operation.mediaUrl,/^\/operations\//);
    const sent=f.requests.at(-1); assert.equal(sent.protocol,'2');
    assert.equal(sent.path, type === 'video' ? '/v1/videos/generations' : type === 'image_to_image' ? '/v1/images/edits' : '/v1/images/generations');
    if (count) {
      assert.ok(sent.body instanceof FormData); assert.equal(sent.body.get('image'),null);
      assert.deepEqual(sent.body.getAll('image[]').map(file=>file.name),Array.from({length:count},(_,i)=>`chosen-${i}.png`));
      for (const [index, image] of sent.body.getAll('image[]').entries()) assert.deepEqual(Buffer.from(await image.arrayBuffer()),f.referenceInputs[index % 5]);
      assert.equal(sent.body.get('size'),'16x16'); assert.equal(sent.body.get('model'),'ironweave');
      if (type === 'video') { assert.equal(sent.body.get('prompt'),prompt); assert.equal(sent.body.get('frames'),'24'); assert.equal(sent.body.get('fps'),'24'); assert.equal(result.kind,'video'); }
    } else {
      assert.equal(sent.body.size,'16x16'); assert.equal(sent.body.model,'ironweave');
      if (type === 'video') { assert.equal(sent.body.prompt,prompt); assert.equal(sent.body.frames,24); assert.equal(sent.body.fps,24); }
    }
    assert.equal(f.db.prepare('SELECT protocol FROM api_protocols WHERE config_id=?').get(saved.id).protocol,'legacy');
  }
  assert.equal(f.requests.length,6); assert.equal(f.acks.length,6);
  await t.test('媒体拒绝旧 JSON/Base64/URL、异步 task_id 与重定向，错误不泄密、不自动重发', async () => {
    const badBodies = ['not-json', '{}', '{"data":[]}', '{"data":[{}]}', '{"task_id":"pending"}', JSON.stringify({data:[{b64_json:f.png.toString('base64')}]}), '{"data":[{"url":"https://example.test/image.png"}]}', '{"error":{"message":"synthetic-key"}}'];
    for (const raw of badBodies) {
      const saved=settings.saveApiConfig(f.db,null,form({...base,baseUrl:f.baseUrl,testSize:'16x16'}));
      f.control.raw=raw; const before=f.requests.length;
      await assert.rejects(settings.checkApiConfig(f.db,saved.id,checkForm(saved)), error=>error.status===502 && !error.message.includes(base.apiKey));
      assert.equal(f.requests.length,before+1);
    }
    const saved=settings.saveApiConfig(f.db,null,form({...base,baseUrl:f.baseUrl,testSize:'16x16'}));
    f.control.status=302; f.control.raw='{}'; const before=f.requests.length;
    await assert.rejects(settings.checkApiConfig(f.db,saved.id,checkForm(saved)),{status:502});
    assert.equal(f.requests.length,before+1); assert.equal(f.redirected(),0); assert.equal(f.acks.length,6);
  });
  await t.test('无参考长中文从页面事件经真实 Drama HTTP 传递为上游 JSON，保存后 ACK', async () => {
    delete f.control.raw; delete f.control.status;
    const saved = settings.saveApiConfig(f.db, null, form({ ...base, type:'video', baseUrl:f.baseUrl, videoProfiles:JSON.stringify([{size:'16x16',frames:24,fps:24}]) }));
    // 动态导入确保媒体目录已由本次 transport 指定，绝不使用业务 data。
    const { createApp } = await import('../src/app.js');
    const app = createApp(f.db);
    await new Promise(resolve => app.listen(0,'127.0.0.1',resolve));
    try {
      const prompt = '字'.repeat(12000), events = {}, nodes = {};
      const getNode = id => nodes[id] ??= { value:'', dataset:{}, files:[], removeAttribute() {}, addEventListener(event, handler) { events[`${id}:${event}`] = handler; } };
      getNode('api-config-form').dataset = { id:String(saved.id), configured:'true' };
      getNode('api-type').value = 'video'; getNode('api-model').value = 'ironweave';
      getNode('api-base-url').value = f.baseUrl; getNode('api-test-profile').value = '0'; getNode('api-test-prompt').value = prompt;
      let status, submitted;
      const before = f.requests.length, ackBefore = f.acks.length;
      runInNewContext(await readFile(new URL('../public/settings.js', import.meta.url),'utf8'), {
        document: { getElementById:getNode }, window: { confirm:()=>true, addEventListener() {} },
        FormData, URLSearchParams, TypeError, Error,
        fetch: async (path, options) => {
          submitted = options.body;
          const response = await fetch(`http://127.0.0.1:${app.address().port}${path}`, options);
          status = response.status; return response;
        },
      });
      await events['check-api-connection:click']();
      assert.equal(status,200);
      assert.ok(submitted instanceof FormData); assert.equal(submitted.get('prompt'),prompt);
      assert.equal(f.requests.length,before+1); assert.equal(f.acks.length,ackBefore+1);
      assert.equal(f.requests.at(-1).path,'/v1/videos/generations');
      assert.deepEqual(f.requests.at(-1).body,{model:'ironweave',n:1,size:'16x16',prompt,frames:24,fps:24});
      assert.equal(getNode('settings-status').dataset.state,'verified');
      assert.equal(getNode('settings-error').textContent,'');
    } finally { await new Promise(resolve => app.close(resolve)); }
  });
});

test('设置测试坏字段和参考图限额在创建操作及任何网络请求前拒绝', async t => {
  const db=database(t); let calls=0;
  const server=createServer((_req,res)=>{ calls++; res.end('{}'); });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); t.after(()=>new Promise(resolve=>server.close(resolve)));
  const baseUrl=`http://127.0.0.1:${server.address().port}/v1`, id=insert(db,{type:'video',baseUrl});
  db.prepare("INSERT INTO api_protocols(config_id,protocol,video_profiles) VALUES(?,'ironweave2',?)").run(id,JSON.stringify([{size:'16x16',frames:24,fps:24}]));
  const config=settings.readApiConfig(db,id);
  const cases = [
    [f=>f.append('prompt','duplicate'),400], [f=>f.append('profileIndex','0'),400],
    [f=>f.set('profileIndex',''),400], [f=>f.set('profileIndex','0.0'),400], [f=>f.set('profileIndex','1'),400],
    [f=>f.set('prompt',' '),400], [f=>f.set('prompt','字'.repeat(12001)),400],
    [f=>f.set('prompt',new Blob(['prompt'])),400], [f=>f.set('mask',new Blob(['x'])),400],
    [f=>f.set('referenceImage',new Blob(['x'])),400], [f=>f.set('referenceImages','not-file'),400],
    [f=>f.set('referenceImages',new Blob(['fake'],{type:'image/png'})),400],
    [f=>{ for(let i=0;i<52;i++) f.append('referenceImages',new Blob(['x'],{type:'image/png'})); },413],
    [f=>f.append('referenceImages',new Blob([Buffer.alloc(32*1024*1024+1)],{type:'image/png'})),413],
    [f=>{ for(let i=0;i<2;i++) f.append('referenceImages',new Blob([Buffer.alloc(17*1024*1024)],{type:'image/png'})); },413],
    [f=>f.set('protocol','legacy'),400], [f=>f.set('unexpected','x'.repeat(65537)),413],
  ];
  for (const [mutate,status] of cases) {
    const request=checkForm(config); request.set('profileIndex','0'); request.set('prompt','完整提示词'); mutate(request);
    await assert.rejects(settings.checkApiConfig(db,id,request),{status});
  }
  const old=insert(db,{model:'old-model',baseUrl}); await assert.rejects(settings.checkApiConfig(db,old,checkForm(settings.readApiConfig(db,old))),{status:400});
  const edit=insert(db,{type:'image_edit',baseUrl}); await assert.rejects(settings.checkApiConfig(db,edit,checkForm(settings.readApiConfig(db,edit))),{status:400});
  const image=insert(db,{type:'image_to_image',baseUrl}); await assert.rejects(settings.checkApiConfig(db,image,checkForm(settings.readApiConfig(db,image))),{status:400});
  assert.equal(db.prepare('SELECT count(*) AS n FROM generation_operations').get().n,0); assert.equal(calls,0);
});
