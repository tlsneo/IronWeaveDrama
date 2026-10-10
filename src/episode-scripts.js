import { readApiConfig } from './settings.js';
import { callModel, readTextResult, safeModelText } from './model-client.js';
import { novelToScriptPrompt } from '../prompts/script/novel-to-script.js';

const generating = new WeakMap();
const limits = { source: 30000, script: 60000, notes: 10000 };
function reject(status, message, extra = {}) { throw Object.assign(new Error(message), { status, ...extra }); }

export function findEpisode(database, projectId, id) {
  const episode = database.prepare('SELECT e.id, e.name FROM episodes e JOIN seasons s ON s.id = e.season_id WHERE e.id = ? AND s.project_id = ?').get(id, projectId);
  if (!episode) reject(404, '集不存在');
  return episode;
}

export function readEpisodeScript(database, episodeId) {
  return database.prepare('SELECT source, script, notes, revision FROM episode_scripts WHERE episode_id = ?').get(episodeId)
    ?? { source: '', script: '', notes: '', revision: 0 };
}

export function assertEpisodeScriptsIdle(database, ids) {
  if (ids.some(id => generating.get(database)?.has(id))) reject(409, '本集正在生成剧本，请等待完成后再操作。');
}

function checkRevision(form, draft) {
  const raw = form.get('revision');
  if (form.getAll('revision').length !== 1 || typeof raw !== 'string' || !/^(0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) reject(400, '剧本版本参数无效，请刷新后重试。');
  if (Number(raw) !== draft.revision) reject(409, '本集内容已在其他页面变化，请先保留当前输入，再刷新核对。');
}

export function saveEpisodeScript(database, projectId, episodeId, form) {
  findEpisode(database, projectId, episodeId);
  assertEpisodeScriptsIdle(database, [episodeId]);
  const draft = readEpisodeScript(database, episodeId);
  checkRevision(form, draft);
  const fields = {};
  for (const [key, max] of Object.entries(limits)) {
    if (form.getAll(key).length !== 1 || typeof form.get(key) !== 'string') reject(400, '原文、剧本或说明字段缺失或重复。');
    fields[key] = form.get(key);
    if (fields[key].length > max || fields[key].includes('\0')) reject(400, `${{ source: '小说原文', script: '剧本正文', notes: '改编说明' }[key]}最多 ${max} 字，不允许空字符。`);
  }
  const revision = draft.revision + 1;
  const result = draft.revision
    ? database.prepare('UPDATE episode_scripts SET source = ?, script = ?, notes = ?, revision = ? WHERE episode_id = ? AND revision = ?').run(fields.source, fields.script, fields.notes, revision, episodeId, draft.revision)
    : database.prepare('INSERT OR IGNORE INTO episode_scripts (source, script, notes, revision, episode_id) VALUES (?, ?, ?, ?, ?)').run(fields.source, fields.script, fields.notes, revision, episodeId);
  if (result.changes !== 1) reject(409, '本集内容已变化，请保留输入并刷新核对。');
  return { revision, message: '原文、剧本和改编说明已保存。' };
}

export async function generateEpisodeScript(database, projectId, episodeId, form) {
  findEpisode(database, projectId, episodeId);
  const draft = readEpisodeScript(database, episodeId);
  checkRevision(form, draft);
  if (!draft.source.trim()) reject(400, '请先填写并保存本集小说原文。');
  if (draft.source.length > limits.source) reject(400, '小说原文最多 30000 字，请分段改编。');
  if (draft.script.trim() || draft.notes.trim()) {
    if (form.getAll('replaceConfirmed').length !== 1 || form.get('replaceConfirmed') !== 'yes') reject(400, '生成成功将替换当前剧本和改编说明，请先确认。');
  }
  if (['apiConfigId', 'model', 'baseUrl'].some(key => form.getAll(key).length !== 1 || typeof form.get(key) !== 'string')) reject(400, '请选择已保存的大语言模型配置。');
  const raw = form.get('apiConfigId');
  const configId = Number(raw);
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(configId)) reject(400, '请选择有效的大语言模型配置。');
  const config = readApiConfig(database, configId);
  if (config.type !== 'llm' || !config.apiKey) reject(400, '请选择已保存密钥的大语言模型配置。');
  if (config.model !== form.get('model') || config.baseUrl !== form.get('baseUrl')) reject(409, 'API 配置已变化，请刷新后重新选择。');
  assertEpisodeScriptsIdle(database, [episodeId]);
  const active = generating.get(database) ?? new Set();
  generating.set(database, active); active.add(episodeId);
  try {
    const response = await callModel(config, '/chat/completions', {
      model: config.model, stream: false, max_tokens: 8192,
      messages: [{ role: 'system', content: novelToScriptPrompt }, { role: 'user', content: JSON.stringify({ source: draft.source }) }],
    });
    const text = readTextResult(response);
    const recoveryText = safeModelText(config, text).slice(0, 80000);
    if (response?.choices?.[0]?.finish_reason && response.choices[0].finish_reason !== 'stop') reject(502, '模型未正常完成输出，原剧本不变；请保留返回内容并检查服务商记录，不自动续写或重试。', { recoveryText });
    let generated;
    try { generated = JSON.parse(text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1')); }
    catch { reject(502, '模型未按约定返回剧本 JSON，原剧本不变；返回文本已提供供手动取回，没有自动重试。', { recoveryText }); }
    if (!generated || typeof generated.script !== 'string' || typeof generated.notes !== 'string') reject(502, '模型返回的剧本或改编说明无效，原剧本不变，没有自动重试。', { recoveryText });
    // 先解析字段再脱敏，避免密钥与 script/notes 等字段名相同而破坏协议。
    generated = { script: safeModelText(config, generated.script), notes: safeModelText(config, generated.notes) };
    if (!generated.script.trim() || generated.script.length > limits.script || generated.notes.length > limits.notes || generated.script.includes('\0') || generated.notes.includes('\0')) reject(502, '模型返回的剧本或改编说明为空、无效或过长，原剧本不变，没有自动重试。', { recoveryText });
    const revision = draft.revision + 1;
    try {
      findEpisode(database, projectId, episodeId);
      const result = database.prepare('UPDATE episode_scripts SET script = ?, notes = ?, revision = ? WHERE episode_id = ? AND revision = ? AND source = ? AND script = ? AND notes = ?').run(generated.script, generated.notes, revision, episodeId, draft.revision, draft.source, draft.script, draft.notes);
      if (result.changes !== 1) reject(409, '生成期间本集内容已变化，新稿未覆盖现有内容；请先复制返回文本。', { recoveryText });
    } catch (error) {
      if (error.status === 409) throw error;
      reject(502, '剧本已生成但未能保存，原剧本不变；请复制返回文本，避免丢失付费结果。', { recoveryText });
    }
    return { script: generated.script, notes: generated.notes, revision, message: '剧本已生成并保存，请对照原文检查。' };
  } finally { active.delete(episodeId); }
}
