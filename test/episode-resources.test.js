import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/database.js';
import { readEpisodeResources } from '../src/episode-resources.js';
import { extractResourcesPrompt } from '../prompts/script/extract-resources.js';

const screenplay = '1-1 房间 内 日\n画面/动作：林秋站在门口。\n台词：林秋：“回来啦。”\n1-2 房间 内 夜\n画面/动作：林秋看向空椅。\n画面/动作：回忆中，周远坐在空椅上。';
const items = [
  { kind: 'character', name: '林秋', description: '', sceneHeading: '1-1 房间 内 日', quote: '画面/动作：林秋站在门口。', mode: 'on_screen', details: '' },
  { kind: 'scene', name: '房间', description: '有门和椅子。', sceneHeading: '1-1 房间 内 日', quote: '1-1 房间 内 日', mode: 'on_screen', details: '室内，白天。' },
  { kind: 'character', name: '林秋', description: '', sceneHeading: '1-2 房间 内 夜', quote: '画面/动作：林秋看向空椅。', mode: 'on_screen', details: '' },
  { kind: 'scene', name: '房间', description: '有门和椅子。', sceneHeading: '1-2 房间 内 夜', quote: '1-2 房间 内 夜', mode: 'on_screen', details: '室内，夜晚。' },
  { kind: 'character', name: '周远', description: '', sceneHeading: '1-2 房间 内 夜', quote: '画面/动作：回忆中，周远坐在空椅上。', mode: 'memory', details: '只在回忆里出现。' },
];
async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.listening ? new Promise(resolve => server.close(resolve)) : Promise.resolve() };
}
async function fixture(t, filename = ':memory:') {
  const db = openDatabase(filename);
  db.exec(`INSERT INTO projects VALUES (1, '提取项目', '水墨', '16:9'), (2, '外部项目', '电影', '9:16');
    INSERT INTO seasons VALUES (1, 1, '第一季', 1), (2, 1, '第二季', 2), (3, 2, '外部季', 1);
    INSERT INTO episodes VALUES (1, 1, '开场', 1), (2, 2, '重逢', 1), (3, 3, '外部集', 1);
    INSERT INTO characters (id, project_id, name, age, appearance_notes) VALUES (1, 1, '林秋', 32, '已有身份，不许修改'), (2, 2, '外部角色', 24, '外部');
    INSERT INTO scenes (id, project_id, name, description) VALUES (1, 1, '房间', '已有房间描述'), (2, 2, '外部场景', '外部');`);
  db.prepare('INSERT INTO episode_scripts (episode_id, source, script, notes, revision) VALUES (1, ?, ?, ?, 1), (2, ?, ?, ?, 1)').run('不应输入模型的原小说', screenplay, '旧说明', '另一集小说', screenplay, '另一集说明');
  const requests = []; let result = { choices: [{ message: { content: JSON.stringify({ occurrences: items }) }, finish_reason: 'stop' }] }, httpStatus = 200;
  let waiting, release, started;
  const provider = await listen(createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    requests.push({ path: request.url, authorization: request.headers.authorization, body: JSON.parse(raw) });
    if (waiting) { started(); await waiting; }
    response.writeHead(httpStatus, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result));
  }));
  db.prepare("INSERT INTO api_configs (id, name, type, base_url, api_key, model) VALUES (1, '编剧', 'llm', ?, 'extract-secret', 'extract-model'), (2, '画图', 'text_to_image', ?, 'image-secret', 'image-model')").run(provider.url + '/v1', provider.url + '/v1');
  const app = await listen(createApp(db)); t.after(async () => { release?.(); await app.close(); await provider.close(); });
  const post = (fields, action = 'extract-resources', episode = 1, project = 1, options = {}) => fetch(`${app.url}/projects/${project}/episodes/${episode}/${action}`, { method: 'POST', body: new URLSearchParams(fields), ...options });
  const state = (episode = 1) => readEpisodeResources(db, episode);
  const fields = (episode = 1) => ({ revision: String(db.prepare('SELECT revision FROM episode_scripts WHERE episode_id = ?').get(episode)?.revision ?? 0), batchRevision: String(state(episode).revision), apiConfigId: '1', model: 'extract-model', baseUrl: provider.url + '/v1', replaceConfirmed: 'yes' });
  const selections = (episode = 1) => state(episode).candidates.map(item => ({ action: item.ignored ? 'ignore' : item.suggestedId ? 'existing' : 'new', resourceId: item.suggestedId,
    resourceName: item.suggestedId ? db.prepare(`SELECT name FROM ${item.kind === 'character' ? 'characters' : 'scenes'} WHERE id = ?`).get(item.suggestedId).name : undefined,
    name: item.name, description: item.description, mode: item.mode, details: item.details }));
  const confirm = (selected = selections(), episode = 1, overrides = {}) => post({ batchRevision: String(state(episode).revision), scriptRevision: String(state(episode).scriptRevision), selections: JSON.stringify(selected), ...overrides }, 'confirm-resources', episode);
  return { db, ...app, requests, post, state, fields, selections, confirm,
    result(value, code = 200) { result = value; httpStatus = code; },
    pause() { waiting = new Promise(resolve => { release = resolve; }); return new Promise(resolve => { started = resolve; }); },
    resume() { release(); waiting = undefined; },
  };
}
const snapshots = db => ({ characters: db.prepare('SELECT * FROM characters ORDER BY id').all(), scenes: db.prepare('SELECT * FROM scenes ORDER BY id').all(), occurrences: db.prepare('SELECT * FROM episode_occurrences ORDER BY id').all() });
async function extracted(f, episode = 1) { const r = await f.post(f.fields(episode), 'extract-resources', episode); assert.equal(r.status, 200); return r.json(); }
function existing(id, name, row) { return { action: 'existing', resourceId: id, resourceName: name, mode: row.mode, details: row.details, sceneHeading: row.scene_heading, quote: row.quote }; }
async function update(f, row, selection, overrides = {}) {
  return f.post({ revision: String(row.revision), scriptRevision: f.fields(row.episode_id).revision, selection: JSON.stringify(selection), ...overrides }, `resource-occurrences/${row.id}`, row.episode_id);
}

