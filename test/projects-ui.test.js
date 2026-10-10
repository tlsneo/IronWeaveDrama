import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const script = await readFile(new URL('../public/projects.js', import.meta.url), 'utf8');

function loadPage(fetch) {
  const events = new Map();
  const button = { disabled: false, textContent: '创建短剧' };
  const error = { textContent: '' };
  const dialog = { open: false, showModal() { this.open = true; }, close() { this.open = false; } };
  const values = { name: '假掌门', style: '国风水墨', aspectRatio: '9:16' };
  const form = {
    values,
    querySelector: () => button,
    addEventListener: (event, handler) => events.set('submit', handler),
  };
  let reloadCount = 0;
  const nodes = {
    'create-project-dialog': dialog,
    'create-project-form': form,
    'create-project-error': error,
    'create-project': { addEventListener: (event, handler) => events.set('open', handler) },
    'cancel-create-project': { addEventListener: (event, handler) => events.set('cancel', handler) },
  };
  runInNewContext(script, {
    document: { getElementById: id => nodes[id] },
    window: { location: { reload: () => reloadCount++ } },
    FormData: class { constructor(form) { return new URLSearchParams(form.values); } },
    URLSearchParams, TypeError, Error, fetch,
  });
  return {
    dialog, button, error, values,
    open: () => events.get('open')(),
    cancel: () => events.get('cancel')(),
    submit: () => events.get('submit')({ preventDefault() {} }),
    get reloadCount() { return reloadCount; },
  };
}

test('创建入口打开弹窗，取消关闭弹窗，不提交或清空填写内容', () => {
  const page = loadPage(() => assert.fail('取消不应发送请求'));
  page.open();
  assert.equal(page.dialog.open, true);
  page.cancel();
  assert.equal(page.dialog.open, false);
  assert.equal(page.values.name, '假掌门');
});

test('创建中阻止重复点击，成功后刷新主页显示项目', async () => {
  let finish, calls = 0;
  const page = loadPage((path, options) => {
    calls++;
    assert.equal(path, '/projects');
    assert.equal(options.method, 'POST');
    assert.equal(options.body.get('name'), '假掌门');
    assert.equal(options.body.get('style'), '国风水墨');
    assert.equal(options.body.get('aspectRatio'), '9:16');
    return new Promise(resolve => { finish = resolve; });
  });
  const submitted = page.submit();
  assert.equal(page.button.disabled, true);
  assert.equal(page.button.textContent, '创建中…');
  await page.submit();
  assert.equal(calls, 1);
  finish({ ok: true, json: async () => ({ id: 1 }) });
  await submitted;
  assert.equal(page.reloadCount, 1);
});

test('服务器或网络报错后保留填写内容，显示错误，并允许重试', async () => {
  for (const fetch of [
    async () => ({ ok: false, json: async () => ({ error: '请填写有效的名称。' }) }),
    async () => { throw new TypeError('fetch failed'); },
  ]) {
    const page = loadPage(fetch);
    page.open();
    await page.submit();
    assert.equal(page.dialog.open, true);
    assert.equal(page.values.name, '假掌门');
    assert.ok(page.error.textContent);
    assert.equal(page.button.disabled, false);
    assert.equal(page.button.textContent, '创建短剧');
    assert.equal(page.reloadCount, 0);
  }
});
