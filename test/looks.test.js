import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { openDatabase } from '../src/database.js';
import { createApp } from '../src/app.js';
import { findLook, lookInputs, readLookImage } from '../src/looks.js';

function png(width = 16, height = 9) {
  const bytes = Buffer.alloc(33); Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
  bytes.write('IHDR', 12); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20); return bytes;
}
async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}
async function fixture(t) {
  const db = openDatabase(':memory:');
  db.exec(`INSERT INTO projects VALUES (1, '定妆测试', '手绘', '16:9'), (2, '其他项目', '写实', '9:16');
    INSERT INTO characters (id, project_id, name) VALUES (1, 1, '演员'), (2, 2, '其他演员');
    INSERT INTO seasons VALUES (1, 1, '一季', 1); INSERT INTO episodes VALUES (1, 1, '一集', 1);
    INSERT INTO episode_scripts (episode_id, script, revision) VALUES (1, '不许改的剧本', 2);`);
  db.prepare("INSERT INTO character_references (character_id, image, mime, width, height) VALUES (1, ?, 'image/png', 16, 9)").run(png());
  const calls = []; let result = { data: [{ b64_json: png().toString('base64') }] }, status = 200, wait, started, finish;
  const provider = await listen(createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const form = await new Response(Buffer.concat(chunks), { headers: { 'Content-Type': request.headers['content-type'] } }).formData();
    const files = await Promise.all(form.getAll('image[]').map(async file => ({ type: file.type, name: file.name, bytes: Buffer.from(await file.arrayBuffer()) })));
    calls.push({ path: request.url, auth: request.headers.authorization, prompt: form.get('prompt'), model: form.get('model'), n: form.get('n'), size: form.get('size'), single: form.get('image'), files });
    if (wait) { started(); await wait; }
    response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result));
  }));
  db.prepare("INSERT INTO api_configs (id,name,type,base_url,api_key,model) VALUES (1,'图生图','image_to_image',?,'SYNTHETIC_LOOK_KEY','edit-model'), (2,'文生图','text_to_image',?,'SYNTHETIC_T2I_KEY','image-model')").run(provider.url + '/v1', provider.url + '/v1');
  const app = await listen(createApp(db));
  t.after(async () => { finish?.(); await app.close(); await provider.close(); });
  const post = (path, fields, options = {}) => fetch(app.url + path, { method: 'POST', body: fields instanceof FormData ? fields : new URLSearchParams(fields), ...options });
  const current = id => findLook(db, 1, id);
  const generateFields = id => ({ revision: String(current(id).revision), inputRevision: lookInputs(db, 1, current(id)).revision, apiConfigId: '1', model: 'edit-model', baseUrl: provider.url + '/v1', chargeConfirmed: 'yes' });
  const upload = (kind, id, bytes = png(2, 3), type = 'image/png') => {
    const asset = db.prepare('SELECT revision FROM production_assets WHERE id=?').get(id);
    const old = db.prepare('SELECT id FROM production_asset_images WHERE asset_id=? AND cleared=0 ORDER BY id DESC LIMIT 1').get(id);
    const body = new FormData(); body.set('revision', String(asset.revision)); body.set('referenceId', String(old?.id ?? 0)); body.set('referenceImage', new Blob([bytes], { type }), 'asset.png');
    return post(`/projects/1/${kind}/${id}/reference-image`, body);
  };
  const ready = async () => {
    for (const [kind, name] of [['costumes','外套'],['props','纸袋']]) {
      const response = await post(`/projects/1/${kind}`, { name }); assert.equal(response.status,201); const asset = await response.json();
      assert.equal((await upload(kind,asset.id, png(kind === 'costumes' ? 2 : 4,3))).status,200);
    }
    const response = await post('/projects/1/looks',{name:'表白定妆'}); const look = await response.json();
    const saved = await post(`/projects/1/looks/${look.id}`, { revision: String(look.revision), name:'表白定妆', characterId:'1', prompt:'  我自己的提示词：单人站立，穿外套，手持纸袋。\n不要四视图。  ', assetIds:'[2,1]' }); assert.equal(saved.status,200);
    return look.id;
  };
  return { db, ...app, calls, post, current, generateFields, upload, ready,
    generate: (id, overrides = {}) => post(`/projects/1/looks/${id}/generate`, { ...generateFields(id), ...overrides }),
    result(value, code = 200) { result=value; status=code; },
    pause() { wait=new Promise(resolve=>{finish=resolve;}); return new Promise(resolve=>{started=resolve;}); },
    resume() { finish(); wait=undefined; },
  };
}
const immutable = db => ['characters','character_references','episode_scripts','episode_storyboards'].map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());