test('按钮只在本集剧本页出现，保存与浏览不调用模型；单集提取只发送已保存正文并保留草稿，不创建资源或关联', async t => {
  const f = await fixture(t); const old = snapshots(f.db);
  const html = await (await fetch(f.url + '/projects/1?view=episode&episode=1')).text();
  assert.match(html, /id="extract-episode-resources"/); assert.match(html, /提取人物与场景/);
  assert.doesNotMatch(html, /extract-secret|image-secret|画图 · image-model/);
  assert.equal((await fetch(f.url + '/episode-resources.js')).status, 200);
  assert.doesNotMatch(await (await fetch(f.url + '/projects/1?view=storyboards&episode=1')).text(), /id="extract-episode-resources"/);
  assert.equal(f.requests.length, 0);
  const result = await extracted(f); assert.match(result.redirect, /episode=1#episode-resources/);
  assert.equal(f.requests.length, 1); const request = f.requests[0];
  assert.equal(request.path, '/v1/chat/completions'); assert.equal(request.authorization, 'Bearer extract-secret');
  assert.equal(request.body.model, 'extract-model'); assert.equal(request.body.stream, false); assert.equal(request.body.max_tokens, 8192);
  assert.equal(request.body.messages[0].content, extractResourcesPrompt);
  assert.deepEqual(JSON.parse(request.body.messages[1].content), { script: screenplay });
  assert.deepEqual(snapshots(f.db), old); assert.equal(f.state().candidates.length, 5); assert.equal(f.state(2).revision, 0);
  assert.equal(f.db.prepare('SELECT script FROM episode_scripts WHERE episode_id = 1').get().script, screenplay);
});

test('确认已有资源只关联不改资料；同地点在不同场和不同集共用资源，未知新角色年龄留空，资源详情双向显示出现位置', async t => {
  const f = await fixture(t); const old = snapshots(f.db); await extracted(f);
  assert.equal((await f.confirm()).status, 200);
  assert.deepEqual(f.db.prepare('SELECT * FROM characters WHERE id = 1').get(), old.characters[0]);
  assert.deepEqual(f.db.prepare('SELECT * FROM scenes WHERE id = 1').get(), old.scenes[0]);
  const newCharacter = f.db.prepare("SELECT * FROM characters WHERE project_id = 1 AND name = '周远'").get(); assert.equal(newCharacter.age, null);
  assert.equal(f.state().occurrences.length, 5); assert.equal(f.state().candidates.length, 0);
  assert.equal(f.state().occurrences.filter(row => row.scene_id === 1).length, 2);
  assert.equal(f.state(2).occurrences.length, 0);
  await extracted(f, 2); assert.equal((await f.confirm(f.selections(2), 2)).status, 200);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM scenes WHERE project_id = 1').get().n, 1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM characters WHERE project_id = 1').get().n, 2);
  const character = await (await fetch(f.url + '/projects/1?resource=characters&character=1')).text();
  assert.match(character, /全剧出现位置 · 4 处/); assert.match(character, /第一季 \/ 开场/); assert.match(character, /第二季 \/ 重逢/);
  assert.match(character, /#occurrence-\d+/); assert.doesNotMatch(character, /外部角色/);
  const scene = await (await fetch(f.url + '/projects/1?resource=scenes&scene=1')).text(); assert.match(scene, /全剧出现位置 · 4 处/);
  assert.match(scene, /室内，白天/); assert.match(scene, /室内，夜晚/); assert.match(scene, /id="generate-scene-image"/);
});

test('实际出场按资源归组，同人物和地点只列一次，各场证据与关联保留；同名不同资源不合并', async t => {
  const f = await fixture(t); await extracted(f);
  let html = await (await fetch(f.url + '/projects/1?view=episode&episode=1')).text();
  assert.match(html, /待确认的提取草稿 · 3 项资源 · 5 处画面出场/);
  assert.equal((html.match(/<legend>角色 · 林秋 · 2 处 /g) ?? []).length, 1);
  assert.equal((html.match(/<legend>场景 · 房间 · 2 处 /g) ?? []).length, 1);
  assert.deepEqual([...html.matchAll(/data-candidate-index="(\d+)"/g)].map(match => Number(match[1])), [0, 2, 1, 3, 4]);
  assert.equal((await f.confirm()).status, 200);
  html = await (await fetch(f.url + '/projects/1?view=episode&episode=1')).text();
  assert.match(html, /已确认人物与场景 · 3 项资源 · 5 处画面出场/);
  assert.equal((html.match(/<legend>角色 · 林秋 · 2 处 /g) ?? []).length, 1);
  assert.equal(f.state().occurrences.length, 5);
  const id = Number(f.db.prepare("INSERT INTO characters (project_id, name) VALUES (1, '林秋')").run().lastInsertRowid);
  const row = f.state().occurrences.find(item => item.quote === items[2].quote);
  assert.equal((await update(f, row, existing(id, '林秋', row))).status, 200);
  html = await (await fetch(f.url + '/projects/1?view=episode&episode=1')).text();
  assert.match(html, /已确认人物与场景 · 4 项资源 · 5 处画面出场/);
  assert.equal((html.match(/<legend>角色 · 林秋 · 1 处 /g) ?? []).length, 2);
});

test('同一位置的重复模型输出只保留一次，仅提及、纯声音和未呈现地点不入草稿，不创建档案', async t => {
  const f = await fixture(t); const before = snapshots(f.db);
  f.result({ choices: [{ message: { content: JSON.stringify({ occurrences: [...items, items[0], items[3],
    { ...items[0], name: '仅提到的人', mode: 'mentioned' }, { ...items[0], name: '未出镜电话者', mode: 'off_screen' },
    { ...items[0], name: '只有心声', mode: 'inner_voice' }, { ...items[1], name: '只谈到的地点', mode: 'mentioned' }] }) }, finish_reason: 'stop' }] });
  await extracted(f); assert.equal(f.state().candidates.length, 5); assert.deepEqual(snapshots(f.db), before);
  assert.equal((await f.confirm()).status, 200); assert.equal(f.state().occurrences.length, 5);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM characters WHERE project_id = 1').get().n, 2);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM scenes WHERE project_id = 1').get().n, 1);
  const confirmed = snapshots(f.db);
  f.result({ choices: [{ message: { content: JSON.stringify({ occurrences: [{ ...items[0], mode: 'mentioned' }, { ...items[1], mode: 'mentioned' }] }) }, finish_reason: 'stop' }] });
  await extracted(f); assert.equal(f.state().candidates.length, 0);
  assert.deepEqual(snapshots(f.db).characters, confirmed.characters); assert.deepEqual(snapshots(f.db).scenes, confirmed.scenes);
  assert.equal(f.state().occurrences.length, 5); assert.ok(f.state().occurrences.every(row => row.needs_review === 1));
  assert.deepEqual(f.state().occurrences.map(row => row.id).sort(), confirmed.occurrences.map(row => row.id).sort());
  const html = await (await fetch(f.url + '/projects/1?view=episode&episode=1')).text();
  assert.match(html, /已确认人物与场景 · 0 项资源 · 0 处画面出场/); assert.match(html, /本次提取未发现，待核对/);
  assert.equal(f.requests.length, 2);
});

test('旧草稿及已保存的非画面引用不再显示或计入出现位置，旧档案和历史记录保留；不能确认新非画面关联', async t => {
  const f = await fixture(t); await extracted(f); await f.confirm(); await extracted(f);
  const raw = f.state().candidates;
  f.db.prepare('UPDATE episode_extractions SET candidates = ? WHERE episode_id = 1').run(JSON.stringify([...raw, { ...raw[0], name: 'OLD_NONVISUAL_CANDIDATE', mode: 'mentioned' }]));
  for (const mode of ['mentioned', 'off_screen', 'inner_voice']) f.db.prepare(`INSERT INTO episode_occurrences (episode_id, kind, character_id, source_name, scene_heading, quote, source_start, mode, details, script_revision)
    VALUES (1, 'character', 1, 'OLD_NONVISUAL_RESOURCE', '', ?, 0, ?, '', 1)`).run('OLD_NONVISUAL_' + mode, mode);
  const before = snapshots(f.db); const persisted = f.db.prepare('SELECT candidates FROM episode_extractions WHERE episode_id = 1').get().candidates;
  assert.equal(f.state().candidates.length, 5);
  const html = await (await fetch(f.url + '/projects/1?view=episode&episode=1')).text();
  assert.doesNotMatch(html, /OLD_NONVISUAL/); assert.match(html, /已确认人物与场景 · 3 项资源 · 5 处画面出场/);
  const resource = await (await fetch(f.url + '/projects/1?resource=characters&character=1')).text();
  assert.match(resource, /全剧出现位置 · 2 处/); assert.doesNotMatch(resource, /OLD_NONVISUAL/);
  const choices = f.selections(); choices[0].mode = 'mentioned';
  assert.equal((await f.confirm(choices)).status, 400); assert.deepEqual(snapshots(f.db), before);
  assert.equal(f.db.prepare('SELECT candidates FROM episode_extractions WHERE episode_id = 1').get().candidates, persisted);
  assert.equal(f.requests.length, 2);
});

