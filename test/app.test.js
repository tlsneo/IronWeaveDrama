import assert from 'node:assert/strict';
import { request } from 'node:http';
import { after, before, test } from 'node:test';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/database.js';

const server = createApp(openDatabase(':memory:'));
let baseUrl;

before(async () => {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

test('首页展示整部短剧的空状态和可用的创建表单', async () => {
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  const html = await response.text();
  assert.match(html, /lang="zh-CN"/);
  assert.match(html, /<h1>剧集库<\/h1>/);
  assert.match(html, /还没有短剧项目/);
  assert.match(html, /整部短剧/);
  assert.match(html, /id="create-project"/);
  assert.doesNotMatch(html, /<button[^>]*disabled/);
  assert.match(html, /<dialog id="create-project-dialog"/);
  assert.match(html, /name="name"/);
  assert.match(html, /name="style"/);
  assert.match(html, /name="aspectRatio"/);
  assert.match(html, /id="theme-toggle"/);
  assert.match(html, /<script src="\/theme.js"><\/script>/);
});

test('画风列表覆盖主要类别，保留已有选项和自由填写', async () => {
  const html = await (await fetch(baseUrl)).text();
  assert.match(html, /<input[^>]*name="style"[^>]*list="visual-styles"/);
  const list = html.match(/<datalist id="visual-styles">([\s\S]*?)<\/datalist>/)[1];
  const styles = [...list.matchAll(/<option value="([^"]+)">/g)].map(match => match[1]);
  assert.equal(styles.length, 40);
  assert.equal(new Set(styles).size, styles.length);
  for (const style of [
    '写实电影', '国风水墨', '日系动漫', '3D 动画', '美式漫画',
    '纪录片', '黑色电影', '写实二次元', '仙侠 3D', '韩漫纯爱',
    '油画', '赛博朋克', '末世废土', '像素风', '低多边形',
  ]) assert.ok(styles.includes(style), `缺少画风：${style}`);
});

test('样式支持窄屏与暗黑主题，首页查询参数不影响访问', async () => {
  const response = await fetch(`${baseUrl}/styles.css`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/css/);
  const css = await response.text();
  assert.match(css, /@media \(max-width: 640px\)/);
  assert.match(css, /:root\[data-theme="dark"\]/);
  assert.match(css, /color-scheme: dark/);
  assert.equal((await fetch(`${baseUrl}/?source=test`)).status, 200);
});

test('主题脚本可以加载', async () => {
  const response = await fetch(`${baseUrl}/theme.js`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/javascript/);
  assert.match(await response.text(), /prefers-color-scheme: dark/);
});

test('创建项目脚本可以加载', async () => {
  const response = await fetch(`${baseUrl}/projects.js`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/javascript/);
  assert.match(await response.text(), /showModal/);
});

test('未声明的路径不能读取项目文件', async () => {
  for (const path of ['/missing', '/package.json', '/src/server.js', '/data/drama.sqlite', '/%2e%2e/README.md']) {
    assert.equal((await fetch(`${baseUrl}${path}`)).status, 404);
  }
});

test('HEAD 没有响应正文，未实现的写入操作返回 405', async () => {
  const head = await fetch(baseUrl, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  const post = await fetch(baseUrl, { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
});

test('只有设置测试允许超过6MiB的multipart；参考上传仍6MiB，设置测试总上限65MiB', async () => {
  const upload = async (path, bytes) => {
    const form = new FormData(); form.set('referenceImages', new Blob([Buffer.alloc(bytes)], { type: 'image/png' }), 'synthetic.png');
    const encoded = new Request(baseUrl + path, { method: 'POST', body: form });
    const body = Buffer.from(await encoded.arrayBuffer());
    return new Promise((resolve, reject) => {
      let responded = false;
      const req = request(baseUrl + path, { method: 'POST', headers: { 'Content-Type': encoded.headers.get('content-type'), 'Content-Length': body.length } }, async res => {
        responded = true; const chunks = []; for await (const chunk of res) chunks.push(chunk);
        resolve(new Response(Buffer.concat(chunks), { status: res.statusCode }));
      });
      req.on('error', error => { if (!responded) reject(error); });
      // 遇到早期413即停止本次上传，避免fetch在继续写大正文时只报告EPIPE。
      let offset = 0;
      const write = () => {
        if (responded || req.destroyed) return;
        if (offset === body.length) { req.end(); return; }
        const next = Math.min(offset + 65536, body.length), chunk = body.subarray(offset, next); offset = next;
        req.write(chunk); setImmediate(write);
      };
      write();
    });
  };
  // 不存在的配置：通过表单限额才会到达404；绝不访问上游。
  const accepted = await upload('/settings/api/999/check', 7 * 1024 * 1024);
  assert.equal(accepted.status, 404);
  const oversized = await upload('/settings/api/999/check', 65 * 1024 * 1024);
  assert.equal(oversized.status, 413); assert.match((await oversized.json()).error, /提交内容过大/);
  for (const path of ['/projects/1/characters/1/reference-image', '/projects/1/scenes/1/reference-image', '/projects/1/costumes/1/reference-image']) {
    const response = await upload(path, 7 * 1024 * 1024);
    assert.equal(response.status, 413, path); assert.match((await response.json()).error, /提交内容过大/);
  }
  assert.equal((await upload('/settings/api/999', 100)).status, 415);
});
