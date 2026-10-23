import { sourceStatus } from './generation-source.js';
import { findLook, lookInputs } from './looks.js';
import { createHash } from 'node:crypto';
import { Blob } from 'node:buffer';
import { inTransaction } from './database.js';
import { findEpisode, readEpisodeScript } from './episode-scripts.js';
import { readEpisodeStoryboards, storyboardResources } from './storyboards.js';
import { readApiConfig } from './settings.js';
import { generateOperation, readOperation, publicOperation } from './generation-operations.js';
import { readStoredImage } from './media-adoption.js';
import { mediaPath, verifyFile } from './media-files.js';
import { openAsBlob } from 'node:fs';

export const sectionNames = ['subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music'];
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export { digest as productionSourceDigest };
function reject(status, message) { throw Object.assign(new Error(message), { status }); }
function field(form, name) { if (form.getAll(name).length !== 1 || typeof form.get(name) !== 'string') reject(400, `${name} 缺失或重复。`); return form.get(name); }
function integer(form, name, min = 0) { const raw = field(form, name), value = Number(raw); if (!/^(0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(value) || value < min) reject(400, `${name} 编号或版本无效。`); return value; }
function json(form, name) { try { return JSON.parse(field(form, name)); } catch (error) { if (error.status) throw error; reject(400, `${name} JSON 无效。`); } }
export function shotSource(db, projectId, episodeId) {
  findEpisode(db, projectId, episodeId);
  const plan = readEpisodeStoryboards(db, episodeId), resources = storyboardResources(db, projectId, episodeId);
  if (!plan.reviewed || !plan.shots.length || plan.scriptRevision !== readEpisodeScript(db, episodeId).revision || plan.resourceRevision !== resources.revision) reject(409, '请先核对并保存当前剧本依据的分镜，旧依据不能继续生成。');
  const looks = plan.shots.flatMap(shot => (shot.characterLooks ?? []).map(binding => {
    const look = findLook(db, projectId, binding.lookId), inputs = lookInputs(db, projectId, look);
    return { binding, characterId: look.character_id, revision: inputs.revision, missing: inputs.missing,
      image: db.prepare('SELECT id,valid,cleared,revision FROM look_images WHERE id=? AND look_id=?').get(binding.imageId, binding.lookId) ?? null };
  }));
  return { plan, resources, hash: digest({ plan, resources, looks }) };
}
export function shotPictures(db, projectId, episodeId, index) {
  const source = shotSource(db, projectId, episodeId), shot = source.plan.shots[index - 1];
  if (!shot) reject(404, '镜头不存在。');
  const pictures = [];
  for (const actorId of shot.characterIds) {
    const look = shot.characterLooks?.find(item => item.characterId === actorId);
    if (look) {
      const current = findLook(db, projectId, look.lookId), inputs = lookInputs(db, projectId, current);
      if (current.character_id !== actorId || inputs.revision !== look.inputRevision || inputs.missing.length) reject(409, '镜头所选定妆的演员或素材依据已变化，请明确重新选择。');
      const row = db.prepare('SELECT i.*,l.project_id FROM look_images i JOIN looks l ON l.id=i.look_id WHERE i.id=? AND l.id=? AND i.valid=1 AND i.cleared=0').get(look.imageId, look.lookId);
      if (!row || row.project_id !== projectId || row.revision !== look.inputRevision) reject(409, '镜头定妆版本无效，不能自动换成新图。');
      pictures.push({ table: 'look_images', id: row.id, mime: row.mime, label: `演员 ${actorId} 定妆` });
    } else {
      const image = source.resources.characters.find(actor => actor.id === actorId)?.image;
      if (!image) reject(409, '出镜演员没有已采用图片。');
      pictures.push({ table: image.type === 'boards' ? 'character_boards' : 'character_references', id: image.id, label: `演员 ${actorId}` });
    }
  }
  if (shot.sceneId !== null) {
    const image = source.resources.scenes.find(scene => scene.id === shot.sceneId)?.image;
    if (!image) reject(409, '镜头场景没有参考图片。');
    pictures.push({ table: image.type === 'images' ? 'scene_images' : 'scene_references', id: image.id, label: `场景 ${shot.sceneId}` });
  }
  for (const picture of pictures) picture.mime ??= db.prepare(`SELECT mime FROM ${picture.table} WHERE id=?`).get(picture.id).mime;
  return { source, shot, pictures };
}
async function appendPictures(db, body, pictures) {
  if (pictures.length > 51) reject(413, '最多 51 张参考图片。');
  let bytes = 0;
  for (const [index, picture] of pictures.entries()) {
    let blob;
    if (picture.operationId) {
      const row = db.prepare('SELECT * FROM generation_operations WHERE id=?').get(picture.operationId);
      if (!row || !['saved', 'confirmed'].includes(row.local_state)) reject(409, '构图图尚未完整保存。');
      const meta = JSON.parse(row.metadata_json); await verifyFile(mediaPath(row.id), meta);
      blob = await openAsBlob(mediaPath(row.id), { type: meta.mime_type });
    } else blob = new Blob([await readStoredImage(db, picture.table, picture.id)], { type: picture.mime });
    bytes += blob.size; if (bytes > 32 * 1024 * 1024) reject(413, '参考图片合计超过 32 MiB。');
    body.append('image[]', blob, `picture-${index + 1}.${blob.type === 'image/jpeg' ? 'jpg' : blob.type.split('/')[1]}`);
  }
}
export async function generateShot(db, projectId, episodeId, index, form) {
  const { source, shot, pictures } = shotPictures(db, projectId, episodeId, index);
  if (integer(form, 'revision') !== source.plan.revision || field(form, 'sourceHash') !== source.hash) reject(409, '镜头来源已变化，请刷新核对。');
  if (field(form, 'chargeConfirmed') !== 'yes') reject(400, '须人工点击确认生成。');
  const config = readApiConfig(db, integer(form, 'apiConfigId', 1));
  if (config.protocol !== 'ironweave2' || config.type !== (pictures.length ? 'image_to_image' : 'text_to_image')) reject(400, '请选择匹配素材数量的 protocol 2 图片配置。');
  const size = field(form, 'size'); if (!/^[1-9]\d*x[1-9]\d*$/.test(size)) reject(400, '必须显式填写输出尺寸。');
  const prompt = field(form, 'prompt'); if (!prompt.trim() || [...prompt].length > 12000) reject(400, '构图提示词必填且最多 12000 字。');
  let body = { model: 'ironweave', prompt, size };
  if (pictures.length) { body = new FormData(); for (const [key, value] of Object.entries({ model: 'ironweave', prompt, size })) body.set(key, value); await appendPictures(db, body, pictures); }
  return generateOperation(db, { projectId, kind: `shot:${episodeId}`, targetId: index, config, source: { hash: source.hash, revision: source.plan.revision, shot, pictures, prompt }, endpoint: pictures.length ? '/images/edits' : '/images/generations', body, expected: { size } });
}
export function clipSource(db, projectId, episodeId, indices) {
  const source = shotSource(db, projectId, episodeId);
  if (!Array.isArray(indices) || !indices.length || indices.length > 100 || new Set(indices).size !== indices.length || indices.some(index => !Number.isSafeInteger(index) || index < 1 || !source.plan.shots[index - 1])) reject(400, '片段须包含一个或多个不重复镜头，按提交顺序排列。');
  const pictures = [];
  for (const index of indices) {
    const refs = shotPictures(db, projectId, episodeId, index).pictures;
    for (const ref of refs) if (!pictures.some(p => p.table === ref.table && p.id === ref.id)) pictures.push(ref);
    const op = db.prepare('SELECT * FROM generation_operations WHERE project_id=? AND kind=? AND target_id=? AND adopted=1 ORDER BY rowid DESC LIMIT 1').get(projectId, `shot:${episodeId}`, index);
    if (op && JSON.parse(op.source_json).hash === source.hash) pictures.push({ operationId: op.id, label: `镜头 ${index} 构图`, mime: JSON.parse(op.metadata_json).mime_type });
  }
  return { hash: source.hash, revision: source.plan.revision, indices, shots: indices.map(index => source.plan.shots[index - 1]), pictures };
}
export function readClip(db, projectId, episodeId, id) {
  findEpisode(db, projectId, episodeId);
  const row = db.prepare('SELECT * FROM video_clips WHERE id=? AND project_id=? AND episode_id=?').get(id, projectId, episodeId);
  if (!row) reject(404, '片段不存在。'); return row;
}
export function saveClip(db, projectId, episodeId, id, form) {
  const previous = id ? readClip(db, projectId, episodeId, id) : null;
  if (integer(form, 'revision') !== (previous?.revision ?? 0)) reject(409, '片段版本已变化。');
  const indices = json(form, 'shots'), source = clipSource(db, projectId, episodeId, indices);
  if (form.has('sourceHash') && field(form, 'sourceHash') !== digest(source)) reject(409, '片段的镜头或素材已变化，请保留输入并刷新核对。');
  const name = field(form, 'name'); if (!name.trim() || name.length > 120) reject(400, '片段名称必填，最多 120 字。');
  const sections = Object.fromEntries(sectionNames.map(key => [key, field(form, key)]));
  if (sectionNames.some(key => sections[key].length > 24000)) reject(413, '片段文本过大。');
  const pictures = json(form, 'pictures'), subjects = json(form, 'subjects'), profile = json(form, 'profile');
  if (!Array.isArray(pictures) || pictures.length > 51 || new Set(pictures.map(digest)).size !== pictures.length || pictures.some(p => !source.pictures.some(known => digest(known) === digest(p)))) reject(400, 'Picture 必须从当前选中镜头的真实版本素材选择，顺序就是上传顺序。');
  if (!Array.isArray(subjects) || subjects.length > 100 || subjects.some((s, i) => s?.number !== i + 1 || typeof s.description !== 'string' || !s.description.trim() || !Array.isArray(s.pictures) || !s.pictures.length || new Set(s.pictures).size !== s.pictures.length || s.pictures.some(n => !Number.isSafeInteger(n) || n < 1 || n > pictures.length))) reject(400, 'Subject 必须连续编号并映射真实 Picture 编号。');
  if (!profile || Object.keys(profile).sort().join(',') !== 'fps,frames,size' || !/^[1-9]\d*x[1-9]\d*$/.test(profile.size) || !Number.isSafeInteger(profile.frames) || profile.frames < 1 || !Number.isSafeInteger(profile.fps) || profile.fps < 1) reject(400, '片段必须显式选择 size、frames、fps；不按秒数取整。');
  const values = [name, JSON.stringify(indices), JSON.stringify(source), JSON.stringify(sections), JSON.stringify(pictures), JSON.stringify(subjects), JSON.stringify(profile)];
  return inTransaction(db, () => {
    if (previous && ['name', 'shots_json', 'source_json', 'sections_json', 'pictures_json', 'subjects_json', 'profile_json'].every((key, index) => previous[key] === values[index])) {
      return { id, revision: previous.revision, redirect: `/projects/${projectId}/episodes/${episodeId}/media?clip=${id}` };
    }
    if (id) {
      db.prepare('UPDATE video_clips SET name=?,shots_json=?,source_json=?,sections_json=?,pictures_json=?,subjects_json=?,profile_json=?,revision=revision+1,adopted_operation_id=NULL WHERE id=?').run(...values, id);
      db.prepare("UPDATE generation_operations SET adopted=0 WHERE project_id=? AND kind='video' AND target_id=?").run(projectId, id);
    } else id = Number(db.prepare('INSERT INTO video_clips(name,shots_json,source_json,sections_json,pictures_json,subjects_json,profile_json,project_id,episode_id) VALUES(?,?,?,?,?,?,?,?,?)').run(...values, projectId, episodeId).lastInsertRowid);
    return { id, revision: (previous?.revision ?? 0) + 1, redirect: `/projects/${projectId}/episodes/${episodeId}/media?clip=${id}` };
  });
}
export function clipPrompt(clip) {
  const sections = JSON.parse(clip.sections_json), pictures = JSON.parse(clip.pictures_json), subjects = JSON.parse(clip.subjects_json), indices = JSON.parse(clip.shots_json), profile = JSON.parse(clip.profile_json);
  if (sectionNames.some(key => typeof sections[key] !== 'string' || !sections[key].trim())) reject(400, '请人工填写完整六段正文；无配乐写 N/A，不自动补写。');
  if (sectionNames.some(key => new RegExp(`^(?:${sectionNames.join('|')}):`, 'm').test(sections[key]))) reject(400, '段落正文不能嵌入重复六段标题。');
  const prompt = sectionNames.map(key => `${key}:\n${sections[key]}`).join('\n\n');
  if ([...prompt].length > 12000 || Buffer.byteLength(JSON.stringify({ prompt, ...profile, model: 'ironweave' })) > 65536) reject(413, '完整六段超过 12000 字或 64 KiB。');
  if (/<(?:Video|Audio)\s+\d+>/.test(prompt)) reject(400, '此页面没有音频/视频参考上传，不允许虚构 Audio 或 Video 素材。');
  for (const match of prompt.matchAll(/<(Picture|Subject) (\d+)>/g)) if (Number(match[2]) < 1 || Number(match[2]) > (match[1] === 'Picture' ? pictures.length : subjects.length)) reject(400, '六段标签引用未映射的真实素材。');
  for (let n = 1; n <= pictures.length; n++) if (!prompt.includes(`<Picture ${n}>`)) reject(400, '每份实际上传素材必须在六段中明确引用其 Picture 编号。');
  for (const s of subjects) {
    const line = sections.subject_definitions.split('\n').find(line => line.startsWith(`<Subject ${s.number}>`));
    const mapped = line ? [...new Set([...line.matchAll(/<Picture (\d+)>/g)].map(match => Number(match[1])))].sort((a,b) => a-b) : [];
    if (!line || JSON.stringify(mapped) !== JSON.stringify([...s.pictures].sort((a,b) => a-b)) || sections.subject_definitions.split('\n').filter(value => value.startsWith(`<Subject ${s.number}>`)).length !== 1) reject(400, 'Subject 定义与已保存 Picture 映射不一致。');
  }
  if (!sections.summary.startsWith('[reference generation]')) reject(400, '当前片段仅支持 [reference generation]，不假装支持 FL2VA 或自动续写。');
  const shots = [...sections.detailed_description.matchAll(/\[Shot (\d+)\]/g)];
  if (shots.length !== indices.length || shots.some((s, i) => Number(s[1]) !== i + 1)) reject(400, '正文镜头编号须与片段顺序一致。');
  let last = 0;
  for (const [i, shot] of shots.entries()) {
    const after = sections.detailed_description.slice(shot.index + shot[0].length);
    const time = /^\s+At (\d\d):(\d\d)\.(\d{3}),/.exec(after);
    if (i === 0) { if (time) reject(400, '首镜头不写时间戳。'); }
    else { const t = time ? Number(time[1]) * 60 + Number(time[2]) + Number(time[3]) / 1000 : NaN; if (!time || Number(time[2]) >= 60 || !(t > last && t < profile.frames / profile.fps)) reject(400, '切点必须严格递增且小于 frames/fps 对应的实际目标时长。'); last = t; }
  }
  return prompt;
}
export async function generateClip(db, projectId, episodeId, id, form) {
  const clip = readClip(db, projectId, episodeId, id);
  if (integer(form, 'revision') !== clip.revision || field(form, 'chargeConfirmed') !== 'yes') reject(409, '片段版本变化或未确认计费。');
  const current = clipSource(db, projectId, episodeId, JSON.parse(clip.shots_json));
  if (digest(current) !== digest(JSON.parse(clip.source_json))) reject(409, '镜头、素材或采用构图版本变化；请人工重新保存片段，旧版本仍保留。');
  const config = readApiConfig(db, integer(form, 'apiConfigId', 1)), profile = JSON.parse(clip.profile_json);
  if (config.type !== 'video' || config.protocol !== 'ironweave2' || !config.videoProfiles.some(p => p.size === profile.size && p.frames === profile.frames && p.fps === profile.fps)) reject(400, '所选视频配置没有该参数组合；不能自动取整或静默换参数。');
  const prompt = clipPrompt(clip), pictures = JSON.parse(clip.pictures_json);
  let body = { model: 'ironweave', prompt, ...profile };
  if (pictures.length) { body = new FormData(); for (const [key, value] of Object.entries({ model: 'ironweave', prompt, ...profile })) body.set(key, String(value)); await appendPictures(db, body, pictures); }
  return generateOperation(db, { projectId, kind: 'video', targetId: id, config, source: { clip, hash: digest(current), prompt, pictures }, endpoint: '/videos/generations', body, expected: profile });
}
export async function adoptProductionOperation(db, projectId, id) {
  const before = readOperation(db, id, projectId);
  if (!['saved', 'confirmed'].includes(before.local_state)) reject(409, '媒体尚未完整保存。');
  await verifyFile(mediaPath(id), JSON.parse(before.metadata_json));
  return inTransaction(db, () => {
    const row = readOperation(db, id, projectId), status = sourceStatus(db, row);
    if (status.state !== 'current') reject(409, `${status.label}：${status.reason} 历史媒体保留，不覆盖当前版本。`);
    if (row.kind !== 'video' && !row.kind.startsWith('shot:')) reject(400, '不是镜头或视频媒体。');
    if (row.adopted) return publicOperation(row);
    if (row.kind === 'video') db.prepare('UPDATE video_clips SET adopted_operation_id=? WHERE id=?').run(id, row.target_id);
    db.prepare('UPDATE generation_operations SET adopted=0 WHERE project_id=? AND kind=? AND target_id=?').run(projectId, row.kind, row.target_id);
    db.prepare('UPDATE generation_operations SET adopted=1 WHERE id=?').run(id);
    return { ...publicOperation(row), adopted: true };
  });
}
