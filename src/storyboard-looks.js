import { lookInputs, readLookImage } from './looks.js';

function reject(status, message) { throw Object.assign(new Error(message), { status }); }
const same = (left, right) => ['characterId', 'lookId', 'inputRevision', 'imageId'].every(key => left?.[key] === right[key]);

export function storyboardLookChoices(database, projectId, characterIds) {
  const actors = new Set(characterIds);
  if (!actors.size) return [];
  return database.prepare('SELECT l.* FROM looks l JOIN characters c ON c.id = l.character_id WHERE l.project_id = ? AND c.project_id = ? ORDER BY l.id').all(projectId, projectId)
    .filter(look => actors.has(look.character_id)).map(look => {
      const inputs = lookInputs(database, projectId, look), image = readLookImage(database, look.id);
      return { id: look.id, name: look.name, characterId: look.character_id, inputRevision: inputs.revision,
        imageId: image?.id ?? null, imageUrl: image ? `/projects/${projectId}/looks/${look.id}/images/${image.id}` : '',
        state: !image ? 'missing' : image.revision !== inputs.revision || inputs.missing.length ? 'stale' : 'ready' };
    });
}

export function validateStoryboardLooks(database, projectId, raw, shots, previous) {
  if (previous.some(shot => shot.characterLooks?.length) && raw.some(shot => !Object.hasOwn(shot, 'characterLooks'))) reject(400, '当前分镜已有定妆选择，请刷新页面后保留或明确取消关联，不能用旧页面静默删除。');
  const choices = raw.some(shot => Array.isArray(shot.characterLooks) && shot.characterLooks.length)
    ? storyboardLookChoices(database, projectId, [...new Set(shots.flatMap(shot => shot.characterIds))]) : [];
  const old = previous.flatMap(shot => shot.characterLooks ?? []);
  return shots.map((shot, index) => {
    const selected = Object.hasOwn(raw[index], 'characterLooks') ? raw[index].characterLooks : [];
    if (!Array.isArray(selected) || selected.length > 50 || new Set(selected.map(item => item?.characterId)).size !== selected.length) reject(400, `镜头 ${index + 1}：定妆须为每个出镜演员至多一项的列表。`);
    const bindings = selected.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)
        || !Number.isSafeInteger(item.characterId) || item.characterId < 1 || !shot.characterIds.includes(item.characterId)
        || !Number.isSafeInteger(item.lookId) || item.lookId < 1 || typeof item.inputRevision !== 'string' || !/^[a-f0-9]{64}$/.test(item.inputRevision)
        || (item.imageId !== null && (!Number.isSafeInteger(item.imageId) || item.imageId < 1))) reject(400, `镜头 ${index + 1}：定妆编号、图片版本或出镜演员关联无效。`);
      const choice = choices.find(choice => choice.id === item.lookId && choice.characterId === item.characterId);
      if (!choice) reject(404, `镜头 ${index + 1}：定妆不存在、不属于本项目或不是该基础演员。`);
      const snapshot = { characterId: choice.characterId, lookId: choice.id, inputRevision: choice.inputRevision, imageId: choice.imageId };
      if (!same(item, snapshot) && !old.some(previous => same(previous, item))) reject(409, `镜头 ${index + 1}：定妆或图片已更新，请刷新后重新选择；没有自动换图。`);
      if (item.imageId !== null && !database.prepare('SELECT id FROM look_images WHERE id = ? AND look_id = ? AND valid = 1 AND cleared = 0').get(item.imageId, item.lookId)) reject(409, `镜头 ${index + 1}：定妆图片已失效，请取消或重新选择。`);
      return { characterId: item.characterId, lookId: item.lookId, inputRevision: item.inputRevision, imageId: item.imageId };
    });
    // Preserve the legacy JSON shape when no look is selected; opening old plans must not invalidate them.
    return bindings.length ? { ...shot, characterLooks: bindings } : shot;
  });
}