test('素材与定妆创建保存不调用模型，用户提示词原样保存、关联按ID隔离、no-op保留版本，不改演员和剧本', async t => {
  const f=await fixture(t), before=immutable(f.db), id=await f.ready(), look=f.current(id);
  assert.equal(look.prompt,'  我自己的提示词：单人站立，穿外套，手持纸袋。\n不要四视图。  ');
  const fields={revision:String(look.revision),name:look.name,characterId:'1',prompt:look.prompt,assetIds:'[1,2]'};
  assert.equal((await f.post(`/projects/1/looks/${id}`,fields)).status,200); assert.equal(f.current(id).revision,look.revision);
  for (const overrides of [{characterId:'2'},{assetIds:'[999]'},{assetIds:'[1,1]'},{assetIds:'["1"]'},{assetIds:'null'},{prompt:'x'.repeat(12001)},{revision:'0'}]) assert.ok([400,404,409].includes((await f.post(`/projects/1/looks/${id}`,{...fields,...overrides})).status));
  f.db.exec("INSERT INTO production_assets(project_id,kind,name)VALUES(2,'props','外部道具')");
  assert.equal((await f.post(`/projects/1/looks/${id}`,{...fields,assetIds:'[3]'})).status,404);
  assert.deepEqual(f.current(id),look); assert.deepEqual(immutable(f.db),before); assert.equal(f.calls.length,0);
});

test('素材图上传替换与清除保留历史、不复活旧图；字节/MIME/大小/版本/所有权边界均不调用模型', async t => {
  const f=await fixture(t); const created=await (await f.post('/projects/1/costumes',{name:'衣服'})).json();
  assert.equal((await f.upload('costumes',created.id)).status,200);
  assert.equal((await f.upload('costumes',created.id,png(4,5))).status,200);
  const images=f.db.prepare('SELECT * FROM production_asset_images ORDER BY id').all(); assert.equal(images.length,2);
  for(const image of images){const r=await fetch(`${f.url}/projects/1/costumes/1/images/${image.id}`); assert.equal(r.status,200); assert.deepEqual(Buffer.from(await r.arrayBuffer()),Buffer.from(image.image));}
  assert.equal((await fetch(`${f.url}/projects/1/props/1/images/1`)).status,404); assert.equal((await fetch(`${f.url}/projects/2/costumes/1/images/1`)).status,404);
  const head=await fetch(`${f.url}/projects/1/costumes/1/images/2`,{method:'HEAD'}); assert.equal(head.status,200); assert.equal(await head.text(),'');
  assert.equal((await f.upload('costumes',1,png(),'image/jpeg')).status,400);
  assert.equal((await f.upload('costumes',1,Buffer.from('not image'))).status,400);
  assert.ok([400,413].includes((await f.upload('costumes',1,Buffer.alloc(5*1024*1024+1))).status));
  const revision=String(f.db.prepare('SELECT revision FROM production_assets WHERE id=1').get().revision);
  assert.equal((await f.post('/projects/1/costumes/1/clear-reference',{revision,referenceId:'2',confirmed:'no'})).status,400);
  assert.equal((await f.post('/projects/1/costumes/1/clear-reference',{revision,referenceId:'1',confirmed:'yes'})).status,409);
  assert.equal((await f.post('/projects/1/costumes/1/clear-reference',{revision,referenceId:'2',confirmed:'yes'})).status,200);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM production_asset_images WHERE cleared=0').get().n,0);
  assert.equal((await fetch(`${f.url}/projects/1/costumes/1/images/1`)).status,200); assert.equal(f.calls.length,0);
});

