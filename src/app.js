import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { inTransaction } from './database.js';
import { changeCreation } from './creation.js';
import { renderCreation } from './render-creation.js';
import { escapeHtml } from './html.js';

const resourceTypes = new Map([
  ['characters', { name: '角色', description: '管理这部短剧的基础角色与参考图' }],
  ['scenes', { name: '场景', description: '管理这部短剧的拍摄环境与场景参考图' }],
  ['props', { name: '道具', description: '管理这部短剧使用的物品与道具参考图' }],
  ['costumes', { name: '服饰', description: '服饰单独制作，与基础角色分开管理' }],
]);
const assets = new Map();
for (const [path, type] of [
  ['/styles.css', 'text/css'],
  ['/theme.js', 'text/javascript'],
  ['/projects.js', 'text/javascript'],
  ['/studio.js', 'text/javascript'],
]) {
  assets.set(path, { type, file: new URL(`../public${path}`, import.meta.url) });
}

async function readForm(request) {
  const reject = (status, message) => {
    request.resume();
    throw Object.assign(new Error(message), { status });
  };
  const origin = request.headers.origin;
  if (request.headers['sec-fetch-site'] === 'cross-site' ||
      (origin && origin !== `http://${request.headers.host}` && origin !== `https://${request.headers.host}`)) reject(403, '不允许从其他网站提交。');
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/x-www-form-urlencoded') reject(415, '不支持的提交格式。');
  let size = 0;
  const chunks = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 8192) reject(413, '提交内容过大。');
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

async function renderLibrary(projects) {
  if (!projects.length) return readFile(new URL('../views/library-empty.html', import.meta.url), 'utf8');
  return `<section class="project-grid" aria-label="短剧项目">${projects.map(project => `
    <article class="project-card">
      <a class="project-link" href="/projects/${project.id}">
        <div class="project-cover" aria-hidden="true"><span>${escapeHtml([...project.name][0])}</span></div>
        <div class="project-details">
          <p class="project-kind">整部短剧</p>
          <h2>${escapeHtml(project.name)}</h2>
          <div class="project-meta"><span>${escapeHtml(project.style)}</span><span>${escapeHtml(project.aspectRatio)}</span></div>
        </div>
      </a>
    </article>`).join('')}</section>`;
}

