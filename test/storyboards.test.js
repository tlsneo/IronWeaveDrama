import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/database.js';
import { readEpisodeStoryboards, storyboardResources, projectStoryboardSummary, formatStoryboardDuration } from '../src/storyboards.js';
import { episodeToShotsPrompt } from '../prompts/storyboard/episode-to-shots.js';

const script = '1-1 房间 内 日\n画面/动作：林秋站在门口。\n台词：林秋：“回来啦。”\n1-2 房间 内 夜\n画面/动作：林秋看向空椅。\n画面/动作：回忆中，周远坐在空椅上。';
const shots = [
  { title: '门口', sceneHeading: '1-1 房间 内 日', quote: '画面/动作：林秋站在门口。', mode: 'on_screen', duration: 3.2, characterIds: [1], sceneId: 1, framing: '中景', action: '林秋站在门口。', dialogue: '', sound: '脚步声', transition: '切', timingReason: '停留以交代人物。' },
  { title: '空椅', sceneHeading: '1-2 房间 内 夜', quote: '画面/动作：回忆中，周远坐在空椅上。', mode: 'memory', duration: 4.1, characterIds: [3], sceneId: 1, framing: '全景', action: '回忆中周远坐在空椅上。', dialogue: '', sound: '', transition: '', timingReason: '区分回忆和现实。' },
];
const completion = (value = { shots }, finish_reason = 'stop') => ({ choices: [{ message: { content: typeof value === 'string' ? value : JSON.stringify(value) }, finish_reason }] });
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.listening ? new Promise(resolve => server.close(resolve)) : Promise.resolve() };
}
async function fixture(t) {
  const db = openDatabase(':memory:');
  db.exec(`INSERT INTO projects VALUES (1, '分镜测试', '水墨', '16:9'), (2, '其他项目', '电影', '9:16');
    INSERT INTO seasons VALUES (1, 1, '第一季', 1), (2, 1, '第二季', 2), (3, 2, '外部季', 1);
    INSERT INTO episodes VALUES (1, 1, '开场', 1), (2, 2, '其他集', 1), (3, 3, '外部集', 1);
    INSERT INTO characters (id, project_id, name, age, appearance_notes) VALUES (1, 1, '林秋', 32, '不许修改的档案'), (2, 2, '外部角色', 25, 'PRIVATE_OTHER_CHARACTER'), (3, 1, '周远', NULL, '回忆中的角色');
    INSERT INTO scenes VALUES (1, 1, '房间', '门和空椅'), (2, 2, '外部场景', 'PRIVATE_OTHER_SCENE');`);
  db.prepare('INSERT INTO episode_scripts (episode_id, source, script, notes, revision) VALUES (1, ?, ?, ?, 1), (2, ?, ?, ?, 1)').run('PRIVATE_NOVEL_SOURCE', script, 'PRIVATE_ADAPTATION_NOTES', 'PRIVATE_OTHER_SOURCE', 'PRIVATE_OTHER_SCRIPT', 'PRIVATE_OTHER_NOTES');
  const occurrence = (kind, id, quote, heading = shots[0].sceneHeading, mode = 'on_screen', episode = 1, overrides = {}) => {
    const row = { character: kind === 'character' ? id : null, scene: kind === 'scene' ? id : null, revision: 1, ignored: 0, needsReview: 0, ...overrides };
    return Number(db.prepare(`INSERT INTO episode_occurrences (episode_id, kind, character_id, scene_id, source_name, scene_heading, quote, source_start, mode, details, script_revision, ignored, needs_review)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)`).run(episode, kind, row.character, row.scene, `证据-${kind}-${id}-${quote}`, heading, quote, Math.max(0, script.indexOf(quote)), mode, row.revision, row.ignored, row.needsReview).lastInsertRowid);
  };
  const firstOccurrence = occurrence('character', 1, shots[0].quote);
  occurrence('character', 1, '画面/动作：林秋看向空椅。', shots[1].sceneHeading);
  occurrence('character', 3, shots[1].quote, shots[1].sceneHeading, 'memory');
  occurrence('scene', 1, shots[0].sceneHeading);
  occurrence('scene', 1, shots[1].sceneHeading, shots[1].sceneHeading);
  const requests = []; let result = completion(), status = 200, waiting, release, started;
  const provider = await listen(createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    requests.push({ path: request.url, authorization: request.headers.authorization, body: JSON.parse(raw) });
    if (waiting) { started(); await waiting; }
    response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result));
  }));
  db.prepare("INSERT INTO api_configs (id, name, type, base_url, api_key, model) VALUES (1, '分镜模型', 'llm', ?, 'synthetic-storyboard-token', 'storyboard-model'), (2, '图片模型', 'text_to_image', ?, 'synthetic-image-token', 'image-model')").run(provider.url + '/v1', provider.url + '/v1');
  const app = await listen(createApp(db));
  t.after(async () => { release?.(); await app.close(); await provider.close(); });
  const state = (episode = 1) => readEpisodeStoryboards(db, episode);
  const resources = (episode = 1, project = 1) => storyboardResources(db, project, episode);
  const fields = (episode = 1) => ({ revision: String(state(episode).revision), scriptRevision: String(db.prepare('SELECT revision FROM episode_scripts WHERE episode_id = ?').get(episode)?.revision ?? 0), resourceRevision: resources(episode).revision, maxShotSeconds: '5' });
  const generation = (episode = 1) => ({ ...fields(episode), apiConfigId: '1', model: 'storyboard-model', baseUrl: provider.url + '/v1', replaceConfirmed: 'yes' });
  const post = (fields, action = 'storyboards', episode = 1, project = 1, options = {}) => fetch(`${app.url}/projects/${project}/episodes/${episode}/${action}`, { method: 'POST', body: new URLSearchParams(fields), ...options });
  const save = (value = shots, episode = 1, overrides = {}) => post({ ...fields(episode), shots: JSON.stringify(value), ...overrides }, 'storyboards', episode);
  const generate = (overrides = {}, episode = 1) => post({ ...generation(episode), ...overrides }, 'generate-storyboards', episode);
  const row = () => db.prepare('SELECT * FROM episode_storyboards WHERE episode_id = 1').get();
  return { db, ...app, requests, post, state, resources, fields, generation, save, generate, row, occurrence, firstOccurrence,
    result(value, code = 200) { result = value; status = code; },
    pause() { waiting = new Promise(resolve => { release = resolve; }); return new Promise(resolve => { started = resolve; }); },
    resume() { release(); waiting = undefined; },
  };
}
const immutable = db => ['episode_scripts', 'characters', 'scenes', 'episode_occurrences'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
const summary = f => projectStoryboardSummary(f.db, 1);

// All provider traffic is captured by a loopback server with synthetic credentials.
test('缺少计划时返回空状态、默认5秒；缺少资源不阻止纯文字规划，空计划不算已核对时长', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.state(), { revision: 0, scriptRevision: 0, resourceRevision: '', maxShotSeconds: 5, reviewed: false, shots: [] });
  f.db.exec('DELETE FROM episode_occurrences');
  assert.deepEqual(f.resources().characters, []); assert.deepEqual(f.resources().scenes, []);
  assert.equal((await f.save([])).status, 200);
  assert.equal(f.state().reviewed, false); assert.equal(f.state().revision, 1);
  const textShots = shots.map(shot => ({ ...shot, characterIds: [], sceneId: null }));
  f.result(completion({ shots: textShots })); assert.equal((await f.generate()).status, 200);
  assert.equal(f.state().reviewed, false); assert.deepEqual(f.state().shots, textShots);
  assert.equal(summary(f).totalSeconds, 0); assert.equal(summary(f).pendingEpisodes, 1);
});