test('旧版已移除的非画面记录不屏蔽新提取：显示本次画面类型和说明，确认前不恢复旧关联，确认后复用原位置ID', async t => {
  const f = await fixture(t); await extracted(f); await f.confirm();
  const row = f.state().occurrences.find(item => item.quote === items[0].quote);
  f.db.prepare("UPDATE episode_occurrences SET mode = 'off_screen', ignored = 1, character_id = NULL, details = '旧版人工移除。' WHERE id = ?").run(row.id);
  await extracted(f);
  const candidate = f.state().candidates.find(item => item.quote === row.quote);
  assert.equal(candidate.occurrenceId, row.id); assert.equal(candidate.mode, 'on_screen'); assert.equal(candidate.details, items[0].details);
  assert.equal(f.state().occurrences.find(item => item.id === row.id).ignored, 1);
  assert.equal((await f.confirm()).status, 200);
  const kept = f.state().occurrences.find(item => item.id === row.id);
  assert.equal(kept.ignored, 0); assert.equal(kept.character_id, 1); assert.equal(kept.details, items[0].details); assert.equal(kept.mode, 'on_screen');
  assert.equal(f.state().occurrences.length, 5);
});

test('同批确认的同类同名新资源只建一次，描述不一致或已有同名新建不默默覆盖', async t => {
  const f = await fixture(t); f.db.exec('DELETE FROM characters WHERE id = 1; DELETE FROM scenes WHERE id = 1');
  await extracted(f); const before = snapshots(f.db); const choices = f.selections(); choices[2].description = '冲突描述';
  assert.equal((await f.confirm(choices)).status, 400); assert.deepEqual(snapshots(f.db), before);
  assert.equal((await f.confirm()).status, 200);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM characters WHERE project_id = 1').get().n, 2);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM scenes WHERE project_id = 1').get().n, 1);
  await extracted(f); const duplicate = f.selections(); duplicate[0] = { ...duplicate[0], action: 'new' };
  const resources = snapshots(f.db); assert.equal((await f.confirm(duplicate)).status, 409); assert.deepEqual(snapshots(f.db), resources);
});

test('同场景跨场的不同模型描述明确指出冲突资源；统一共享描述后只建一份档案，各场说明独立保存', async t => {
  const f = await fixture(t); f.db.exec('DELETE FROM scenes WHERE id = 1');
  const returned = items.map((item, index) => item.kind === 'scene' ? { ...item, description: index === 1 ? '房间内有门。' : '房间内有椅子。' } : item);
  f.result({ choices: [{ message: { content: JSON.stringify({ occurrences: returned }) }, finish_reason: 'stop' }] });
  await extracted(f); const before = snapshots(f.db); const batch = f.state();
  const failed = await f.confirm(); assert.equal(failed.status, 400); assert.match((await failed.json()).error, /场景「房间」.*描述不一致/);
  assert.deepEqual(snapshots(f.db), before); assert.deepEqual(f.state(), batch);
  const selections = f.selections(); for (const [index, item] of f.state().candidates.entries()) if (item.kind === 'scene') selections[index].description = '房间内有门和椅子。';
  assert.equal((await f.confirm(selections)).status, 200);
  const scene = f.db.prepare('SELECT * FROM scenes WHERE project_id = 1').all(); assert.equal(scene.length, 1); assert.equal(scene[0].description, '房间内有门和椅子。');
  const occurrences = f.state().occurrences.filter(item => item.kind === 'scene'); assert.equal(occurrences.length, 2);
  assert.ok(occurrences.every(item => item.scene_id === scene[0].id)); assert.deepEqual(occurrences.map(item => item.details), [items[1].details, items[3].details]);
});

test('同名已有资源有歧义时不自动选择；确认只接受当前项目资源和名称快照，失败不写半组关联', async t => {
  const f = await fixture(t); f.db.exec("INSERT INTO characters (project_id, name) VALUES (1, '林秋')");
  await extracted(f); assert.equal(f.state().candidates[0].suggestedId, null);
  const selections = f.selections(); selections[0] = { ...selections[0], action: 'existing', resourceId: 1, resourceName: '林秋' };
  selections[2] = { ...selections[2], action: 'existing', resourceId: 2, resourceName: '外部角色' };
  const old = snapshots(f.db); assert.equal((await f.confirm(selections)).status, 404); assert.deepEqual(snapshots(f.db), old);
  selections[2] = { ...selections[0] }; f.db.exec("UPDATE characters SET name = '已改名' WHERE id = 1");
  assert.equal((await f.confirm(selections)).status, 409); assert.equal(f.state().occurrences.length, 0);
});

test('重提取可建议已有人工关联，但画面类型和说明使用本次结果；旧移除不屏蔽新草稿，只有确认才重新保存关联', async t => {
  const f = await fixture(t); await extracted(f); await f.confirm();
  const id = Number(f.db.prepare("INSERT INTO characters (project_id, name, age) VALUES (1, '正确身份', 45)").run().lastInsertRowid);
  let row = f.state().occurrences.find(row => row.source_name === '林秋');
  const corrected = { ...existing(id, '正确身份', row), mode: 'imagination', details: '人工修正叙事层次。' };
  assert.equal((await update(f, row, corrected)).status, 200);
  await extracted(f); const candidate = f.state().candidates.find(item => item.name === '林秋' && item.quote === row.quote);
  assert.equal(candidate.suggestedId, id); assert.equal(candidate.mode, items[0].mode); assert.equal(candidate.details, items[0].details);
  await f.confirm(); row = f.state().occurrences.find(item => item.id === row.id); assert.equal(row.character_id, id);
  assert.equal((await update(f, row, { action: 'ignore', mode: row.mode, details: row.details })).status, 200);
  assert.ok(f.db.prepare('SELECT id FROM characters WHERE id = ?').get(id));
  await extracted(f); assert.ok(f.state().candidates.find(item => item.quote === row.quote && item.kind === 'character'));
  assert.equal(f.state().occurrences.find(item => item.id === row.id).ignored, 1);
  await f.confirm(); row = f.state().occurrences.find(item => item.id === row.id); assert.equal(row.ignored, 0); assert.equal(row.character_id, 1);
  const detail = await (await fetch(f.url + `/projects/1?resource=characters&character=${id}`)).text(); assert.match(detail, /全剧出现位置 · 0 处/);
});

test('本轮手工定位和移除更新当前草稿；再次提取显示新的原文证据，确认复用旧ID而不制造副本', async t => {
  const f = await fixture(t); await extracted(f); await f.confirm(); await extracted(f);
  let row = f.state().occurrences.find(item => item.quote === items[0].quote);
  const id = row.id; const expanded = items[0].quote + '\n台词：林秋：“回来啦。”';
  assert.equal((await update(f, row, { ...existing(1, '林秋', row), quote: expanded })).status, 200);
  assert.equal(f.state().candidates.find(item => item.occurrenceId === id).quote, expanded);
  row = f.state().occurrences.find(item => item.id === id);
  assert.equal((await update(f, row, { action: 'ignore', mode: row.mode, details: '人工移除。' })).status, 200);
  assert.equal(f.state().candidates.find(item => item.occurrenceId === id), undefined);
  assert.equal((await f.confirm()).status, 200); assert.equal(f.state().occurrences.length, 5);
  await extracted(f);
  assert.equal(f.state().candidates.find(item => item.occurrenceId === id).quote, items[0].quote);
  assert.equal(f.state().occurrences.find(item => item.id === id).ignored, 1);
  assert.equal((await f.confirm()).status, 200); assert.equal(f.state().occurrences.length, 5);
  row = f.state().occurrences.find(item => item.id === id);
  assert.equal(row.ignored, 0); assert.equal(row.character_id, 1); assert.equal(row.quote, items[0].quote);
});

