import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const script = await readFile(new URL('../public/delete.js', import.meta.url), 'utf8');
function page(fetch) {
  const events = {};
  const redirects = [], confirmations = [];
  let confirmed = true;
  const main = { inert: false };
  const error = { textContent: '' };
  const characterForm = { dataset: { dirty: 'true' } };
  const button = { disabled: false, textContent: '删除', dataset: { deleteUrl: '/projects/1/characters/2/delete', deleteName: '林秋', deleteMessage: '确定删除林秋？角色和图片将删除，无法恢复。' }, closest: () => main.inert ? main : null };
  runInNewContext(script, {
    document: { getElementById: id => id === 'delete-error' ? error : id === 'character-form' ? characterForm : null, querySelector: () => main, addEventListener: (event, handler) => { events[event] = handler; } },
    window: { confirm(message) { confirmations.push(message); return confirmed; }, location: { assign: url => redirects.push(url) }, addEventListener: (event, handler) => { events[event] = handler; } },
    fetch, URLSearchParams, Error, TypeError,
  });
  return { main, error, button, characterForm, redirects, confirmations, confirm(value) { confirmed = value; }, click: () => events.click({ target: { closest: () => button }, preventDefault() {} }), beforeUnload: event => events.beforeunload(event) };
}

test('删除必须先确认，取消不发送请求；确认后显示删除中、防重复请求，成功只跳转一次且不再弹未保存提醒', async () => {
  let calls = 0, finish;
  const p = page((url, options) => {
    calls++;
    assert.equal(url, '/projects/1/characters/2/delete');
    assert.equal(options.body.get('confirmed'), 'yes');
    assert.equal(options.body.get('name'), '林秋');
    return new Promise(resolve => { finish = resolve; });
  });
  p.confirm(false); await p.click();
  assert.equal(calls, 0); assert.equal(p.main.inert, false);
  p.confirm(true);
  const pending = p.click();
  assert.equal(p.button.textContent, '删除中…');
  assert.equal(p.button.disabled, true);
  assert.equal(p.main.inert, true);
  await p.click();
  assert.equal(calls, 1);
  assert.match(p.confirmations[0], /角色和图片/);
  let prevented = false;
  p.beforeUnload({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  finish({ ok: true, json: async () => ({ deleted: true, redirect: '/projects/1?resource=characters' }) });
  await pending;
  assert.deepEqual(p.redirects, ['/projects/1?resource=characters']);
  assert.equal(p.characterForm.dataset.dirty, '');
});

test('删除失败保留页面与编辑输入，恢复按钮；网络失败只提示刷新，不自动重试', async () => {
  const p = page(async () => ({ ok: false, json: async () => ({ error: '角色正在生成，请稍后删除。' }) }));
  await p.click();
  assert.deepEqual(p.redirects, []);
  assert.equal(p.characterForm.dataset.dirty, 'true');
  assert.equal(p.button.disabled, false);
  assert.equal(p.button.textContent, '删除');
  assert.equal(p.main.inert, false);
  assert.match(p.error.textContent, /正在生成/);
  let calls = 0;
  const failure = page(async () => { calls++; throw new TypeError('network'); });
  await failure.click();
  assert.equal(calls, 1);
  assert.match(failure.error.textContent, /刷新页面查看/);
  assert.deepEqual(failure.redirects, []);
});

test('其他操作锁定表单时不弹删除确认，也不发送请求', async () => {
  let calls = 0;
  const p = page(async () => { calls++; });
  p.main.inert = true;
  await p.click();
  assert.equal(calls, 0);
  assert.deepEqual(p.confirmations, []);
});
