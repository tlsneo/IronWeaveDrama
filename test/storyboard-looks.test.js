import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/database.js';
import { lookInputs } from '../src/looks.js';
import { readEpisodeStoryboards, storyboardResources, projectStoryboardSummary } from '../src/storyboards.js';

const heading = '1-1 房间 内 日';
const script = `${heading}\n画面/动作：阿青推门。\n画面/动作：阿青坐下，阿白站在窗边。`;
const shots = [
  { title: '推门', sceneHeading: heading, quote: '画面/动作：阿青推门。', mode: 'on_screen', duration: 2, characterIds: [1], sceneId: null, framing: '中景', action: '阿青推门。', dialogue: '', sound: '', transition: '', timingReason: '交代入场。' },
  { title: '窗边', sceneHeading: heading, quote: '画面/动作：阿青坐下，阿白站在窗边。', mode: 'on_screen', duration: 3, characterIds: [1, 3], sceneId: null, framing: '全景', action: '阿青坐下。', dialogue: '', sound: '', transition: '', timingReason: '交代空间。' },
];
const pixels = Buffer.from('synthetic-look-image-only');

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}
async function fixture(t) {
  const db = openDatabase(':memory:');
  db.exec(`INSERT INTO projects VALUES (1, '定妆分镜', '水墨', '16:9'), (2, '外部项目', '电影', '16:9');
    INSERT INTO seasons VALUES (1, 1, '第一季', 1);
    INSERT INTO episodes VALUES (1, 1, '入场', 1);
    INSERT INTO characters (id, project_id, name, appearance_notes) VALUES (1, 1, '阿青', '演员档案不可改'), (2, 2, '外部演员', 'PRIVATE_OTHER_ACTOR'), (3, 1, '阿白', '窗边演员');
    INSERT INTO looks (id, project_id, character_id, name, prompt) VALUES
      (1, 1, 1, '青衣', '青衣四视图'), (2, 1, 1, '未出图草稿', ''), (3, 1, 3, '白衣', '白衣四视图'),
      (4, 2, 2, 'PRIVATE_OTHER_LOOK', '外部定妆'), (5, 1, 2, '越界演员定妆', ''),
      (6, 1, NULL, '未选演员', ''), (7, 1, 1, '旧图定妆', '旧输入'), (8, 2, 1, '越界项目定妆', '');
    INSERT INTO production_assets (id, project_id, kind, name, description) VALUES (1, 1, 'costumes', '青衣素材', '服装说明');
    INSERT INTO look_assets VALUES (1, 1);`);
  db.prepare('INSERT INTO episode_scripts (episode_id, source, script, notes, revision) VALUES (1, ?, ?, ?, 1)').run('PRIVATE_SOURCE', script, 'PRIVATE_NOTES');
  for (const id of [1, 3]) db.prepare(`INSERT INTO episode_occurrences (episode_id, kind, character_id, source_name, scene_heading, quote, source_start, mode, script_revision)
    VALUES (1, 'character', ?, ?, ?, ?, ?, 'on_screen', 1)`).run(id, `角色${id}`, heading, shots[id === 1 ? 0 : 1].quote, script.indexOf(shots[id === 1 ? 0 : 1].quote));
  for (const id of [1, 3]) db.prepare("INSERT INTO character_boards (character_id, image, mime, width, height, valid, revision, model, prompt) VALUES (?, ?, 'image/png', 16, 9, 1, 'base-revision', 'synthetic-base-model', 'base-prompt')").run(id, pixels);
  db.prepare("INSERT INTO production_asset_images (asset_id, image, mime, width, height) VALUES (1, ?, 'image/png', 16, 9)").run(pixels);
  const inputs = id => lookInputs(db, 1, db.prepare('SELECT * FROM looks WHERE id = ?').get(id));
  const image = (id, revision = inputs(id).revision, valid = 1, cleared = 0) => Number(db.prepare(`INSERT INTO look_images
    (look_id, image, mime, width, height, valid, cleared, revision, model, prompt, inputs_json)
    VALUES (?, ?, 'image/png', 16, 9, ?, ?, ?, 'synthetic-look-model', 'PRIVATE_LOOK_IMAGE_PROMPT', ?)`)
    .run(id, pixels, valid, cleared, revision, JSON.stringify(inputs(id))).lastInsertRowid);
  const readyImage = image(1), otherActorImage = image(3), staleImage = image(7);
  db.exec("UPDATE looks SET prompt = '新输入', revision = revision + 1 WHERE id = 7");
  const requests = [];
  let generated = shots;
  const provider = await listen(createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    requests.push({ path: request.url, authorization: request.headers.authorization, body: JSON.parse(raw) });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ shots: generated }) }, finish_reason: 'stop' }] }));
  }));
  t.after(() => provider.close());
  db.prepare("INSERT INTO api_configs (id, name, type, base_url, api_key, model) VALUES (1, '合成文字模型', 'llm', ?, 'synthetic-storyboard-look-token', 'synthetic-storyboard-model')").run(provider.url + '/v1');
  const app = await listen(createApp(db));
  t.after(() => app.close());
  const state = () => readEpisodeStoryboards(db, 1);
  const resource = () => storyboardResources(db, 1, 1);
  const row = () => db.prepare('SELECT * FROM episode_storyboards WHERE episode_id = 1').get();
  const fields = () => ({ revision: String(state().revision), scriptRevision: '1', resourceRevision: resource().revision, maxShotSeconds: '5' });
  const post = (fields, action = 'storyboards') => fetch(`${app.url}/projects/1/episodes/1/${action}`, { method: 'POST', body: new URLSearchParams(fields) });
  const save = value => post({ ...fields(), shots: JSON.stringify(value) });
  const selection = (id, imageId = undefined) => ({ characterId: db.prepare('SELECT character_id FROM looks WHERE id = ?').get(id).character_id, lookId: id, inputRevision: inputs(id).revision,
    imageId: imageId === undefined ? (db.prepare('SELECT id FROM look_images WHERE look_id = ? AND valid = 1 AND cleared = 0 ORDER BY id DESC LIMIT 1').get(id)?.id ?? null) : imageId });
  const choices = async (ids = [1], project = 1) => (await import('../src/storyboard-looks.js')).storyboardLookChoices(db, project, ids);
  const bound = (selected = selection(1)) => shots.map((shot, index) => ({ ...shot, characterLooks: index === 0 ? [selected] : [] }));
  const summary = () => projectStoryboardSummary(db, 1);
  const immutable = () => ['episode_scripts', 'characters', 'episode_occurrences', 'scenes', 'character_boards', 'production_assets', 'production_asset_images', 'looks', 'look_assets', 'look_images', 'api_configs'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  return { db, ...app, state, resource, row, fields, post, save, selection, choices, bound, summary, immutable, inputs, image, readyImage, otherActorImage, staleImage, requests,
    generate: value => { generated = value; return post({ ...fields(), apiConfigId: '1', model: 'synthetic-storyboard-model', baseUrl: provider.url + '/v1', replaceConfirmed: 'yes' }, 'generate-storyboards'); } };
}
async function rejectsUnchanged(f, value, statuses = [400]) {
  const before = f.row(), response = await f.save(value);
  assert.ok(statuses.includes(response.status), `expected ${statuses}, got ${response.status}: ${await response.text()}`);
  assert.deepEqual(f.row(), before, 'rejection must preserve the entire previous plan');
}