test('资源只读本集当前已确认画面出场，合并同ID，排除其他项目／集、过期、忽略、待核对与非画面资源', async t => {
  const f = await fixture(t);
  f.db.exec("INSERT INTO characters (id, project_id, name) VALUES (4, 1, '未确认'), (5, 1, '过期'), (6, 1, '忽略'), (7, 1, '待核对'), (8, 1, '仅提及'), (9, 1, '其他集'), (10, 1, '声音'), (11, 1, '心声'), (12, 1, '想象');");
  f.occurrence('character', 5, '过期位置', undefined, 'on_screen', 1, { revision: 2 });
  f.occurrence('character', 6, '忽略位置', undefined, 'on_screen', 1, { ignored: 1 });
  f.occurrence('character', 7, '待核对位置', undefined, 'on_screen', 1, { needsReview: 1 });
  f.occurrence('character', 8, '提及位置', undefined, 'mentioned');
  f.occurrence('character', 9, '其他集位置', undefined, 'on_screen', 2);
  f.occurrence('character', 10, '声音位置', undefined, 'off_screen');
  f.occurrence('character', 11, '心声位置', undefined, 'inner_voice');
  f.occurrence('character', 12, '台词：林秋：“回来啦。”', undefined, 'imagination');
  f.occurrence('character', 2, '越界档案');
  const before = immutable(f.db), resources = f.resources();
  assert.deepEqual(resources.characters.map(item => item.id), [1, 3, 12]);
  assert.deepEqual(resources.scenes.map(item => item.id), [1]);
  assert.equal(resources.characters[0].name, '林秋'); assert.match(resources.characters[0].description, /不许修改的档案/);
  assert.equal(resources.scenes[0].description, '门和空椅');
  assert.ok(resources.characters.every(item => item.image === null));
  assert.match(resources.revision, /^[a-f0-9]{64}$/); assert.equal(f.resources().revision, resources.revision);
  assert.deepEqual(immutable(f.db), before); assert.equal(f.requests.length, 0);
});

