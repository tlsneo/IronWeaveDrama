import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

const directory = await mkdtemp(join(tmpdir(), 'drama-source-status-'));
process.env.IRONWEAVE_DRAMA_MEDIA_DIR = directory;
after(() => rm(directory, { recursive: true, force: true }));
const { openDatabase } = await import('../src/database.js');
const { sourceStatus } = await import('../src/generation-source.js');
const { readOperation, listOperations } = await import('../src/generation-operations.js');
const { mediaPath } = await import('../src/media-files.js');
const { resourceRevision } = await import('../src/resource-images.js');
const { lookInputs, findLook } = await import('../src/looks.js');
const { storyboardResources } = await import('../src/storyboards.js');
const { shotSource, shotPictures, clipSource, saveClip, readClip, productionSourceDigest, adoptProductionOperation, sectionNames } = await import('../src/video-production.js');
const { adoptOperation } = await import('../src/media-adoption.js');
const { renderOperations, renderProduction } = await import('../src/render-generation.js');
const { deleteItem } = await import('../src/deletion.js');

async function fixture(t) {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  db.exec("INSERT INTO projects VALUES(1,'project','style','16:9'); INSERT INTO seasons VALUES(1,1,'season',1); INSERT INTO episodes VALUES(1,1,'episode',1); INSERT INTO episode_scripts VALUES(1,'source','script','',1); INSERT INTO characters(id,project_id,name,age) VALUES(1,1,'actor',25); INSERT INTO scenes(id,project_id,name) VALUES(1,1,'scene'); INSERT INTO character_boards(character_id,image,mime,width,height,valid,revision,model,prompt) VALUES(1,x'010203','image/png',16,9,1,'fixture','fixture','fixture'); INSERT INTO scene_references(scene_id,image,mime,width,height) VALUES(1,x'010203','image/png',16,9); INSERT INTO production_assets(id,project_id,kind,name) VALUES(1,1,'costumes','costume'); INSERT INTO production_asset_images(asset_id,image,mime,width,height) VALUES(1,x'010203','image/png',16,9); INSERT INTO looks(id,project_id,character_id,name,prompt) VALUES(1,1,1,'look','fixture prompt'); INSERT INTO look_assets VALUES(1,1)");
  for (const kind of ['character', 'scene']) db.prepare(`INSERT INTO episode_occurrences(episode_id,kind,${kind}_id,source_name,scene_heading,quote,source_start,mode,script_revision) VALUES(1,?,1,'fixture','1-1','script',0,'on_screen',1)`).run(kind);
  const inputs = lookInputs(db, 1, findLook(db, 1, 1));
  db.prepare("INSERT INTO look_images(look_id,image,mime,width,height,valid,revision,model,prompt,inputs_json) VALUES(1,x'010203','image/png',16,9,1,?,'fixture','fixture',?)").run(inputs.revision, JSON.stringify(inputs));
  const shot = { title: 'shot', framing: 'wide', action: 'room', dialogue: '', characterIds: [1], sceneId: 1, characterLooks: [{ characterId: 1, lookId: 1, imageId: 1, inputRevision: inputs.revision }] };
  db.prepare('INSERT INTO episode_storyboards(episode_id,script_revision,revision,reviewed,resources_json,shots) VALUES(1,1,1,1,?,?)').run(JSON.stringify(storyboardResources(db, 1, 1)), JSON.stringify([shot]));
  const refs = clipSource(db, 1, 1, [1]);
  const sections = Object.fromEntries(sectionNames.map(name => [name, name === 'summary' ? '[reference generation] fixture' : 'fixture text']));
  const clipId = saveClip(db, 1, 1, null, new URLSearchParams({ revision: '0', name: 'clip', shots: '[1]', pictures: JSON.stringify(refs.pictures), subjects: '[]', profile: '{"size":"16x9","frames":12,"fps":6}', ...sections })).id;
  async function operation(kind) {
    let source, targetId = 1;
    if (['character', 'scene'].includes(kind)) {
      const item = db.prepare(`SELECT * FROM ${kind === 'character' ? 'characters' : 'scenes'} WHERE id=1`).get();
      source = { revision: resourceRevision(kind, item, db.prepare('SELECT * FROM projects WHERE id=1').get()), referenceId: kind === 'scene' ? 1 : null, model: 'fixture', prompt: 'fixture' };
    } else if (kind === 'look') {
      const inputs = lookInputs(db, 1, findLook(db, 1, 1)); source = { inputRevision: inputs.revision, inputs, model: 'fixture', prompt: 'fixture' };
    } else if (kind === 'shot:1') {
      const current = shotPictures(db, 1, 1, 1); source = { hash: current.source.hash, shot: current.shot, pictures: current.pictures };
    } else {
      targetId = clipId; const clip = readClip(db, 1, 1, clipId);
      source = { clip, hash: productionSourceDigest(clipSource(db, 1, 1, [1])), pictures: JSON.parse(clip.pictures_json) };
    }
    const id = randomUUID(), bytes = Buffer.from('synthetic already-validated source fixture');
    const meta = { mime_type: kind === 'video' ? 'video/mp4' : 'image/png', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), width: 16, height: 9 };
    db.prepare("INSERT INTO generation_operations(id,project_id,kind,target_id,config_id,config_json,source_json,request_json,metadata_json,local_state,task_state,active) VALUES(?,1,?,?,1,'{}',?,'{}',?,'saved','delivering',0)").run(id, kind, targetId, JSON.stringify(source), JSON.stringify(meta));
    await mkdir(directory, { recursive: true }); await writeFile(mediaPath(id), bytes);
    return id;
  }
  const adopt = (kind, id) => ['character', 'scene', 'look'].includes(kind) ? adoptOperation(db, 1, id) : adoptProductionOperation(db, 1, id);
  return { db, operation, adopt, clipId };
}

