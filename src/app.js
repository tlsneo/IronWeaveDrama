import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';

const template = await readFile(new URL('../views/index.html', import.meta.url), 'utf8');
const emptyLibrary = await readFile(new URL('../views/library-empty.html', import.meta.url), 'utf8');
const assets = new Map();
for (const [path, type] of [
  ['/styles.css', 'text/css'],
  ['/theme.js', 'text/javascript'],
  ['/projects.js', 'text/javascript'],
]) {
  assets.set(path, { type, body: await readFile(new URL(`../public${path}`, import.meta.url)) });
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function renderLibrary(projects) {
  if (!projects.length) return emptyLibrary;
  return `<section class="project-grid" aria-label="短剧项目">${projects.map(project => `
    <article class="project-card">
      <div class="project-cover" aria-hidden="true"><span>${escapeHtml([...project.name][0])}</span></div>
      <div class="project-details">
        <p class="project-kind">整部短剧</p>
        <h2>${escapeHtml(project.name)}</h2>
        <div class="project-meta"><span>${escapeHtml(project.style)}</span><span>${escapeHtml(project.aspectRatio)}</span></div>
      </div>
    </article>`).join('')}</section>`;
}

export function createApp(database) {
  const listProjects = database.prepare('SELECT id, name, style, aspect_ratio AS aspectRatio FROM projects ORDER BY id DESC');
  const insertProject = database.prepare('INSERT INTO projects (name, style, aspect_ratio) VALUES (?, ?, ?)');
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

    try {
      if (path === '/projects' && request.method === 'POST') {
        const origin = request.headers.origin;
        if (request.headers['sec-fetch-site'] === 'cross-site' ||
            (origin && origin !== `http://${request.headers.host}` && origin !== `https://${request.headers.host}`)) {
          request.resume();
          json(403, { error: '不允许从其他网站提交项目。' });
          return;
        }
        if (request.headers['content-type']?.split(';')[0].trim() !== 'application/x-www-form-urlencoded') {
          request.resume();
          json(415, { error: '不支持的提交格式。' });
          return;
        }
        let size = 0;
        const chunks = [];
        for await (const chunk of request.iterator({ destroyOnReturn: false })) {
          size += chunk.length;
          if (size > 8192) {
            request.resume();
            json(413, { error: '提交内容过大。' });
            return;
          }
          chunks.push(chunk);
        }
        const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        const name = form.get('name')?.trim() ?? '';
        const style = form.get('style')?.trim() ?? '';
        const aspectRatio = form.get('aspectRatio');
        if (['name', 'style', 'aspectRatio'].some(field => form.getAll(field).length !== 1) ||
            !name || name.length > 80 || !style || style.length > 120 ||
            !['9:16', '16:9', '21:9', '4:3', '3:4', '1:1'].includes(aspectRatio)) {
          json(400, { error: '请填写短剧名称（最多 80 字）、画面风格（最多 120 字），并选择有效的画面比例。' });
          return;
        }
        const result = insertProject.run(name, style, aspectRatio);
        json(201, { id: Number(result.lastInsertRowid), name, style, aspectRatio });
        return;
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        request.resume();
        send(405, 'text/plain', '暂不支持此操作', { Allow: path === '/projects' ? 'POST' : 'GET, HEAD' });
        return;
      }
      if (path === '/') {
        send(200, 'text/html', template.replace('<!-- PROJECT_LIBRARY -->', () => renderLibrary(listProjects.all())));
        return;
      }
      const asset = assets.get(path);
      send(asset ? 200 : 404, asset?.type ?? 'text/plain', asset?.body ?? '页面不存在');
    } catch (error) {
      console.error('处理请求失败：', error);
      if (!response.headersSent) json(500, { error: '暂时无法完成操作，请稍后重试。' });
    }
  });
  server.on('close', () => database.close());
  return server;
}