test('图片仅固定ID／类型／URL元数据：最新有效生成图优先，无效或清空回退上传参考图，读资源不推理', async t => {
  const f = await fixture(t), pixels = Buffer.from('PRIVATE_IMAGE_PIXELS');
  for (const [kind, table, column, generated] of [['character', 'characters', 'character_id', 'character_boards'], ['scene', 'scenes', 'scene_id', 'scene_images']]) {
    const references = `${kind}_references`;
    const ref = Number(f.db.prepare(`INSERT INTO ${references} (${column}, image, mime, width, height) VALUES (1, ?, 'image/png', 16, 9)`).run(pixels).lastInsertRowid);
    const item = () => f.resources()[table][0];
    assert.deepEqual(item().image, { id: ref, type: 'references', url: `/projects/1/${table}/1/references/${ref}` });
    const originalHash = f.resources().revision;
    const insert = (valid, cleared = 0) => Number(f.db.prepare(`INSERT INTO ${generated} (${column}, image, mime, width, height, valid, revision, model, prompt, cleared) VALUES (1, ?, 'image/png', 16, 9, ?, 'fixture-image-revision', 'fixture-image-model', 'fixture-prompt', ?)`).run(pixels, valid, cleared).lastInsertRowid);
    const id = insert(1); insert(0); insert(1, 1);
    assert.deepEqual(item().image, { id, type: kind === 'character' ? 'boards' : 'images', url: `/projects/1/${table}/1/${kind === 'character' ? 'boards' : 'images'}/${id}` });
    assert.notEqual(f.resources().revision, originalHash);
    f.db.prepare(`UPDATE ${generated} SET valid = 0 WHERE id = ?`).run(id);
    assert.equal(item().image.type, 'references'); assert.equal(f.resources().revision, originalHash);
    f.db.prepare(`UPDATE ${references} SET cleared = 1 WHERE id = ?`).run(ref); assert.equal(item().image, null);
  }
  assert.doesNotMatch(JSON.stringify(f.resources()), /PRIVATE_IMAGE_PIXELS|fixture-prompt|fixture-image-model/);
  assert.equal(f.requests.length, 0);
});

test('资源快照包括名称、描述、图ID及关联证据；编辑、删除、媒体和出场变化使计划过期，其他集不影响', async t => {
  const f = await fixture(t);
  for (const sql of ["UPDATE characters SET name = name || '改' WHERE id = 1", "UPDATE characters SET appearance_notes = appearance_notes || '改' WHERE id = 1", "UPDATE scenes SET description = description || '改' WHERE id = 1", `UPDATE episode_occurrences SET details = details || '改' WHERE id = ${f.firstOccurrence}`, `UPDATE episode_occurrences SET revision = revision + 1 WHERE id = ${f.firstOccurrence}`, `DELETE FROM episode_occurrences WHERE id = ${f.firstOccurrence}`, 'DELETE FROM characters WHERE id = 1']) {
    const hash = f.resources().revision; f.db.exec('SAVEPOINT resource_change'); f.db.exec(sql);
    assert.notEqual(f.resources().revision, hash, sql);
    f.db.exec('ROLLBACK TO resource_change; RELEASE resource_change');
  }
  const hash = f.resources().revision;
  f.db.exec("UPDATE characters SET name = '外部改名' WHERE id = 2; UPDATE episode_scripts SET script = '其他集改稿', revision = 2 WHERE episode_id = 2");
  assert.equal(f.resources().revision, hash);
  assert.equal(f.requests.length, 0);
});

test('手动保存核对非空计划，递增版本并返回分镜redirect；允许空稿和省略可选文字，不调用模型或修改剧本／档案', async t => {
  const f = await fixture(t), before = immutable(f.db);
  let response = await f.save(); assert.equal(response.status, 200);
  let result = await response.json(); assert.equal(result.revision, 1); assert.equal(result.redirect, '/projects/1?view=storyboards&episode=1');
  assert.deepEqual(f.state().shots, shots); assert.equal(f.state().reviewed, true);
  assert.equal(f.state().scriptRevision, 1); assert.equal(f.state().resourceRevision, f.resources().revision);
  assert.equal(summary(f).totalSeconds, 7.3); assert.equal(summary(f).shotCount, 2);
  assert.equal((await f.save([], 1, { maxShotSeconds: '15' })).status, 200);
  assert.equal(f.state().reviewed, false); assert.equal(f.state().maxShotSeconds, 15);
  const optional = { ...shots[0], duration: 0.1, mode: 'imagination' };
  for (const field of ['dialogue', 'sound', 'transition']) delete optional[field];
  response = await f.save([optional], 1, { maxShotSeconds: '1' }); assert.equal(response.status, 200, 'dialogue/sound/transition are optional');
  assert.equal(f.state().revision, 3); assert.equal(f.state().reviewed, true);
  assert.deepEqual(immutable(f.db), before); assert.equal(f.requests.length, 0);
});