// Every model request goes to the synthetic loopback provider, never a paid service.
test('look choices filter both project and base actor and report real ready/missing/stale snapshots without fallback', async t => {
  const f = await fixture(t), before = f.immutable();
  const choices = (await f.choices([1, 1, 2, 999])).sort((a, b) => a.id - b.id);
  assert.deepEqual(choices.map(({ id, name, characterId, inputRevision, imageId, imageUrl, state }) => ({ id, name, characterId, inputRevision, imageId, imageUrl, state })), [
    { id: 1, name: '青衣', characterId: 1, inputRevision: f.inputs(1).revision, imageId: f.readyImage, imageUrl: `/projects/1/looks/1/images/${f.readyImage}`, state: 'ready' },
    { id: 2, name: '未出图草稿', characterId: 1, inputRevision: f.inputs(2).revision, imageId: null, imageUrl: '', state: 'missing' },
    { id: 7, name: '旧图定妆', characterId: 1, inputRevision: f.inputs(7).revision, imageId: f.staleImage, imageUrl: `/projects/1/looks/7/images/${f.staleImage}`, state: 'stale' },
  ]);
  for (const choice of choices) assert.match(choice.inputRevision, /^[a-f0-9]{64}$/);
  assert.deepEqual(await f.choices([]), []);
  assert.deepEqual((await f.choices([3])).map(item => item.id), [3]);
  assert.deepEqual((await f.choices([2], 2)).map(item => item.id), [4]);
  assert.doesNotMatch(JSON.stringify(choices), /PRIVATE_|synthetic-look-image|base-prompt|\/boards\//);
  assert.deepEqual(f.immutable(), before); assert.equal(f.requests.length, 0);
});

test('manual selections persist only in shots JSON; reads and page GET are read-only and retain reviewed text runtime', async t => {
  const f = await fixture(t), before = f.immutable(), resource = f.resource(), schema = f.db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all();
  const value = f.bound();
  value[1].characterLooks = [f.selection(1), f.selection(3)];
  const response = await f.save(value); assert.equal(response.status, 200);
  assert.equal((await response.json()).redirect, '/projects/1?view=storyboards&episode=1');
  assert.deepEqual(f.state().shots, value); assert.deepEqual(JSON.parse(f.row().shots), value);
  assert.equal(f.state().reviewed, true); assert.equal(f.state().resourceRevision, resource.revision);
  assert.deepEqual(JSON.parse(f.row().resources_json), resource);
  assert.equal(f.summary().totalSeconds, 5); assert.equal(f.summary().plannedEpisodes, 1);
  const saved = f.row();
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(f.state().shots, value);
    const page = await fetch(`${f.url}/projects/1?view=storyboards&episode=1`);
    assert.equal(page.status, 200); await page.text();
  }
  assert.deepEqual(f.row(), saved); assert.deepEqual(f.resource(), resource);
  assert.deepEqual(f.immutable(), before); assert.deepEqual(f.db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all(), schema);
  assert.equal(f.requests.length, 0);
});