test('多个新位置重叠同一人工旧记录时不自动合并或恢复关联，必须明确核对选择', async t => {
  const f = await fixture(t); await extracted(f); await f.confirm();
  let row = f.state().occurrences.find(item => item.quote === items[0].quote);
  const second = f.state().occurrences.find(item => item.quote === items[2].quote);
  const expanded = screenplay.slice(screenplay.indexOf(items[0].quote), screenplay.indexOf(items[2].quote) + items[2].quote.length);
  assert.equal((await update(f, row, { ...existing(1, '林秋', row), quote: expanded })).status, 200);
  row = f.state().occurrences.find(item => item.id === row.id);
  assert.equal((await update(f, row, { action: 'ignore', mode: row.mode, details: '保留人工移除。' })).status, 200);
  f.db.prepare('DELETE FROM episode_occurrences WHERE id = ?').run(second.id);
  await extracted(f);
  const ambiguous = f.state().candidates.filter(item => item.name === '林秋');
  assert.equal(ambiguous.length, 2);
  for (const item of ambiguous) { assert.equal(item.needsReview, true); assert.equal(item.suggestedId, null); assert.equal(item.occurrenceId, null); }
  const html = await (await fetch(f.url + '/projects/1?view=episode&episode=1')).text(); assert.match(html, /原文位置无法唯一对应旧记录/);
  const choices = f.selections(); f.state().candidates.forEach((item, index) => { if (item.needsReview) choices[index].action = 'ignore'; });
  assert.equal((await f.confirm(choices)).status, 200);
  assert.equal(f.state().occurrences.find(item => item.id === row.id).ignored, 1);
  assert.equal(f.state().occurrences.filter(item => item.source_name === '林秋' && !item.ignored).length, 0);
});

test('保存未改动的剧本保留版本和已付费提取草稿，旧页面或重复字段仍拒绝', async t => {
  const f = await fixture(t); await extracted(f); const batch = f.state();
  const draft = f.db.prepare('SELECT * FROM episode_scripts WHERE episode_id = 1').get();
  const saved = await f.post({ source: draft.source, script: draft.script, notes: draft.notes, revision: '1' }, 'script');
  assert.equal(saved.status, 200); assert.equal((await saved.json()).revision, 1); assert.deepEqual(f.state(), batch);
  assert.equal((await f.post({ source: draft.source, script: draft.script, notes: draft.notes, revision: '0' }, 'script')).status, 409);
  const duplicate = new URLSearchParams({ source: draft.source, script: draft.script, notes: draft.notes, revision: '1' }); duplicate.append('script', draft.script);
  assert.equal((await f.post(duplicate, 'script')).status, 400);
  assert.equal((await f.confirm()).status, 200); assert.equal(f.requests.length, 1);
});

test('人工改关联同时刷新尚未确认的提取建议，旧确认页不能把改动覆盖回去', async t => {
  const f = await fixture(t); await extracted(f); await f.confirm(); await extracted(f);
  const staleBatchRevision = f.state().revision; const staleSelections = f.selections();
  const id = Number(f.db.prepare("INSERT INTO characters (project_id, name) VALUES (1, '人工选择')").run().lastInsertRowid);
  const row = f.state().occurrences.find(row => row.source_name === '林秋');
  assert.equal((await update(f, row, existing(id, '人工选择', row))).status, 200);
  assert.equal(f.state().candidates.find(item => item.quote === row.quote && item.kind === 'character').suggestedId, id);
  assert.equal((await f.confirm(staleSelections, 1, { batchRevision: String(staleBatchRevision) })).status, 409);
});

test('剧本修改使旧草稿和记录待核对；同步不删除消失的位置，空提取也不清掉旧关联，其他集不受影响', async t => {
  const f = await fixture(t); await extracted(f); await f.confirm(); await extracted(f, 2); await f.confirm(f.selections(2), 2);
  const other = f.state(2); await extracted(f); const oldChoices = f.selections();
  const shortened = '1-1 房间 内 日\n画面/动作：林秋站在门口。';
  const saved = await f.post({ source: '原文', script: shortened, notes: '', revision: '1' }, 'script'); assert.equal(saved.status, 200);
  assert.equal((await f.confirm(oldChoices)).status, 409);
  const html = await (await fetch(f.url + '/projects/1?view=episode&episode=1')).text(); assert.match(html, /剧本已变化，待核对/);
  f.result({ choices: [{ message: { content: JSON.stringify({ occurrences: items.slice(0, 2) }) }, finish_reason: 'stop' }] });
  await extracted(f); await f.confirm(); assert.equal(f.state().occurrences.length, 5);
  assert.equal(f.state().occurrences.filter(row => row.script_revision === 2).length, 2);
  f.result({ choices: [{ message: { content: '{"occurrences":[]}' }, finish_reason: 'stop' }] });
  await extracted(f); assert.equal(f.state().occurrences.length, 5); assert.deepEqual(f.state(2), other);
});

test('可以修正出场位置，但原文必须唯一存在；旧记录版本、外部记录和无效资源不能被修改', async t => {
  const f = await fixture(t); await extracted(f); await f.confirm();
  const row = f.state().occurrences.find(row => row.source_name === '周远');
  const chosen = existing(row.character_id, '周远', row);
  for (const invalid of [{ ...chosen, quote: '不存在的原文' }, { ...chosen, quote: '林秋' }, { ...chosen, sceneHeading: '不存在的标题' }]) assert.equal((await update(f, row, invalid)).status, 400);
  assert.equal((await update(f, row, chosen, { revision: '0' })).status, 400);
  assert.equal((await update(f, row, chosen, { revision: '999' })).status, 409);
  assert.equal((await f.post({ revision: '1', scriptRevision: '1', selection: JSON.stringify(chosen) }, `resource-occurrences/${row.id}`, 2)).status, 404);
  assert.equal((await update(f, row, { ...chosen, resourceId: 2, resourceName: '外部角色' })).status, 404);
  const corrected = { ...chosen, quote: '台词：林秋：“回来啦。”', sceneHeading: '1-1 房间 内 日', mode: 'on_screen' };
  assert.equal((await update(f, row, corrected)).status, 200);
  assert.equal(f.state().occurrences.find(item => item.id === row.id).quote, corrected.quote);
});

test('保存确认是事务：中途失败回滚新资源与整组关联，付费草稿仍可取回', async t => {
  const f = await fixture(t); t.mock.method(console, 'error', () => {}); await extracted(f);
  const old = snapshots(f.db); const batch = f.state();
  f.db.exec("CREATE TEMP TRIGGER fail_occurrence BEFORE INSERT ON episode_occurrences WHEN NEW.source_name = '周远' BEGIN SELECT RAISE(ABORT, 'occurrence write failure'); END");
  assert.equal((await f.confirm()).status, 500); assert.deepEqual(snapshots(f.db), old); assert.deepEqual(f.state(), batch);
  f.db.exec('DROP TRIGGER fail_occurrence'); assert.equal((await f.confirm()).status, 200); assert.equal(f.requests.length, 1);
});

