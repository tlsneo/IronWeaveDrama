import { resourceRevision, readResourceReference } from './resource-images.js';
import { findLook, lookInputs } from './looks.js';
import { shotSource, clipSource, readClip, productionSourceDigest } from './video-production.js';

const result = (state, reason) => ({ state, label: { current: '当前有效', expired: '已过期', deleted: '来源已删除' }[state], reason });
const pictureTables = new Set(['character_boards', 'character_references', 'scene_images', 'scene_references', 'look_images', 'production_asset_images']);
function missingPictures(db, pictures = []) {
  return pictures.some(picture => picture.operationId
    ? !db.prepare('SELECT id FROM generation_operations WHERE id=?').get(picture.operationId)
    : pictureTables.has(picture.table) && !db.prepare(`SELECT id FROM ${picture.table} WHERE id=?`).get(picture.id));
}

// 只读动态判断；不改变历史、确认状态或采用标记，与采用门禁共用同一依据。
export function sourceStatus(db, row) {
  const source = JSON.parse(row.source_json);
  if (row.kind === 'test') return result('current', '测试操作无项目来源，不能作为项目资源采用。');
  const project = db.prepare('SELECT style,aspect_ratio FROM projects WHERE id=?').get(row.project_id);
  if (!project) return result('deleted', '所属项目已删除。');
  try {
    if (['character', 'scene'].includes(row.kind)) {
      const table = row.kind === 'character' ? 'characters' : 'scenes';
      const item = db.prepare(`SELECT * FROM ${table} WHERE id=? AND project_id=?`).get(row.target_id, row.project_id);
      if (!item) return result('deleted', '生成对象已删除，历史媒体仍保留。');
      if (source.referenceId != null && !db.prepare(`SELECT id FROM ${row.kind}_references WHERE id=?`).get(source.referenceId)) return result('deleted', '原参考图片已删除。');
      if (resourceRevision(row.kind, item, project) !== source.revision || (readResourceReference(row.kind, db, row.target_id)?.id ?? null) !== source.referenceId) return result('expired', '资料、风格、比例或参考图片已变化。');
    } else if (row.kind === 'look') {
      const look = findLook(db, row.project_id, row.target_id);
      if (source.inputs?.character && !db.prepare('SELECT id FROM characters WHERE id=?').get(source.inputs.character.id)) return result('deleted', '原基础演员已删除。');
      if (source.inputs?.assets?.some(asset => !db.prepare('SELECT id FROM production_assets WHERE id=?').get(asset.id))) return result('deleted', '原服饰或道具已删除。');
      const actorImage = source.inputs?.character?.image;
      const originalPictures = (source.inputs?.assets ?? []).filter(asset => asset.image).map(asset => ({ table: 'production_asset_images', id: asset.image.id }));
      if (actorImage) originalPictures.push({ table: actorImage.type === 'boards' ? 'character_boards' : 'character_references', id: actorImage.id });
      if (missingPictures(db, originalPictures)) return result('deleted', '原演员或素材图片已删除。');
      const current = lookInputs(db, row.project_id, look);
      if (current.missing.length || current.revision !== source.inputRevision) return result('expired', '演员、素材图片、定妆提示词或项目风格已变化。');
    } else if (row.kind.startsWith('shot:')) {
      if (missingPictures(db, source.pictures)) return result('deleted', '原镜头素材已删除。');
      const current = shotSource(db, row.project_id, Number(row.kind.split(':')[1]));
      if (!current.plan.shots[row.target_id - 1]) return result('deleted', '原镜头已删除。');
      if (current.hash !== source.hash) return result('expired', '剧本、分镜或镜头素材版本已变化。');
    } else if (row.kind === 'video') {
      if (!source.clip) return result('expired', '片段来源快照不完整。');
      const clip = readClip(db, row.project_id, source.clip.episode_id, row.target_id);
      if (missingPictures(db, source.pictures)) return result('deleted', '原片段素材已删除。');
      if (clip.revision !== source.clip.revision || productionSourceDigest(clipSource(db, row.project_id, clip.episode_id, JSON.parse(clip.shots_json))) !== source.hash) return result('expired', '片段、镜头或采用素材版本已变化。');
    } else return result('expired', '无法核实该历史操作的来源。');
    return result('current', '与当前保存的来源版本一致；艺术质量仍需人工核对。');
  } catch (error) {
    if (error.status === 404) return result('deleted', error.message);
    if (error.status === 409) return result('expired', error.message);
    throw error;
  }
}