test('逐镜字段边界、唯一原文／标题顺序、时长0.1步长、当前资源ID、镜头数和JSON总大小均验证，失败不覆盖', async t => {
  const f = await fixture(t); assert.equal((await f.save()).status, 200); const original = f.row();
  const invalid = [null, [], { ...shots[0], mode: 'mentioned' }, { ...shots[0], mode: 'off_screen' }, { ...shots[0], mode: '__proto__' }, { ...shots[0], quote: '虚构原文' }, { ...shots[0], quote: '林秋' }, { ...shots[0], sceneHeading: shots[1].sceneHeading }, ...[0, -1, 5.1, 0.15, '3.2', null].map(duration => ({ ...shots[0], duration })), ...[[1, 1], [2], [999], ['1'], Array(51).fill(1)].map(characterIds => ({ ...shots[0], characterIds })), ...[2, 999, '1', undefined].map(sceneId => ({ ...shots[0], sceneId }))];
  for (const [field, limit] of Object.entries({ title: 120, sceneHeading: 300, quote: 1500, framing: 500, action: 1500, dialogue: 2000, sound: 1000, transition: 500, timingReason: 500 })) {
    invalid.push({ ...shots[0], [field]: 'x'.repeat(limit + 1) }, { ...shots[0], [field]: '\0' }, { ...shots[0], [field]: 3 });
    if (['title', 'sceneHeading', 'quote', 'framing', 'action', 'timingReason'].includes(field)) invalid.push({ ...shots[0], [field]: '' });
  }
  for (const shot of invalid) {
    assert.equal((await f.save([shot])).status, 400, JSON.stringify(shot)); assert.deepEqual(f.row(), original);
  }
  for (const value of [{ shots }, null, Array(301).fill(shots[0]), Array(100).fill({ ...shots[0], action: 'x'.repeat(1500), dialogue: 'x'.repeat(2000), sound: 'x'.repeat(1000), transition: 'x'.repeat(500), framing: 'x'.repeat(500) })]) {
    assert.equal((await f.save(value)).status, 400); assert.deepEqual(f.row(), original);
  }
  assert.equal((await f.post({ ...f.fields(), shots: '{' })).status, 400);
  assert.equal((await f.post(f.fields())).status, 400);
  const boundary = { ...shots[0], title: 'x'.repeat(120), framing: 'x'.repeat(500), action: 'x'.repeat(1500), dialogue: 'x'.repeat(2000), sound: 'x'.repeat(1000), transition: 'x'.repeat(500), timingReason: 'x'.repeat(500), duration: 5 };
  assert.equal((await f.save([boundary])).status, 200);
  assert.equal((await f.save(Array(300).fill({ ...shots[0], duration: 0.1 }))).status, 200);
  const beforePartialHeading = f.row();
  assert.equal((await f.save([{ ...shots[0], sceneHeading: '1-1 房间 内' }])).status, 400, 'sceneHeading must match the complete saved heading, not just its prefix');
  assert.deepEqual(f.row(), beforePartialHeading);
  assert.equal(f.requests.length, 0);
});

test('原文必须属于所标场次，不能借后一场冒充前场覆盖或跨越场边界；失败保留旧稿及付费返回文本', async t => {
  const f = await fixture(t); assert.equal((await f.save()).status, 200); const original = f.row();
  const wrongScene = { ...shots[0], quote: shots[1].quote };
  const acrossScenes = { ...shots[0], quote: script.slice(script.indexOf(shots[0].quote), script.indexOf(shots[1].quote) + shots[1].quote.length) };
  for (const shot of [wrongScene, acrossScenes, { ...shots[0], sceneHeading: '1' }]) {
    assert.equal((await f.save([shot])).status, 400); assert.deepEqual(f.row(), original);
  }
  f.result(completion({ shots: [wrongScene, shots[1]] }));
  const response = await f.generate(); assert.equal(response.status, 502);
  assert.deepEqual(JSON.parse((await response.json()).recoveryText), { shots: [wrongScene, shots[1]] });
  assert.deepEqual(f.row(), original); assert.equal(f.requests.length, 1);
  f.db.prepare('UPDATE episode_scripts SET script = ? WHERE episode_id = 1').run(script.replaceAll('\n', '\r\n'));
  assert.equal((await f.save()).status, 200, 'CRLF source positions still accept correctly anchored shots');
  f.result(completion({ shots })); assert.equal((await f.generate()).status, 200, 'CRLF source generation checks coverage without treating CR as part of the heading');
  const current = f.row(), duplicateHeading = script.replace(shots[1].sceneHeading, shots[0].sceneHeading);
  f.db.prepare('UPDATE episode_scripts SET script = ? WHERE episode_id = 1').run(duplicateHeading);
  f.result(completion({ shots: [{ ...shots[1], sceneHeading: shots[0].sceneHeading }] }));
  assert.equal((await f.generate()).status, 502, 'repeated identical heading lines are separate scene intervals, not proof of both scenes being covered');
  assert.deepEqual(f.row(), current); assert.equal(f.requests.length, 3);
});