test('付费前验证版本、正文、配置和确认；跨项目、跨站、重复字段和过大请求拒绝，不调用模型', async t => {
  const f = await fixture(t);
  for (const [key, value, status] of [['revision', '999', 409], ['batchRevision', '999', 409], ['apiConfigId', '2', 400], ['apiConfigId', '999', 404], ['model', 'changed', 409], ['baseUrl', 'changed', 409]]) assert.equal((await f.post({ ...f.fields(), [key]: value })).status, status);
  const duplicate = new URLSearchParams(f.fields()); duplicate.append('revision', '1'); assert.equal((await f.post(duplicate)).status, 400);
  assert.equal((await f.post(f.fields(), 'extract-resources', 1, 2)).status, 404);
  assert.equal((await f.post(f.fields(), 'extract-resources', 3, 1)).status, 404);
  assert.equal((await f.post(f.fields(), 'extract-resources', 1, 1, { headers: { Origin: 'https://external.example' } })).status, 403);
  assert.equal((await f.post(f.fields(), 'extract-resources', 1, 1, { headers: { 'Content-Type': 'application/json' } })).status, 415);
  assert.equal((await f.post({ huge: 'x'.repeat(33000) })).status, 413);
  f.db.exec("UPDATE episode_scripts SET script = '' WHERE episode_id = 1"); assert.equal((await f.post(f.fields())).status, 400);
  assert.equal(f.requests.length, 0);
  f.db.prepare('UPDATE episode_scripts SET script = ? WHERE episode_id = 1').run(screenplay);
  await extracted(f); const count = f.requests.length;
  assert.equal((await f.post({ ...f.fields(), replaceConfirmed: 'no' })).status, 400); assert.equal(f.requests.length, count);
});

test('无效 JSON、截断、空任务、错误原文定位、冲突或过多记录都拒绝，保留旧数据与恢复文本，不重试或泄漏密钥', async t => {
  const f = await fixture(t); await extracted(f); await f.confirm(); const old = snapshots(f.db); const state = f.state();
  const result = value => ({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }] });
  for (const value of [
    { task_id: 'not-result' }, { choices: [{ message: { content: '' } }] },
    { choices: [{ message: { content: 'extract-secret 非 JSON' }, finish_reason: 'stop' }] },
    { choices: [{ message: { content: JSON.stringify({ occurrences: items }) }, finish_reason: 'length' }] },
    result({ occurrences: [{ ...items[0], quote: '幻觉原文' }] }), result({ occurrences: [{ ...items[0], quote: '林秋' }] }),
    result({ occurrences: [{ ...items[0], name: '不存在的人物' }] }),
    result({ occurrences: [{ ...items[0], sceneHeading: '不存在的标题' }] }), result({ occurrences: [items[0], { ...items[0], mode: 'memory' }] }),
    result({ occurrences: Array(201).fill(items[0]) }), result({ occurrences: [{ ...items[0], kind: '__proto__' }] }),
    result({ occurrences: [{ ...items[1], mode: 'unsupported' }] }), result({ occurrences: [{ ...items[0], description: '字'.repeat(1001) }] }),
  ]) {
    f.result(value); const count = f.requests.length; const response = await f.post(f.fields()); assert.equal(response.status, 502);
    const error = await response.json(); assert.ok(!JSON.stringify(error).includes('extract-secret'));
    if (value.choices?.[0]?.message?.content) assert.ok(error.recoveryText);
    assert.deepEqual(snapshots(f.db), old); assert.deepEqual(f.state(), state); assert.equal(f.requests.length, count + 1);
  }
});

test('先解析 JSON 字段再脱敏，密钥与协议字段同名不破坏结果；特殊名称和原文安全显示', async t => {
  const f = await fixture(t);
  f.db.exec("UPDATE api_configs SET api_key = 'occurrences' WHERE id = 1"); await extracted(f);
  const escaped = '</textarea><script>alert(1)</script>';
  f.db.prepare('UPDATE episode_scripts SET script = ?, revision = revision + 1 WHERE episode_id = 1').run('画面/动作：<角色> ' + escaped);
  f.result({ choices: [{ message: { content: JSON.stringify({ occurrences: [{ ...items[0], name: '<角色>', sceneHeading: '', quote: escaped }] }) }, finish_reason: 'stop' }] });
  await extracted(f);
  const html = await (await fetch(f.url + '/projects/1?view=episode&episode=1')).text();
  assert.match(html, /&lt;角色&gt;/); assert.match(html, /&lt;\/textarea&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;/); assert.doesNotMatch(html, /<script>alert\(1\)/);
});

test('同集提取锁防重复调用，不能并发保存剧本、生成剧本、改关联或删除集及父项，其他集仍可编辑', async t => {
  const f = await fixture(t); await extracted(f); await f.confirm(); const row = f.state().occurrences[0];
  const started = f.pause(); const fields = f.fields(); const pending = f.post(fields); await started;
  assert.equal((await f.post(fields)).status, 409);
  assert.equal((await f.post({ source: '', script: '改稿', notes: '', revision: '1' }, 'script')).status, 409);
  assert.equal((await f.post(fields, 'generate-script')).status, 409);
  assert.equal((await f.post({ confirmed: 'yes', batchRevision: String(f.state().revision), scriptRevision: '1', targets: JSON.stringify({ type: 'occurrences', items: [{ id: row.id, revision: row.revision }] }) }, 'remove-resources')).status, 409);
  const resource = row.kind === 'character' ? f.db.prepare('SELECT name FROM characters WHERE id = ?').get(row.character_id) : f.db.prepare('SELECT name FROM scenes WHERE id = ?').get(row.scene_id);
  assert.equal((await update(f, row, existing(row.character_id ?? row.scene_id, resource.name, row))).status, 409);
  for (const [path, name] of [['/projects/1/episodes/1/delete', '开场'], ['/projects/1/seasons/1/delete', '第一季'], ['/projects/1/delete', '提取项目']]) assert.equal((await fetch(f.url + path, { method: 'POST', body: new URLSearchParams({ confirmed: 'yes', name }) })).status, 409);
  assert.equal((await f.post({ source: '', script: '另一集修改', notes: '', revision: '1' }, 'script', 2)).status, 200);
  f.resume(); assert.equal((await pending).status, 200); assert.equal(f.requests.length, 2);
});

test('模型返回期间剧本或关联异常变化不覆盖；本地保存失败可恢复付费文本', async t => {
  const f = await fixture(t); await extracted(f); const original = f.state();
  let started = f.pause(); let pending = f.post(f.fields()); await started;
  f.db.exec("UPDATE episode_scripts SET script = '别人修改的剧本' WHERE episode_id = 1"); f.resume();
  let response = await pending; assert.equal(response.status, 409); assert.ok((await response.json()).recoveryText); assert.deepEqual(f.state(), original);
  f.db.prepare('UPDATE episode_scripts SET script = ? WHERE episode_id = 1').run(screenplay);
  started = f.pause(); pending = f.post(f.fields()); await started;
  f.db.exec('UPDATE episode_extractions SET revision = revision + 1 WHERE episode_id = 1'); f.resume();
  response = await pending; assert.equal(response.status, 409); assert.ok((await response.json()).recoveryText);
  f.db.exec("CREATE TEMP TRIGGER fail_extraction BEFORE UPDATE ON episode_extractions BEGIN SELECT RAISE(ABORT, 'storage failure'); END");
  response = await f.post(f.fields()); assert.equal(response.status, 502); assert.ok((await response.json()).recoveryText);
});

