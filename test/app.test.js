import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp } from '../src/app.js';

const server = createApp();
let baseUrl;

before(async () => {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

test('首页展示整部短剧的空状态，不开放尚未实现的创建操作', async () => {
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  const html = await response.text();
  assert.match(html, /lang="zh-CN"/);
  assert.match(html, /<h1>剧集库<\/h1>/);
  assert.match(html, /还没有短剧项目/);
  assert.match(html, /整部短剧/);
  assert.match(html, /<button[^>]*disabled/);
  assert.match(html, /id="theme-toggle"/);
  assert.match(html, /<script src="\/theme.js"><\/script>/);
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

test('未声明的路径不能读取项目文件', async () => {
  for (const path of ['/missing', '/package.json', '/src/server.js', '/%2e%2e/README.md']) {
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
