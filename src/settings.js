import { inTransaction } from './database.js';
import { callModel, readTextResult, safeModelText } from './model-client.js';
import { imageDetails } from './images.js';

export const apiTypes = new Map([
  ['text_to_image', '文生图配置'],
  ['llm', '大语言模型配置'],
  ['image_to_image', '图生图配置'],
  ['video', '视频配置（IronWeave protocol 2）'],
]);
const mediaTypes = new Set(['text_to_image', 'image_to_image', 'video']);
const runtimeProtocol = type => type === 'llm' ? 'chat' : mediaTypes.has(type) ? 'ironweave2' : 'unsupported';
const imageLimit = 32 * 1024 * 1024;

function reject(status, message) {
  throw Object.assign(new Error(message), { status });
}
function baseAddress(value) {
  let url;
  try { url = new URL(value); } catch { reject(400, '请填写有效的 Base URL。'); }
  if (typeof value !== 'string' || value.length > 2048 || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || /[\s\x00-\x1f\x7f]/.test(value)) reject(400, 'Base URL 仅支持 HTTP／HTTPS，不允许用户名、密码、查询参数或片段。');
  return url;
}
function validSize(value) {
  return typeof value === 'string' && /^[1-9]\d*x[1-9]\d*$/.test(value) && value.length <= 30 && value.split('x').every(n => Number.isSafeInteger(Number(n)));
}
function validProfiles(profiles) {
  return Array.isArray(profiles) && profiles.length <= 100 && profiles.every(p => p && Object.keys(p).sort().join(',') === 'fps,frames,size' && validSize(p.size) && Number.isSafeInteger(p.frames) && p.frames > 0 && Number.isSafeInteger(p.fps) && p.fps > 0);
}

export function requireWeaveConfig(config) {
  if (!config || !mediaTypes.has(config.type) || config.protocol !== 'ironweave2') reject(400, '此生成入口只支持 Weave 图片或视频配置；遮罩编辑已停用。');
  if (config.model !== 'ironweave') reject(400, '旧媒体模型配置不能直接调用，请主动保存模型名为 ironweave 的配置。');
  if (!baseAddress(config.baseUrl).pathname.endsWith('/v1')) reject(400, 'Weave 地址须以 /v1 结尾，请修改并保存配置；不会自动补齐地址。');
  return config;
}

export function readApiConfig(database, id) {
  const config = database.prepare('SELECT id, name, type, base_url AS baseUrl, api_key AS apiKey, model FROM api_configs WHERE id = ?').get(id);
  if (!config) reject(404, 'API 配置不存在');
  const options = database.prepare('SELECT test_size AS testSize, video_profiles AS videoProfiles FROM api_protocols WHERE config_id = ?').get(id);
  // 历史协议标签只保留在原表中，不能恢复旧媒体调用，也不改写配置身份。
  return { ...config, protocol: runtimeProtocol(config.type), testSize: options?.testSize || '1024x1024', videoProfiles: options ? JSON.parse(options.videoProfiles) : [] };
}