test('场景库支持手动建档、编辑、搜索与每页50条，跨项目隔离、验证和安全转义；普通保存不调用模型', async t => {
  const f = await fixture(t);
  const post = (path, fields) => fetch(f.url + path, { method: 'POST', body: new URLSearchParams(fields) });
  const created = await post('/projects/1/scenes', { name: '<场景> & 大厅' }); assert.equal(created.status, 201); const scene = await created.json();
  assert.equal((await post(`/projects/1/scenes/${scene.id}`, { name: '<场景> & 大厅', description: '<script>环境</script>' })).status, 200);
  const html = await (await fetch(f.url + `/projects/1?resource=scenes&scene=${scene.id}`)).text(); assert.match(html, /&lt;场景&gt; &amp; 大厅/); assert.match(html, /&lt;script&gt;环境&lt;\/script&gt;/);
  assert.equal((await post(`/projects/2/scenes/${scene.id}`, { name: '越界', description: '' })).status, 404);
  for (const fields of [{ name: '' }, { name: '字'.repeat(81) }]) assert.equal((await post('/projects/1/scenes', fields)).status, 400);
  assert.equal((await post(`/projects/1/scenes/${scene.id}`, { name: '名称' })).status, 400);
  assert.equal((await fetch(f.url + `/projects/2?resource=scenes&scene=${scene.id}`)).status, 404);
  assert.equal((await fetch(f.url + '/projects/1?resource=scenes&scene=bad')).status, 404);
  assert.equal((await fetch(f.url + '/projects/1?resource=scenes&page=0')).status, 400);
  for (let i = 0; i < 51; i++) f.db.prepare('INSERT INTO scenes (project_id, name) VALUES (1, ?)').run(`搜索-${i}`);
  const first = await (await fetch(f.url + '/projects/1?resource=scenes&q=搜索')).text(); assert.equal((first.match(/class="project-card"/g) ?? []).length, 50); assert.match(first, /每页 50 条/);
  const second = await (await fetch(f.url + '/projects/1?resource=scenes&q=搜索&page=2')).text(); assert.equal((second.match(/class="project-card"/g) ?? []).length, 1);
  assert.doesNotMatch(first, /外部场景/); assert.equal(f.requests.length, 0);
});

test('出现位置分页不隐瞒其他集记录；删除资源保留待重新关联记录，删除集只清本集，删除项目级联清理', async t => {
  const f = await fixture(t); await extracted(f); await f.confirm();
  const row = f.state().occurrences.find(row => row.scene_id === 1);
  for (let i = 0; i < 51; i++) f.db.prepare(`INSERT INTO episode_occurrences (episode_id, kind, scene_id, source_name, scene_heading, quote, source_start, mode, details, script_revision) VALUES (1, 'scene', 1, '房间', '场号', ?, 0, 'on_screen', '', 1)`).run(`位置-${i}`);
  const html = await (await fetch(f.url + '/projects/1?resource=scenes&scene=1')).text(); assert.match(html, /全剧出现位置 · 53 处/); assert.equal((html.match(/class="resource-appearance"/g) ?? []).length, 50);
  const next = await (await fetch(f.url + '/projects/1?resource=scenes&scene=1&occurrencePage=2')).text(); assert.equal((next.match(/class="resource-appearance"/g) ?? []).length, 3);
  assert.equal((await fetch(f.url + '/projects/1?resource=scenes&scene=1&occurrencePage=bad')).status, 400);
  const remove = (path, name) => fetch(f.url + path, { method: 'POST', body: new URLSearchParams({ confirmed: 'yes', name }) });
  assert.equal((await remove('/projects/1/scenes/1/delete', '房间')).status, 200); assert.equal(f.state().occurrences.find(item => item.id === row.id).scene_id, null);
  assert.match(await (await fetch(f.url + '/projects/1?view=episode&episode=1')).text(), /资源已删除，需重新关联/);
  await extracted(f, 2); await f.confirm(f.selections(2), 2);
  assert.equal((await remove('/projects/1/episodes/1/delete', '开场')).status, 200); assert.equal(f.state().occurrences.length, 0); assert.equal(f.state(2).occurrences.length, 5);
  assert.equal((await remove('/projects/1/delete', '提取项目')).status, 200);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM episode_extractions').get().n, 0); assert.equal(f.db.prepare('SELECT count(*) AS n FROM episode_occurrences').get().n, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM scenes WHERE project_id = 2').get().n, 1); assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('已有确认结果的本轮草稿删除不提前改关联；确认时移除本轮删掉的旧位置，重新提取再次显示而不改共享档案', async t => {
  const f = await fixture(t); await extracted(f); await f.confirm(); await extracted(f);
  const before = snapshots(f.db);
  const removed = await f.post({ confirmed: 'yes', batchRevision: String(f.state().revision), scriptRevision: '1', targets: JSON.stringify({ type: 'candidates', items: [0, 2] }) }, 'remove-resources');
  assert.equal(removed.status, 200); assert.deepEqual(snapshots(f.db), before);
  assert.equal(f.state().candidates.length, 3); assert.ok(!f.state().candidates.some(item => item.name === '林秋'));
  const invalid = f.selections(); invalid[2] = { ...invalid[2], action: 'existing', resourceId: 2, resourceName: '外部角色' };
  assert.equal((await f.confirm(invalid)).status, 404); assert.deepEqual(snapshots(f.db), before);
  assert.equal((await f.confirm()).status, 200);
  assert.ok(f.state().occurrences.filter(row => row.source_name === '林秋').every(row => row.ignored && row.character_id === null));
  const html = await (await fetch(f.url + '/projects/1?view=episode&episode=1')).text();
  assert.match(html, /已确认人物与场景 · 2 项资源 · 3 处画面出场/);
  await extracted(f); assert.equal(f.state().candidates.length, 5); assert.equal(f.requests.length, 3);
  assert.deepEqual(snapshots(f.db).characters, before.characters); assert.deepEqual(snapshots(f.db).scenes, before.scenes);
});

test('重新提取显示本次原文、画面类型和说明，不沿用旧删除或人工内容，也不补入模型未返回的旧项；编辑别项不丢新结果', async t => {
  const f = await fixture(t); await extracted(f); await f.confirm();
  let row = f.state().occurrences.find(item => item.quote === items[0].quote);
  const expanded = items[0].quote + '\n台词：林秋：“回来啦。”';
  assert.equal((await update(f, row, { ...existing(1, '林秋', row), quote: expanded, mode: 'imagination', details: '旧手工说明。' })).status, 200);
  row = f.state().occurrences.find(item => item.id === row.id);
  assert.equal((await update(f, row, { action: 'ignore', mode: row.mode, details: '旧删除说明。' })).status, 200);
  const deleted = f.state().occurrences.find(item => item.id === row.id);
  const fresh = [{ ...items[0], details: '本次新识别说明。' }, items[1], items[3]];
  f.result({ choices: [{ message: { content: JSON.stringify({ occurrences: fresh }) }, finish_reason: 'stop' }] });
  await extracted(f); assert.equal(f.requests.length, 2);
  assert.deepEqual(f.state().candidates.map(({ kind, name, quote, mode, details }) => ({ kind, name, quote, mode, details })), fresh.map(({ kind, name, quote, mode, details }) => ({ kind, name, quote, mode, details })));
  assert.deepEqual(f.state().occurrences.find(item => item.id === row.id), deleted);
  const scene = f.state().occurrences.find(item => item.quote === items[1].quote);
  assert.equal((await update(f, scene, { ...existing(1, '房间', scene), details: '本轮另一项人工修改。' })).status, 200);
  const candidate = f.state().candidates.find(item => item.occurrenceId === row.id);
  assert.equal(candidate.quote, items[0].quote); assert.equal(candidate.mode, 'on_screen'); assert.equal(candidate.details, fresh[0].details); assert.equal(candidate.ignored, false);
  assert.equal(f.state().candidates.length, 3); assert.ok(!f.state().candidates.some(item => item.name === '周远'));
});