test('定妆单次真实multipart多图字段按演员/服饰/道具顺序，原提示词和版本快照落库；生成后不误标旧版，清图保留历史', async t => {
  const f=await fixture(t), id=await f.ready(), before=f.current(id), hash=lookInputs(f.db,1,before).revision, unchanged=immutable(f.db);
  const response=await f.generate(id); assert.equal(response.status,200); const result=await response.json();
  assert.equal(f.calls.length,1); const call=f.calls[0]; assert.equal(call.path,'/v1/images/edits'); assert.equal(call.auth,'Bearer SYNTHETIC_LOOK_KEY'); assert.equal(call.model,'edit-model'); assert.equal(call.n,'1'); assert.equal(call.size,'2560x1440'); assert.equal(call.single,null);
  assert.equal(call.files.length,3); assert.deepEqual(call.files.map(file=>file.bytes),[png(),png(2,3),png(4,3)]); assert.ok(call.prompt.replaceAll('\r\n','\n').endsWith(before.prompt), 'multipart正常统一换行，但不改写提示词内容');
  const image=f.db.prepare('SELECT * FROM look_images WHERE id=?').get(result.id); assert.equal(image.valid,1); assert.equal(image.revision,hash); assert.equal(image.prompt,call.prompt.replaceAll('\r\n','\n')); assert.equal(image.model,'edit-model');
  const inputs=JSON.parse(image.inputs_json); assert.equal(inputs.character.id,1); assert.equal(inputs.character.image.type,'references'); assert.deepEqual(inputs.assets.map(a=>a.kind),['costumes','props']); assert.ok(!image.inputs_json.includes('SYNTHETIC_LOOK_KEY'));
  assert.equal(f.current(id).revision,before.revision+1); assert.equal(lookInputs(f.db,1,f.current(id)).revision,hash); assert.deepEqual(immutable(f.db),unchanged);
  assert.equal((await f.generate(id)).status,200); const current=readLookImage(f.db,id);
  assert.equal((await f.post(`/projects/1/looks/${id}/clear-image`,{revision:String(f.current(id).revision),imageId:String(image.id),confirmed:'yes'})).status,409);
  assert.equal((await f.post(`/projects/1/looks/${id}/clear-image`,{revision:String(f.current(id).revision),imageId:String(current.id),confirmed:'yes'})).status,200);
  assert.equal(readLookImage(f.db,id),null); assert.equal((await fetch(`${f.url}/projects/1/looks/${id}/images/${image.id}`)).status,200);
});

test('只有演员也固定使用image[]；优先有效基础图，较新的无效图不被当成身份参考', async t => {
  const f=await fixture(t), id=await f.ready(), look=f.current(id);
  assert.equal((await f.post(`/projects/1/looks/${id}`,{revision:String(look.revision),name:look.name,characterId:'1',prompt:look.prompt,assetIds:'[]'})).status,200);
  const insert=f.db.prepare("INSERT INTO character_boards(character_id,image,mime,width,height,valid,revision,model,prompt)VALUES(1,?,'image/png',32,18,?,'synthetic','fake-model','fake-prompt')");
  insert.run(png(32,18),1); insert.run(png(64,36),0);
  assert.equal((await f.generate(id)).status,200); assert.equal(f.calls.length,1); assert.equal(f.calls[0].files.length,1);
  assert.equal(f.calls[0].single,null); assert.deepEqual(f.calls[0].files[0].bytes,png(32,18));
  const image=f.db.prepare('SELECT inputs_json FROM look_images').get(); assert.equal(JSON.parse(image.inputs_json).character.image.type,'boards');
});

test('缺图/旧快照/空提示词/错误API/重复参数/跨站与错格式在计费前拒绝，无协议回退', async t => {
  const f=await fixture(t), id=await f.ready();
  for(const fields of [{revision:'0'},{inputRevision:'old'},{chargeConfirmed:'no'},{apiConfigId:'2'},{model:'wrong'},{baseUrl:'https://wrong.invalid'},{apiConfigId:'1.0'}]) assert.ok([400,409].includes((await f.generate(id,fields)).status));
  for(const key of Object.keys(f.generateFields(id))){const fields=new URLSearchParams(f.generateFields(id));fields.append(key,fields.get(key));assert.ok([400,409].includes((await f.post(`/projects/1/looks/${id}/generate`,fields)).status),key);}
  assert.equal((await f.post(`/projects/2/looks/${id}/generate`,f.generateFields(id))).status,404);
  for(const headers of [{Origin:'https://elsewhere.invalid'},{'Sec-Fetch-Site':'cross-site'},{'Content-Type':'application/json'}]) assert.ok([403,415].includes((await f.post(`/projects/1/looks/${id}/generate`,f.generateFields(id),{headers})).status));
  f.db.exec('UPDATE character_references SET image=zeroblob(32*1024*1024)');
  const large=await f.generate(id); assert.equal(large.status,400); assert.match((await large.json()).error,/32 MiB/);
  f.db.prepare('UPDATE character_references SET image=?').run(png());
  f.db.exec("UPDATE production_asset_images SET image=X'0102' WHERE asset_id=1");
  const corrupt=await f.generate(id); assert.equal(corrupt.status,400); assert.match((await corrupt.json()).error,/已损坏/);
  f.db.prepare('UPDATE production_asset_images SET image=? WHERE asset_id=1').run(png(2,3));
  f.db.exec('UPDATE production_asset_images SET cleared=1 WHERE asset_id=1'); assert.equal((await f.generate(id)).status,400);
  f.db.exec('DELETE FROM look_assets WHERE asset_id=1; UPDATE character_references SET cleared=1'); assert.equal((await f.generate(id)).status,400);
  f.db.exec("UPDATE looks SET character_id=NULL,prompt='' WHERE id=1"); assert.equal((await f.generate(id)).status,400); assert.equal(f.calls.length,0);
});

