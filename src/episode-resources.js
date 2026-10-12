import { inTransaction } from './database.js';
import { findEpisode, readEpisodeScript, assertEpisodeScriptsIdle, withEpisodeScriptLock } from './episode-scripts.js';
import { readApiConfig } from './settings.js';
import { callModel, readTextResult, safeModelText } from './model-client.js';
import { extractResourcesPrompt } from '../prompts/script/extract-resources.js';

export const occurrenceModes = { on_screen: '实际画面', memory: '回忆画面', imagination: '想象画面' };
export function isVisualOccurrence(item) { return Object.hasOwn(occurrenceModes, item.mode); }
const tables = { character: 'characters', scene: 'scenes' };
function reject(status, message, extra = {}) { throw Object.assign(new Error(message), { status, ...extra }); }
function text(value, max, required = false) {
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || (required && !value.trim())) reject(400, '提取或关联资料为空、过长或格式无效。');
  return value;
}
function number(form, key, zero = false) {
  const raw = form.get(key);
  if (form.getAll(key).length !== 1 || typeof raw !== 'string' || !(zero ? /^(0|[1-9]\d*)$/ : /^[1-9]\d*$/).test(raw) || !Number.isSafeInteger(Number(raw))) reject(400, '版本或编号无效，请刷新核对。');
  return Number(raw);
}
function mode(kind, value) {
  if (!Object.hasOwn(occurrenceModes, value)) reject(400, '只接受实际呈现的画面出场类型。');
  return value;
}
function locate(script, quote, heading) {
  text(quote, 1000, true); text(heading, 300);
  const start = script.indexOf(quote);
  if (start < 0 || script.indexOf(quote, start + 1) !== -1 || (heading && script.lastIndexOf(heading, start) < 0)) reject(400, '原文片段必须在当前剧本中唯一存在，场标题必须出现在该位置之前；请补足上下文后核对。');
  return start;
}
export function readEpisodeResources(database, episodeId) {
  const batch = database.prepare('SELECT * FROM episode_extractions WHERE episode_id = ?').get(episodeId);
  return { revision: batch?.revision ?? 0, scriptRevision: batch?.script_revision ?? 0, candidates: batch ? JSON.parse(batch.candidates).filter(item => isVisualOccurrence(item) && !item.ignored) : [],
    occurrences: database.prepare('SELECT * FROM episode_occurrences WHERE episode_id = ? ORDER BY source_start, kind, id').all(episodeId) };
}
export function resourceChoices(database, projectId, kind) {
  if (!Object.hasOwn(tables, kind)) reject(400, '资源类型无效。');
  return database.prepare(`SELECT id, name FROM ${tables[kind]} WHERE project_id = ? ORDER BY name, id`).all(projectId);
}
function enrich(database, projectId, episodeId, occurrences) {
  const previous = readEpisodeResources(database, episodeId).occurrences;
  const choices = { character: resourceChoices(database, projectId, 'character'), scene: resourceChoices(database, projectId, 'scene') };
  const script = readEpisodeScript(database, episodeId).script;
  const anchors = new Map(previous.map(row => {
    try { return [row.id, { quote: row.quote, sceneHeading: row.scene_heading, sourceStart: locate(script, row.quote, row.scene_heading) }]; }
    catch { return [row.id, null]; }
  }));
  const matches = occurrences.map(item => {
    const related = previous.filter(row => row.kind === item.kind && row.source_name === item.name);
    const overlaps = related.filter(row => {
      const anchor = anchors.get(row.id);
      return anchor && anchor.sourceStart < item.sourceStart + item.quote.length && item.sourceStart < anchor.sourceStart + anchor.quote.length;
    });
    const old = related.find(row => row.id === item.occurrenceId) ?? related.find(row => row.quote === item.quote) ?? (overlaps.length === 1 ? overlaps[0] : null);
    return { item, old, ambiguous: !old && overlaps.length > 1 };
  });
  return matches.map(({ item, old, ambiguous }) => {
    if (old && matches.filter(match => match.old?.id === old.id).length > 1) { old = null; ambiguous = true; }
    const column = item.kind === 'character' ? 'character_id' : 'scene_id';
    // shortcut: 无法唯一对齐的改写只保留旧记录并要求核对，不做模糊自动归并。
    const priorIds = [...new Set(previous.filter(row => isVisualOccurrence(row) && row.kind === item.kind && row.source_name === item.name && !row.ignored && row[column] !== null).map(row => row[column]))];
    const named = choices[item.kind].filter(row => row.name.trim().toLowerCase() === item.name.trim().toLowerCase());
    const suggestedId = ambiguous ? null : old && !old.ignored && old[column] !== null ? old[column]
      : priorIds.length === 1 ? priorIds[0] : priorIds.length === 0 && named.length === 1 ? named[0].id : null;
    return { ...item, occurrenceId: old?.id ?? null, needsReview: ambiguous,
      suggestedId: choices[item.kind].some(row => row.id === suggestedId) ? suggestedId : null, ignored: false };
  });
}
export async function extractEpisodeResources(database, projectId, episodeId, form) {
  findEpisode(database, projectId, episodeId);
  const draft = readEpisodeScript(database, episodeId);
  if (number(form, 'revision') !== draft.revision) reject(409, '剧本已变化，请保存并刷新核对。');
  if (!draft.script.trim() || draft.script.length > 60000) reject(400, '请先保存本集剧本正文，最多 60000 字。');
  const batch = readEpisodeResources(database, episodeId);
  if (number(form, 'batchRevision', true) !== batch.revision) reject(409, '本集提取或关联结果已变化，请刷新核对。');
  if (batch.candidates.length && (form.getAll('replaceConfirmed').length !== 1 || form.get('replaceConfirmed') !== 'yes')) reject(400, '重新提取将替换未确认的提取草稿，请先确认；已保存出场记录不会删除。');
  const config = readApiConfig(database, number(form, 'apiConfigId'));
  if (config.type !== 'llm' || !config.apiKey) reject(400, '请选择已保存密钥的大语言模型配置。');
  if (['model', 'baseUrl'].some(key => form.getAll(key).length !== 1 || typeof form.get(key) !== 'string')) reject(400, '模型配置参数缺失或重复。');
  if (config.model !== form.get('model') || config.baseUrl !== form.get('baseUrl')) reject(409, 'API 配置已变化，请刷新后重新选择。');
  return withEpisodeScriptLock(database, episodeId, async () => {
    const response = await callModel(config, '/chat/completions', { model: config.model, stream: false, max_tokens: 8192,
      messages: [{ role: 'system', content: extractResourcesPrompt }, { role: 'user', content: JSON.stringify({ script: draft.script }) }] });
    const raw = readTextResult(response);
    const recoveryText = safeModelText(config, raw).slice(0, 80000);
    let parsed, candidates;
    try {
      if (response?.choices?.[0]?.finish_reason && response.choices[0].finish_reason !== 'stop') throw new Error('输出未正常结束');
      parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1'));
      if (!parsed || !Array.isArray(parsed.occurrences) || parsed.occurrences.length > 200) throw new Error('出现记录格式或数量无效');
      const keys = new Map();
      candidates = parsed.occurrences.map(item => {
        if (!item || !Object.hasOwn(tables, item.kind)) throw new Error('资源类型无效');
        if (['off_screen', 'inner_voice', 'mentioned'].includes(item.mode)) return null;
        const clean = { kind: item.kind };
        for (const [key, max] of Object.entries({ name: 80, description: 1000, sceneHeading: 300, quote: 1000, details: 1000 })) clean[key] = text(safeModelText(config, text(item[key], max, ['name', 'quote'].includes(key))), max, ['name', 'quote'].includes(key));
        clean.name = clean.name.trim(); clean.mode = mode(clean.kind, item.mode);
        if (!draft.script.includes(clean.name)) throw new Error('资源名称不在剧本中');
        clean.sourceStart = locate(draft.script, clean.quote, clean.sceneHeading);
        const key = JSON.stringify([clean.kind, clean.name, clean.quote]);
        if (keys.has(key)) {
          if (JSON.stringify(keys.get(key)) !== JSON.stringify(clean)) throw new Error('重复位置的资料有冲突');
          return null;
        }
        keys.set(key, clean); return clean;
      }).filter(Boolean);
    } catch {
      reject(502, '提取结果格式、原文定位或数量不合格，已有资源和出场记录不变；可复制返回文本，没有自动重试。', { recoveryText });
    }
    try {
      inTransaction(database, () => {
        findEpisode(database, projectId, episodeId);
        const current = readEpisodeScript(database, episodeId);
        if (current.revision !== draft.revision || current.script !== draft.script || readEpisodeResources(database, episodeId).revision !== batch.revision) reject(409, '提取期间剧本或关联已变化，结果未覆盖；请保留返回文本。', { recoveryText });
        candidates = enrich(database, projectId, episodeId, candidates);
        const found = new Set(candidates.map(item => item.occurrenceId));
        for (const row of batch.occurrences) if (!row.ignored && !row.needs_review && !found.has(row.id)) database.prepare('UPDATE episode_occurrences SET needs_review = 1, revision = revision + 1 WHERE id = ? AND episode_id = ?').run(row.id, episodeId);
        database.prepare(`INSERT INTO episode_extractions (episode_id, script_revision, revision, candidates) VALUES (?, ?, ?, ?)
          ON CONFLICT(episode_id) DO UPDATE SET script_revision = excluded.script_revision, revision = excluded.revision, candidates = excluded.candidates`).run(episodeId, draft.revision, batch.revision + 1, JSON.stringify(candidates));
      });
    } catch (error) {
      if (error.status === 409) throw error;
      reject(502, '已提取但未能保存提取草稿，旧记录不变；请复制返回文本，避免丢失付费结果。', { recoveryText });
    }
    return { message: candidates.length ? '本集提取草稿已保存，请核对后确认关联。' : '未提取到人物或场景；已有出场记录没有删除，请核对。', redirect: `/projects/${projectId}?view=episode&episode=${episodeId}#episode-resources` };
  });
}
function selectResource(database, projectId, kind, selection, created) {
  if (!selection || !['existing', 'new', 'ignore'].includes(selection.action)) reject(400, '请选择关联资源、新建或忽略。');
  if (selection.action === 'ignore') return null;
  const table = tables[kind];
  if (selection.action === 'existing') {
    if (!Number.isSafeInteger(selection.resourceId) || selection.resourceId <= 0) reject(400, '关联资源编号无效。');
    const resource = database.prepare(`SELECT id, name FROM ${table} WHERE id = ? AND project_id = ?`).get(selection.resourceId, projectId);
    if (!resource) reject(404, '关联资源不存在或不属于本项目。');
    if (text(selection.resourceName, 80, true) !== resource.name) reject(409, '资源名称已变化，请刷新后重新确认。');
    return resource.id;
  }
  const name = text(selection.name, 80, true).trim();
  const description = text(selection.description, 1000);
  const key = JSON.stringify([kind, name]);
  if (created.has(key)) {
    const earlier = created.get(key);
    if (earlier.description !== description) reject(400, '同类同名的新建项会共用一个资源，请统一新建描述；不同资源请使用可区分的名称。');
    return earlier.id;
  }
  if (resourceChoices(database, projectId, kind).some(row => row.name.trim().toLowerCase() === name.toLowerCase())) reject(409, '已有同名资源，请选择关联；确为不同资源时请使用可区分的名称。');
  const result = kind === 'character'
    ? database.prepare('INSERT INTO characters (project_id, name, appearance_notes) VALUES (?, ?, ?)').run(projectId, name, description)
    : database.prepare('INSERT INTO scenes (project_id, name, description) VALUES (?, ?, ?)').run(projectId, name, description);
  const id = Number(result.lastInsertRowid); created.set(key, { id, description }); return id;
}
export function confirmEpisodeResources(database, projectId, episodeId, form) {
  findEpisode(database, projectId, episodeId); assertEpisodeScriptsIdle(database, [episodeId]);
  const batchRevision = number(form, 'batchRevision');
  const scriptRevision = number(form, 'scriptRevision');
  if (form.getAll('selections').length !== 1 || typeof form.get('selections') !== 'string' || form.get('selections').length > 512000) reject(400, '关联确认内容无效或过大。');
  let selections;
  try { selections = JSON.parse(form.get('selections')); } catch { reject(400, '关联确认格式无效。'); }
  return inTransaction(database, () => {
    const batch = readEpisodeResources(database, episodeId);
    const draft = readEpisodeScript(database, episodeId);
    if (batch.revision !== batchRevision || batch.scriptRevision !== scriptRevision || draft.revision !== scriptRevision) reject(409, '剧本或提取草稿已变化，请重新提取或刷新核对；已有资源不变。');
    if (!batch.candidates.length || !Array.isArray(selections) || selections.length !== batch.candidates.length) reject(400, '请逐项核对提取草稿，不需要的项选择忽略。');
    const kept = new Set(batch.candidates.map(item => item.occurrenceId));
    // 模型漏掉的旧位置已标待核对；本轮从草稿删掉的旧位置，到确认时才移除关联。
    for (const row of batch.occurrences) if (!row.ignored && !row.needs_review && !kept.has(row.id)) database.prepare('UPDATE episode_occurrences SET character_id = NULL, scene_id = NULL, ignored = 1, revision = revision + 1 WHERE id = ? AND episode_id = ?').run(row.id, episodeId);
    const created = new Map();
    batch.candidates.forEach((candidate, index) => {
      const selection = selections[index];
      const chosenMode = mode(candidate.kind, selection.mode);
      const id = selectResource(database, projectId, candidate.kind, selection, created);
      const details = text(selection.details, 1000);
      const start = locate(draft.script, candidate.quote, candidate.sceneHeading);
      const characterId = candidate.kind === 'character' ? id : null;
      const sceneId = candidate.kind === 'scene' ? id : null;
      const values = [characterId, sceneId, candidate.name, candidate.sceneHeading, candidate.quote, start, chosenMode, details, scriptRevision, selection.action === 'ignore' ? 1 : 0];
      if (candidate.occurrenceId) {
        const result = database.prepare(`UPDATE episode_occurrences SET character_id = ?, scene_id = ?, source_name = ?, scene_heading = ?, quote = ?, source_start = ?, mode = ?, details = ?,
          script_revision = ?, ignored = ?, needs_review = 0, revision = revision + 1 WHERE id = ? AND episode_id = ? AND kind = ?`).run(...values, candidate.occurrenceId, episodeId, candidate.kind);
        if (result.changes !== 1) reject(409, '原出场记录已变化，请刷新核对；本次确认未保存。');
      } else {
        database.prepare(`INSERT INTO episode_occurrences (episode_id, kind, character_id, scene_id, source_name, scene_heading, quote, source_start, mode, details, script_revision, ignored)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(episode_id, kind, source_name, quote) DO UPDATE SET character_id = excluded.character_id, scene_id = excluded.scene_id,
          scene_heading = excluded.scene_heading, source_start = excluded.source_start, mode = excluded.mode, details = excluded.details,
          script_revision = excluded.script_revision, ignored = excluded.ignored, needs_review = 0, revision = episode_occurrences.revision + 1`).run(episodeId, candidate.kind, ...values);
      }
    });
    database.prepare("UPDATE episode_extractions SET candidates = '[]', revision = revision + 1 WHERE episode_id = ?").run(episodeId);
    return { message: '本集关联已保存；已有资源档案未修改，其他集记录不变。', redirect: `/projects/${projectId}?view=episode&episode=${episodeId}#episode-resources` };
  });
}
export function removeEpisodeResources(database, projectId, episodeId, form) {
  findEpisode(database, projectId, episodeId); assertEpisodeScriptsIdle(database, [episodeId]);
  if (form.getAll('confirmed').length !== 1 || form.get('confirmed') !== 'yes') reject(400, '请先确认只删除本集提取项／关联，不删除共享档案。');
  const batchRevision = number(form, 'batchRevision', true); const scriptRevision = number(form, 'scriptRevision', true);
  let targets;
  if (form.getAll('targets').length !== 1) reject(400, '删除范围无效。');
  try { targets = JSON.parse(form.get('targets')); } catch { reject(400, '删除范围无效。'); }
  if (!targets || !['candidates', 'occurrences'].includes(targets.type) || !Array.isArray(targets.items) || !targets.items.length || targets.items.length > 200) reject(400, '请选择本集要删除的项，单次最多 200 处。');
  return inTransaction(database, () => {
    const batch = readEpisodeResources(database, episodeId);
    if (batch.revision !== batchRevision || readEpisodeScript(database, episodeId).revision !== scriptRevision) reject(409, '剧本或提取结果已变化，请刷新核对后再删除。');
    const seen = new Set();
    for (const item of targets.items) {
      const index = targets.type === 'candidates' ? item : item?.id;
      if (!Number.isSafeInteger(index) || index < (targets.type === 'candidates' ? 0 : 1) || seen.has(index)) reject(400, '删除编号无效或重复。');
      seen.add(index);
      if (targets.type === 'candidates') {
        if (!batch.candidates[index]) reject(409, '提取项已变化，请刷新核对。');
      } else {
        const row = batch.occurrences.find(row => row.id === index);
        if (!row) reject(404, '出场记录不存在或不属于本集。');
        if (!Number.isSafeInteger(item.revision) || item.revision !== row.revision) reject(409, '出场记录已变化，本次删除未保存。');
        database.prepare('UPDATE episode_occurrences SET character_id = NULL, scene_id = NULL, ignored = 1, needs_review = 0, revision = revision + 1 WHERE id = ? AND episode_id = ?').run(index, episodeId);
      }
    }
    const remaining = targets.type === 'candidates' ? batch.candidates.filter((item, index) => !seen.has(index)) : batch.candidates.filter(item => !seen.has(item.occurrenceId));
    database.prepare('UPDATE episode_extractions SET candidates = ?, revision = revision + 1 WHERE episode_id = ?').run(JSON.stringify(enrich(database, projectId, episodeId, remaining)), episodeId);
    return { message: '已删除本集提取项／关联，共享档案与其他集不变。', redirect: `/projects/${projectId}?view=episode&episode=${episodeId}#episode-resources` };
  });
}

