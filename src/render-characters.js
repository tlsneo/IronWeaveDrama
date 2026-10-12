import { readFile } from 'node:fs/promises';
import { characterFields, findCharacter } from './characters.js';
import { escapeHtml, deleteButton } from './html.js';
import { baseCharacterBoard } from '../prompts/character/base-board.js';
import { characterRevision, characterBoardUrl, readCharacterReference } from './character-images.js';
import { renderResourceAppearances } from './render-episode-resources.js';
import { renderImageDialog } from './render-image-dialog.js';

function renderField(field, character) {
  const value = escapeHtml(String(character[field.column] ?? ''));
  const attributes = `id="character-${field.key}" name="${field.key}"`;
  const control = field.multiline
    ? `<textarea ${attributes} maxlength="${field.max}" rows="3">${value}</textarea>`
    : `<input ${attributes} type="${field.type ?? 'text'}" value="${value}" ${field.type === 'number' ? `min="0" max="${Number.MAX_SAFE_INTEGER}" step="1"` : `maxlength="${field.max}"`} ${field.key === 'name' ? 'required' : ''}>`;
  return `<div class="form-field ${field.multiline || field.key === 'name' ? 'field-wide' : ''}"><label for="character-${field.key}">${field.label}</label>${control}</div>`;
}

export async function renderCharacters(database, projectId, project, query) {
  const base = `/projects/${projectId}?resource=characters`;
  if (query.has('character')) {
    const raw = query.get('character');
    const id = Number(raw);
    if (query.getAll('character').length !== 1 || !/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(id)) throw Object.assign(new Error('角色不存在'), { status: 404 });
    const character = findCharacter(database, projectId, id);
    const groups = [...new Set(characterFields.map(field => field.group))];
    const revision = characterRevision(character, project.style);
    const board = database.prepare('SELECT id, revision, reference_id FROM character_boards WHERE character_id = ? AND valid = 1 AND cleared = 0 ORDER BY id DESC LIMIT 1').get(id);
    const latest = database.prepare('SELECT id, valid, width, height FROM character_boards WHERE character_id = ? AND cleared = 0 ORDER BY id DESC LIMIT 1').get(id);
    const reference = readCharacterReference(database, id);
    const apiType = reference ? 'image_to_image' : 'text_to_image';
    const apiName = reference ? '图生图' : '文生图';
    const referenceUrl = reference ? `/projects/${projectId}/characters/${id}/references/${reference.id}` : '';
    const configs = database.prepare('SELECT id, name, model, base_url AS baseUrl FROM api_configs WHERE type = ? ORDER BY id').all(apiType);
    const editConfigs = database.prepare("SELECT id, name, model, base_url AS baseUrl FROM api_configs WHERE type = 'image_edit' ORDER BY id").all();
    const adult = Number.isSafeInteger(character.age) && character.age >= 18;
    const content = `<div class="character-editor">
      <form id="character-form" data-url="/projects/${projectId}/characters/${id}" aria-label="角色基础外观">
        <div class="character-edit-toolbar"><a class="episode-back" href="${base}">← 角色库</a><div class="item-actions"><button class="create-button" type="submit">保存资料</button>${deleteButton(`/projects/${projectId}/characters/${id}/delete`, character.name, `确定删除角色“${character.name}”？角色资料及全部图片将一并删除，无法恢复。`)}</div></div>
        <p id="character-error" class="form-error" role="alert"></p>
        ${groups.map(group => `<fieldset class="character-fieldset"><legend>${group}</legend><div class="character-fields">${characterFields.filter(field => field.group === group).map(field => renderField(field, character)).join('')}</div></fieldset>`).join('')}
      </form>
      <aside class="character-preview" aria-label="基础角色板预览">
        <div class="character-preview-heading"><h3>基础角色板</h3><span>${baseCharacterBoard.aspectRatio}</span></div>
        <a id="character-board-link" ${latest ? `href="${characterBoardUrl(projectId, id, latest.id)}"` : 'hidden'} target="_blank" rel="noopener"><img id="character-board-image" class="character-board-image" ${latest ? `src="${characterBoardUrl(projectId, id, latest.id)}"` : ''} alt="${escapeHtml(character.name)}的基础角色板生成结果"></a>
        <div id="character-board-empty" class="character-board-empty" ${latest ? 'hidden' : ''}><span aria-hidden="true">${escapeHtml([...character.name][0])}</span><p>尚未生成角色板</p></div>
        <p id="character-board-note" class="field-help" role="status">${latest && !latest.valid ? `上方为本次未通过的生成结果（${latest.width} × ${latest.height}），未替换原角色板。` : ''}</p>
        <form id="character-generation-form" class="character-generation" data-url="/projects/${projectId}/characters/${id}/generate" data-revision="${revision}" data-adult="${adult}" data-board-id="${latest?.id ?? ''}" data-reference-id="${reference?.id ?? ''}" data-reference-url="/projects/${projectId}/characters/${id}/reference-image" data-api-name="${apiName}">
          <div class="character-reference">
            ${reference ? `<a href="${referenceUrl}" target="_blank" rel="noopener"><img class="character-reference-image" src="${referenceUrl}" alt="${escapeHtml(character.name)}的身份参考图"></a>` : ''}
            <div><span class="character-reference-label">身份参考图</span><div class="character-image-actions">
              <input id="character-reference-file" type="file" accept="image/png,image/jpeg,image/webp" hidden aria-label="上传角色身份参考图">
              <button id="upload-character-reference" class="theme-toggle" type="button">${reference ? '替换图片' : '上传图片'}</button>
              <button id="clear-character-reference" class="theme-toggle" type="button" ${reference ? '' : 'disabled'}>移除参考图</button>
            </div></div>
          </div>
          <div class="form-field"><label for="character-image-api">${apiName} API</label><select id="character-image-api" name="apiConfigId" required>${configs.length !== 1 ? `<option value="">选择${apiName}配置</option>` : ''}${configs.map(config => `<option value="${config.id}" data-model="${escapeHtml(config.model)}" data-base-url="${escapeHtml(config.baseUrl)}">${escapeHtml(config.name)} · ${escapeHtml(config.model)}</option>`).join('')}</select></div>
          <div class="character-image-actions">
            <button id="generate-character-image" class="create-button" type="button" ${adult && configs.length ? '' : 'disabled'}>生成图片</button>
            <button id="edit-character-image" class="theme-toggle" type="button" aria-controls="character-image-edit-dialog" aria-haspopup="dialog" ${latest ? '' : 'disabled'}>AI修图</button>
            <button id="clear-character-image" class="theme-toggle" type="button" ${latest ? '' : 'disabled'}>清空图像</button>
          </div>
          ${!configs.length ? `<p class="field-help">尚无${apiName}配置，请先到<a href="/settings?type=${apiType}">设置</a>添加。</p>` : ''}
          <p id="character-generation-error" class="form-error" role="alert"></p>
          <p id="character-generation-status" class="field-help" role="status" aria-live="polite">${board && (board.revision !== revision || board.reference_id !== (reference?.id ?? null)) ? '现有图片对应旧资料或参考图；修改后不会自动重新生成。' : ''}</p>
        </form>
      </aside>
    </div>
    ${renderResourceAppearances(database, projectId, 'character', id, query)}
    ${renderImageDialog(editConfigs)}`;
    return { title: character.name, description: '全剧共用 · 只记录人物本身的外观，服饰、配饰、鞋履、武器与道具单独制作。', actions: '', content };
  }

  const search = (query.get('q') ?? '').trim();
  const rawPage = query.get('page') ?? '1';
  if (search.length > 80 || query.getAll('q').length > 1 || query.getAll('page').length > 1 || !/^[1-9]\d*$/.test(rawPage) || !Number.isSafeInteger(Number(rawPage))) {
    throw Object.assign(new Error('搜索名称最多 80 字，页码必须为正整数。'), { status: 400 });
  }
  const total = database.prepare('SELECT count(*) AS count FROM characters WHERE project_id = ? AND instr(lower(name), lower(?)) > 0').get(projectId, search).count;
  const pages = Math.max(1, Math.ceil(total / 50));
  const page = Math.min(Number(rawPage), pages);
  const characters = database.prepare('SELECT id, name, age, gender_presentation, (SELECT id FROM character_boards WHERE character_id = characters.id AND valid = 1 AND cleared = 0 ORDER BY id DESC LIMIT 1) AS board_id FROM characters WHERE project_id = ? AND instr(lower(name), lower(?)) > 0 ORDER BY id DESC LIMIT 50 OFFSET ?').all(projectId, search, (page - 1) * 50);
  const actions = `<button class="create-button" type="button" data-name-dialog data-url="/projects/${projectId}/characters" data-title="创建角色" data-name="" data-season-id="">＋ 创建角色</button>`;
  const searchForm = `<div class="character-list-toolbar"><form class="character-search" action="/projects/${projectId}" method="get">
    <input type="hidden" name="resource" value="characters">
    <label class="visually-hidden" for="character-search">搜索角色名称</label>
    <input id="character-search" name="q" type="search" value="${escapeHtml(search)}" maxlength="80" placeholder="搜索角色名称">
    <button class="theme-toggle" type="submit">搜索</button>
    ${search ? `<a class="clear-search" href="${base}">清除</a>` : ''}
  </form><span class="character-total">共 ${total} 个角色</span></div>`;
  let list;
  if (characters.length) {
    list = `<div class="project-grid character-grid">${characters.map(character => `<article class="project-card character-card">
      <a class="project-link" href="${base}&amp;character=${character.id}">
        <div class="project-cover character-cover" aria-hidden="true">${character.board_id ? `<img src="${characterBoardUrl(projectId, character.id, character.board_id)}" alt="">` : `<span>${escapeHtml([...character.name][0])}</span>`}</div>
        <div class="project-details"><h3>${escapeHtml(character.name)}</h3>
          <p class="character-card-info">${escapeHtml([character.age === null ? '' : `${character.age} 岁`, character.gender_presentation].filter(Boolean).join(' · ') || '外观资料待完善')}</p>
          <span class="character-status">${character.board_id ? '角色板已生成 · 待检查' : '未生成角色板'}</span>
        </div>
      </a>
      <div class="card-actions">${deleteButton(`/projects/${projectId}/characters/${character.id}/delete`, character.name, `确定删除角色“${character.name}”？角色资料及全部图片将一并删除，无法恢复。`)}</div>
    </article>`).join('')}</div>`;
  } else if (search) {
    list = '<section class="studio-empty"><h3>没有匹配的角色</h3><p>可以更换名称搜索，或清除筛选。</p></section>';
  } else {
    list = (await readFile(new URL('../views/resource-empty.html', import.meta.url), 'utf8')).replaceAll('<!-- RESOURCE_NAME -->', '角色');
  }
  const pageLink = number => escapeHtml(`/projects/${projectId}?${new URLSearchParams({ resource: 'characters', q: search, page: String(number) })}`);
  const pagination = pages > 1 ? `<nav class="character-pagination" aria-label="角色分页">
    ${page > 1 ? `<a href="${pageLink(page - 1)}">← 上一页</a>` : '<span>← 上一页</span>'}
    <span>第 ${page} / ${pages} 页 · 每页 50 条</span>
    ${page < pages ? `<a href="${pageLink(page + 1)}">下一页 →</a>` : '<span>下一页 →</span>'}
  </nav>` : '';
  return { title: '角色', description: '管理这部短剧的基础角色与参考图', actions, content: searchForm + list + pagination };
}