test('无效尺寸/非图片结果/服务商失败保持旧图且不重试，存储失败返回可下载的付费结果', async t => {
  const f=await fixture(t), id=await f.ready(); assert.equal((await f.generate(id)).status,200); const old=readLookImage(f.db,id);
  f.result({data:[{b64_json:png(1,1).toString('base64')}]}); const invalid=await f.generate(id); assert.equal(invalid.status,502); const recovery=await invalid.json(); assert.match(recovery.recoveryImage,/^\/projects\/1\/looks\/1\/images\//); assert.equal(readLookImage(f.db,id).id,old.id); assert.equal(f.db.prepare('SELECT valid FROM look_images ORDER BY id DESC LIMIT 1').get().valid,0);
  f.result({task_id:'not an image'}); assert.equal((await f.generate(id)).status,502); assert.equal(readLookImage(f.db,id).id,old.id);
  f.result({error:{message:'SYNTHETIC_LOOK_KEY failed'}},400); const failure=await (await f.generate(id)).json(); assert.ok(!failure.error.includes('SYNTHETIC_LOOK_KEY'));
  f.result({data:[{b64_json:png().toString('base64')}]}); const prepare=f.db.prepare.bind(f.db);
  t.mock.method(f.db,'prepare',sql=>{if(sql.startsWith('INSERT INTO look_images'))throw new Error('simulated storage failure');return prepare(sql);});
  const failed=await f.generate(id); assert.equal(failed.status,502); const data=await failed.json(); assert.equal(data.recoveryImage,`data:image/png;base64,${png().toString('base64')}`); t.mock.restoreAll();
  assert.equal(readLookImage(f.db,id).id,old.id); assert.equal(f.calls.length,5);
});

test('生成锁阻止本定妆与演员/项目删除；素材更新使新结果存旧依据而不替换原图，锁最终释放', async t => {
  const f=await fixture(t), id=await f.ready(); assert.equal((await f.generate(id)).status,200); const old=readLookImage(f.db,id);
  const started=f.pause(), pending=f.generate(id); await started;
  const look=f.current(id); const save={revision:String(look.revision),name:look.name,characterId:'1',prompt:look.prompt,assetIds:'[1,2]'};
  assert.equal((await f.post(`/projects/1/looks/${id}`,save)).status,409); assert.equal((await f.generate(id)).status,409);
  assert.equal((await f.post(`/projects/1/looks/${id}/clear-image`,{revision:String(look.revision),imageId:String(old.id),confirmed:'yes'})).status,409);
  for(const[path,name]of[[`/projects/1/looks/${id}/delete`,look.name],['/projects/1/characters/1/delete','演员'],['/projects/1/delete','定妆测试']]) assert.equal((await f.post(path,{confirmed:'yes',name})).status,409);
  assert.equal((await f.upload('costumes',1,png(5,6))).status,200);
  f.resume(); const response=await pending; assert.equal(response.status,409); assert.match((await response.json()).recoveryImage,/images\//); assert.equal(readLookImage(f.db,id).id,old.id); assert.equal(f.calls.length,2);
  assert.equal((await f.post(`/projects/1/looks/${id}/delete`,{confirmed:'yes',name:look.name})).status,200);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM characters').get().n,2); assert.equal(f.db.prepare('SELECT count(*) AS n FROM production_assets').get().n,2); assert.equal(f.db.prepare('SELECT count(*) AS n FROM look_images').get().n,0);
});
