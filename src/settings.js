import { inTransaction } from './database.js';
import { callModel, imageMime, readImageResult, readTextResult, safeModelText } from './model-client.js';

export const apiTypes = new Map([
  ['text_to_image', '文生图配置'],
  ['llm', '大语言模型配置'],
  ['image_to_image', '图生图配置'],
  ['image_edit', '编辑图片配置'],
  ['video', '视频配置（IronWeave protocol 2）'],
]);

function reject(status, message) {
  throw Object.assign(new Error(message), { status });
}

export function readApiConfig(database, id) {
  const config = database.prepare('SELECT id, name, type, base_url AS baseUrl, api_key AS apiKey, model FROM api_configs WHERE id = ?').get(id);
  if (!config) reject(404, 'API 配置不存在');
  const options = database.prepare('SELECT protocol, test_size AS testSize, video_profiles AS videoProfiles FROM api_protocols WHERE config_id = ?').get(id);
  return { ...config, protocol: options?.protocol ?? 'legacy', testSize: options?.testSize || '1024x1024', videoProfiles: options ? JSON.parse(options.videoProfiles) : [] };
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
  const protocol = form.get('protocol') ?? existing?.protocol ?? 'legacy';
  const testSize = form.get('testSize') ?? existing?.testSize ?? '1024x1024';
  if (!['legacy', 'ironweave2'].includes(protocol) || form.getAll('protocol').length > 1) reject(400, '请选择明确的接口协议。');
  if ((type === 'llm' || type === 'image_edit') && protocol !== 'legacy') reject(400, 'protocol 2 不支持文字或遮罩编辑。');
  if (type === 'video' && protocol !== 'ironweave2') reject(400, '视频只支持显式 protocol 2，不调用云端协议。');
  if (protocol === 'ironweave2' && model !== 'ironweave') reject(400, 'protocol 2 的模型名必须是 ironweave。');
  if (!/^[1-9]\d*x[1-9]\d*$/.test(testSize) || testSize.length > 30 || form.getAll('testSize').length > 1) reject(400, '测试图片尺寸必填，格式为宽x高。');
  let videoProfiles;
  try { videoProfiles = form.has('videoProfiles') ? JSON.parse(form.get('videoProfiles')) : existing?.videoProfiles ?? []; } catch { reject(400, '视频参数列表 JSON 无效。'); }
  if (form.getAll('videoProfiles').length > 1 || !Array.isArray(videoProfiles) || videoProfiles.length > 100 || videoProfiles.some(p => !p || Object.keys(p).sort().join(',') !== 'fps,frames,size' || !/^[1-9]\d*x[1-9]\d*$/.test(p.size) || !Number.isSafeInteger(p.frames) || p.frames < 1 || !Number.isSafeInteger(p.fps) || p.fps < 1)) reject(400, '视频参数须显式列出 size、frames、fps；能力仍由 Iron 已验证配置决定。');
  return inTransaction(database, () => {
  if (id) {
    database.prepare('UPDATE api_configs SET name = ?, type = ?, base_url = ?, api_key = ?, model = ? WHERE id = ?').run(name, type, baseUrl, apiKey, model, id);
  } else {
    id = Number(database.prepare('INSERT INTO api_configs (name, type, base_url, api_key, model) VALUES (?, ?, ?, ?, ?)').run(name, type, baseUrl, apiKey, model).lastInsertRowid);
  }
  database.prepare('INSERT INTO api_protocols(config_id, protocol, test_size, video_profiles) VALUES(?,?,?,?) ON CONFLICT(config_id) DO UPDATE SET protocol=excluded.protocol,test_size=excluded.test_size,video_profiles=excluded.video_profiles').run(id, protocol, testSize, JSON.stringify(videoProfiles));
  return { id, name, type, baseUrl, model, protocol, testSize, videoProfiles, hasApiKey: true, message: '配置已保存。尚未验证连接或模型调用能力。' };
  });
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
  if (!isText) { if (body instanceof FormData) body.set('size', config.testSize); else body.size = config.testSize; }
  if (config.protocol === 'ironweave2') {
    if (config.type === 'video') {
      const index = Number(form.get('profileIndex'));
      if (!form.has('profileIndex') || !Number.isSafeInteger(index) || !config.videoProfiles[index]) reject(400, '请显式选择已登记的视频参数组合。');
      body = { model: 'ironweave', prompt: form.get('prompt')?.trim(), ...config.videoProfiles[index] };
      if (!body.prompt) reject(400, '视频测试提示词必填。');
    }
    const { generateOperation } = await import('./generation-operations.js');
    const expected = body instanceof FormData ? { size: body.get('size') } : { size: body.size, ...(body.frames ? { frames: body.frames, fps: body.fps } : {}) };
    const operation = await generateOperation(database, { projectId: null, kind: 'test', targetId: id, config, source: { test: true }, endpoint: config.type === 'video' ? '/videos/generations' : endpoint, body, expected });
    return { verified: operation.deliveryConfirmed, kind: config.type === 'video' ? 'video' : 'image', image: operation.mediaUrl, operation, message: operation.deliveryConfirmed ? '测试文件已保存并确认交付；不代表其他参数或真实 GPU 能力已验证。' : '测试文件已保存，交付确认未确定，请在操作历史核对。' };
  }
  const result = await callModel(config, endpoint, body, isText ? 60000 : 180000);
  if (isText) {
    return { verified: true, kind: 'text', text: safeModelText(config, readTextResult(result)).slice(0, 3000), message: '模型实际调用成功，已收到文本回复。此次测试可能计费。' };
  }
  return { verified: true, kind: 'image', image: readImageResult(config, result), message: '模型实际调用成功，已收到图片结果。此次测试可能计费；测试图不写入角色资源。' };
}