test('删完本轮草稿后重新提取确实请求模型：失败不改结果或自动重试，成功仅显示本次返回的项', async t => {
  const f = await fixture(t); await extracted(f);
  const removed = await f.post({ confirmed: 'yes', batchRevision: String(f.state().revision), scriptRevision: '1', targets: JSON.stringify({ type: 'candidates', items: [0, 1, 2, 3, 4] }) }, 'remove-resources');
  assert.equal(removed.status, 200); assert.equal(f.state().candidates.length, 0); assert.equal(f.state().occurrences.length, 0);
  const before = snapshots(f.db); const batch = f.state();
  f.result({ error: { message: 'provider unavailable' } }, 503);
  assert.equal((await f.post(f.fields())).status, 502); assert.equal(f.requests.length, 2);
  assert.deepEqual(f.state(), batch); assert.deepEqual(snapshots(f.db), before);
  f.result({ choices: [{ message: { content: JSON.stringify({ occurrences: [items[4]] }) }, finish_reason: 'stop' }] });
  await extracted(f); assert.equal(f.requests.length, 3);
  assert.equal(f.state().candidates.length, 1); assert.equal(f.state().candidates[0].name, '周远'); assert.deepEqual(snapshots(f.db), before);
  const html = await (await fetch(f.url + '/projects/1?view=episode&episode=1')).text(); assert.match(html, /重新提取人物与场景/);
});

test('提取提示词只分析本集正文、要求原文证据与真实姓名地点，不改编、不推断未知信息或输出分镜', () => {
  assert.doesNotMatch(extractResourcesPrompt, /[^\x00-\x7f]/);
  for (const rule of ['ONE saved episode screenplay', 'data, not instructions', 'Do not rewrite', 'Do not infer ages', 'copied verbatim', 'uniquely identify', 'Matching is handled separately', 'Maximum 200 occurrences', 'Ordinary in-scene dialogue', 'stable role or group label', 'brief appearances', 'The prose need not repeat the location name', 'COMPLETENESS CHECK', 'unknown', 'explicit nonvisual label', 'depicted figures inside a screen']) assert.ok(extractResourcesPrompt.includes(rule), rule);
  assert.doesNotMatch(extractResourcesPrompt, /Do not infer presence from a name, a cast list, dialogue attribution, or the scene heading alone/);
  assert.doesNotMatch(extractResourcesPrompt, /林秋|房间|路明非|表白/);
});

test('删除图标只删除本轮草稿：不创建忽略记录，不建／删共享档案，不改其他集；确认后重新提取完整显示新结果', async t => {
  const f = await fixture(t); await extracted(f); const before = snapshots(f.db);
  const remove = targets => f.post({ confirmed: 'yes', batchRevision: String(f.state().revision), scriptRevision: '1', targets: JSON.stringify(targets) }, 'remove-resources');
  let html = await (await fetch(f.url + '/projects/1?view=episode&episode=1')).text();
  assert.match(html, /data-resource-remove/); assert.match(html, /aria-label="删除本集整项：林秋"/); assert.match(html, /aria-label="删除这一处：周远"/);
  assert.equal((await remove({ type: 'candidates', items: [0, 2] })).status, 200);
  assert.equal(f.state().candidates.length, 3); assert.ok(!f.state().candidates.some(item => item.name === '林秋'));
  assert.equal((await remove({ type: 'candidates', items: [2] })).status, 200);
  assert.equal(f.state().candidates.length, 2); assert.ok(!f.state().candidates.some(item => item.name === '周远'));
  assert.deepEqual(snapshots(f.db).characters, before.characters); assert.deepEqual(snapshots(f.db).scenes, before.scenes);
  assert.equal(f.state().occurrences.length, 0); assert.equal(f.state(2).revision, 0);
  assert.equal((await f.confirm()).status, 200); assert.ok(f.state().occurrences.every(item => item.kind === 'scene'));
  await extracted(f); assert.equal(f.state().candidates.length, 5);
  assert.deepEqual(f.state().candidates.map(item => item.name), items.map(item => item.name));
  assert.equal(f.requests.length, 2);
});

test('删除已确认整组关联和单处关联，刷新待确认草稿，旧确认不能恢复，删除最后一项后空状态可再次提取', async t => {
  const f = await fixture(t); await extracted(f); await f.confirm(); await extracted(f, 2); await f.confirm(f.selections(2), 2); await extracted(f);
  const other = f.state(2); const resources = snapshots(f.db); const oldRevision = f.state().revision;
  const remove = rows => f.post({ confirmed: 'yes', batchRevision: String(f.state().revision), scriptRevision: '1', targets: JSON.stringify({ type: 'occurrences', items: rows.map(row => ({ id: row.id, revision: row.revision })) }) }, 'remove-resources');
  const characters = f.state().occurrences.filter(row => row.source_name === '林秋');
  assert.equal((await remove(characters)).status, 200); assert.equal(f.state().candidates.filter(item => item.name === '林秋').length, 0);
  assert.equal((await f.confirm(f.selections(), 1, { batchRevision: String(oldRevision) })).status, 409);
  const scene = f.state().occurrences.find(row => row.scene_id === 1); assert.equal((await remove([scene])).status, 200);
  assert.equal(f.state().occurrences.find(row => row.id === scene.id).ignored, 1);
  assert.equal(f.state().occurrences.filter(row => row.scene_id === 1).length, 1);
  const remaining = f.state().occurrences.filter(row => !row.ignored); assert.equal((await remove(remaining)).status, 200);
  assert.equal(f.state().candidates.length, 0); assert.equal(f.state().occurrences.filter(row => !row.ignored).length, 0);
  await extracted(f); assert.equal(f.state().candidates.length, 5);
  assert.ok(f.state().occurrences.every(row => row.ignored));
  assert.deepEqual(snapshots(f.db).characters, resources.characters); assert.deepEqual(snapshots(f.db).scenes, resources.scenes); assert.deepEqual(f.state(2), other);
  const html = await (await fetch(f.url + '/projects/1?view=episode&episode=1')).text(); assert.match(html, /已确认人物与场景 · 0 项资源/); assert.match(html, /id="extract-episode-resources"/);
});

