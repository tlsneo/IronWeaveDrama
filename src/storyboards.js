import { createHash } from 'node:crypto';
import { inTransaction } from './database.js';
import { findEpisode, readEpisodeScript, assertEpisodeScriptsIdle, withEpisodeScriptLock } from './episode-scripts.js';
import { occurrenceModes } from './episode-resources.js';
import { characterFields } from './characters.js';
import { readApiConfig } from './settings.js';
import { callModel, readTextResult, safeModelText } from './model-client.js';
import { episodeToShotsPrompt } from '../prompts/storyboard/episode-to-shots.js';

function reject(status, message, extra = {}) { throw Object.assign(new Error(message), { status, ...extra }); }
function text(value, max, required = false) {
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || (required && !value.trim())) reject(400, '分镜字段为空、过长或格式无效，请核对。');
  return value;
}
function integer(form, key, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const raw = form.get(key); const value = Number(raw);
  if (form.getAll(key).length !== 1 || typeof raw !== 'string' || !/^(0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) reject(400, `${key === 'maxShotSeconds' ? '单镜时长上限须为 1–15 秒的整数' : '分镜版本或编号无效'}，请核对。`);
  return value;
}
export function readEpisodeStoryboards(database, episodeId) {
  const row = database.prepare('SELECT * FROM episode_storyboards WHERE episode_id = ?').get(episodeId);
  if (!row) return { revision: 0, scriptRevision: 0, resourceRevision: '', maxShotSeconds: 5, reviewed: false, shots: [] };
  return { revision: row.revision, scriptRevision: row.script_revision, resourceRevision: JSON.parse(row.resources_json).revision,
    maxShotSeconds: row.max_shot_seconds, reviewed: !!row.reviewed, shots: JSON.parse(row.shots) };
}
export function storyboardResources(database, projectId, episodeId) {
  findEpisode(database, projectId, episodeId);
  const scriptRevision = readEpisodeScript(database, episodeId).revision;
  const rows = database.prepare(`SELECT * FROM episode_occurrences WHERE episode_id = ? AND script_revision = ? AND ignored = 0 AND needs_review = 0 AND mode IN ('on_screen', 'memory', 'imagination') ORDER BY id`).all(episodeId, scriptRevision);
  const resources = { characters: [], scenes: [] };
  for (const kind of ['character', 'scene']) {
    const column = `${kind}_id`; const table = kind === 'character' ? 'characters' : 'scenes';
    const ids = [...new Set(rows.filter(row => row.kind === kind && row[column] !== null).map(row => row[column]))].sort((a, b) => a - b);
    for (const id of ids) {
      const item = database.prepare(`SELECT * FROM ${table} WHERE id = ? AND project_id = ?`).get(id, projectId);
      if (!item) continue;
      const generated = database.prepare(`SELECT id FROM ${kind === 'character' ? 'character_boards' : 'scene_images'} WHERE ${column} = ? AND valid = 1 AND cleared = 0 ORDER BY id DESC LIMIT 1`).get(id);
      const reference = generated ? null : database.prepare(`SELECT id FROM ${kind}_references WHERE ${column} = ? AND cleared = 0 ORDER BY id DESC LIMIT 1`).get(id);
      const image = generated ? { id: generated.id, type: kind === 'character' ? 'boards' : 'images', url: `/projects/${projectId}/${table}/${id}/${kind === 'character' ? 'boards' : 'images'}/${generated.id}` }
        : reference ? { id: reference.id, type: 'references', url: `/projects/${projectId}/${table}/${id}/references/${reference.id}` } : null;
      const description = kind === 'scene' ? item.description : characterFields.filter(field => field.key !== 'name' && item[field.column] !== null && item[field.column] !== '').map(field => `${field.label}：${item[field.column]}`).join('\n');
      resources[table].push({ id, name: item.name, description, image,
        appearances: rows.filter(row => row.kind === kind && row[column] === id).map(row => ({ sceneHeading: row.scene_heading, mode: row.mode, details: row.details })) });
    }
  }
  const project = database.prepare('SELECT style, aspect_ratio FROM projects WHERE id = ?').get(projectId);
  return { ...resources, revision: createHash('sha256').update(JSON.stringify([projectId, episodeId, scriptRevision, project, rows, resources])).digest('hex') };
}
function snapshots(database, projectId, episodeId, form) {
  findEpisode(database, projectId, episodeId);
  const plan = readEpisodeStoryboards(database, episodeId), script = readEpisodeScript(database, episodeId), resources = storyboardResources(database, projectId, episodeId);
  if (integer(form, 'revision') !== plan.revision || integer(form, 'scriptRevision') !== script.revision) reject(409, '剧本或分镜已变化，请先保留输入，再刷新核对。');
  if (form.getAll('resourceRevision').length !== 1 || form.get('resourceRevision') !== resources.revision) reject(409, '本集资源或参考图已变化，请刷新核对后再操作。');
  return { plan, script, resources, maxShotSeconds: integer(form, 'maxShotSeconds', 1, 15) };
}
function validateShots(value, script, resources, maxShotSeconds, required = false) {
  if (!Array.isArray(value) || value.length > 300 || (required && !value.length) || JSON.stringify(value).length > 512000) reject(400, '分镜须为完整镜头列表，最多 300 镜／512000 字符；不能以空输出代替成功。');
  const fields = { title: 120, sceneHeading: 300, quote: 1500, framing: 500, action: 1500, dialogue: 2000, sound: 1000, transition: 500, timingReason: 500 };
  const headingNames = new Set(value.map(shot => shot?.sceneHeading));
  // shortcut: unnumbered scenes use submitted headings; add a heading contract before checking their full coverage.
  const headings = [...script.matchAll(/^([^\r\n]+)\r?$/gm)].filter(match => /^\d+-\d+/.test(match[1]) || headingNames.has(match[1]));
  return value.map((shot, index) => {
    try {
      if (!shot || typeof shot !== 'object' || Array.isArray(shot)) reject(400, '镜头格式无效。');
      const clean = {};
      for (const [key, max] of Object.entries(fields)) clean[key] = text(Object.hasOwn(shot, key) ? shot[key] : '', max, ['title', 'sceneHeading', 'quote', 'framing', 'action', 'timingReason'].includes(key));
      const start = script.indexOf(clean.quote);
      const heading = headings.findLast(match => match.index <= start), nextHeading = headings.find(match => match.index > start);
      if (start < 0 || script.indexOf(clean.quote, start + 1) !== -1 || heading?.[1] !== clean.sceneHeading || (nextHeading && start + clean.quote.length > nextHeading.index)) reject(400, '原文依据须在当前剧本中唯一存在，位于所标完整场标题之内，不能引用其他场或跨越场边界。');
      if (typeof shot.mode !== 'string' || !Object.hasOwn(occurrenceModes, shot.mode)) reject(400, '画面类型无效。');
      if (typeof shot.duration !== 'number' || !Number.isFinite(shot.duration) || shot.duration <= 0 || shot.duration > maxShotSeconds || Math.abs(shot.duration * 10 - Math.round(shot.duration * 10)) > 1e-8) reject(400, `预计时长须以 0.1 秒递增，且大于 0、不超过 ${maxShotSeconds} 秒；请拆分或核对，不能强行加速。`);
      if (!Array.isArray(shot.characterIds) || shot.characterIds.length > 50 || new Set(shot.characterIds).size !== shot.characterIds.length || shot.characterIds.some(id => !Number.isSafeInteger(id) || !resources.characters.some(item => item.id === id))) reject(400, '人物关联须来自本集已确认的当前画面资源，不得重复或猜编号。');
      if (shot.sceneId !== null && (!Number.isSafeInteger(shot.sceneId) || !resources.scenes.some(item => item.id === shot.sceneId))) reject(400, '场景关联须来自本集已确认的当前画面资源；未关联时使用空值。');
      return { ...clean, mode: shot.mode, duration: Math.round(shot.duration * 10) / 10, characterIds: [...shot.characterIds], sceneId: shot.sceneId };
    } catch (error) { if (error.status === 400) reject(400, `镜头 ${index + 1}：${error.message}`); throw error; }
  });
}
function store(database, episodeId, before, shots, reviewed) {
  const revision = before.plan.revision + 1;
  database.prepare(`INSERT INTO episode_storyboards (episode_id, script_revision, revision, max_shot_seconds, reviewed, resources_json, shots) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(episode_id) DO UPDATE SET script_revision = excluded.script_revision, revision = excluded.revision, max_shot_seconds = excluded.max_shot_seconds, reviewed = excluded.reviewed, resources_json = excluded.resources_json, shots = excluded.shots`).run(episodeId, before.script.revision, revision, before.maxShotSeconds, Number(reviewed), JSON.stringify(before.resources), JSON.stringify(shots));
  return { revision, message: reviewed ? '分镜已核对保存，预计时长已计入全剧已规划部分。' : '分镜草稿已保存，请逐镜核对后确认；尚未计入全剧已核对时长。' };
}
export function saveEpisodeStoryboards(database, projectId, episodeId, form) {
  findEpisode(database, projectId, episodeId); assertEpisodeScriptsIdle(database, [episodeId]);
  return inTransaction(database, () => {
    const before = snapshots(database, projectId, episodeId, form);
    if (before.plan.shots.length && (before.plan.scriptRevision !== before.script.revision || before.plan.resourceRevision !== before.resources.revision)) reject(409, '当前分镜依据的剧本或资源已过期，请保留编辑后重新生成核对；旧分镜没有删除。');
    if (form.getAll('shots').length !== 1 || typeof form.get('shots') !== 'string' || form.get('shots').length > 512000) reject(400, '镜头列表缺失、重复或过大。');
    let shots;
    try { shots = JSON.parse(form.get('shots')); } catch { reject(400, '镜头列表 JSON 无效。'); }
    shots = validateShots(shots, before.script.script, before.resources, before.maxShotSeconds);
    return { ...store(database, episodeId, before, shots, !!shots.length), redirect: `/projects/${projectId}?view=storyboards&episode=${episodeId}` };
  });
}
export async function generateEpisodeStoryboards(database, projectId, episodeId, form) {
  const before = snapshots(database, projectId, episodeId, form);
  if (!before.script.script.trim() || before.script.script.length > 60000) reject(400, '请先保存本集剧本正文（最多 60000 字），再生成分镜。');
  if (form.getAll('replaceConfirmed').length > 1) reject(400, '替换确认参数不能重复。');
  if (before.plan.shots.length && (form.getAll('replaceConfirmed').length !== 1 || form.get('replaceConfirmed') !== 'yes')) reject(400, '重新生成会替换当前分镜，请先确认并自行保留旧稿。');
  const config = readApiConfig(database, integer(form, 'apiConfigId', 1));
  if (config.type !== 'llm' || !config.apiKey) reject(400, '请选择已保存密钥的大语言模型配置。');
  if (['model', 'baseUrl'].some(key => form.getAll(key).length !== 1 || typeof form.get(key) !== 'string')) reject(400, '模型配置参数缺失或重复。');
  if (config.model !== form.get('model') || config.baseUrl !== form.get('baseUrl')) reject(409, 'API 配置已变化，请刷新后重新选择。');
  return withEpisodeScriptLock(database, episodeId, async () => {
    const episode = findEpisode(database, projectId, episodeId);
    const response = await callModel(config, '/chat/completions', { model: config.model, stream: false, max_tokens: 16384,
      messages: [{ role: 'system', content: episodeToShotsPrompt }, { role: 'user', content: JSON.stringify({ episodeNumber: episode.number, script: before.script.script, maxShotSeconds: before.maxShotSeconds, resources: before.resources }) }] });
    const raw = readTextResult(response); const recoveryText = safeModelText(config, raw).slice(0, 512000);
    let shots;
    try {
      if (response?.choices?.[0]?.finish_reason && response.choices[0].finish_reason !== 'stop') throw new Error('输出未完成');
      const result = JSON.parse(raw.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1'));
      if (!result || Object.keys(result).length !== 1 || !Object.hasOwn(result, 'shots')) throw new Error('输出字段不符');
      shots = validateShots(result.shots, before.script.script, before.resources, before.maxShotSeconds, true);
      const headings = [...before.script.script.matchAll(/^(\d+-\d+[^\r\n]*)\r?$/gm)];
      const anchors = shots.map(shot => ({ heading: shot.sceneHeading, start: before.script.script.indexOf(shot.quote) }));
      if (headings.some((heading, index) => !anchors.some(anchor => anchor.heading === heading[1] && anchor.start >= heading.index && anchor.start < (headings[index + 1]?.index ?? before.script.script.length)))) throw new Error('未覆盖全部已编号剧本场');
      // 先验证原文定位再脱敏；脱敏若改变依据，也不能伪称它仍来自剧本。
      shots = shots.map(shot => Object.fromEntries(Object.entries(shot).map(([key, value]) => [key, typeof value === 'string' ? safeModelText(config, value) : value])));
      shots = validateShots(shots, before.script.script, before.resources, before.maxShotSeconds, true);
    } catch (error) { reject(502, `分镜输出无效、超限或未完整结束，原分镜不变；${error.status === 400 ? error.message : '请核对返回内容。'}没有自动重试。`, { recoveryText }); }
    try {
      return inTransaction(database, () => {
        const current = snapshots(database, projectId, episodeId, form);
        if (current.script.script !== before.script.script || current.resources.revision !== before.resources.revision) reject(409, '生成期间剧本或资源发生变化，新分镜未覆盖，请复制返回文本。', { recoveryText });
        const result = store(database, episodeId, before, shots, false);
        return { ...result, redirect: `/projects/${projectId}?view=storyboards&episode=${episodeId}` };
      });
    } catch (error) {
      if (error.status === 409) { error.recoveryText = recoveryText; throw error; }
      reject(502, '分镜已生成但未能保存，旧分镜不变；请复制返回文本，避免丢失付费结果。', { recoveryText });
    }
  });
}
export function formatStoryboardDuration(seconds) {
  const tenths = Math.round(seconds * 10), minutes = Math.floor(tenths / 600), rest = (tenths % 600) / 10;
  return minutes ? `${minutes} 分 ${rest} 秒` : `${rest} 秒`;
}
export function projectStoryboardSummary(database, projectId) {
  const episodes = database.prepare('SELECT e.id FROM episodes e JOIN seasons s ON s.id = e.season_id WHERE s.project_id = ?').all(projectId);
  const summary = { episodeCount: episodes.length, plannedEpisodes: 0, unplannedEpisodes: 0, staleEpisodes: 0, pendingEpisodes: 0, totalSeconds: 0, shotCount: 0 };
  let tenths = 0;
  for (const episode of episodes) {
    const plan = readEpisodeStoryboards(database, episode.id);
    if (!plan.shots.length) { summary.unplannedEpisodes++; continue; }
    const current = plan.scriptRevision === readEpisodeScript(database, episode.id).revision && plan.resourceRevision === storyboardResources(database, projectId, episode.id).revision;
    if (!current) { summary.staleEpisodes++; continue; }
    if (!plan.reviewed) { summary.pendingEpisodes++; continue; }
    summary.plannedEpisodes++; summary.shotCount += plan.shots.length;
    for (const shot of plan.shots) tenths += Math.round(shot.duration * 10);
  }
  summary.totalSeconds = tenths / 10;
  return summary;
}
