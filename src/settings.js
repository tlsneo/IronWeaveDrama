import { callModel, imageMime, readImageResult, readTextResult, safeModelText } from './model-client.js';

export const apiTypes = new Map([
  ['text_to_image', '文生图配置'],
  ['llm', '大语言模型配置'],
  ['image_to_image', '图生图配置'],
  ['image_edit', '编辑图片配置'],
]);

function reject(status, message) {
  throw Object.assign(new Error(message), { status });
}

export function readApiConfig(database, id) {
  const config = database.prepare('SELECT id, name, type, base_url AS baseUrl, api_key AS apiKey, model FROM api_configs WHERE id = ?').get(id);
  if (!config) reject(404, 'API 配置不存在');
  return config;
}

export function saveApiConfig(database, id, form) {
  const existing = id ? readApiConfig(database, id) : undefined;
  if (['name', 'type', 'baseUrl', 'apiKey', 'model'].some(key => form.getAll(key).length !== 1)) reject(400, '配置字段缺失或重复，请刷新后重试。');
  const name = form.get('name').trim();
  const type = form.get('type');
  if (!name || name.length > 80) reject(400, '请填写配置名称，最多 80 字。');
  if (!apiTypes.has(type)) reject(400, '请选择有效的 API 类型。');
  const baseUrl = form.get('baseUrl').trim().replace(/\/+$/, '');
  const apiKey = form.get('apiKey').trim() || existing?.apiKey;
  const model = form.get('model').trim();
  let url;
  try { url = new URL(baseUrl); } catch { reject(400, '请填写有效的 Base URL。'); }
  if (baseUrl.length > 2048 || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || /[\s\x00-\x1f\x7f]/.test(baseUrl)) reject(400, 'Base URL 仅支持 HTTP／HTTPS，不允许用户名、密码、查询参数或片段。');
  if (!apiKey || apiKey.length > 4096 || !/^[\x21-\x7e]+$/.test(apiKey)) reject(400, '请填写有效的 API Key；这条配置已保存密钥时留空可保持原值。');
  if (!model || model.length > 200 || /[\x00-\x1f\x7f]/.test(model)) reject(400, '请填写模型名称，最多 200 字。');
  if (id) {
    database.prepare('UPDATE api_configs SET name = ?, type = ?, base_url = ?, api_key = ?, model = ? WHERE id = ?').run(name, type, baseUrl, apiKey, model, id);
  } else {
    id = Number(database.prepare('INSERT INTO api_configs (name, type, base_url, api_key, model) VALUES (?, ?, ?, ?, ?)').run(name, type, baseUrl, apiKey, model).lastInsertRowid);
  }
  return { id, name, type, baseUrl, model, hasApiKey: true, message: '配置已保存。尚未验证连接或模型调用能力。' };
}

export async function checkApiConfig(database, id, form) {
  const config = readApiConfig(database, id);
  if (!config.apiKey) reject(400, '请先完善并保存这条 API 配置。');
  if (form.getAll('chargeConfirmed').length !== 1 || form.get('chargeConfirmed') !== 'yes') reject(400, '测试会实际调用模型并可能计费，请刷新页面并确认后测试。');
  if (['type', 'model', 'baseUrl'].some(key => form.getAll(key).length !== 1 || form.get(key) !== config[key])) reject(409, '配置已变化，请刷新页面后重新确认测试。');
  const isText = config.type === 'llm';
  const needsImage = ['image_to_image', 'image_edit'].includes(config.type);
  const endpoint = isText ? '/chat/completions' : needsImage ? '/images/edits' : '/images/generations';
  let body;
  if (needsImage) {
    const image = form.get('referenceImage');
    if (form.getAll('referenceImage').length !== 1 || !(image instanceof Blob) || !image.size) reject(400, '图生图和编辑图片测试需要上传一张参考图。');
    if (image.size > 5 * 1024 * 1024) reject(413, '参考图最多 5 MiB。');
    const bytes = Buffer.from(await image.arrayBuffer());
    const mime = imageMime(bytes);
    if (!mime) reject(400, '参考图只支持 PNG、JPEG 或 WebP，请上传真实图片文件。');
    body = new FormData();
    body.set('model', config.model);
    body.set('n', '1');
    body.set('prompt', config.type === 'image_to_image' ? 'Create a simple watercolor version of the input image.' : 'Change the background of the input image to plain light blue. Preserve the main subject.');
    body.set('image', new Blob([bytes], { type: mime }), `reference.${mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1]}`);
  } else {
    body = isText
      ? { model: config.model, messages: [{ role: 'user', content: 'Reply only with OK.' }], max_tokens: 16, stream: false }
      : { model: config.model, prompt: 'A single blue ceramic mug with a handle on a wooden table, soft natural light, realistic product photography. No text, logos, symbols, flags or people.', n: 1 };
  }
  const result = await callModel(config, endpoint, body, isText ? 60000 : 180000);
  if (isText) {
    return { verified: true, kind: 'text', text: safeModelText(config, readTextResult(result)).slice(0, 3000), message: '模型实际调用成功，已收到文本回复。此次测试可能计费。' };
  }
  return { verified: true, kind: 'image', image: readImageResult(config, result), message: '模型实际调用成功，已收到图片结果。此次测试可能计费；测试图不写入角色资源。' };
}
