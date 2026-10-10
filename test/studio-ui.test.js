import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const script = await readFile(new URL('../public/studio.js', import.meta.url), 'utf8');

function page(fetch, characterValues) {
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
  const characterButton = { disabled: false, textContent: '保存资料' };
  const characterError = { textContent: '' };
  if (characterValues) {
    nodes['character-form'] = {
      dataset: { url: '/projects/1/characters/2' },
      querySelector: () => characterButton,
      addEventListener: (event, handler) => { events[`character${event}`] = handler; },
    };
    nodes['character-error'] = characterError;
  }
  const redirects = [];
  runInNewContext(script, {
    document: {
      getElementById: id => nodes[id],
      addEventListener: (event, handler) => { events.click = handler; },
    },
    window: { location: { assign: url => redirects.push(url) }, addEventListener: (event, handler) => { events[event] = handler; } },
    FormData: class { constructor(target) { return new URLSearchParams(target === nodes['character-form'] ? characterValues : { name: name.value, seasonId: season.value }); } },
    URLSearchParams, TypeError, Error, fetch,
  });
  return {
    nodes, name, season, button, error, pageError, dialog, redirects,
    open: data => events.click({ target: { closest: selector => selector === '[data-name-dialog]' ? { dataset: data } : null } }),
    move: element => events.click({ target: { closest: selector => selector === '[data-move-url]' ? element : null } }),
    submit: () => events.submit({ preventDefault() {} }),
    close: () => events.close(),
    cancel: event => events.cancel(event),
    characterValues, characterButton, characterError,
    submitCharacter: () => events.charactersubmit({ preventDefault() {} }),
    changeCharacter(key, value) { characterValues[key] = value; events.characterinput(); },
    beforeUnload: event => events.beforeunload(event),
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
  assert.equal(p.nodes['name-form'].inert, false);
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

test('创建角色复用名称弹窗，无默认示例名称，保存后回到角色卡片列表', async () => {
  const p = page(async (url, options) => {
    assert.equal(url, '/projects/1/characters');
    assert.equal(options.body.get('name'), '林秋');
    return { ok: true, json: async () => ({ redirect: '/projects/1?resource=characters' }) };
  });
  await p.open({ title: '创建角色', name: '', seasonId: '', url: '/projects/1/characters' });
  assert.equal(p.name.value, '');
  assert.equal(p.nodes['name-dialog-title'].textContent, '创建角色');
  p.name.value = '林秋';
  await p.submit();
  assert.deepEqual(p.redirects, ['/projects/1?resource=characters']);
});

test('角色编辑失败保留输入并允许重试，保存期间锁定表单、防止重复提交和后续输入丢失', async () => {
  let finish, calls = 0;
  const p = page((url, options) => {
    calls++;
    assert.equal(url, '/projects/1/characters/2');
    assert.equal(options.body.get('faceFeatures'), '圆脸');
    return new Promise(resolve => { finish = resolve; });
  }, { name: '林秋', age: '27', faceFeatures: '' });
  p.changeCharacter('faceFeatures', '圆脸');
  const pending = p.submitCharacter();
  assert.equal(p.characterButton.disabled, true);
  assert.equal(p.nodes['character-form'].inert, true);
  await p.submitCharacter();
  assert.equal(calls, 1);
  finish({ ok: false, json: async () => ({ error: '暂时无法保存。' }) });
  await pending;
  assert.equal(p.characterValues.faceFeatures, '圆脸');
  assert.equal(p.characterError.textContent, '暂时无法保存。');
  assert.equal(p.characterButton.disabled, false);
  assert.equal(p.nodes['character-form'].inert, false);
  assert.equal(p.nodes['character-form'].dataset.dirty, 'true');
  assert.deepEqual(p.redirects, []);
  const retry = p.submitCharacter();
  finish({ ok: true, json: async () => ({ redirect: '/projects/1?resource=characters&character=2' }) });
  await retry;
  assert.equal(calls, 2);
  assert.equal(p.characterError.textContent, '');
  assert.equal(p.characterButton.textContent, '保存资料');
  assert.deepEqual(p.redirects, ['/projects/1?resource=characters&character=2']);
});

test('角色未保存修改离开页面时提醒，保存成功后清除提醒再跳转', async () => {
  const p = page(async () => ({ ok: true, json: async () => ({ redirect: '/projects/1?resource=characters&character=2' }) }), { name: '林秋' });
  let prevented = false;
  const event = { preventDefault() { prevented = true; } };
  p.beforeUnload(event);
  assert.equal(prevented, false);
  p.changeCharacter('name', '林秋新版');
  p.beforeUnload(event);
  assert.equal(prevented, true);
  await p.submitCharacter();
  prevented = false;
  p.beforeUnload(event);
  assert.equal(prevented, false);
  assert.equal(p.nodes['character-form'].dataset.dirty, '');
});
