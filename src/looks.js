import { generateOperation } from './generation-operations.js';
import { readStoredImage, storedImageBytes } from './media-adoption.js';
import { createHash } from 'node:crypto';
import { inTransaction } from './database.js';
import { findCharacter, characterFields } from './characters.js';
import { assertLooksIdle, withLookLock } from './look-locks.js';
import { readAssetImage, productionInteger, productionText, productionReject as reject } from './production-assets.js';
import { readApiConfig } from './settings.js';
import { imageDetails } from './images.js';
import { requestedImageSize } from './resource-images.js';
import { manualLookPrompt } from '../prompts/look/manual-look.js';

export function findLook(database, projectId, id) {
  const look = database.prepare('SELECT * FROM looks WHERE id = ? AND project_id = ?').get(id, projectId);
  if (!look) reject(404, '定妆不存在。');
  return look;
}
export function readLookImage(database, lookId) {
  return database.prepare('SELECT id, mime, width, height, revision, model, prompt, inputs_json, created_at FROM look_images WHERE look_id = ? AND valid = 1 AND cleared = 0 ORDER BY id DESC LIMIT 1').get(lookId) ?? null;
}
export function lookInputs(database, projectId, look) {
  const project = database.prepare('SELECT style, aspect_ratio FROM projects WHERE id = ?').get(projectId);
  if (!project || look.project_id !== projectId) reject(404, '项目或定妆不存在。');
  const missing = [];
  let character = null;
  if (look.character_id !== null) {
    const actor = findCharacter(database, projectId, look.character_id);
    const columns = 'id, mime, width, height, length(image) AS bytes';
    let image = database.prepare(`SELECT ${columns} FROM character_boards WHERE character_id = ? AND valid = 1 AND cleared = 0 ORDER BY id DESC LIMIT 1`).get(actor.id);
    if (image) image = { ...image, bytes: storedImageBytes(database, 'character_boards', image.id, image.bytes), type: 'boards' };
    else {
      image = database.prepare(`SELECT ${columns} FROM character_references WHERE character_id = ? AND cleared = 0 ORDER BY id DESC LIMIT 1`).get(actor.id);
      if (image) image = { ...image, type: 'references' };
    }
    if (image) image.url = `/projects/${projectId}/characters/${actor.id}/${image.type}/${image.id}`;
    character = { id: actor.id, name: actor.name, description: characterFields.filter(field => field.key !== 'name' && actor[field.column] !== null && actor[field.column] !== '').map(field => `${field.label}：${actor[field.column]}`).join('\n'), image: image ?? null };
    if (!image) missing.push(`基础演员「${actor.name}」没有有效基础图或上传参考图。`);
  } else missing.push('请先选择基础演员。');
  const assets = database.prepare("SELECT a.* FROM production_assets a JOIN look_assets la ON la.asset_id = a.id WHERE la.look_id = ? ORDER BY CASE a.kind WHEN 'costumes' THEN 0 ELSE 1 END, a.id").all(look.id).map(asset => {
    if (asset.project_id !== projectId) reject(409, '定妆关联了其他项目的素材，请核对。');
    const image = readAssetImage(database, asset.id);
    if (image) image.url = `/projects/${projectId}/${asset.kind}/${asset.id}/images/${image.id}`;
    else missing.push(`已选${asset.kind === 'costumes' ? '服饰' : '道具'}「${asset.name}」缺少参考图。`);
    return { id: asset.id, kind: asset.kind, name: asset.name, description: asset.description, image };
  });
  if ((character?.image?.bytes ?? 0) + assets.reduce((sum, asset) => sum + (asset.image?.bytes ?? 0), 0) > 32 * 1024 * 1024) missing.push('所选参考图合计超过 32 MiB，请缩小素材图或减少选择。');
  const source = { lookId: look.id, name: look.name, prompt: look.prompt, character, assets, style: project.style, format: 'four-view', aspectRatio: '16:9' };
  return { ...source, missing, revision: createHash('sha256').update(JSON.stringify(source)).digest('hex') };
}
export function saveLook(database, projectId, id, form) {
  if (!database.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)) reject(404, '项目不存在。');
  if (id) assertLooksIdle(database, [id]);
  return inTransaction(database, () => {
    const name = productionText(form, 'name', 80, true);
    let revision = 1;
    if (!id) id = Number(database.prepare('INSERT INTO looks (project_id, name) VALUES (?, ?)').run(projectId, name).lastInsertRowid);
    else {
      const look = findLook(database, projectId, id);
      if (productionInteger(form, 'revision', 1) !== look.revision) reject(409, '定妆已变化，请保留输入后刷新。');
      if (form.getAll('characterId').length !== 1 || typeof form.get('characterId') !== 'string') reject(400, '基础演员选择缺失或重复。');
      const actor = form.get('characterId') === '' ? null : productionInteger(form, 'characterId', 1);
      if (actor !== null) findCharacter(database, projectId, actor);
      const prompt = productionText(form, 'prompt', 12000);
      let ids;
      if (form.getAll('assetIds').length !== 1 || typeof form.get('assetIds') !== 'string' || form.get('assetIds').length > 5000) reject(400, '素材选择缺失、重复或过大。');
      try { ids = JSON.parse(form.get('assetIds')); } catch { reject(400, '素材选择格式无效。'); }
      if (!Array.isArray(ids) || ids.length > 50 || new Set(ids).size !== ids.length || ids.some(value => !Number.isSafeInteger(value) || value < 1)) reject(400, '素材须为不重复的有效编号，最多选择 50 件。');
      ids.sort((a, b) => a - b);
      for (const assetId of ids) {
        const asset = database.prepare('SELECT project_id FROM production_assets WHERE id = ?').get(assetId);
        if (!asset || asset.project_id !== projectId) reject(404, '素材不存在或不属于本项目。');
      }
      const beforeIds = database.prepare('SELECT asset_id FROM look_assets WHERE look_id = ? ORDER BY asset_id').all(id).map(row => row.asset_id);
      revision = look.revision;
      if (name !== look.name || actor !== look.character_id || prompt !== look.prompt || JSON.stringify(ids) !== JSON.stringify(beforeIds)) {
        revision++;
        database.prepare('UPDATE looks SET name = ?, character_id = ?, prompt = ?, revision = ? WHERE id = ?').run(name, actor, prompt, revision, id);
        database.prepare('DELETE FROM look_assets WHERE look_id = ?').run(id);
        for (const assetId of ids) database.prepare('INSERT INTO look_assets (look_id, asset_id) VALUES (?, ?)').run(id, assetId);
      }
    }
    return { id, revision, redirect: `/projects/${projectId}?resource=looks&look=${id}` };
  });
}
export async function generateLookImage(database, projectId, id, form) {
  const look = findLook(database, projectId, id);
  if (productionInteger(form, 'revision', 1) !== look.revision) reject(409, '定妆已变化，请先保存并刷新后生成。');
  const inputs = lookInputs(database, projectId, look);
  if (form.getAll('inputRevision').length !== 1 || form.get('inputRevision') !== inputs.revision) reject(409, '演员、素材或项目风格已变化，请刷新核对后生成。');
  if (!look.prompt.trim()) reject(400, '请先填写并保存自己的定妆提示词。');
  if (inputs.missing.length) reject(400, inputs.missing.join(' '));
  if (form.getAll('chargeConfirmed').length !== 1 || form.get('chargeConfirmed') !== 'yes') reject(400, '生成可能计费，须显式点击生成。');
  const config = readApiConfig(database, productionInteger(form, 'apiConfigId', 1));
  if (config.type !== 'image_to_image' || !config.apiKey) reject(400, '请选择已保存密钥的图生图配置；不会回退文生图。');
  if (['model', 'baseUrl'].some(key => form.getAll(key).length !== 1 || typeof form.get(key) !== 'string')) reject(400, '模型参数缺失或重复。');
  if (form.get('model') !== config.model || form.get('baseUrl') !== config.baseUrl) reject(409, 'API 配置已变化，请刷新后重新选择。');
  const size = requestedImageSize(config, form, inputs.aspectRatio);
  return withLookLock(database, id, async () => {
    const actor = inputs.character;
    const table = actor.image.type === 'boards' ? 'character_boards' : 'character_references';
    const first = { image: await readStoredImage(database, table, actor.image.id) };
    const files = [{ metadata: actor.image, bytes: first?.image }, ...inputs.assets.map(asset => ({ metadata: asset.image,
      bytes: database.prepare('SELECT image FROM production_asset_images WHERE id = ? AND asset_id = ?').get(asset.image.id, asset.id)?.image }))];
    const prompt = manualLookPrompt(inputs), body = new FormData();
    body.set('model', config.model); body.set('prompt', prompt); body.set('n', '1'); body.set('size', size);
    for (const [index, file] of files.entries()) {
      let details;
      try { details = imageDetails(Buffer.from(file.bytes)); } catch { reject(400, '所选参考图不存在或已损坏，没有调用模型。'); }
      if (details.mime !== file.metadata.mime) reject(400, '参考图类型与记录不符，没有调用模型。');
      // 固定多图协议；即使只选演员也使用image[]，不换字段重试或忽略素材。
      body.append('image[]', new Blob([file.bytes], { type: details.mime }), `reference-${index + 1}.${details.mime === 'image/jpeg' ? 'jpg' : details.mime.split('/')[1]}`);
    }
    const operation = await generateOperation(database, { projectId, kind: 'look', targetId: id, config,
      source: { revision: look.revision, inputRevision: inputs.revision, inputs, prompt, model: config.model },
      endpoint: '/images/edits', body, expected: { size } });
    return { id: look.id, revision: look.revision, imageUrl: operation.mediaUrl, operation,
      message: `${operation.error || (operation.deliveryConfirmed ? '媒体已保存，交付已确认。' : '媒体已保存，交付确认未确定。')}请人工采用，原定妆不变。`, redirect: `/projects/${projectId}/operations` };
  });
}
export function clearLookImage(database, projectId, id, form) {
  assertLooksIdle(database, [id]);
  return inTransaction(database, () => {
    const look = findLook(database, projectId, id), image = readLookImage(database, id);
    if (form.getAll('confirmed').length !== 1 || form.get('confirmed') !== 'yes') reject(400, '清除当前定妆照须明确确认。');
    if (productionInteger(form, 'revision', 1) !== look.revision || productionInteger(form, 'imageId', 1) !== image?.id) reject(409, '定妆或当前图片已变化，没有清除图片。');
    database.prepare('UPDATE look_images SET cleared = 1 WHERE look_id = ? AND valid = 1').run(id);
    const revision = look.revision + 1;
    database.prepare('UPDATE looks SET revision = ? WHERE id = ?').run(revision, id);
    return { revision, redirect: `/projects/${projectId}?resource=looks&look=${id}` };
  });
}
