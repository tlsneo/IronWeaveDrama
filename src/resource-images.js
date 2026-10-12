import { createHash } from 'node:crypto';
import { characterFields } from './characters.js';
import { readApiConfig } from './settings.js';
import { callModel, readImageResult } from './model-client.js';
import { loadImage, imageDetails } from './images.js';
import { baseCharacterBoard } from '../prompts/character/base-board.js';
import { referenceCharacterBoard } from '../prompts/character/reference-board.js';
import { sceneImagePrompt } from '../prompts/scene/reference-image.js';

const kinds = {
  character: { table: 'characters', images: 'character_boards', references: 'character_references', column: 'character_id', label: '角色', imageLabel: '角色板' },
  scene: { table: 'scenes', images: 'scene_images', references: 'scene_references', column: 'scene_id', label: '场景', imageLabel: '场景参考图' },
};
const sizes = { '16:9': '2560x1440', '9:16': '1440x2560', '21:9': '2688x1152', '4:3': '2048x1536', '3:4': '1536x2048', '1:1': '2048x2048' };
const generating = new WeakMap();
function reject(status, message) { throw Object.assign(new Error(message), { status }); }
function find(kind, database, projectId, id) {
  const d = kinds[kind];
  const item = database.prepare(`SELECT * FROM ${d.table} WHERE id = ? AND project_id = ?`).get(id, projectId);
  if (!item) reject(404, `${d.label}不存在`);
  return item;
}
export function assertResourceImagesIdle(kind, database, ids) {
  if (ids.some(id => generating.get(database)?.has(`${kind}:${id}`))) reject(409, `${kinds[kind].label}正在生成图片，请等待完成后再操作。`);
}
export function readResourceReference(kind, database, id) {
  const d = kinds[kind];
  return database.prepare(`SELECT id, mime, width, height FROM ${d.references} WHERE ${d.column} = ? AND cleared = 0 ORDER BY id DESC LIMIT 1`).get(id);
}
function checkReferenceId(kind, form, reference) {
  if (form.getAll('referenceId').length > 1) reject(400, '参考图参数重复，请刷新后重试。');
  if ((form.get('referenceId') ?? '') !== String(reference?.id ?? '')) reject(409, `${kinds[kind].label}参考图已变化，请刷新后重试。`);
}
export async function saveResourceReference(kind, database, projectId, id, form) {
  const d = kinds[kind]; find(kind, database, projectId, id);
  const image = form.get('referenceImage');
  if (form.getAll('referenceImage').length !== 1 || !(image instanceof Blob) || !image.size) reject(400, '请上传一张 PNG、JPEG 或 WebP 参考图。');
  if (image.size > 5 * 1024 * 1024) reject(413, '参考图最多 5 MiB。');
  const bytes = Buffer.from(await image.arrayBuffer()); let details;
  try { details = imageDetails(bytes); } catch { reject(400, '参考图不是可识别的安全尺寸 PNG、JPEG 或 WebP 图片。'); }
  assertResourceImagesIdle(kind, database, [id]); find(kind, database, projectId, id);
  checkReferenceId(kind, form, readResourceReference(kind, database, id));
  const referenceId = Number(database.prepare(`INSERT INTO ${d.references} (${d.column}, image, mime, width, height) VALUES (?, ?, ?, ?, ?)`).run(id, bytes, details.mime, details.width, details.height).lastInsertRowid);
  return { referenceId };
}
export function clearResourceReference(kind, database, projectId, id, form) {
  const d = kinds[kind]; find(kind, database, projectId, id); assertResourceImagesIdle(kind, database, [id]);
  const reference = readResourceReference(kind, database, id); checkReferenceId(kind, form, reference);
  if (!reference) reject(400, '当前没有参考图。');
  database.prepare(`UPDATE ${d.references} SET cleared = 1 WHERE ${d.column} = ? AND cleared = 0`).run(id);
  return { cleared: true };
}
export function resourceRevision(kind, item, project) {
  const data = kind === 'character' ? [project.style, ...characterFields.map(field => item[field.column])] : [project.style, project.aspect_ratio, item.name, item.description];
  return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}