test('画面类型必须是枚举字符串，数组和其他JSON类型不保存、不改变旧分镜叙事层', async t => {
  const f = await fixture(t); assert.equal((await f.save()).status, 200); const original = f.row();
  for (const mode of [['memory'], ['on_screen'], [], null, false, 1, { toString: 'memory' }]) {
    assert.equal((await f.save([{ ...shots[1], mode }])).status, 400); assert.deepEqual(f.row(), original);
  }
  f.result(completion({ shots: [shots[0], { ...shots[1], mode: ['memory'] }] }));
  const response = await f.generate(); assert.equal(response.status, 502);
  assert.ok((await response.json()).recoveryText); assert.deepEqual(f.row(), original); assert.equal(f.requests.length, 1);
});

test('计费前拒绝旧版本／脚本／资源快照、非法最大时长和模型配置；替换已有镜头须yes确认，旧计划保留', async t => {
  const f = await fixture(t); assert.equal((await f.save()).status, 200); const original = f.row();
  for (const action of ['storyboards', 'generate-storyboards']) {
    const base = action === 'storyboards' ? { ...f.fields(), shots: JSON.stringify(shots) } : f.generation();
    for (const [key, value, expected] of [['revision', '0', 409], ['scriptRevision', '0', 409], ['resourceRevision', 'old', 409], ['revision', 'bad', 400], ['scriptRevision', '-1', 400], ...['0', '16', '1.5', '01', '', 'NaN'].map(value => ['maxShotSeconds', value, 400])]) assert.equal((await f.post({ ...base, [key]: value }, action)).status, expected, `${action}: ${key}=${value}`);
  }
  for (const [key, value, expected] of [['apiConfigId', '2', 400], ['apiConfigId', '99999', 404], ['apiConfigId', 'bad', 400], ['model', 'changed', 409], ['baseUrl', 'changed', 409], ['replaceConfirmed', 'no', 400]]) assert.equal((await f.generate({ [key]: value })).status, expected);
  const missing = f.generation(); delete missing.replaceConfirmed;
  assert.equal((await f.post(missing, 'generate-storyboards')).status, 400);
  assert.deepEqual(f.row(), original); assert.equal(f.requests.length, 0);
  f.db.exec("UPDATE characters SET name = '档案已变化' WHERE id = 1");
  assert.equal((await f.save()).status, 409, 'a fresh request snapshot cannot silently endorse a stale stored plan');
  assert.deepEqual(f.row(), original);
  assert.equal((await f.generate()).status, 200, 'explicit regeneration can replace stale plans');
});

