import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { inTransaction } from './database.js';
import { changeCreation } from './creation.js';
import { renderCreation, renderCreationNavigation } from './render-creation.js';
import { escapeHtml, deleteButton } from './html.js';
import { saveCharacter, findCharacter } from './characters.js';
import { renderCharacters } from './render-characters.js';
import { saveApiConfig, checkApiConfig } from './settings.js';
import { renderSettings } from './render-settings.js';
import { generateCharacterBoard, clearCharacterBoard, saveCharacterReference, clearCharacterReference } from './character-images.js';
import { deleteItem } from './deletion.js';
import { saveEpisodeScript, generateEpisodeScript } from './episode-scripts.js';
import { extractEpisodeResources, confirmEpisodeResources, updateEpisodeOccurrence, removeEpisodeResources } from './episode-resources.js';
import { saveScene, findScene, renderScenes } from './scenes.js';
import { generateSceneImage, clearSceneImage, saveSceneReference, clearSceneReference } from './scene-images.js';
import { saveEpisodeStoryboards, generateEpisodeStoryboards } from './storyboards.js';

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
  ['/settings.js', 'text/javascript'],
  ['/character-images.js', 'text/javascript'],
  ['/delete.js', 'text/javascript'],
  ['/image-editor.js', 'text/javascript'],
  ['/image-mask.js', 'text/javascript'],
  ['/character-reference.js', 'text/javascript'],
  ['/episode-script.js', 'text/javascript'],
  ['/episode-resources.js', 'text/javascript'],
  ['/storyboards.js', 'text/javascript'],
]) {
  assets.set(path, { type, file: new URL(`../public${path}`, import.meta.url) });
}

async function readForm(request, maxBytes = 8192, allowMultipart = false) {
  const reject = (status, message) => {
    request.resume();
    throw Object.assign(new Error(message), { status });
  };
  const origin = request.headers.origin;
  if (request.headers['sec-fetch-site'] === 'cross-site' ||
      (origin && origin !== `http://${request.headers.host}` && origin !== `https://${request.headers.host}`)) reject(403, '不允许从其他网站提交。');
  const contentType = request.headers['content-type'];
  const multipart = allowMultipart && contentType?.split(';')[0].trim() === 'multipart/form-data';
  if (!multipart && contentType?.split(';')[0].trim() !== 'application/x-www-form-urlencoded') reject(415, '不支持的提交格式。');
  if (multipart) maxBytes = 6 * 1024 * 1024;
  let size = 0;
  const chunks = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxBytes) reject(413, '提交内容过大。');
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  if (!multipart) return new URLSearchParams(body.toString('utf8'));
  try { return await new Response(body, { headers: { 'Content-Type': contentType } }).formData(); }
  catch { reject(400, '图片上传格式无效，请重新选择文件后测试。'); }
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
      <div class="card-actions">${deleteButton(`/projects/${project.id}/delete`, project.name, `确定删除短剧“${project.name}”？全部季、集、角色及图片将一并删除，无法恢复。`)}</div>
    </article>`).join('')}</section>`;
}

