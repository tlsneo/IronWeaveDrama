import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/database.js';
import { storyboardResources } from '../src/storyboards.js';
import { sectionNames, saveClip, readClip, clipSource, clipPrompt, generateClip } from '../src/video-production.js';
import { renderProduction } from '../src/render-generation.js';

function fixture(t) {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  db.exec("INSERT INTO projects VALUES(1,'合成测试','写实','16:9'),(2,'其他项目','水墨','1:1'); INSERT INTO seasons VALUES(1,1,'第一季',1); INSERT INTO episodes VALUES(1,1,'第一集',1); INSERT INTO episode_scripts VALUES(1,'原文','剧本','',1)");
  const shots = [{ title: '第一镜', framing: 'wide shot', action: 'Static shot', dialogue: '', characterIds: [], sceneId: null }, { title: '第二镜', framing: 'close shot', action: 'The camera cuts', dialogue: '', characterIds: [], sceneId: null }];
  db.prepare('INSERT INTO episode_storyboards(episode_id,script_revision,revision,reviewed,resources_json,shots) VALUES(1,1,1,1,?,?)').run(JSON.stringify(storyboardResources(db, 1, 1)), JSON.stringify(shots));
  const sections = { subject_definitions: 'No external subjects.', summary: '[reference generation] A quiet empty room.', retention_analysis: 'No external reference.', detailed_description: 'Natural lighting. [Shot 1] A quiet room. [Shot 2] At 00:02.000, the camera cuts to the window.', overall_soundscape: 'Wind in the room.', non_diegetic_music: 'N/A' };
  const form = extra => new URLSearchParams({ revision: '0', name: '片段', shots: '[1,2]', pictures: '[]', subjects: '[]', profile: '{"size":"16x9","frames":124,"fps":24}', ...sections, ...extra });
  return { db, shots, sections, form };
}
test('六段名称与顺序严格沿用既有文档，镜头顺序和参数原样保存，无模型调用', t => {
  const f = fixture(t); assert.deepEqual(sectionNames, ['subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music']);
  const saved = saveClip(f.db, 1, 1, null, f.form()), clip = readClip(f.db, 1, 1, saved.id), prompt = clipPrompt(clip);
  assert.equal(saved.revision, 1); assert.equal(clip.shots_json, '[1,2]'); assert.deepEqual(JSON.parse(clip.profile_json), { size: '16x9', frames: 124, fps: 24 });
  assert.deepEqual([...prompt.matchAll(/^(\w+):$/gm)].map(m => m[1]), sectionNames); assert.equal(f.db.prepare('SELECT count(*) AS n FROM generation_operations').get().n, 0);
});
test('一镜和多镜片段、排序、乐观版本、跨项目归属与旧依据不可覆盖', async t => {
  const f = fixture(t), first = saveClip(f.db, 1, 1, null, f.form({ shots: '[2,1]' }));
  assert.deepEqual(JSON.parse(readClip(f.db, 1, 1, first.id).source_json).shots.map(s => s.title), ['第二镜', '第一镜']);
  assert.throws(() => saveClip(f.db, 1, 1, first.id, f.form()), { status: 409 });
  assert.throws(() => readClip(f.db, 2, 1, first.id), { status: 404 });
  saveClip(f.db, 1, 1, first.id, f.form({ revision: '1', shots: '[1]', detailed_description: 'Natural light. [Shot 1] A quiet room.' }));
  const clip = readClip(f.db, 1, 1, first.id); assert.equal(clip.revision, 2); assert.ok(clipPrompt(clip));
  f.db.exec('UPDATE episode_storyboards SET revision=2 WHERE episode_id=1');
  await assert.rejects(generateClip(f.db, 1, 1, first.id, new URLSearchParams({ revision: '2', chargeConfirmed: 'yes', apiConfigId: '1' })), { status: 409 });
});
test('真实素材映射固定 Picture 顺序，Subject 可以引用多图但不能猜图或跨项目', t => {
  const f = fixture(t);
  f.db.exec("INSERT INTO scenes(id,project_id,name) VALUES(1,1,'房间'); INSERT INTO scene_references(scene_id,image,mime,width,height) VALUES(1,x'010203','image/png',16,9); INSERT INTO episode_occurrences(episode_id,kind,scene_id,source_name,scene_heading,quote,source_start,mode,script_revision) VALUES(1,'scene',1,'房间','1-1','剧本',0,'on_screen',1)");
  const shots = f.shots.map(s => ({ ...s, sceneId: 1 }));
  f.db.prepare('UPDATE episode_storyboards SET shots=?,resources_json=? WHERE episode_id=1').run(JSON.stringify(shots), JSON.stringify(storyboardResources(f.db, 1, 1)));
  const source = clipSource(f.db, 1, 1, [1, 2]); assert.equal(source.pictures.length, 1); assert.equal(source.pictures[0].table, 'scene_references');
  const saved = saveClip(f.db, 1, 1, null, f.form({ pictures: JSON.stringify(source.pictures), subjects: JSON.stringify([{ number: 1, pictures: [1], description: 'room' }]), subject_definitions: '<Subject 1> is the room in <Picture 1>.' }));
  assert.match(clipPrompt(readClip(f.db, 1, 1, saved.id)), /<Picture 1>/);
  for (const extra of [{ pictures: '[{"table":"scene_references","id":999}]' }, { subjects: '[{"number":1,"pictures":[2],"description":"missing"}]' }, { shots: '[1,1]' }]) assert.throws(() => saveClip(f.db, 1, 1, null, f.form(extra)), { status: 400 });
});
test('六段缺失、虚构标签、非法切点、未知模式、非整数帧数不伪装可支持', t => {
  const f = fixture(t);
  for (const extra of [{ summary: '' }, { summary: '[video continuation] continue' }, { subject_definitions: '<Picture 2> no upload' }, { overall_soundscape: '<Audio 1> missing audio' }, { detailed_description: '[Shot 1] At 00:00.000, room. [Shot 2] At 00:02.000, cut.' }, { detailed_description: 'Style. [Shot 1] room. [Shot 2] At 00:06.000, cut.' }, { detailed_description: 'Style. [Shot 2] room.' }]) {
    const saved = saveClip(f.db, 1, 1, null, f.form(extra)); assert.throws(() => clipPrompt(readClip(f.db, 1, 1, saved.id)), { status: 400 });
  }
  assert.throws(() => saveClip(f.db, 1, 1, null, f.form({ profile: '{"size":"16x9","frames":124.5,"fps":24}' })), { status: 400 });
});
test('页面展示完整六段、真实分数时长、人工生成按钮；读页面不调用任何模型', t => {
  const f = fixture(t); f.db.exec("INSERT INTO api_configs(name,type,base_url,api_key,model) VALUES('本地视频','video','http://127.0.0.1:1/v1','synthetic-secret','ironweave'); INSERT INTO api_protocols(config_id,protocol,video_profiles) VALUES(1,'ironweave2','[{\"size\":\"16x9\",\"frames\":124,\"fps\":24}]')");
  const html = renderProduction(f.db, 1, 1, new URLSearchParams());
  for (const name of sectionNames) assert.match(html, new RegExp(`name="${name}"`)); assert.match(html, /5\.166666/); assert.doesNotMatch(html, /synthetic-secret/); assert.match(html, /不增加文字模型/);
});

test('保存新片段版本须撤销当前采用指针，旧视频只留历史且不删文件', t => {
  const f = fixture(t), saved = saveClip(f.db, 1, 1, null, f.form());
  const operation = '965375ee-5e5a-46bb-b187-23f779f3ddc1';
  f.db.prepare("INSERT INTO generation_operations(id,project_id,kind,target_id,config_id,config_json,source_json,request_json,local_state,active,adopted) VALUES(?,1,'video',?,1,'{}','{}','{}','confirmed',0,1)").run(operation, saved.id);
  f.db.prepare('UPDATE video_clips SET adopted_operation_id=? WHERE id=?').run(operation, saved.id);
  saveClip(f.db, 1, 1, saved.id, f.form({ revision: '1', summary: '[reference generation] Revised scene.' }));
  assert.equal(readClip(f.db, 1, 1, saved.id).adopted_operation_id, null);
  const history = f.db.prepare('SELECT * FROM generation_operations WHERE id=?').get(operation);
  assert.equal(history.adopted, 0); assert.equal(history.local_state, 'confirmed');
});