export function saveApiConfig(database, id, form) {
  const existing = id ? readApiConfig(database, id) : undefined;
  if (['name', 'type', 'baseUrl', 'apiKey', 'model'].some(key => form.getAll(key).length !== 1 || typeof form.get(key) !== 'string')) reject(400, '配置字段缺失或重复，请刷新后重试。');
  for (const key of ['protocol', 'testSize', 'videoProfiles']) if (form.getAll(key).length > 1 || (form.has(key) && typeof form.get(key) !== 'string')) reject(400, '配置字段类型错误或重复。');
  const name = form.get('name').trim(), type = form.get('type');
  if (!name || name.length > 80) reject(400, '请填写配置名称，最多 80 字。');
  if (existing?.type === 'image_edit' || type === 'image_edit') reject(400, '遮罩编辑配置已停用，保留原记录；请另建图片或视频配置。');
  if (!apiTypes.has(type)) reject(400, '请选择有效的 API 类型。');
  const baseUrl = form.get('baseUrl').trim().replace(/\/+$/, '');
  const apiKey = form.get('apiKey').trim() || existing?.apiKey;
  const model = form.get('model').trim(), protocol = runtimeProtocol(type);
  baseAddress(baseUrl);
  if (!apiKey || apiKey.length > 4096 || !/^[\x21-\x7e]+$/.test(apiKey)) reject(400, '请填写有效的 API Key；这条配置已保存密钥时留空可保持原值。');
  if (!model || model.length > 200 || /[\x00-\x1f\x7f]/.test(model)) reject(400, '请填写模型名称，最多 200 字。');
  if (form.has('protocol') && (type === 'llm' ? !['chat', 'legacy'].includes(form.get('protocol')) : form.get('protocol') !== 'ironweave2')) reject(400, '媒体只支持 Weave protocol 2，不接受旧协议；文字聊天独立配置。');
  if (mediaTypes.has(type)) requireWeaveConfig({ type, model, baseUrl, protocol });
  const testSize = form.get('testSize') ?? existing?.testSize ?? '1024x1024';
  if (!validSize(testSize)) reject(400, '测试图片尺寸必填，格式为宽x高。');
  let videoProfiles;
  try { videoProfiles = form.has('videoProfiles') ? JSON.parse(form.get('videoProfiles')) : existing?.videoProfiles ?? []; } catch { reject(400, '视频参数列表 JSON 无效。'); }
  if (!validProfiles(videoProfiles)) reject(400, '视频参数须显式列出 size、frames、fps；能力仍由 Iron 已验证配置决定。');
  return inTransaction(database, () => {
    if (id) {
      database.prepare('UPDATE api_configs SET name = ?, type = ?, base_url = ?, api_key = ?, model = ? WHERE id = ?').run(name, type, baseUrl, apiKey, model, id);
    } else {
      id = Number(database.prepare('INSERT INTO api_configs (name, type, base_url, api_key, model) VALUES (?, ?, ?, ?, ?)').run(name, type, baseUrl, apiKey, model).lastInsertRowid);
    }
    if (mediaTypes.has(type)) database.prepare('INSERT INTO api_protocols(config_id, protocol, test_size, video_profiles) VALUES(?,?,?,?) ON CONFLICT(config_id) DO UPDATE SET protocol=excluded.protocol,test_size=excluded.test_size,video_profiles=excluded.video_profiles').run(id, protocol, testSize, JSON.stringify(videoProfiles));
    return { id, name, type, baseUrl, model, protocol, testSize, videoProfiles, hasApiKey: true, message: '配置已保存。尚未验证连接或模型调用能力。' };
  });
}