test('一次非流式chat/completions调用，16384tokens／180秒，发送已保存本集剧本、上限和已确认资源元数据，生成草稿须人工核对', async t => {
  const f = await fixture(t), pixels = Buffer.from('PRIVATE_IMAGE_PIXELS');
  f.db.prepare("INSERT INTO character_references (character_id, image, mime, width, height) VALUES (1, ?, 'image/png', 16, 9)").run(pixels);
  f.db.prepare("INSERT INTO scene_images (scene_id, image, mime, width, height, valid, revision, model, prompt) VALUES (1, ?, 'image/png', 16, 9, 1, 'dummy-image-revision', 'dummy-model', 'PRIVATE_IMAGE_PROMPT')").run(pixels);
  const before = immutable(f.db), timeouts = [], originalTimeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', milliseconds => { timeouts.push(milliseconds); return originalTimeout(milliseconds); });
  const response = await f.generate({ maxShotSeconds: '6' }); assert.equal(response.status, 200);
  const result = await response.json(); assert.equal(result.redirect, '/projects/1?view=storyboards&episode=1'); assert.equal(result.revision, 1);
  assert.equal(f.state().reviewed, false); assert.deepEqual(f.state().shots, shots); assert.equal(f.state().maxShotSeconds, 6);
  assert.equal(summary(f).totalSeconds, 0); assert.equal(summary(f).pendingEpisodes, 1);
  assert.equal(f.requests.length, 1); const request = f.requests[0];
  assert.equal(request.path, '/v1/chat/completions'); assert.equal(request.authorization, 'Bearer synthetic-storyboard-token');
  assert.equal(request.body.model, 'storyboard-model'); assert.equal(request.body.stream, false); assert.equal(request.body.max_tokens, 16384);
  assert.ok(timeouts.includes(180000)); assert.equal(request.body.messages.length, 2);
  assert.equal(request.body.messages[0].role, 'system'); assert.equal(request.body.messages[0].content, episodeToShotsPrompt);
  assert.equal(request.body.messages[1].role, 'user'); const input = JSON.parse(request.body.messages[1].content);
  assert.deepEqual(input, { episodeNumber: 1, script, maxShotSeconds: 6, resources: f.resources() });
  assert.doesNotMatch(JSON.stringify(request.body), /PRIVATE_NOVEL_SOURCE|PRIVATE_ADAPTATION_NOTES|PRIVATE_OTHER|synthetic-storyboard-token|synthetic-image-token|data:image|b64_json|PRIVATE_IMAGE_PIXELS|PRIVATE_IMAGE_PROMPT|UFJJVkFURV9JTUFHRV9QSVhFTFM=/);
  assert.equal((await f.save(f.state().shots, 1, { maxShotSeconds: '6' })).status, 200);
  assert.equal(f.state().reviewed, true); assert.equal(summary(f).totalSeconds, 7.3); assert.equal(f.requests.length, 1);
  assert.deepEqual(immutable(f.db), before);
});

test('没有已保存剧本不能生成；缺少图／档案仍可生成纯文字完整场景，未改剧本或其他集', async t => {
  const f = await fixture(t), original = immutable(f.db);
  f.db.exec("UPDATE episode_scripts SET script = '' WHERE episode_id = 1");
  assert.equal((await f.generate()).status, 400); assert.equal(f.requests.length, 0);
  f.db.prepare('UPDATE episode_scripts SET script = ? WHERE episode_id = 1').run(script);
  f.db.exec('DELETE FROM characters WHERE project_id = 1; DELETE FROM scenes WHERE project_id = 1');
  const textShots = shots.map(shot => ({ ...shot, characterIds: [], sceneId: null }));
  f.result(completion({ shots: textShots })); assert.equal((await f.generate()).status, 200);
  assert.deepEqual(f.state().shots, textShots); assert.deepEqual(immutable(f.db)[0], original[0]);
  assert.equal(f.state(2).revision, 0); assert.equal(f.requests.length, 1);
});

test('无效／超限／截断或漏掉最后编号场的付费输出返回恢复文本，不重试且不覆盖旧计划；只generation要求覆盖全部场', async t => {
  const f = await fixture(t); assert.equal((await f.save()).status, 200); const original = f.row();
  const invalid = [completion('非 JSON synthetic-storyboard-token'), completion({ shots: [] }), completion({ shots, extra: true }), completion({ shots }, 'length'), completion({ shots }, 'content_filter'), completion({ shots: [shots[0]] }), completion({ shots: [{ ...shots[0], quote: '不存在' }, shots[1]] }), completion({ shots: [{ ...shots[0], duration: 5.1 }, shots[1]] }), completion({ shots: [{ ...shots[0], characterIds: [2] }, shots[1]] }), completion({ shots: Array(301).fill(shots[0]) }), completion({ shots: Array(100).fill({ ...shots[0], action: 'x'.repeat(1500), dialogue: 'x'.repeat(2000), sound: 'x'.repeat(1000), framing: 'x'.repeat(500), transition: 'x'.repeat(500) }) })];
  for (const value of invalid) {
    f.result(value); const count = f.requests.length, response = await f.generate(); assert.equal(response.status, 502);
    const failure = await response.json(); assert.ok(failure.recoveryText); assert.doesNotMatch(JSON.stringify(failure), /synthetic-storyboard-token/);
    if (value.choices[0].message.content === JSON.stringify({ shots: [shots[0]] })) assert.deepEqual(JSON.parse(failure.recoveryText), { shots: [shots[0]] });
    assert.deepEqual(f.row(), original); assert.equal(f.requests.length, count + 1);
  }
  for (const [value, code] of [[{ error: { message: 'synthetic-storyboard-token provider failure' } }, 500], [{ task_id: 'not-a-result' }, 200], [{ choices: [{ message: { content: '' } }] }, 200]]) {
    f.result(value, code); const count = f.requests.length, response = await f.generate(); assert.equal(response.status, 502);
    assert.doesNotMatch(JSON.stringify(await response.json()), /synthetic-storyboard-token/); assert.deepEqual(f.row(), original); assert.equal(f.requests.length, count + 1);
  }
  assert.equal((await f.save([shots[0]])).status, 200, 'manual removal of a scene is allowed');
  f.result(completion('```json\n' + JSON.stringify({ shots }) + '\n```')); assert.equal((await f.generate()).status, 200);
});

