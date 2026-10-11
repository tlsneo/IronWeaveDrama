import { escapeHtml, deleteButton } from './html.js';
import { renderResourceAppearances } from './render-episode-resources.js';

function reject(status, message) { throw Object.assign(new Error(message), { status }); }
export function findScene(database, projectId, id) {
  const scene = database.prepare('SELECT * FROM scenes WHERE id = ? AND project_id = ?').get(id, projectId);
  if (!scene) reject(404, '场景不存在');
  return scene;
}
export function saveScene(database, projectId, id, form) {
  if (!database.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)) reject(404, '剧集项目不存在');
  if (id) findScene(database, projectId, id);
  const fields = id ? { name: 80, description: 1000 } : { name: 80 };
  const values = Object.entries(fields).map(([key, max]) => {
    const value = form.get(key);
    if (form.getAll(key).length !== 1 || typeof value !== 'string' || value.includes('\0') || value.length > max || (key === 'name' && !value.trim())) reject(400, '场景名称不能为空且最多 80 字，环境描述最多 1000 字，字段不能缺失或重复。');
    return value.trim();
  });
  if (id) database.prepare('UPDATE scenes SET name = ?, description = ? WHERE id = ? AND project_id = ?').run(...values, id, projectId);
  else id = Number(database.prepare('INSERT INTO scenes (project_id, name) VALUES (?, ?)').run(projectId, values[0]).lastInsertRowid);
  return { id, redirect: `/projects/${projectId}?resource=scenes${values.length > 1 ? `&scene=${id}` : ''}` };
}
export function renderScenes(database, projectId, query) {
  const base = `/projects/${projectId}?resource=scenes`;
  if (query.has('scene')) {
    const raw = query.get('scene'); const id = Number(raw);
    if (query.getAll('scene').length !== 1 || !/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(id)) reject(404, '场景不存在');
    const scene = findScene(database, projectId, id);
    return { title: scene.name, description: '全剧共享场景 · 同一地点可用于多集，本场时间与光照记录在出场关联中。', actions: '', content: `<form id="scene-form" class="creation-panel" data-url="/projects/${projectId}/scenes/${id}">
      <div class="character-edit-toolbar"><a class="episode-back" href="${base}">← 场景库</a><div class="item-actions"><button class="create-button" type="submit">保存资料</button>${deleteButton(`/projects/${projectId}/scenes/${id}/delete`, scene.name, `确定删除场景“${scene.name}”？场景资料将删除，出场记录将解除关联，无法恢复。`)}</div></div>
      <p id="scene-error" class="form-error" role="alert"></p>
      <div class="form-field"><label for="scene-name">场景名称</label><input id="scene-name" name="name" maxlength="80" required value="${escapeHtml(scene.name)}"></div>
      <div class="form-field"><label for="scene-description">固定环境描述</label><textarea id="scene-description" name="description" maxlength="1000" rows="6">${escapeHtml(scene.description)}</textarea></div>
      <p class="field-help">场景图片生成尚未接入。提取只关联已有场景，不会修改这里的档案。</p>
    </form>${renderResourceAppearances(database, projectId, 'scene', id, query)}` };
  }
  const search = (query.get('q') ?? '').trim(); const rawPage = query.get('page') ?? '1';
  if (search.length > 80 || query.getAll('q').length > 1 || query.getAll('page').length > 1 || !/^[1-9]\d*$/.test(rawPage) || !Number.isSafeInteger(Number(rawPage))) reject(400, '搜索名称最多 80 字，页码必须为正整数。');
  const count = database.prepare('SELECT count(*) AS count FROM scenes WHERE project_id = ? AND instr(lower(name), lower(?)) > 0').get(projectId, search).count;
  const pages = Math.max(1, Math.ceil(count / 50)); const page = Math.min(Number(rawPage), pages);
  const scenes = database.prepare('SELECT * FROM scenes WHERE project_id = ? AND instr(lower(name), lower(?)) > 0 ORDER BY id DESC LIMIT 50 OFFSET ?').all(projectId, search, (page - 1) * 50);
  const searchForm = `<div class="character-list-toolbar"><form class="character-search" action="/projects/${projectId}" method="get"><input type="hidden" name="resource" value="scenes"><label class="visually-hidden" for="scene-search">搜索场景名称</label><input id="scene-search" name="q" type="search" maxlength="80" value="${escapeHtml(search)}" placeholder="搜索场景名称"><button class="theme-toggle" type="submit">搜索</button>${search ? `<a class="clear-search" href="${base}">清除</a>` : ''}</form><span class="character-total">共 ${count} 个场景</span></div>`;
  const list = scenes.length ? `<div class="project-grid">${scenes.map(scene => `<article class="project-card"><a class="project-link" href="${base}&scene=${scene.id}"><div class="project-details"><h3>${escapeHtml(scene.name)}</h3><p class="character-card-info">${escapeHtml(scene.description || '环境资料待完善')}</p></div></a><div class="card-actions">${deleteButton(`/projects/${projectId}/scenes/${scene.id}/delete`, scene.name, `确定删除场景“${scene.name}”？场景资料将删除，出场记录将解除关联，无法恢复。`)}</div></article>`).join('')}</div>` : `<section class="studio-empty"><h3>${search ? '没有匹配的场景' : '还没有场景资源'}</h3><p>${search ? '可以更换名称搜索，或清除筛选。' : '可以从本集剧本提取并确认场景，也可以手动创建。'}</p></section>`;
  const pageLink = number => escapeHtml(`/projects/${projectId}?${new URLSearchParams({ resource: 'scenes', q: search, page: String(number) })}`);
  const pagination = pages > 1 ? `<nav class="character-pagination" aria-label="场景分页">${page > 1 ? `<a href="${pageLink(page - 1)}">← 上一页</a>` : '<span>← 上一页</span>'}<span>第 ${page} / ${pages} 页 · 每页 50 条</span>${page < pages ? `<a href="${pageLink(page + 1)}">下一页 →</a>` : '<span>下一页 →</span>'}</nav>` : '';
  return { title: '场景', description: '全剧共享 · 按地点管理场景资料与各集使用位置。', actions: `<button class="create-button" type="button" data-name-dialog data-url="/projects/${projectId}/scenes" data-title="创建场景" data-name="" data-season-id="">＋ 创建场景</button>`, content: searchForm + list + pagination };
}