test('malformed look arrays, duplicate actors and nonnumeric or unsafe snapshot fields reject atomically', async t => {
  const f = await fixture(t); assert.equal((await f.save(f.bound())).status, 200);
  const selected = f.selection(1), malformed = [null, {}, '[]', 1, false, [null], [[]], [1], [false], [selected, selected], [selected, f.selection(2)]];
  for (const field of ['characterId', 'lookId', 'imageId']) {
    for (const bad of ['1', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, true, [], {}]) malformed.push([{ ...selected, [field]: bad }]);
    const missing = { ...selected }; delete missing[field]; malformed.push([missing]);
  }
  for (const field of ['characterId', 'lookId']) malformed.push([{ ...selected, [field]: null }]);
  for (const bad of [null, 1, [], {}, '', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), `\0${'a'.repeat(63)}`]) malformed.push([{ ...selected, inputRevision: bad }]);
  const missingHash = { ...selected }; delete missingHash.inputRevision; malformed.push([missingHash]);
  for (const value of malformed) await rejectsUnchanged(f, [{ ...shots[0], characterLooks: value }, { ...shots[1], characterLooks: [] }]);
  assert.equal(f.requests.length, 0);
});

test('selection must belong to the project and shot actor, including the image owner; rejected changes preserve old associations', async t => {
  const f = await fixture(t); assert.equal((await f.save(f.bound())).status, 200);
  const selected = f.selection(1);
  for (const value of [
    { ...selected, characterId: 3 },
    { ...selected, lookId: 3 },
    { ...selected, characterId: 2, lookId: 4 },
    { ...selected, lookId: 8 },
    { ...selected, lookId: 999 },
    { ...selected, imageId: f.otherActorImage },
    { ...selected, imageId: 999 },
  ]) await rejectsUnchanged(f, f.bound(value), [400, 404, 409]);
  await rejectsUnchanged(f, [{ ...shots[0], characterIds: [], characterLooks: [selected] }, { ...shots[1], characterLooks: [] }], [400, 404, 409]);
  assert.equal(f.requests.length, 0);
});