export function resourceImageUrl(kind, projectId, id, imageId) {
  return `/projects/${projectId}/${kinds[kind].table}/${id}/${kind === 'character' ? 'boards' : 'images'}/${imageId}`;
}
export function clearResourceImage(kind, database, projectId, id, form) {
  const d = kinds[kind]; find(kind, database, projectId, id); assertResourceImagesIdle(kind, database, [id]);
  const image = database.prepare(`SELECT id FROM ${d.images} WHERE ${d.column} = ? AND cleared = 0 ORDER BY id DESC LIMIT 1`).get(id);
  if (!image) reject(400, '当前没有可操作的图片。');
  if (form.getAll('boardId').length !== 1 || form.get('boardId') !== String(image.id)) reject(409, `${d.label}图片已变化，请刷新后重试。`);
  database.prepare(`UPDATE ${d.images} SET cleared = 1 WHERE ${d.column} = ? AND cleared = 0`).run(id);
  return { cleared: true, boardId: image.id };
}
export async function generateResourceImage(kind, database, projectId, id, form) {
  const d = kinds[kind]; const item = find(kind, database, projectId, id);
  const project = database.prepare('SELECT style, aspect_ratio FROM projects WHERE id = ?').get(projectId);
  if (kind === 'character' && (!Number.isSafeInteger(item.age) || item.age < 18)) reject(400, '基础角色板模板仅适用于明确年满 18 岁的角色，请先确认并保存真实年龄。');
  if (['apiConfigId', 'chargeConfirmed', 'revision', 'model', 'baseUrl'].some(key => form.getAll(key).length !== 1)) reject(400, '生成参数缺失或重复，请刷新页面后重试。');
  if (form.get('chargeConfirmed') !== 'yes') reject(400, '生成图片可能计费，请确认后再生成。');
  const configId = Number(form.get('apiConfigId'));
  if (!/^[1-9]\d*$/.test(form.get('apiConfigId')) || !Number.isSafeInteger(configId)) reject(400, '请选择已保存的图片配置。');
  const reference = readResourceReference(kind, database, id); checkReferenceId(kind, form, reference);
  const config = readApiConfig(database, configId);
  if (config.type !== (reference ? 'image_to_image' : 'text_to_image') || !config.apiKey) reject(400, reference ? '请选择已保存密钥的图生图配置。' : '请选择已保存密钥的文生图配置。');
  if (config.model !== form.get('model') || config.baseUrl !== form.get('baseUrl')) reject(409, 'API 配置已变化，请刷新后重新确认生成。');
  const revision = resourceRevision(kind, item, project);
  if (revision !== form.get('revision')) reject(409, `${d.label}资料已变化，请先保存并刷新后再生成。`);
  const active = generating.get(database) ?? new Set(); generating.set(database, active);
  const key = `${kind}:${id}`; assertResourceImagesIdle(kind, database, [id]); active.add(key);
  try {
    const ratio = kind === 'character' ? '16:9' : project.aspect_ratio;
    const size = sizes[ratio];
    const identity = Object.fromEntries(characterFields.filter(field => item[field.column] !== null && item[field.column] !== undefined && item[field.column] !== '').map(field => [field.label, item[field.column]]));
    const prompt = kind === 'character'
      ? `MANDATORY ART STYLE / 画风: ${project.style}\nApply the style only to rendering, line quality and surface treatment. Do not import costumes, scenery, props or dramatic lighting from style conventions.\n\nADULT CHARACTER IDENTITY / 成年角色基础外观:\n${JSON.stringify(identity, null, 2)}\n\n${(reference ? referenceCharacterBoard : baseCharacterBoard).prompt}`
      : `MANDATORY ART STYLE: ${project.style}\nOUTPUT ASPECT RATIO: ${ratio}\n\nLOCATION DATA:\n${JSON.stringify({ name: item.name, description: item.description }, null, 2)}\n\n${sceneImagePrompt}`;
    let body = { model: config.model, prompt, n: 1, size };
    if (reference) {
      const source = database.prepare(`SELECT image FROM ${d.references} WHERE id = ? AND ${d.column} = ?`).get(reference.id, id);
      body = new FormData(); body.set('model', config.model); body.set('prompt', prompt); body.set('n', '1'); body.set('size', size);
      body.set('image', new Blob([source.image], { type: reference.mime }), `reference.${reference.mime === 'image/jpeg' ? 'jpg' : reference.mime.split('/')[1]}`);
    }
    const response = await callModel(config, reference ? '/images/edits' : '/images/generations', body);
    const bytes = await loadImage(readImageResult(config, response), config.baseUrl);
    const { mime, width, height } = imageDetails(bytes);
    const current = find(kind, database, projectId, id);
    const currentProject = database.prepare('SELECT style, aspect_ratio FROM projects WHERE id = ?').get(projectId);
    const unchanged = resourceRevision(kind, current, currentProject) === revision && (readResourceReference(kind, database, id)?.id ?? null) === (reference?.id ?? null);
    const [w, h] = ratio.split(':').map(Number); const valid = width * h === height * w && unchanged;
    let imageId;
    try {
      imageId = Number(database.prepare(`INSERT INTO ${d.images} (${d.column}, image, mime, width, height, valid, revision, model, prompt, reference_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, bytes, mime, width, height, Number(valid), revision, config.model, prompt, reference?.id ?? null).lastInsertRowid);
    } catch {
      throw Object.assign(new Error(`图片已生成但未能保存，原${d.imageLabel}不变。请下载本次图片，避免丢失付费结果。`), { status: 502, recoveryImage: `data:${mime};base64,${bytes.toString('base64')}` });
    }
    return { valid, imageUrl: resourceImageUrl(kind, projectId, id, imageId), width, height,
      message: valid ? kind === 'character' ? '基础角色板已生成并保存，请检查四视图及人物一致性。' : '场景参考图已生成并保存，请检查环境布局与一致性。'
        : !unchanged ? `生成期间${d.label}资料或参考图发生变化；本次图片已保存供查看，但未替换原${d.imageLabel}。`
          : `接口返回 ${width} × ${height}，不符合${kind === 'character' ? '固定' : '项目'} ${ratio}；本次图片已保存供查看，但未替换原${d.imageLabel}。` };
  } finally { active.delete(key); }
}