export function createApp(database) {
  const listProjects = database.prepare('SELECT id, name, style, aspect_ratio AS aspectRatio FROM projects ORDER BY id DESC');
  const insertProject = database.prepare('INSERT INTO projects (name, style, aspect_ratio) VALUES (?, ?, ?)');
  const findProject = database.prepare('SELECT name, style, aspect_ratio AS aspectRatio FROM projects WHERE id = ?');
  const server = createServer(async (request, response) => {
    function send(status, type, body, headers = {}) {
      response.writeHead(status, {
        'Content-Type': type.startsWith('image/') ? type : `${type}; charset=utf-8`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...headers,
      });
      response.end(request.method === 'HEAD' ? undefined : body);
    }
    const json = (status, value) => send(status, 'application/json', JSON.stringify(value));
    const path = request.url.split('?')[0];
    const deleteProjectRoute = path.match(/^\/projects\/([1-9]\d*)(?:\/(characters|scenes|seasons|episodes)\/([1-9]\d*))?\/delete$/);
    const deleteConfigRoute = path.match(/^\/settings\/api\/([1-9]\d*)\/delete$/);
    const creationRoute = path.match(/^\/projects\/([1-9]\d*)\/(seasons|episodes)(?:\/([1-9]\d*)(\/move)?)?$/);
    const scriptRoute = path.match(/^\/projects\/([1-9]\d*)\/episodes\/([1-9]\d*)\/(script|generate-script)$/);
    const storyboardRoute = path.match(/^\/projects\/([1-9]\d*)\/episodes\/([1-9]\d*)\/(storyboards|generate-storyboards)$/);
    const extractionRoute = path.match(/^\/projects\/([1-9]\d*)\/episodes\/([1-9]\d*)\/(extract-resources|confirm-resources|remove-resources|resource-occurrences\/([1-9]\d*))$/);
    const sceneRoute = path.match(/^\/projects\/([1-9]\d*)\/scenes(?:\/([1-9]\d*))?$/);
    const characterRoute = path.match(/^\/projects\/([1-9]\d*)\/characters(?:\/([1-9]\d*))?$/);
    const generationRoute = path.match(/^\/projects\/([1-9]\d*)\/(characters|scenes)\/([1-9]\d*)\/(generate|edit-image|clear-image)$/);
    const referenceRoute = path.match(/^\/projects\/([1-9]\d*)\/(characters|scenes)\/([1-9]\d*)\/(reference-image|clear-reference)$/);
    const boardRoute = path.match(/^\/projects\/([1-9]\d*)\/(characters|scenes)\/([1-9]\d*)\/(boards|images|references)\/([1-9]\d*)$/);
    const settingsRoute = path.match(/^\/settings\/api(?:\/([1-9]\d*)(\/check)?)?$/);

    try {
      if ((deleteProjectRoute || deleteConfigRoute) && request.method === 'POST') {
        const form = await readForm(request);
        const kind = deleteConfigRoute ? 'api_configs' : deleteProjectRoute[2] ?? 'projects';
        const id = Number(deleteConfigRoute?.[1] ?? deleteProjectRoute[3] ?? deleteProjectRoute[1]);
        const projectId = deleteProjectRoute?.[2] ? Number(deleteProjectRoute[1]) : undefined;
        json(200, deleteItem(database, kind, id, projectId, form));
        return;
      }
      if (storyboardRoute && request.method === 'POST') {
        const [projectId, id] = storyboardRoute.slice(1, 3).map(Number);
        const form = await readForm(request, storyboardRoute[3] === 'storyboards' ? 1024 * 1024 : 32768);
        if (![projectId, id].every(Number.isSafeInteger)) { json(404, { error: '集不存在' }); return; }
        json(200, storyboardRoute[3] === 'storyboards' ? saveEpisodeStoryboards(database, projectId, id, form) : await generateEpisodeStoryboards(database, projectId, id, form)); return;
      }
      if (extractionRoute && request.method === 'POST') {
        const [projectId, id] = extractionRoute.slice(1, 3).map(Number);
        const occurrenceId = extractionRoute[4] ? Number(extractionRoute[4]) : undefined;
        const form = await readForm(request, extractionRoute[3] === 'confirm-resources' ? 1024 * 1024 : 32768);
        if (![projectId, id, ...(occurrenceId === undefined ? [] : [occurrenceId])].every(Number.isSafeInteger)) { json(404, { error: '集或出场记录不存在' }); return; }
        json(200, extractionRoute[3] === 'extract-resources' ? await extractEpisodeResources(database, projectId, id, form)
          : extractionRoute[3] === 'confirm-resources' ? confirmEpisodeResources(database, projectId, id, form)
          : extractionRoute[3] === 'remove-resources' ? removeEpisodeResources(database, projectId, id, form)
          : updateEpisodeOccurrence(database, projectId, id, occurrenceId, form));
        return;
      }
      if (sceneRoute && request.method === 'POST') {
        const projectId = Number(sceneRoute[1]); const id = sceneRoute[2] ? Number(sceneRoute[2]) : undefined;
        const form = await readForm(request);
        if (![projectId, ...(id === undefined ? [] : [id])].every(Number.isSafeInteger)) { json(404, { error: '场景不存在' }); return; }
        json(id ? 200 : 201, saveScene(database, projectId, id, form)); return;
      }
      if (scriptRoute && request.method === 'POST') {
        const [projectId, id] = scriptRoute.slice(1).map(Number);
        const form = await readForm(request, scriptRoute[3] === 'script' ? 1024 * 1024 : 32768);
        if (![projectId, id].every(Number.isSafeInteger)) { json(404, { error: '集不存在' }); return; }
        json(200, scriptRoute[3] === 'script' ? saveEpisodeScript(database, projectId, id, form) : await generateEpisodeScript(database, projectId, id, form));
        return;
      }
      if (referenceRoute && request.method === 'POST') {
        const [projectId, id] = [referenceRoute[1], referenceRoute[3]].map(Number);
        const scene = referenceRoute[2] === 'scenes'; const uploading = referenceRoute[4] === 'reference-image';
        const form = await readForm(request, 8192, uploading);
        if (![projectId, id].every(Number.isSafeInteger)) { json(404, { error: '资源不存在' }); return; }
        json(uploading ? 201 : 200, uploading
          ? await (scene ? saveSceneReference : saveCharacterReference)(database, projectId, id, form)
          : (scene ? clearSceneReference : clearCharacterReference)(database, projectId, id, form));
        return;
      }
      if (generationRoute && request.method === 'POST') {
        const [projectId, id] = [generationRoute[1], generationRoute[3]].map(Number);
        const scene = generationRoute[2] === 'scenes';
        const form = await readForm(request, 32768);
        if (![projectId, id].every(Number.isSafeInteger)) { json(404, { error: '资源不存在' }); return; }
        if (generationRoute[4] === 'edit-image') {
          (scene ? findScene : findCharacter)(database, projectId, id);
          json(503, { error: '遮罩修图接口尚未接入，不会调用模型或回退为整图编辑。' });
          return;
        }
        json(200, generationRoute[4] === 'clear-image' ? (scene ? clearSceneImage : clearCharacterBoard)(database, projectId, id, form)
          : await (scene ? generateSceneImage : generateCharacterBoard)(database, projectId, id, form));
        return;
      }
      if (settingsRoute && request.method === 'POST') {
        const form = await readForm(request, 32768, Boolean(settingsRoute[2]));
        const id = settingsRoute[1] ? Number(settingsRoute[1]) : undefined;
        if (id !== undefined && !Number.isSafeInteger(id)) {
          json(404, { error: 'API 配置不存在' });
          return;
        }
        json(settingsRoute[2] ? 200 : id ? 200 : 201, settingsRoute[2] ? await checkApiConfig(database, id, form) : saveApiConfig(database, id, form));
        return;
      }
      if (characterRoute && request.method === 'POST') {
        const projectId = Number(characterRoute[1]);
        const id = characterRoute[2] ? Number(characterRoute[2]) : undefined;
        const form = await readForm(request, id ? 65536 : 8192);
        if (!Number.isSafeInteger(projectId) || (id !== undefined && !Number.isSafeInteger(id))) {
          json(404, { error: '角色不存在' });
          return;
        }
        json(id ? 200 : 201, saveCharacter(database, projectId, id, form));
        return;
      }
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
        send(405, 'text/plain', '暂不支持此操作', { Allow: path === '/projects' || creationRoute || scriptRoute || storyboardRoute || extractionRoute || sceneRoute || characterRoute || settingsRoute || generationRoute || referenceRoute || deleteProjectRoute || deleteConfigRoute ? 'POST' : 'GET, HEAD' });
        return;
      }
      if (path === '/') {
        const template = await readFile(new URL('../views/index.html', import.meta.url), 'utf8');
        const library = await renderLibrary(listProjects.all());
        send(200, 'text/html', template.replace('<!-- PROJECT_LIBRARY -->', () => library));
        return;
      }
      if (path === '/settings') {
        send(200, 'text/html', await renderSettings(database, new URL(request.url, 'http://localhost').searchParams));
        return;
      }
      if (boardRoute) {
        const [projectId, id, boardId] = [boardRoute[1], boardRoute[3], boardRoute[5]].map(Number);
        const scene = boardRoute[2] === 'scenes';
        if (![projectId, id, boardId].every(Number.isSafeInteger) || (scene ? boardRoute[4] === 'boards' : boardRoute[4] === 'images')) { send(404, 'text/plain', '图片不存在'); return; }
        const table = boardRoute[4] === 'references' ? scene ? 'scene_references' : 'character_references' : scene ? 'scene_images' : 'character_boards';
        (scene ? findScene : findCharacter)(database, projectId, id);
        const board = database.prepare(`SELECT image, mime FROM ${table} WHERE id = ? AND ${scene ? 'scene_id' : 'character_id'} = ?`).get(boardId, id);
        if (!board) { send(404, 'text/plain', '角色板不存在'); return; }
        send(200, board.mime, board.image, { 'Content-Length': board.image.length });
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
          if (resourceType === 'characters') {
            workspace = await renderCharacters(database, id, project, query);
          } else if (resourceType === 'scenes') {
            workspace = renderScenes(database, id, query);
          } else {
            const content = await readFile(new URL('../views/resource-empty.html', import.meta.url), 'utf8');
            workspace = { title: resource.name, description: resource.description, actions: '', content: content.replaceAll('<!-- RESOURCE_NAME -->', resource.name) };
          }
        } else if (['scripts', 'seasons', 'episode', 'storyboards'].includes(view)) {
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
          .replaceAll('<!-- SCRIPTS_CURRENT -->', ['scripts', 'episode'].includes(view) ? 'page' : 'false')
          .replaceAll('<!-- STORYBOARDS_CURRENT -->', view === 'storyboards' ? 'page' : 'false')
          .replaceAll('<!-- SEASONS_CURRENT -->', view === 'seasons' ? 'page' : 'false')
          .replaceAll('<!-- CREATION_HIERARCHY -->', () => renderCreationNavigation(database, id, view, query))
          .replaceAll(/<!-- (CHARACTERS|SCENES|PROPS|COSTUMES)_CURRENT -->/g, (_match, type) => view === 'resources' && type.toLowerCase() === resourceType ? 'page' : 'false');
        send(200, 'text/html', html);
        return;
      }
      const asset = assets.get(path);
      send(asset ? 200 : 404, asset?.type ?? 'text/plain', asset ? await readFile(asset.file) : '页面不存在');
    } catch (error) {
      if (!error.status) console.error('处理请求失败：', error);
      if (!response.headersSent) json(error.status ?? 500, { error: error.status ? error.message : '暂时无法完成操作，请稍后重试。', ...(error.recoveryImage ? { recoveryImage: error.recoveryImage } : {}), ...(error.recoveryText ? { recoveryText: error.recoveryText } : {}) });
    }
  });
  server.on('close', () => database.close());
  return server;
}