export function createApp(database) {
  const listProjects = database.prepare('SELECT id, name, style, aspect_ratio AS aspectRatio FROM projects ORDER BY id DESC');
  const insertProject = database.prepare('INSERT INTO projects (name, style, aspect_ratio) VALUES (?, ?, ?)');
  const findProject = database.prepare('SELECT name, style, aspect_ratio AS aspectRatio FROM projects WHERE id = ?');
  const server = createServer(async (request, response) => {
    function send(status, type, body, headers = {}) {
      response.writeHead(status, {
        'Content-Type': `${type}; charset=utf-8`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...headers,
      });
      response.end(request.method === 'HEAD' ? undefined : body);
    }
    const json = (status, value) => send(status, 'application/json', JSON.stringify(value));
    const path = request.url.split('?')[0];
    const creationRoute = path.match(/^\/projects\/([1-9]\d*)\/(seasons|episodes)(?:\/([1-9]\d*)(\/move)?)?$/);

    try {
      if (creationRoute && request.method === 'POST') {
        const form = await readForm(request);
        const projectId = Number(creationRoute[1]);
        const id = creationRoute[3] ? Number(creationRoute[3]) : undefined;
        if (!Number.isSafeInteger(projectId) || (id !== undefined && !Number.isSafeInteger(id))) {
          json(404, { error: '季或集不存在' });
          return;
        }
        json(id ? 200 : 201, changeCreation(database, projectId, creationRoute[2], id, creationRoute[4] ? 'move' : 'rename', form));
        return;
      }
      if (path === '/projects' && request.method === 'POST') {
        const form = await readForm(request);
        const name = form.get('name')?.trim() ?? '';
        const style = form.get('style')?.trim() ?? '';
        const aspectRatio = form.get('aspectRatio');
        if (['name', 'style', 'aspectRatio'].some(field => form.getAll(field).length !== 1) ||
            !name || name.length > 80 || !style || style.length > 120 ||
            !['9:16', '16:9', '21:9', '4:3', '3:4', '1:1'].includes(aspectRatio)) {
          json(400, { error: '请填写短剧名称（最多 80 字）、画面风格（最多 120 字），并选择有效的画面比例。' });
          return;
        }
        const id = inTransaction(database, () => {
          const id = Number(insertProject.run(name, style, aspectRatio).lastInsertRowid);
          database.prepare('INSERT INTO seasons (project_id, name, position) VALUES (?, ?, 1)').run(id, '第一季');
          return id;
        });
        json(201, { id, name, style, aspectRatio });
        return;
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        request.resume();
        send(405, 'text/plain', '暂不支持此操作', { Allow: path === '/projects' || creationRoute ? 'POST' : 'GET, HEAD' });
        return;
      }
      if (path === '/') {
        const template = await readFile(new URL('../views/index.html', import.meta.url), 'utf8');
        const library = await renderLibrary(listProjects.all());
        send(200, 'text/html', template.replace('<!-- PROJECT_LIBRARY -->', () => library));
        return;
      }
      const projectRoute = path.match(/^\/projects\/([1-9]\d*)$/);
      if (projectRoute) {
        const id = Number(projectRoute[1]);
        const project = Number.isSafeInteger(id) ? findProject.get(id) : undefined;
        if (!project) {
          send(404, 'text/plain', '短剧项目不存在');
          return;
        }
        const query = new URL(request.url, 'http://localhost').searchParams;
        const view = query.get('view') ?? (query.has('resource') ? 'resources' : 'seasons');
        const resourceType = query.get('resource') ?? 'characters';
        let workspace;
        if (view === 'resources') {
          const resource = resourceTypes.get(resourceType);
          if (!resource) {
            send(404, 'text/plain', '资源分类不存在');
            return;
          }
          const content = await readFile(new URL('../views/resource-empty.html', import.meta.url), 'utf8');
          workspace = { title: resource.name, description: resource.description, actions: '', content: content.replaceAll('<!-- RESOURCE_NAME -->', resource.name) };
        } else if (['scripts', 'seasons', 'episode'].includes(view)) {
          workspace = renderCreation(database, id, view, query);
        } else {
          send(404, 'text/plain', '创作页面不存在');
          return;
        }
        const projectTemplate = await readFile(new URL('../views/project.html', import.meta.url), 'utf8');
        const html = projectTemplate
          .replaceAll('<!-- PROJECT_NAME -->', () => escapeHtml(project.name))
          .replaceAll('<!-- PROJECT_STYLE -->', () => escapeHtml(project.style))
          .replaceAll('<!-- PROJECT_ASPECT_RATIO -->', () => escapeHtml(project.aspectRatio))
          .replaceAll('<!-- WORKSPACE_TITLE -->', () => escapeHtml(workspace.title))
          .replaceAll('<!-- WORKSPACE_DESCRIPTION -->', () => escapeHtml(workspace.description))
          .replaceAll('<!-- WORKSPACE_ACTIONS -->', () => workspace.actions)
          .replaceAll('<!-- WORKSPACE_CONTENT -->', () => workspace.content)
          .replaceAll('<!-- SCRIPTS_CURRENT -->', view === 'scripts' ? 'page' : 'false')
          .replaceAll('<!-- SEASONS_CURRENT -->', ['seasons', 'episode'].includes(view) ? 'page' : 'false')
          .replaceAll(/<!-- (CHARACTERS|SCENES|PROPS|COSTUMES)_CURRENT -->/g, (_match, type) => view === 'resources' && type.toLowerCase() === resourceType ? 'page' : 'false');
        send(200, 'text/html', html);
        return;
      }
      const asset = assets.get(path);
      send(asset ? 200 : 404, asset?.type ?? 'text/plain', asset ? await readFile(asset.file) : '页面不存在');
    } catch (error) {
      if (!error.status) console.error('处理请求失败：', error);
      if (!response.headersSent) json(error.status ?? 500, { error: error.status ? error.message : '暂时无法完成操作，请稍后重试。' });
    }
  });
  server.on('close', () => database.close());
  return server;
}
