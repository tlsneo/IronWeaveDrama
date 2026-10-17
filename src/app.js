import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { generationContext, readOperation, listOperations, recoverOperation, releaseOperation } from './generation-operations.js';
import { linkedOperation, adoptOperation } from './media-adoption.js';
import { mediaPath } from './media-files.js';
import { cleanupPendingMedia } from './media-cleanup.js';
import { generateShot, saveClip, generateClip, adoptProductionOperation } from './video-production.js';
import { renderOperations, renderProduction } from './render-generation.js';
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
import { saveEpisodeStoryboards, generateEpisodeStoryboards, clearEpisodeStoryboards } from './storyboards.js';
import { findProductionAsset, saveProductionAsset, saveAssetReference, clearAssetReference } from './production-assets.js';
import { findLook, saveLook, generateLookImage, clearLookImage } from './looks.js';
import { renderProductionAssets, renderLooks } from './render-production-resources.js';

const resourceTypes = new Map([
  ['characters', { name: '角色', description: '管理这部短剧的基础角色与参考图' }],
  ['scenes', { name: '场景', description: '管理这部短剧的拍摄环境与场景参考图' }],
  ['props', { name: '道具', description: '管理这部短剧使用的物品与道具参考图' }],
  ['costumes', { name: '服饰', description: '服饰单独制作，与基础角色分开管理' }],
  ['looks', { name: '定妆', description: '选择基础演员、服饰和道具，自己写提示词生成定妆照' }],
]);
const assets = new Map();
for (const [path, type] of [
  ['/styles.css', 'text/css'],
  ['/generation-stream.js', 'text/javascript'],
  ['/generation-pages.js', 'text/javascript'],
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
  ['/production-resources.js', 'text/javascript'],
  ['/production-resources.css', 'text/css'],
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
      <div class="card-actions">${deleteButton(`/projects/${project.id}/delete`, project.name, `确定删除短剧“${project.name}”？全部季、集、资源及旧图片将删除；所属新媒体在事务提交后清理，失败保留待办重试。未确认交付须先在历史核对。无法恢复。`)}</div>
    </article>`).join('')}</section>`;
}

export function createApp(database) {
  const listProjects = database.prepare('SELECT id, name, style, aspect_ratio AS aspectRatio FROM projects ORDER BY id DESC');
  const insertProject = database.prepare('INSERT INTO projects (name, style, aspect_ratio) VALUES (?, ?, ?)');
  const findProject = database.prepare('SELECT name, style, aspect_ratio AS aspectRatio FROM projects WHERE id = ?');
  const server = createServer((request, response) => {
    const controller = new AbortController(); let streaming = false;
    response.on('close', () => { if (!response.writableFinished) controller.abort(); });
    const progress = event => {
      if (!request.headers.accept?.split(',').some(type => type.trim() === 'application/x-ndjson') || response.destroyed) return;
      if (!streaming) { streaming = true; response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'X-Content-Type-Options': 'nosniff' }); }
      if (response.writableLength > 65536) { controller.abort(); response.destroy(); return; }
      response.write(JSON.stringify(event) + '\n');
    };
    generationContext.run({ signal: controller.signal, progress }, async () => {
    function send(status, type, body, headers = {}) {
      response.writeHead(status, {
        'Content-Type': type.startsWith('image/') ? type : `${type}; charset=utf-8`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...headers,
      });
      response.end(request.method === 'HEAD' ? undefined : body);
    }
    const json = (status, value) => {
      if (streaming) { if (!response.destroyed) response.end(JSON.stringify({ type: 'result', status, result: value }) + '\n'); }
      else send(status, 'application/json', JSON.stringify(value));
    };
    async function fileResponse(op) {
      if (!['saved', 'confirmed'].includes(op.local_state)) throw Object.assign(new Error('媒体尚未完整保存。'), { status: 409 });
      const meta = JSON.parse(op.metadata_json), filename = mediaPath(op.id), info = await stat(filename);
      if (info.size !== meta.bytes) throw Object.assign(new Error('本地媒体长度不符。'), { status: 409 });
      let start = 0, end = meta.bytes - 1, code = 200;
      if (request.headers.range) {
        const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
        if (!range || !Number.isSafeInteger(Number(range[1]))) { send(416, 'text/plain', '不支持的范围'); return; }
        start = Number(range[1]); end = range[2] ? Math.min(Number(range[2]), end) : end;
        if (!Number.isSafeInteger(end) || start > end) { send(416, 'text/plain', '范围无效'); return; } code = 206;
      }
      response.writeHead(code, { 'Content-Type': meta.mime_type, 'Content-Length': end - start + 1, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes', ...(code === 206 ? { 'Content-Range': `bytes ${start}-${end}/${meta.bytes}` } : {}) });
      if (request.method === 'HEAD') response.end(); else await pipeline(createReadStream(filename, { start, end, highWaterMark: 65536 }), response);
    }
    const path = request.url.split('?')[0];
    const deleteProjectRoute = path.match(/^\/projects\/([1-9]\d*)(?:\/(characters|scenes|props|costumes|looks|seasons|episodes)\/([1-9]\d*))?\/delete$/);
    const deleteConfigRoute = path.match(/^\/settings\/api\/([1-9]\d*)\/delete$/);
    const creationRoute = path.match(/^\/projects\/([1-9]\d*)\/(seasons|episodes)(?:\/([1-9]\d*)(\/move)?)?$/);
    const scriptRoute = path.match(/^\/projects\/([1-9]\d*)\/episodes\/([1-9]\d*)\/(script|generate-script)$/);
    const storyboardRoute = path.match(/^\/projects\/([1-9]\d*)\/episodes\/([1-9]\d*)\/(storyboards|generate-storyboards|clear-storyboards)$/);
    const extractionRoute = path.match(/^\/projects\/([1-9]\d*)\/episodes\/([1-9]\d*)\/(extract-resources|confirm-resources|remove-resources|resource-occurrences\/([1-9]\d*))$/);
    const sceneRoute = path.match(/^\/projects\/([1-9]\d*)\/scenes(?:\/([1-9]\d*))?$/);
    const characterRoute = path.match(/^\/projects\/([1-9]\d*)\/characters(?:\/([1-9]\d*))?$/);
    const generationRoute = path.match(/^\/projects\/([1-9]\d*)\/(characters|scenes)\/([1-9]\d*)\/(generate|edit-image|clear-image)$/);
    const referenceRoute = path.match(/^\/projects\/([1-9]\d*)\/(characters|scenes)\/([1-9]\d*)\/(reference-image|clear-reference)$/);
    const boardRoute = path.match(/^\/projects\/([1-9]\d*)\/(characters|scenes)\/([1-9]\d*)\/(boards|images|references)\/([1-9]\d*)$/);
    const productionRoute = path.match(/^\/projects\/([1-9]\d*)\/(props|costumes|looks)(?:\/([1-9]\d*)(?:\/(reference-image|clear-reference|generate|clear-image|edit-image))?)?$/);
    const productionImageRoute = path.match(/^\/projects\/([1-9]\d*)\/(props|costumes|looks)\/([1-9]\d*)\/images\/([1-9]\d*)$/);
    const settingsRoute = path.match(/^\/settings\/api(?:\/([1-9]\d*)(\/check)?)?$/);

    try {
      const operationRoute = path.match(/^(?:\/projects\/([1-9]\d*))?\/operations(?:\/([a-f0-9-]{36})\/(media|recover|release|adopt))?$/);
      const productionMediaRoute = path.match(/^\/projects\/([1-9]\d*)\/episodes\/([1-9]\d*)\/(media|shots\/([1-9]\d*)\/generate|clips(?:\/([1-9]\d*)(\/generate)?)?)$/);
      if (operationRoute) {
        const projectId = operationRoute[1] ? Number(operationRoute[1]) : null, id = operationRoute[2], action = operationRoute[3];
        if (projectId !== null && !findProject.get(projectId)) { json(404, { error: '项目不存在。' }); return; }
        if (request.method === 'POST' && ['recover', 'release', 'adopt'].includes(action)) {
          const form = await readForm(request); if (form.getAll('confirmed').length !== 1 || form.get('confirmed') !== 'yes') { json(400, { error: '须明确人工确认。' }); return; }
          const row = readOperation(database, id, projectId);
          json(200, action === 'recover' ? await recoverOperation(database, projectId, id) : action === 'release' ? releaseOperation(database, projectId, id)
            : row.kind === 'video' || row.kind.startsWith('shot:') ? await adoptProductionOperation(database, projectId, id) : await adoptOperation(database, projectId, id)); return;
        }
        if (['GET', 'HEAD'].includes(request.method)) {
          if (action === 'media') await fileResponse(readOperation(database, id, projectId));
          else if (!action) { if (request.headers.accept === 'application/json') json(200, listOperations(database, projectId)); else send(200, 'text/html', renderOperations(database, projectId)); }
          else json(405, { error: '此操作需要 POST。' }); return;
        }
      }
      if (productionMediaRoute) {
        const projectId = Number(productionMediaRoute[1]), episodeId = Number(productionMediaRoute[2]);
        if (request.method === 'GET' && productionMediaRoute[3] === 'media') { send(200, 'text/html', renderProduction(database, projectId, episodeId, new URL(request.url, 'http://localhost').searchParams)); return; }
        if (request.method === 'POST' && productionMediaRoute[3] !== 'media') {
          const form = await readForm(request, 256 * 1024);
          json(200, productionMediaRoute[4] ? await generateShot(database, projectId, episodeId, Number(productionMediaRoute[4]), form)
            : productionMediaRoute[6] ? await generateClip(database, projectId, episodeId, Number(productionMediaRoute[5]), form)
            : saveClip(database, projectId, episodeId, productionMediaRoute[5] ? Number(productionMediaRoute[5]) : null, form)); return;
        }
      }
      if ((deleteProjectRoute || deleteConfigRoute) && request.method === 'POST') {
        const form = await readForm(request);
        const kind = deleteConfigRoute ? 'api_configs' : deleteProjectRoute[2] ?? 'projects';
        const id = Number(deleteConfigRoute?.[1] ?? deleteProjectRoute[3] ?? deleteProjectRoute[1]);
        const projectId = deleteProjectRoute?.[2] ? Number(deleteProjectRoute[1]) : undefined;
        const result = deleteItem(database, kind, id, projectId, form);
        if (kind === 'projects') {
          let pending = true;
          try { pending = (await cleanupPendingMedia(database, { projectId: id, limit: 25 })).pending > 0; } catch { /* 删除事务已提交；不能将清理故障冒充项目未删除。 */ }
          result.mediaCleanupPending = pending;
          result.message = pending ? '项目已删除，媒体清理待重试。' : '项目已删除，所属新媒体已清理。';
        }
        json(200, result);
        return;
      }
      if (productionRoute && request.method === 'POST') {
        const projectId = Number(productionRoute[1]), kind = productionRoute[2], id = productionRoute[3] ? Number(productionRoute[3]) : null, action = productionRoute[4];
        if (![projectId, ...(id ? [id] : [])].every(Number.isSafeInteger)) { json(404, { error: '素材或定妆不存在' }); return; }
        if ((kind === 'looks' && ['reference-image', 'clear-reference'].includes(action)) || (kind !== 'looks' && ['generate', 'clear-image', 'edit-image'].includes(action))) { json(404, { error: '此资源不支持该操作' }); return; }
        const form = await readForm(request, action ? 32768 : kind === 'looks' ? 256 * 1024 : 65536, action === 'reference-image');
        if (action === 'edit-image') {
          findLook(database, projectId, id);
          json(503, { error: '遮罩修图接口尚未接入，不会调用模型或回退为整图编辑。' }); return;
        }
        const result = !action ? kind === 'looks' ? saveLook(database, projectId, id, form) : saveProductionAsset(database, projectId, kind, id, form)
          : action === 'reference-image' ? await saveAssetReference(database, projectId, kind, id, form)
            : action === 'clear-reference' ? clearAssetReference(database, projectId, kind, id, form)
              : action === 'generate' ? await generateLookImage(database, projectId, id, form) : clearLookImage(database, projectId, id, form);
        json(id ? 200 : 201, result); return;
      }
      if (storyboardRoute && request.method === 'POST') {
        const [projectId, id] = storyboardRoute.slice(1, 3).map(Number);
        const action = storyboardRoute[3];
        const form = await readForm(request, action === 'storyboards' ? 1024 * 1024 : action === 'clear-storyboards' ? 8192 : 32768);
        if (![projectId, id].every(Number.isSafeInteger)) { json(404, { error: '集不存在' }); return; }
        json(200, action === 'storyboards' ? saveEpisodeStoryboards(database, projectId, id, form)
          : action === 'clear-storyboards' ? clearEpisodeStoryboards(database, projectId, id, form)
            : await generateEpisodeStoryboards(database, projectId, id, form)); return;
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
        send(405, 'text/plain', '暂不支持此操作', { Allow: path === '/projects' || creationRoute || scriptRoute || storyboardRoute || extractionRoute || sceneRoute || characterRoute || settingsRoute || generationRoute || referenceRoute || productionRoute || deleteProjectRoute || deleteConfigRoute ? 'POST' : 'GET, HEAD' });
        return;
      }
      if (path === '/') {
        const template = await readFile(new URL('../views/index.html', import.meta.url), 'utf8');
        const library = await renderLibrary(listProjects.all());
        send(200, 'text/html', template.replace('<!-- PROJECT_LIBRARY -->', () => library));
        return;
      }
      if (path === '/settings') {
        send(200, 'text/html', (await renderSettings(database, new URL(request.url, 'http://localhost').searchParams)).replace('</body>', '<script src="/generation-stream.js"></script></body>'));
        return;
      }
      if (productionImageRoute) {
        const [projectId, id, imageId] = [productionImageRoute[1], productionImageRoute[3], productionImageRoute[4]].map(Number), kind = productionImageRoute[2];
        if (![projectId, id, imageId].every(Number.isSafeInteger)) { send(404, 'text/plain', '图片不存在'); return; }
        if (kind === 'looks') findLook(database, projectId, id); else findProductionAsset(database, projectId, kind, id);
        const table = kind === 'looks' ? 'look_images' : 'production_asset_images', column = kind === 'looks' ? 'look_id' : 'asset_id';
        const image = database.prepare(`SELECT image, mime FROM ${table} WHERE id = ? AND ${column} = ?`).get(imageId, id);
        if (!image) { send(404, 'text/plain', '图片不存在'); return; }
        const linked = linkedOperation(database, table, imageId);
        if (linked) await fileResponse(linked); else send(200, image.mime, image.image, { 'Content-Length': image.image.length }); return;
      }
      if (boardRoute) {
        const [projectId, id, boardId] = [boardRoute[1], boardRoute[3], boardRoute[5]].map(Number);
        const scene = boardRoute[2] === 'scenes';
        if (![projectId, id, boardId].every(Number.isSafeInteger) || (scene ? boardRoute[4] === 'boards' : boardRoute[4] === 'images')) { send(404, 'text/plain', '图片不存在'); return; }
        const table = boardRoute[4] === 'references' ? scene ? 'scene_references' : 'character_references' : scene ? 'scene_images' : 'character_boards';
        (scene ? findScene : findCharacter)(database, projectId, id);
        const board = database.prepare(`SELECT image, mime FROM ${table} WHERE id = ? AND ${scene ? 'scene_id' : 'character_id'} = ?`).get(boardId, id);
        if (!board) { send(404, 'text/plain', '角色板不存在'); return; }
        const linked = linkedOperation(database, table, boardId);
        if (linked) await fileResponse(linked); else send(200, board.mime, board.image, { 'Content-Length': board.image.length });
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
          } else if (resourceType === 'looks') {
            workspace = renderLooks(database, id, query);
          } else {
            workspace = renderProductionAssets(database, id, resourceType, query);
          }
        } else if (['scripts', 'seasons', 'episode', 'storyboards'].includes(view)) {
          workspace = renderCreation(database, id, view, query);
        } else {
          send(404, 'text/plain', '创作页面不存在');
          return;
        }
        workspace.content = `<p><a href="/projects/${id}/operations">生成历史 / 恢复 / 人工采用</a>${view === 'storyboards' && /^[1-9]\d*$/.test(query.get('episode') ?? '') ? ` · <a href="/projects/${id}/episodes/${query.get('episode')}/media">镜头构图 / 视频片段</a>` : ''}</p>` + workspace.content;
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
          .replaceAll(/<!-- (CHARACTERS|SCENES|PROPS|COSTUMES|LOOKS)_CURRENT -->/g, (_match, type) => view === 'resources' && type.toLowerCase() === resourceType ? 'page' : 'false');
        send(200, 'text/html', html.replace('</body>', '<script src="/generation-stream.js"></script></body>'));
        return;
      }
      const asset = assets.get(path);
      send(asset ? 200 : 404, asset?.type ?? 'text/plain', asset ? await readFile(asset.file) : '页面不存在');
    } catch (error) {
      if (!error.status) console.error('处理请求失败：', error);
      if (!response.headersSent || streaming) json(error.status ?? 500, { error: error.status ? error.message : '暂时无法完成操作，请稍后重试。', ...(error.operationId ? { operationId: error.operationId } : {}), ...(error.recoveryImage ? { recoveryImage: error.recoveryImage } : {}), ...(error.recoveryText ? { recoveryText: error.recoveryText } : {}) });
    }
    }).catch(() => { if (!response.destroyed) response.destroy(); });
  });
  server.on('close', () => database.close());
  return server;
}
