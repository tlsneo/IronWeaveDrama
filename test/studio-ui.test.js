import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const script = await readFile(new URL('../public/studio.js', import.meta.url), 'utf8');

function page(fetch) {
  const events = {};
  const name = { value: '', select() {} };
  const season = { value: '' };
  const button = { disabled: false, textContent: '保存' };
  const error = { textContent: '' };
  const pageError = { textContent: '' };
  const dialog = {
    open: false,
    showModal() { this.open = true; },
    close() { this.open = false; },
    addEventListener: (event, handler) => { events.cancel = handler; },
  };
  const form = { dataset: {}, querySelector: () => button, addEventListener: (event, handler) => { events.submit = handler; } };
  const nodes = {
    'name-dialog': dialog, 'name-form': form, 'creation-name': name,
    'creation-season-id': season, 'name-error': error, 'studio-error': pageError,
    'name-dialog-title': { textContent: '' },
    'cancel-name': { addEventListener: (event, handler) => { events.close = handler; } },
  };
  const redirects = [];
  runInNewContext(script, {
    document: {
      getElementById: id => nodes[id],
      addEventListener: (event, handler) => { events.click = handler; },
    },
    window: { location: { assign: url => redirects.push(url) } },
    FormData: class { constructor() { return new URLSearchParams({ name: name.value, seasonId: season.value }); } },
    URLSearchParams, TypeError, Error, fetch,
  });
  return {
    nodes, name, season, button, error, pageError, dialog, redirects,
    open: data => events.click({ target: { closest: selector => selector === '[data-name-dialog]' ? { dataset: data } : null } }),
    move: element => events.click({ target: { closest: selector => selector === '[data-move-url]' ? element : null } }),
    submit: () => events.submit({ preventDefault() {} }),
    close: () => events.close(),
    cancel: event => events.cancel(event),
  };
}

test('添加集和重命名使用同一弹窗，预填名称、所属季和提交地址，成功进入返回页面', async () => {
  const p = page(async (url, options) => {
    assert.equal(url, '/projects/1/episodes');
    assert.equal(options.body.get('name'), '开场');
    assert.equal(options.body.get('seasonId'), '3');
    return { ok: true, json: async () => ({ redirect: '/projects/1?view=seasons&season=3' }) };
  });
  await p.open({ title: '添加集', name: '第1集', seasonId: '3', url: '/projects/1/episodes' });
  assert.equal(p.dialog.open, true);
  assert.equal(p.name.value, '第1集');
  assert.equal(p.nodes['name-dialog-title'].textContent, '添加集');
  p.name.value = '开场';
  await p.submit();
  assert.deepEqual(p.redirects, ['/projects/1?view=seasons&season=3']);
  await p.open({ title: '重命名', name: '续篇', seasonId: '', url: '/projects/1/seasons/3' });
  assert.equal(p.name.value, '续篇');
  p.close();
  assert.equal(p.dialog.open, false);
});

test('保存期间拒绝重复提交或关闭，失败保留名称且允许再次保存', async () => {
  let finish, calls = 0;
  const p = page(() => {
    calls++;
    return new Promise(resolve => { finish = resolve; });
  });
  await p.open({ title: '添加季', name: '续篇', seasonId: '', url: '/projects/1/seasons' });
  const saving = p.submit();
  assert.equal(p.button.disabled, true);
  await p.submit();
  assert.equal(calls, 1);
  p.close();
  assert.equal(p.dialog.open, true);
  let prevented = false;
  p.cancel({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  finish({ ok: false, json: async () => ({ error: '保存失败。' }) });
  await saving;
  assert.equal(p.name.value, '续篇');
  assert.equal(p.button.disabled, false);
  assert.equal(p.error.textContent, '保存失败。');
  assert.deepEqual(p.redirects, []);
});

test('排序期间阻止重复请求，网络失败恢复按钮并显示错误，不跳转', async () => {
  let fail, calls = 0;
  const p = page((url, options) => {
    calls++;
    assert.equal(url, '/projects/1/seasons/3/move');
    assert.equal(options.body.get('direction'), 'up');
    return new Promise((resolve, reject) => { fail = reject; });
  });
  const control = { disabled: false, dataset: { moveUrl: '/projects/1/seasons/3/move', direction: 'up' } };
  const moving = p.move(control);
  await p.move(control);
  assert.equal(calls, 1);
  assert.equal(control.disabled, true);
  fail(new TypeError('fetch failed'));
  await moving;
  assert.equal(control.disabled, false);
  assert.match(p.pageError.textContent, /网络连接失败/);
  assert.deepEqual(p.redirects, []);
});
