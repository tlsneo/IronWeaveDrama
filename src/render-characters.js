import { readFile } from 'node:fs/promises';
import { characterFields, findCharacter } from './characters.js';
import { escapeHtml, deleteButton } from './html.js';
import { baseCharacterBoard } from '../prompts/character/base-board.js';
import { characterRevision, characterBoardUrl } from './character-images.js';

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
    const board = database.prepare('SELECT id, revision FROM character_boards WHERE character_id = ? AND valid = 1 AND cleared = 0 ORDER BY id DESC LIMIT 1').get(id);
    const latest = database.prepare('SELECT id, valid, width, height FROM character_boards WHERE character_id = ? AND cleared = 0 ORDER BY id DESC LIMIT 1').get(id);
    const configs = database.prepare("SELECT id, name, model, base_url AS baseUrl FROM api_configs WHERE type = 'text_to_image' ORDER BY id").all();
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
        <form id="character-generation-form" class="character-generation" data-url="/projects/${projectId}/characters/${id}/generate" data-revision="${revision}" data-adult="${adult}" data-board-id="${latest?.id ?? ''}">
          <div class="form-field"><label for="character-image-api">文生图 API</label><select id="character-image-api" name="apiConfigId" required>${configs.length !== 1 ? '<option value="">选择文生图配置</option>' : ''}${configs.map(config => `<option value="${config.id}" data-model="${escapeHtml(config.model)}" data-base-url="${escapeHtml(config.baseUrl)}">${escapeHtml(config.name)} · ${escapeHtml(config.model)}</option>`).join('')}</select></div>
          <div class="character-image-actions">
            <button id="generate-character-image" class="create-button" type="button" ${adult && configs.length ? '' : 'disabled'}>生成图片</button>
            <button id="edit-character-image" class="theme-toggle" type="button" aria-controls="character-image-edit-dialog" aria-haspopup="dialog" ${latest ? '' : 'disabled'}>AI修图</button>
            <button id="clear-character-image" class="theme-toggle" type="button" ${latest ? '' : 'disabled'}>清空图像</button>
          </div>
          ${!configs.length ? '<p class="field-help">尚无文生图配置，请先到<a href="/settings">设置</a>添加。</p>' : ''}
          <p id="character-generation-error" class="form-error" role="alert"></p>
          <p id="character-generation-status" class="field-help" role="status" aria-live="polite">${board && board.revision !== revision ? '现有图片对应旧资料；修改后的资料不会自动重新生成。' : ''}</p>
        </form>
      </aside>
    </div>
    <dialog id="character-image-edit-dialog" class="project-dialog image-edit-dialog" aria-labelledby="image-edit-title">
      <div class="image-edit-heading"><h2 id="image-edit-title">AI修图</h2><button id="image-edit-close" class="theme-toggle" type="button">关闭</button></div>
      <p id="image-edit-error" class="form-error" role="alert"></p>
      <div class="image-edit-layout">
        <section aria-label="遮罩绘制区">
          <div class="image-edit-tools">
            <button class="theme-toggle" type="button" data-mask-tool="paint" aria-pressed="true">画笔</button>
            <button class="theme-toggle" type="button" data-mask-tool="erase" aria-pressed="false">橡皮擦</button>
            <button class="theme-toggle" type="button" data-mask-tool="pan" aria-pressed="false">平移</button>
            <label>笔刷 <input id="image-edit-brush" type="range" min="2" max="160" value="36"><span id="image-edit-brush-value">36</span></label>
            <button id="image-edit-undo" class="theme-toggle" type="button" disabled>撤销</button>
            <button id="image-edit-redo" class="theme-toggle" type="button" disabled>重做</button>
            <button id="image-edit-clear" class="theme-toggle" type="button" disabled>清空选区</button>
          </div>
          <div id="image-edit-stage" class="image-edit-stage" data-tool="paint" tabindex="0" role="group" aria-label="原图和遮罩画布" aria-describedby="image-edit-keyboard-help">
            <img id="image-edit-source" alt="修图原图" draggable="false">
            <canvas id="image-edit-overlay" aria-label="独立遮罩选区，不修改原图"></canvas>
            <span id="image-edit-cursor" class="image-edit-cursor" hidden></span>
          </div>
          <p id="image-edit-keyboard-help" class="visually-hidden">方向键移动画笔定位点，空格涂抹或擦除；平移模式下方向键移动画面，加减键缩放。</p>
          <div class="image-edit-tools image-edit-view-tools">
            <button id="image-edit-zoom-out" class="theme-toggle" type="button" aria-label="缩小">−</button><span id="image-edit-zoom-value">100%</span>
            <button id="image-edit-zoom-in" class="theme-toggle" type="button" aria-label="放大">＋</button>
            <button id="image-edit-fit" class="theme-toggle" type="button">适合窗口</button>
            <button id="image-edit-export" class="theme-toggle" type="button" disabled>下载遮罩</button>
          </div>
          <p id="image-edit-selection" class="field-help" role="status" aria-live="polite">原图加载中…</p>
        </section>
        <aside>
          <div class="form-field"><label for="character-edit-api">编辑图片 API</label><select id="character-edit-api">${editConfigs.length !== 1 ? '<option value="">选择编辑图片配置</option>' : ''}${editConfigs.map(config => `<option value="${config.id}">${escapeHtml(config.name)} · ${escapeHtml(config.model)}</option>`).join('')}</select></div>
          <div class="form-field"><label for="character-edit-instruction">修改要求</label><textarea id="character-edit-instruction" maxlength="2000" rows="7"></textarea></div>
          <button id="submit-character-edit" class="create-button" type="button" disabled aria-describedby="image-edit-unavailable">开始修图</button>
          <p id="image-edit-unavailable" class="field-help">遮罩接口待接入，当前不会调用模型。</p>
        </aside>
      </div>
    </dialog>`;
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
