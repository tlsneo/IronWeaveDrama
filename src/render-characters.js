import { readFile } from 'node:fs/promises';
import { characterFields, findCharacter } from './characters.js';
import { escapeHtml } from './html.js';
import { baseCharacterBoard } from '../prompts/character/base-board.js';

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
    const content = `<div class="character-editor">
      <form id="character-form" data-url="/projects/${projectId}/characters/${id}" aria-label="角色基础外观">
        <div class="character-edit-toolbar"><a class="episode-back" href="${base}">← 角色库</a><button class="create-button" type="submit">保存资料</button></div>
        <p id="character-error" class="form-error" role="alert"></p>
        ${groups.map(group => `<fieldset class="character-fieldset"><legend>${group}</legend><div class="character-fields">${characterFields.filter(field => field.group === group).map(field => renderField(field, character)).join('')}</div></fieldset>`).join('')}
      </form>
      <aside class="character-preview" aria-label="基础角色板预览">
        <div class="character-preview-heading"><h3>基础角色板</h3><span>${baseCharacterBoard.aspectRatio}</span></div>
        <div class="character-board-empty"><span aria-hidden="true">${escapeHtml([...character.name][0])}</span><p>尚未生成角色板</p></div>
        <dl class="character-style"><dt>画面风格</dt><dd>${escapeHtml(project.style)}<span>继承项目</span></dd></dl>
        <p class="field-help">资料保存不会调用 AI。参考图上传与生图尚未接入。</p>
        <p class="field-help">这份基础角色板模板仅适用于明确年满 18 岁的角色；其他年龄或年龄未填写时，也可以先保存角色档案。</p>
      </aside>
    </div>`;
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
  const characters = database.prepare('SELECT id, name, age, gender_presentation FROM characters WHERE project_id = ? AND instr(lower(name), lower(?)) > 0 ORDER BY id DESC LIMIT 50 OFFSET ?').all(projectId, search, (page - 1) * 50);
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
        <div class="project-cover character-cover" aria-hidden="true"><span>${escapeHtml([...character.name][0])}</span></div>
        <div class="project-details"><h3>${escapeHtml(character.name)}</h3>
          <p class="character-card-info">${escapeHtml([character.age === null ? '' : `${character.age} 岁`, character.gender_presentation].filter(Boolean).join(' · ') || '外观资料待完善')}</p>
          <span class="character-status">未生成角色板</span>
        </div>
      </a>
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