test('B: 所有五类来源初始有效，list/渲染只读且不伪造交付确认', async t => {
  const f = await fixture(t);
  for (const kind of ['character', 'scene', 'look', 'shot:1', 'video']) await f.operation(kind);
  const before = f.db.prepare('SELECT total_changes() AS n').get().n;
  const list = listOperations(f.db, 1); assert.equal(list.length, 5);
  assert.ok(list.every(op => op.sourceStatus.state === 'current' && !op.deliveryConfirmed));
  const html = renderOperations(f.db, 1); assert.match(html, /来源状态：当前有效/); assert.match(html, /交付尚未确认/);
  assert.doesNotMatch(html, /disabled aria-disabled/);
  assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n, before);
});

for (const [kind, mutation] of [
  ['character', "UPDATE characters SET hair_color='changed' WHERE id=1"],
  ['scene', "UPDATE scenes SET description='changed' WHERE id=1"],
  ['look', "UPDATE production_assets SET description='changed' WHERE id=1"],
  ['shot:1', 'UPDATE episode_storyboards SET revision=revision+1 WHERE episode_id=1'],
  ['video', "UPDATE looks SET prompt='changed upstream look' WHERE id=1"],
]) test(`B: ${kind}上游变更动态展示过期；已采用也拒绝重复采用，未采用按钮禁用且文件保留`, async t => {
  const f = await fixture(t), id = await f.operation(kind);
  await f.adopt(kind, id);
  const notAdopted = await f.operation(kind), original = await readFile(mediaPath(id));
  f.db.exec(mutation);
  assert.equal(sourceStatus(f.db, readOperation(f.db, id, 1)).state, 'expired');
  await assert.rejects(f.adopt(kind, id), { status: 409 });
  await assert.rejects(f.adopt(kind, notAdopted), { status: 409 });
  const html = renderOperations(f.db, 1);
  assert.match(html, /来源状态：已过期/); assert.match(html, /曾采用，当前已失效/);
  assert.match(html, new RegExp(`${notAdopted}/adopt" disabled aria-disabled="true"`));
  assert.match(html, /恢复 \/ 核对同一回执/);
  assert.deepEqual(await readFile(mediaPath(id)), original);
  assert.equal(readOperation(f.db, id, 1).ack_json, null);
  if (kind === 'video') assert.match(renderProduction(f.db, 1, 1, new URLSearchParams({ clip: String(f.clipId) })), /曾采用，当前已失效/);
});

for (const [kind, removedKind, name] of [
  ['character', 'characters', 'actor'], ['scene', 'scenes', 'scene'], ['look', 'costumes', 'costume'], ['shot:1', 'episodes', 'episode'], ['video', 'seasons', 'season'],
]) test(`A/B: 删除${removedKind}保留${kind}操作/文件，来源显示已删除并拒绝采用`, async t => {
  const f = await fixture(t), id = await f.operation(kind);
  await f.adopt(kind, id);
  deleteItem(f.db, removedKind, 1, 1, new URLSearchParams({ confirmed: 'yes', name }));
  assert.equal(sourceStatus(f.db, readOperation(f.db, id, 1)).state, 'deleted');
  await assert.rejects(f.adopt(kind, id), { status: 409 });
  assert.match(renderOperations(f.db, 1), /来源已删除/);
  assert.ok((await readFile(mediaPath(id))).length);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM media_cleanup').get().n, 0);
});