export async function checkApiConfig(database, id, form) {
  const config = readApiConfig(database, id);
  if (!config.apiKey) reject(400, '请先完善并保存这条 API 配置。');
  if (form.getAll('chargeConfirmed').length !== 1 || form.get('chargeConfirmed') !== 'yes') reject(400, '测试会实际调用模型并可能计费，请刷新页面并确认后测试。');
  if (['type', 'model', 'baseUrl'].some(key => form.getAll(key).length !== 1 || form.get(key) !== config[key])) reject(409, '配置已变化，请刷新页面后重新确认测试。');
  const isText = config.type === 'llm', isVideo = config.type === 'video';
  if (!isText) requireWeaveConfig(config);
  let textBytes = 0;
  for (const [key, value] of form) if (typeof value === 'string') textBytes += Buffer.byteLength(key) + Buffer.byteLength(value);
  if (textBytes > 65536) reject(413, '测试文本合计最多 64 KiB。');
  const allowed = new Set(['chargeConfirmed', 'type', 'model', 'baseUrl', 'protocol']);
  if (config.type === 'image_to_image' || isVideo) allowed.add('referenceImages');
  if (isVideo) { allowed.add('profileIndex'); allowed.add('prompt'); }
  for (const [key, value] of form) {
    if (!allowed.has(key) || (key !== 'referenceImages' && (typeof value !== 'string' || form.getAll(key).length !== 1))) reject(400, '测试字段未知、类型错误或重复，请刷新页面后重试。');
  }
  if (form.has('protocol') && form.get('protocol') !== config.protocol) reject(400, '测试协议已停用或不符合配置类型，请刷新页面。');
  if (isText) {
    const result = await callModel(config, '/chat/completions', { model: config.model, messages: [{ role: 'user', content: 'Reply only with OK.' }], max_tokens: 16, stream: false }, 60000);
    return { verified: true, kind: 'text', text: safeModelText(config, readTextResult(result)).slice(0, 3000), message: '模型实际调用成功，已收到文本回复。此次测试可能计费。' };
  }
  const parameters = { model: config.model, n: 1, size: config.testSize, prompt: config.type === 'image_to_image' ? 'Create a simple watercolor version of the input images. Preserve their order.' : 'A single blue ceramic mug with a handle on a wooden table, soft natural light, realistic product photography. No text, logos, symbols, flags or people.' };
  if (isVideo) {
    const index = form.get('profileIndex'), prompt = form.get('prompt');
    if (!/^(0|[1-9]\d*)$/.test(index ?? '') || !Number.isSafeInteger(Number(index)) || !validProfiles(config.videoProfiles) || !config.videoProfiles[Number(index)]) reject(400, '请显式选择已登记的视频参数组合。');
    if (typeof prompt !== 'string' || !prompt.trim() || [...prompt].length > 12000 || /[\uD800-\uDFFF]/u.test(prompt)) reject(400, '视频测试提示词必填，最多 12000 个 Unicode 字符。');
    Object.assign(parameters, config.videoProfiles[Number(index)], { prompt });
  }
  if (!validSize(parameters.size)) reject(400, '请先保存合法测试尺寸。');
  const images = form.getAll('referenceImages');
  if (images.length > 51) reject(413, '参考图最多 51 张，实际支持数量仍由 Weave 判断。');
  if (images.some(image => !(image instanceof Blob) || !image.size)) reject(400, '请上传真实的 PNG、JPEG 或 WebP 参考图文件。');
  if (images.some(image => image.size > imageLimit) || images.reduce((total, image) => total + image.size, 0) > imageLimit) reject(413, '参考图每张及合计最多 32 MiB。');
  if (config.type === 'image_to_image' && !images.length) reject(400, '图生图测试需要上传实际参考图，不会自动补图。');
  let body = parameters;
  if (images.length) {
    body = new FormData();
    for (const [key, value] of Object.entries(parameters)) body.set(key, String(value));
    for (const image of images) {
      const bytes = Buffer.from(await image.arrayBuffer());
      let details;
      try { details = imageDetails(bytes); } catch { reject(400, '参考图只支持真实的静态 PNG、JPEG 或 WebP 安全尺寸图片。'); }
      if (image.type !== details.mime || details.width * details.height > 64000000) reject(400, '参考图声明类型或尺寸不符合实际图片。');
      body.append('image[]', new Blob([bytes], { type: details.mime }), image.name || 'reference');
    }
  }
  const { generateOperation } = await import('./generation-operations.js');
  const expected = { size: parameters.size, ...(isVideo ? { frames: parameters.frames, fps: parameters.fps } : {}) };
  const endpoint = isVideo ? '/videos/generations' : config.type === 'image_to_image' ? '/images/edits' : '/images/generations';
  const operation = await generateOperation(database, { projectId: null, kind: 'test', targetId: id, config, source: { test: true }, endpoint, body, expected });
  return { verified: operation.deliveryConfirmed, kind: isVideo ? 'video' : 'image', ...(isVideo ? {} : { image: operation.mediaUrl }), operation, message: operation.deliveryConfirmed ? '测试文件已保存并确认交付；可在操作历史查看，不代表其他参数或真实 GPU 能力已验证。' : '测试文件已保存，请在操作历史核对交付状态。' };
}