export function updateEpisodeOccurrence(database, projectId, episodeId, occurrenceId, form) {
  findEpisode(database, projectId, episodeId); assertEpisodeScriptsIdle(database, [episodeId]);
  const revision = number(form, 'revision'); const scriptRevision = number(form, 'scriptRevision');
  let selection;
  if (form.getAll('selection').length !== 1) reject(400, '关联修改格式无效。');
  try { selection = JSON.parse(form.get('selection')); } catch { reject(400, '关联修改格式无效。'); }
  return inTransaction(database, () => {
    const row = database.prepare('SELECT * FROM episode_occurrences WHERE id = ? AND episode_id = ?').get(occurrenceId, episodeId);
    if (!row) reject(404, '出场记录不存在。');
    const draft = readEpisodeScript(database, episodeId);
    if (row.revision !== revision || draft.revision !== scriptRevision) reject(409, '剧本或出场记录已变化，请保留输入并刷新核对。');
    const id = selectResource(database, projectId, row.kind, selection, new Map());
    const ignored = selection.action === 'ignore';
    const heading = ignored ? row.scene_heading : text(selection.sceneHeading, 300);
    const quote = ignored ? row.quote : text(selection.quote, 1000, true);
    const start = ignored ? row.source_start : locate(draft.script, quote, heading);
    database.prepare(`UPDATE episode_occurrences SET character_id = ?, scene_id = ?, scene_heading = ?, quote = ?, source_start = ?, mode = ?, details = ?,
      script_revision = ?, ignored = ?, needs_review = 0, revision = revision + 1 WHERE id = ?`).run(row.kind === 'character' ? id : null, row.kind === 'scene' ? id : null,
      heading, quote, start, mode(row.kind, selection.mode), text(selection.details, 1000), ignored ? row.script_revision : scriptRevision, ignored ? 1 : 0, occurrenceId);
    const batch = readEpisodeResources(database, episodeId);
    const candidates = batch.candidates.filter(item => !ignored || item.occurrenceId !== occurrenceId).map(item => item.occurrenceId === occurrenceId
      ? { ...item, sceneHeading: heading, quote, sourceStart: start, mode: selection.mode, details: selection.details } : item);
    database.prepare('UPDATE episode_extractions SET revision = revision + 1, candidates = ? WHERE episode_id = ?').run(JSON.stringify(enrich(database, projectId, episodeId, candidates)), episodeId);
    return { message: '出场记录已更新，资源档案和其他集记录不变。', redirect: `/projects/${projectId}?view=episode&episode=${episodeId}#occurrence-${occurrenceId}` };
  });
}