test('付费返回后重查所有快照，脚本原文、版本、资源或计划异常变化返回409恢复文本，保持旧稿', async t => {
  const f = await fixture(t); assert.equal((await f.save()).status, 200);
  for (const [sql, restore] of [
    ["UPDATE episode_scripts SET script = script || '改变' WHERE episode_id = 1", () => f.db.prepare('UPDATE episode_scripts SET script = ? WHERE episode_id = 1').run(script)],
    ['UPDATE episode_scripts SET revision = revision + 1 WHERE episode_id = 1', () => f.db.exec('UPDATE episode_scripts SET revision = 1 WHERE episode_id = 1')],
    ["UPDATE characters SET name = name || '改' WHERE id = 1", () => f.db.exec("UPDATE characters SET name = '林秋' WHERE id = 1")],
    [`UPDATE episode_occurrences SET ignored = 1 WHERE id = ${f.firstOccurrence}`, () => f.db.prepare('UPDATE episode_occurrences SET ignored = 0 WHERE id = ?').run(f.firstOccurrence)],
    ['UPDATE episode_storyboards SET revision = revision + 1 WHERE episode_id = 1', () => f.db.exec('UPDATE episode_storyboards SET revision = revision - 1 WHERE episode_id = 1')],
  ]) {
    const started = f.pause(), pending = f.generate(); await started;
    f.db.exec(sql); const changed = f.row(); f.resume();
    const response = await pending; assert.equal(response.status, 409, sql);
    assert.deepEqual(JSON.parse((await response.json()).recoveryText), { shots }); assert.deepEqual(f.row(), changed);
    restore();
  }
  assert.equal(f.requests.length, 5);
});

test('生成保存失败原子回滚，初次不留半稿、替换不损失旧稿，恢复付费结果；字段同名密钥仍先解析再脱敏', async t => {
  const f = await fixture(t);
  f.db.exec("CREATE TEMP TRIGGER fail_storyboard_insert BEFORE INSERT ON episode_storyboards BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END");
  let response = await f.generate(); assert.equal(response.status, 502); assert.deepEqual(JSON.parse((await response.json()).recoveryText), { shots }); assert.equal(f.row(), undefined);
  f.db.exec('DROP TRIGGER fail_storyboard_insert'); assert.equal((await f.save()).status, 200); const original = f.row();
  f.db.exec("CREATE TEMP TRIGGER fail_storyboard_update BEFORE UPDATE ON episode_storyboards BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END");
  response = await f.generate(); assert.equal(response.status, 502); const failure = await response.json(); assert.match(failure.error, /已生成但未能保存/); assert.ok(failure.recoveryText); assert.deepEqual(f.row(), original);
  f.db.exec('DROP TRIGGER fail_storyboard_update');
  for (const key of ['shots', 'a"b']) {
    f.db.prepare('UPDATE api_configs SET api_key = ? WHERE id = 1').run(key);
    f.result(completion({ shots: shots.map(shot => ({ ...shot, action: `模型意外输出：${key}` })) }));
    response = await f.generate(); assert.equal(response.status, 200);
    assert.ok(f.state().shots.every(shot => shot.action.includes('[密钥已隐藏]') && !shot.action.includes(key)));
  }
  assert.equal(f.requests.length, 4);
});

test('共用本集锁防重复付费，同时阻止剧本保存／生成／提取、确认／修改／移除出场、保存分镜和级联删除，其他集仍可编辑', async t => {
  const f = await fixture(t), started = f.pause(), pending = f.generate(); await started;
  const paths = [
    ['generate-storyboards', f.generation()], ['storyboards', { ...f.fields(), shots: JSON.stringify(shots) }],
    ['script', { source: '原文', script: '修改', notes: '', revision: '1' }],
    ['generate-script', { revision: '1', apiConfigId: '1', model: 'storyboard-model', baseUrl: f.generation().baseUrl, replaceConfirmed: 'yes' }],
    ['extract-resources', { revision: '1', batchRevision: '0', apiConfigId: '1', model: 'storyboard-model', baseUrl: f.generation().baseUrl }],
    ['confirm-resources', { batchRevision: '0', scriptRevision: '1', selections: '[]' }],
    [`resource-occurrences/${f.firstOccurrence}`, { revision: '1', scriptRevision: '1', selection: JSON.stringify({ action: 'existing', resourceId: 1, resourceName: '林秋', sceneHeading: shots[0].sceneHeading, quote: shots[0].quote, mode: 'on_screen', details: '' }) }],
    ['remove-resources', { confirmed: 'yes', batchRevision: '0', scriptRevision: '1', targets: JSON.stringify({ type: 'occurrences', items: [{ id: f.firstOccurrence, revision: 1 }] }) }],
  ];
  for (const [action, fields] of paths) { const response = await f.post(fields, action); assert.equal(response.status, 409, action); assert.match((await response.json()).error, /本集正在生成剧本、提取资源或设计分镜/); }
  for (const [path, name] of [['/projects/1/episodes/1/delete', '开场'], ['/projects/1/seasons/1/delete', '第一季'], ['/projects/1/delete', '分镜测试']]) assert.equal((await fetch(f.url + path, { method: 'POST', body: new URLSearchParams({ confirmed: 'yes', name }) })).status, 409);
  assert.equal((await f.post({ source: '其他集', script: '正常修改', notes: '', revision: '1' }, 'script', 2)).status, 200);
  assert.equal((await f.save([], 2)).status, 200);
  f.resume(); assert.equal((await pending).status, 200); assert.equal(f.requests.length, 1);
  assert.equal((await f.save()).status, 200, 'lock released after completion');
});