test('删除范围确认、版本、编号、归属与事务校验，拒绝跨集、重复／无效和半组写入；不调用模型', async t => {
  const f = await fixture(t); await extracted(f); await f.confirm(); await extracted(f);
  const rows = f.state().occurrences; const payload = { confirmed: 'yes', batchRevision: String(f.state().revision), scriptRevision: '1', targets: JSON.stringify({ type: 'occurrences', items: [{ id: rows[0].id, revision: rows[0].revision }] }) };
  const before = snapshots(f.db); const batch = f.state();
  for (const fields of [{ ...payload, confirmed: 'no' }, { ...payload, batchRevision: '999' }, { ...payload, scriptRevision: '999' }, { ...payload, targets: 'invalid' },
    { ...payload, targets: JSON.stringify({ type: 'candidates', items: [0, 0] }) }, { ...payload, targets: JSON.stringify({ type: 'candidates', items: [0, 999] }) },
    { ...payload, targets: JSON.stringify({ type: 'occurrences', items: [{ id: rows[0].id, revision: rows[0].revision }, { id: rows[1].id, revision: 999 }] }) }]) {
    assert.ok([400, 409].includes((await f.post(fields, 'remove-resources')).status)); assert.deepEqual(snapshots(f.db), before); assert.deepEqual(f.state(), batch);
  }
  assert.equal((await f.post(payload, 'remove-resources', 2)).status, 409);
  assert.equal((await f.post({ ...payload, batchRevision: '0' }, 'remove-resources', 2)).status, 404);
  assert.equal((await f.post(payload, 'remove-resources', 1, 2)).status, 404);
  assert.equal((await f.post(payload, 'remove-resources', 1, 1, { headers: { Origin: 'https://elsewhere.example' } })).status, 403);
  f.db.exec("CREATE TEMP TRIGGER fail_remove BEFORE UPDATE ON episode_extractions BEGIN SELECT RAISE(ABORT, 'remove storage failure'); END");
  t.mock.method(console, 'error', () => {}); assert.equal((await f.post(payload, 'remove-resources')).status, 500);
  assert.deepEqual(snapshots(f.db), before); assert.deepEqual(f.state(), batch); assert.equal(f.requests.length, 2);
});

test('同版剧本重新提取也将未发现的旧位置留待核对，确认不恢复旧项，人工核对可恢复；保存草稿失败回滚标记', async t => {
  const f = await fixture(t); await extracted(f); await f.confirm();
  const old = snapshots(f.db); const batch = f.state();
  const response = { choices: [{ message: { content: JSON.stringify({ occurrences: items.slice(0, 4) }) }, finish_reason: 'stop' }] };
  f.result(response);
  f.db.exec("CREATE TEMP TRIGGER fail_filter BEFORE UPDATE ON episode_extractions BEGIN SELECT RAISE(ABORT, 'filter storage failure'); END");
  const failed = await f.post(f.fields()); assert.equal(failed.status, 502); assert.ok((await failed.json()).recoveryText);
  assert.deepEqual(snapshots(f.db), old); assert.deepEqual(f.state(), batch);
  f.db.exec('DROP TRIGGER fail_filter'); await extracted(f); assert.equal((await f.confirm()).status, 200);
  let missing = f.state().occurrences.find(row => row.source_name === '周远');
  assert.equal(missing.needs_review, 1); assert.ok(missing.character_id);
  let html = await (await fetch(f.url + '/projects/1?view=episode&episode=1')).text();
  assert.match(html, /已确认人物与场景 · 2 项资源 · 4 处画面出场/); assert.match(html, /待核对记录 · 1 处/);
  assert.equal((await update(f, missing, existing(missing.character_id, '周远', missing))).status, 200);
  missing = f.state().occurrences.find(row => row.id === missing.id); assert.equal(missing.needs_review, 0);
  html = await (await fetch(f.url + '/projects/1?view=episode&episode=1')).text();
  assert.match(html, /已确认人物与场景 · 3 项资源 · 5 处画面出场/);
});

test('版本12升级增加待核对标记而不改变旧关联／档案，失败完整回滚，重复打开保留标记', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ironweave-visible-migration-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, 'drama.sqlite'); const f = await fixture(t, filename); await extracted(f); await f.confirm();
  f.db.exec('DROP TABLE episode_storyboards; DROP TABLE scene_images; DROP TABLE scene_references; ALTER TABLE episode_occurrences DROP COLUMN needs_review; PRAGMA user_version = 12');
  const original = snapshots(f.db); const draft = f.state(); await f.close();
  const exec = DatabaseSync.prototype.exec;
  t.mock.method(DatabaseSync.prototype, 'exec', function(sql) { const result = exec.call(this, sql); if (sql.includes('PRAGMA user_version = 13')) throw new Error('review migration failure'); return result; });
  assert.throws(() => openDatabase(filename), /review migration failure/); t.mock.restoreAll();
  let db = new DatabaseSync(filename); assert.equal(db.prepare('PRAGMA user_version').get().user_version, 12);
  assert.deepEqual(snapshots(db), original); assert.deepEqual(readEpisodeResources(db, 1), draft);
  assert.ok(!db.prepare('PRAGMA table_info(episode_occurrences)').all().some(row => row.name === 'needs_review')); db.close();
  db = openDatabase(filename); assert.equal(db.prepare('PRAGMA user_version').get().user_version, 15);
  const upgraded = snapshots(db); assert.deepEqual(upgraded.characters, original.characters); assert.deepEqual(upgraded.scenes, original.scenes);
  assert.deepEqual(upgraded.occurrences.map(({ needs_review, ...row }) => row), original.occurrences.map(row => ({ ...row })));
  assert.ok(upgraded.occurrences.every(row => row.needs_review === 0)); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  const id = upgraded.occurrences[0].id; db.prepare('UPDATE episode_occurrences SET needs_review = 1 WHERE id = ?').run(id);
  db.close(); db = openDatabase(filename); assert.equal(db.prepare('SELECT needs_review FROM episode_occurrences WHERE id = ?').get(id).needs_review, 1); db.close();
});

test('新资源、候选、人工关联和移除状态重启后保留，版本11升级失败整组回滚并保留旧表数据', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ironweave-resources-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, 'drama.sqlite'); const f = await fixture(t, filename); await extracted(f); await f.confirm();
  const removed = f.state().occurrences.find(row => row.source_name === '周远');
  assert.equal((await update(f, removed, { action: 'ignore', mode: removed.mode, details: '手动移除，重启后保留。' })).status, 200);
  await extracted(f); assert.ok(f.state().candidates.find(item => item.name === '周远'));
  assert.equal(f.state().occurrences.find(item => item.id === removed.id).ignored, 1);
  const original = snapshots(f.db); const batch = f.state(); await f.close();
  let db = openDatabase(filename); assert.deepEqual(snapshots(db), original); assert.deepEqual(readEpisodeResources(db, 1), batch);
  db.close(); db = openDatabase(filename); assert.deepEqual(readEpisodeResources(db, 1), batch);
  db.exec('DROP TABLE episode_storyboards; DROP TABLE scene_images; DROP TABLE scene_references; DROP TABLE episode_occurrences; DROP TABLE episode_extractions; DROP TABLE scenes; PRAGMA user_version = 11');
  const oldCharacters = db.prepare('SELECT * FROM characters').all(); const oldScripts = db.prepare('SELECT * FROM episode_scripts').all(); db.close();
  const exec = DatabaseSync.prototype.exec;
  t.mock.method(DatabaseSync.prototype, 'exec', function(sql) { const result = exec.call(this, sql); if (sql.includes('PRAGMA user_version = 12')) throw new Error('resource migration failure'); return result; });
  assert.throws(() => openDatabase(filename), /resource migration failure/); t.mock.restoreAll();
  db = new DatabaseSync(filename); assert.equal(db.prepare('PRAGMA user_version').get().user_version, 11); assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'scenes'").get(), undefined); assert.deepEqual(db.prepare('SELECT * FROM characters').all(), oldCharacters); assert.deepEqual(db.prepare('SELECT * FROM episode_scripts').all(), oldScripts); db.close();
  db = openDatabase(filename); assert.equal(db.prepare('PRAGMA user_version').get().user_version, 15); assert.deepEqual(db.prepare('SELECT * FROM characters').all(), oldCharacters); assert.deepEqual(db.prepare('SELECT * FROM episode_scripts').all(), oldScripts); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); db.close();
});