test('draft/no-image and currently stale-image choices can be bound truthfully for text planning without base board substitution', async t => {
  const f = await fixture(t);
  assert.equal((await f.save(f.bound(f.selection(2)))).status, 200);
  assert.equal(f.state().shots[0].characterLooks[0].imageId, null);
  assert.equal((await f.choices()).find(item => item.id === 2).state, 'missing');
  assert.equal((await f.save(f.bound(f.selection(7)))).status, 200);
  assert.equal(f.state().shots[0].characterLooks[0].imageId, f.staleImage);
  assert.equal((await f.choices()).find(item => item.id === 7).state, 'stale');
  assert.equal(f.summary().totalSeconds, 5); assert.equal(f.requests.length, 0);
});

test('first binding compares both source hash and current image-ID snapshot, while exact persisted draft selection may remain', async t => {
  const f = await fixture(t); assert.equal((await f.save(shots)).status, 200);
  const initial = f.selection(1), draft = f.selection(2);
  f.db.exec("UPDATE looks SET prompt = prompt || ' changed', revision = revision + 1 WHERE id = 1");
  await rejectsUnchanged(f, f.bound(initial), [409]);
  const current = f.selection(1), latest = f.image(1);
  await rejectsUnchanged(f, f.bound(current), [409]);
  await rejectsUnchanged(f, f.bound({ ...f.selection(1), imageId: null }), [409]);
  assert.equal((await f.save(f.bound(f.selection(1)))).status, 200);
  assert.equal(f.state().shots[0].characterLooks[0].imageId, latest);
  assert.equal((await f.save(f.bound(draft))).status, 200);
  f.image(2);
  const retained = f.bound(draft); retained[0].action = '保留草稿定妆，只编辑动作。';
  assert.equal((await f.save(retained)).status, 200);
  assert.equal(f.state().shots[0].characterLooks[0].imageId, null);
  assert.equal((await f.choices()).find(item => item.id === 2).state, 'ready');
  assert.equal(f.requests.length, 0);
});

test('exact prior selection retains older valid image and hash after new images or changed look inputs; stale reselection rejects', async t => {
  const f = await fixture(t), selected = f.selection(1), resource = f.resource().revision;
  assert.equal((await f.save(f.bound(selected))).status, 200);
  const newest = f.image(1); f.image(1, f.inputs(1).revision, 0); f.image(1, f.inputs(1).revision, 1, 1);
  assert.equal((await f.choices()).find(item => item.id === 1).imageId, newest);
  const retained = f.bound(selected); retained[0].title = '改标题而不换图';
  assert.equal((await f.save(retained)).status, 200);
  assert.equal(f.state().shots[0].characterLooks[0].imageId, f.readyImage);
  f.db.exec("UPDATE production_assets SET description = description || ' 改', revision = revision + 1 WHERE id = 1");
  assert.notEqual(f.inputs(1).revision, selected.inputRevision);
  assert.equal((await f.save(retained)).status, 200);
  assert.deepEqual(f.state().shots[0].characterLooks, [selected]);
  assert.equal(f.resource().revision, resource); assert.equal(f.summary().totalSeconds, 5); assert.equal(f.summary().staleEpisodes, 0);
  await rejectsUnchanged(f, f.bound({ ...selected, imageId: newest }), [409]);
  assert.equal((await f.save(f.bound(f.selection(2)))).status, 200);
  await rejectsUnchanged(f, f.bound(selected), [409]);
  assert.equal((await f.save(f.bound(f.selection(1)))).status, 200);
  assert.equal(f.state().shots[0].characterLooks[0].imageId, newest);
  assert.equal(f.requests.length, 0);
});