test('全剧仅累计已核对且脚本与资源当前的分镜，完整计数缺失／草稿／过期并正确累计0.1秒，不把零集当完整时长', async t => {
  const f = await fixture(t);
  f.db.exec("INSERT INTO episodes VALUES (4, 1, '缺失', 2), (5, 1, '空稿', 3), (6, 2, '资源过期', 2); INSERT INTO projects VALUES (3, '零集项目', '水墨', '16:9');");
  f.db.prepare('UPDATE episode_scripts SET script = ? WHERE episode_id = 2').run(script);
  for (const episode of [4, 5, 6]) f.db.prepare('INSERT INTO episode_scripts (episode_id, script, revision) VALUES (?, ?, 1)').run(episode, script);
  assert.equal((await f.save()).status, 200);
  const textShots = shots.map(shot => ({ ...shot, characterIds: [], sceneId: null }));
  f.result(completion({ shots: textShots })); assert.equal((await f.generate({}, 2)).status, 200);
  assert.equal((await f.save([], 5)).status, 200); assert.equal((await f.save(textShots, 6)).status, 200);
  f.occurrence('character', 1, shots[0].quote, undefined, 'on_screen', 6);
  assert.deepEqual(summary(f), { episodeCount: 5, plannedEpisodes: 1, unplannedEpisodes: 2, pendingEpisodes: 1, staleEpisodes: 1, totalSeconds: 7.3, shotCount: 2 });
  assert.deepEqual(projectStoryboardSummary(f.db, 3), { episodeCount: 0, plannedEpisodes: 0, unplannedEpisodes: 0, pendingEpisodes: 0, staleEpisodes: 0, totalSeconds: 0, shotCount: 0 });
  f.db.exec('UPDATE episode_scripts SET revision = revision + 1 WHERE episode_id = 1');
  assert.equal(summary(f).plannedEpisodes, 0); assert.equal(summary(f).staleEpisodes, 2); assert.equal(summary(f).totalSeconds, 0);
  for (const [seconds, expected] of [[0, '0 秒'], [0.1, '0.1 秒'], [59.9, '59.9 秒'], [60, '1 分 0 秒'], [61.2, '1 分 1.2 秒'], [120, '2 分 0 秒']]) assert.equal(formatStoryboardDuration(seconds), expected);
});

test('两个路由拒绝跨项目／跨站／格式错误／重复字段／超大请求，不付费、不写数据、不泄漏密钥', async t => {
  const f = await fixture(t); assert.equal((await f.save()).status, 200); const original = f.row();
  for (const action of ['storyboards', 'generate-storyboards']) {
    const fields = action === 'storyboards' ? { ...f.fields(), shots: JSON.stringify(shots) } : f.generation();
    for (const [project, episode] of [[2, 1], [1, 3], [1, 99999], [1, '9007199254740992']]) assert.equal((await f.post(fields, action, episode, project)).status, 404);
    for (const headers of [{ Origin: 'https://other.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) assert.equal((await f.post(fields, action, 1, 1, { headers })).status, 403);
    assert.equal((await f.post(fields, action, 1, 1, { headers: { 'Content-Type': 'application/json' } })).status, 415);
    assert.equal((await f.post({ huge: 'x'.repeat(action === 'storyboards' ? 1024 * 1024 + 1 : 33000) }, action)).status, 413);
    for (const field of Object.keys(fields)) {
      const duplicate = new URLSearchParams(fields); duplicate.append(field, fields[field]);
      assert.ok([400, 409].includes((await f.post(duplicate, action)).status), `${action}: duplicate ${field}`);
    }
  }
  assert.deepEqual(f.row(), original); assert.equal(f.requests.length, 0);
});
