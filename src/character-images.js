import { createHash } from 'node:crypto';
import { characterFields, findCharacter } from './characters.js';
import { readApiConfig } from './settings.js';
import { callModel, readImageResult } from './model-client.js';
import { loadImage, imageDetails } from './images.js';
import { baseCharacterBoard } from '../prompts/character/base-board.js';

const generating = new WeakMap();
function reject(status, message) { throw Object.assign(new Error(message), { status }); }

export function assertCharacterImagesIdle(database, ids) {
  if (ids.some(id => generating.get(database)?.has(id))) reject(409, '角色正在生成或修图，请等待完成后再删除。');
}

export function characterRevision(character, style) {
  return createHash('sha256').update(JSON.stringify([style, ...characterFields.map(field => character[field.column])])).digest('hex');
}

export function characterBoardUrl(projectId, characterId, boardId) {
  return `/projects/${projectId}/characters/${characterId}/boards/${boardId}`;
}

export function clearCharacterBoard(database, projectId, characterId, form) {
  findCharacter(database, projectId, characterId);
  if (generating.get(database)?.has(characterId)) reject(409, '正在生成或修图，请等待完成后再清空。');
  const board = readCurrentBoard(database, characterId, form);
  database.prepare('UPDATE character_boards SET cleared = 1 WHERE character_id = ? AND cleared = 0').run(characterId);
  return { cleared: true, boardId: board.id };
}

function readCurrentBoard(database, characterId, form) {
  const board = database.prepare('SELECT * FROM character_boards WHERE character_id = ? AND cleared = 0 ORDER BY id DESC LIMIT 1').get(characterId);
  if (!board) reject(400, '当前没有可操作的图片。');
  if (form.getAll('boardId').length !== 1 || form.get('boardId') !== String(board.id)) reject(409, '角色图片已变化，请刷新后重试。');
  return board;
}

export async function generateCharacterBoard(database, projectId, characterId, form) {
  const character = findCharacter(database, projectId, characterId);
  const project = database.prepare('SELECT style FROM projects WHERE id = ?').get(projectId);
  if (!Number.isSafeInteger(character.age) || character.age < 18) reject(400, '基础角色板模板仅适用于明确年满 18 岁的角色，请先确认并保存真实年龄。');
  if (['apiConfigId', 'chargeConfirmed', 'revision', 'model', 'baseUrl'].some(key => form.getAll(key).length !== 1)) reject(400, '生成参数缺失或重复，请刷新页面后重试。');
  if (form.get('chargeConfirmed') !== 'yes') reject(400, '生成图片可能计费，请确认后再生成。');
  const configId = Number(form.get('apiConfigId'));
  if (!/^[1-9]\d*$/.test(form.get('apiConfigId')) || !Number.isSafeInteger(configId)) reject(400, '请选择已保存的文生图配置。');
  const config = readApiConfig(database, configId);
  if (config.type !== 'text_to_image' || !config.apiKey) reject(400, '请选择已保存密钥的文生图配置。');
  if (config.model !== form.get('model') || config.baseUrl !== form.get('baseUrl')) reject(409, 'API 配置已变化，请刷新后重新确认生成。');
  const revision = characterRevision(character, project.style);
  if (revision !== form.get('revision')) reject(409, '角色资料已变化，请先保存并刷新后再生成。');
  const active = generating.get(database) ?? new Set();
  generating.set(database, active);
  if (active.has(characterId)) reject(409, '这个角色正在生成图片，请等待完成，不要重复扣费。');
  active.add(characterId);
  try {
    const identity = Object.fromEntries(characterFields.filter(field => character[field.column] !== null && character[field.column] !== '').map(field => [field.label, character[field.column]]));
    const prompt = `MANDATORY ART STYLE / 画风: ${project.style}\nApply the style only to rendering, line quality and surface treatment. Do not import costumes, scenery, props or dramatic lighting from style conventions.\n\nADULT CHARACTER IDENTITY / 成年角色基础外观:\n${JSON.stringify(identity, null, 2)}\n\n${baseCharacterBoard.prompt}`;
    const response = await callModel(config, '/images/generations', { model: config.model, prompt, n: 1, size: '2560x1440' });
    const source = readImageResult(config, response);
    const bytes = await loadImage(source, config.baseUrl);
    const { mime, width, height } = imageDetails(bytes);
    const current = findCharacter(database, projectId, characterId);
    const currentStyle = database.prepare('SELECT style FROM projects WHERE id = ?').get(projectId).style;
    const unchanged = characterRevision(current, currentStyle) === revision;
    const valid = width * 9 === height * 16 && unchanged;
    let id;
    try {
      id = Number(database.prepare('INSERT INTO character_boards (character_id, image, mime, width, height, valid, revision, model, prompt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(characterId, bytes, mime, width, height, Number(valid), revision, config.model, prompt).lastInsertRowid);
    } catch {
      throw Object.assign(new Error('图片已生成但未能保存，原角色板不变。请下载本次图片，避免丢失付费结果。'), { status: 502, recoveryImage: `data:${mime};base64,${bytes.toString('base64')}` });
    }
    return {
      valid, imageUrl: characterBoardUrl(projectId, characterId, id), width, height,
      message: valid ? '基础角色板已生成并保存，请检查四视图及人物一致性。'
        : !unchanged ? '生成期间角色资料发生变化；本次图片已保存供查看，但未替换原角色板。'
          : `接口返回 ${width} × ${height}，不符合固定 16:9；本次图片已保存供查看，但未替换原角色板。`,
    };
  } finally { active.delete(characterId); }
}