test('deleted look, changed actor and cleared/invalid/deleted chosen image require explicit cancellation or valid reselection', async t => {
  for (const change of ['delete-look', 'change-actor', 'clear-image', 'invalidate-image', 'delete-image']) await t.test(change, async t => {
    const f = await fixture(t), selected = f.selection(1);
    assert.equal((await f.save(f.bound(selected))).status, 200);
    if (change === 'delete-look') f.db.exec('DELETE FROM looks WHERE id = 1');
    else if (change === 'change-actor') f.db.exec('UPDATE looks SET character_id = 3, revision = revision + 1 WHERE id = 1');
    else if (change === 'delete-image') f.db.prepare('DELETE FROM look_images WHERE id = ?').run(selected.imageId);
    else f.db.prepare(`UPDATE look_images SET ${change === 'clear-image' ? 'cleared = 1' : 'valid = 0'} WHERE id = ?`).run(selected.imageId);
    const original = f.row();
    await rejectsUnchanged(f, f.bound(selected), [400, 404, 409]);
    const page = await fetch(`${f.url}/projects/1?view=storyboards&episode=1`); assert.equal(page.status, 200); await page.text();
    assert.deepEqual(f.row(), original, 'GET must not erase or repair a broken reference');
    const cancelled = shots.map(shot => ({ ...shot, characterLooks: [] }));
    assert.equal((await f.save(cancelled)).status, 200);
    assert.deepEqual(f.state().shots, shots, 'empty selections preserve the legacy JSON shape');
    assert.equal((await f.save(f.bound(f.selection(2)))).status, 200);
    assert.equal(f.requests.length, 0);
  });
});

test('old unbound plans allow omitted fields, but selected plans require explicit characterLooks on every submitted shot', async t => {
  const f = await fixture(t);
  assert.equal((await f.save(shots)).status, 200);
  assert.deepEqual(f.state().shots, shots);
  assert.equal((await f.save(shots)).status, 200);
  assert.equal((await f.save(f.bound())).status, 200);
  await rejectsUnchanged(f, shots, [400, 409]);
  const mixed = f.bound(); delete mixed[1].characterLooks;
  await rejectsUnchanged(f, mixed, [400, 409]);
  const omittedSelected = f.bound(); delete omittedSelected[0].characterLooks;
  await rejectsUnchanged(f, omittedSelected, [400, 409]);
  const cancelled = shots.map(shot => ({ ...shot, characterLooks: [] }));
  assert.equal((await f.save(cancelled)).status, 200);
  assert.ok(f.state().shots.every(shot => !shot.characterLooks?.length));
  assert.equal((await f.save(shots)).status, 200, 'once unbound again, old clients are legal');
  assert.equal(f.requests.length, 0);
});

test('unselected look library edits do not make original reviewed plans stale or change text resource hashes', async t => {
  const f = await fixture(t); assert.equal((await f.save(shots)).status, 200);
  const resource = f.resource(), summary = f.summary(), original = f.row();
  const protectedRows = ['episode_scripts', 'characters', 'episode_occurrences'].map(table => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  f.image(1); f.db.exec("UPDATE looks SET name = '新名称', prompt = '新提示词', revision = revision + 1 WHERE id = 1; DELETE FROM looks WHERE id = 3; UPDATE production_assets SET description = '改素材说明', revision = revision + 1 WHERE id = 1;");
  assert.deepEqual(f.resource(), resource); assert.deepEqual(f.summary(), summary); assert.deepEqual(f.row(), original);
  assert.deepEqual(['episode_scripts', 'characters', 'episode_occurrences'].map(table => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()), protectedRows);
  assert.equal((await f.save(shots)).status, 200);
  assert.equal(f.summary().totalSeconds, 5); assert.equal(f.requests.length, 0);
});

test('explicit text regeneration replaces costume associations and never chooses looks automatically', async t => {
  const f = await fixture(t); assert.equal((await f.save(f.bound())).status, 200);
  const before = f.immutable();
  assert.equal((await f.generate(shots)).status, 200);
  assert.ok(f.state().shots.every(shot => !shot.characterLooks?.length));
  assert.equal(f.state().reviewed, false); assert.equal(f.state().revision, 2);
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].path, '/v1/chat/completions');
  assert.equal(f.requests[0].authorization, 'Bearer synthetic-storyboard-look-token');
  const input = JSON.parse(f.requests[0].body.messages[1].content);
  assert.deepEqual(input.resources, f.resource());
  assert.doesNotMatch(JSON.stringify(input), /characterLooks|inputRevision|青衣四视图|PRIVATE_|synthetic-storyboard-look-token/);
  assert.deepEqual(f.immutable(), before);
  assert.equal((await f.generate(f.bound())).status, 200, 'even extra provider fields cannot auto-select costumes');
  assert.ok(f.state().shots.every(shot => !shot.characterLooks?.length));
  assert.equal(f.requests.length, 2);
});
