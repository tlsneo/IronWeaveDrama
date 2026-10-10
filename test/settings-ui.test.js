import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const script = await readFile(new URL('../public/settings.js', import.meta.url), 'utf8');

function page(fetch, id = '', type = 'text_to_image') {
  let confirmed = true;
  const confirmations = [];
  const events = {};
  const node = (key, extra = {}) => ({ ...extra, addEventListener(event, handler) { events[`${key}:${event}`] = handler; } });
  const nodes = {
    'api-config-form': node('form', { dataset: { configured: String(Boolean(id)), id } }),
    'api-type': node('type', { value: type, disabled: false }),
    'api-name': { value: '测试接口' },
    'api-config-title': { textContent: '测试接口' },
    'save-api-settings': node('save', { disabled: false, textContent: '保存配置' }),
    'check-api-connection': node('check', { disabled: !id, textContent: '测试模型（可能计费）' }),
    'api-test-reference': { hidden: !['image_to_image', 'image_edit'].includes(type) },
    'api-test-reference-image': { files: [], disabled: false },
    'settings-test-output': { textContent: '', hidden: true },
    'settings-test-image': { hidden: true, removeAttribute() { delete this.src; } },
    'api-key': { value: '', required: !id },
    'api-key-state': { textContent: '' },
    'api-base-url': { value: 'http://localhost:3001/v1' },
    'api-model': { value: 'my-model' },
    'settings-error': { textContent: '' },
    'settings-status': { textContent: '', dataset: {} },
  };
  const redirects = [];
  runInNewContext(script, {
    document: { getElementById: key => nodes[key] },
    window: { location: { assign: url => redirects.push(url) }, confirm: message => { confirmations.push(message); return confirmed; }, addEventListener: (event, handler) => { events[event] = handler; } },
    FormData: class {
      constructor(form) {
        if (!form) return new FormData();
        return new URLSearchParams({ name: nodes['api-name'].value, type: nodes['api-type'].value, baseUrl: nodes['api-base-url'].value, apiKey: nodes['api-key'].value, model: nodes['api-model'].value });
      }
    },
    URLSearchParams, TypeError, Error, fetch,
  });
  return {
    nodes, redirects, confirmations,
    confirm(value) { confirmed = value; },
    save: () => events['form:submit']({ preventDefault() {} }),
    check: () => events['check:click'](),
    edit(key, value) { nodes[key].value = value; events['form:input'](); },
    choose(value) { nodes['api-type'].value = value; events['form:change'](); },
    beforeUnload: event => events.beforeunload(event),
  };
}

const result = { id: 3, name: '测试接口', type: 'text_to_image', baseUrl: 'http://localhost:3001/v1', model: 'my-model', hasApiKey: true, message: '配置已保存。' };

test('添加配置保存失败保留输入、锁定表单并防止重复提交；成功回到卡片列表，不连续创建重复卡片', async () => {
  let finish, calls = 0;
  const p = page((url, options) => {
    calls++;
    assert.equal(url, calls <= 2 ? '/settings/api' : '/settings/api/3');
    assert.equal(options.body.get('name'), '测试接口');
    assert.equal(options.body.get('apiKey'), calls <= 2 ? 'typed-key' : '');
    return new Promise(resolve => { finish = resolve; });
  });
  p.edit('api-key', 'typed-key');
  const saving = p.save();
  assert.equal(p.nodes['api-config-form'].inert, true);
  assert.equal(p.nodes['api-type'].disabled, true);
  await p.save();
  assert.equal(calls, 1);
  finish({ ok: false, json: async () => ({ error: '保存失败。' }) });
  await saving;
  assert.equal(p.nodes['api-key'].value, 'typed-key');
  assert.equal(p.nodes['settings-error'].textContent, '保存失败。');
  assert.equal(p.nodes['api-config-form'].inert, false);
  const retry = p.save();
  finish({ ok: true, json: async () => result });
  await retry;
  assert.equal(p.nodes['api-key'].value, '');
  assert.equal(p.nodes['api-key'].required, false);
  assert.equal(p.nodes['api-config-form'].dataset.id, '3');
  assert.equal(p.nodes['check-api-connection'].disabled, false);
  assert.deepEqual(p.redirects, ['/settings']);
  const nextSave = p.save();
  finish({ ok: true, json: async () => result });
  await nextSave;
  assert.equal(calls, 3);
  assert.deepEqual(p.redirects, ['/settings']);
});

test('卡片详情按 ID 编辑，选择类型不跳走、不清空连接资料；保存后更新标题', async () => {
  const p = page(async (url, options) => {
    assert.equal(url, '/settings/api/3');
    assert.equal(options.body.get('type'), 'llm');
    assert.equal(options.body.get('name'), '语言模型接口');
    return { ok: true, json: async () => ({ ...result, name: '语言模型接口', type: 'llm' }) };
  }, '3');
  p.choose('llm');
  assert.deepEqual(p.redirects, []);
  assert.equal(p.nodes['api-base-url'].value, 'http://localhost:3001/v1');
  assert.equal(p.nodes['check-api-connection'].disabled, true);
  p.edit('api-name', '语言模型接口');
  await p.save();
  assert.equal(p.nodes['api-config-title'].textContent, '语言模型接口');
  assert.equal(p.nodes['api-type'].value, 'llm');
  assert.equal(p.nodes['settings-status'].dataset.state, 'saved');
  assert.deepEqual(p.redirects, []);
});

test('实际测试必须确认计费，按配置 ID 请求，不携带浏览器密钥；展示真实文本，配置未保存不测试', async () => {
  let calls = 0;
  const p = page(async (url, options) => {
    calls++;
    assert.equal(url, '/settings/api/3/check');
    assert.equal(options.body.get('chargeConfirmed'), 'yes');
    assert.equal(options.body.get('type'), 'llm');
    assert.equal(options.body.get('model'), 'my-model');
    assert.equal(options.body.get('baseUrl'), 'http://localhost:3001/v1');
    assert.equal(options.body.get('apiKey'), null);
    return { ok: true, json: async () => ({ verified: true, kind: 'text', text: 'OK', message: '模型实际调用成功。' }) };
  }, '3', 'llm');
  p.confirm(false);
  await p.check();
  assert.equal(calls, 0);
  p.confirm(true);
  await p.check();
  assert.equal(calls, 1);
  assert.match(p.confirmations[0], /可能消耗额度或扣费/);
  assert.equal(p.nodes['settings-status'].dataset.state, 'verified');
  assert.equal(p.nodes['settings-test-output'].textContent, 'OK');
  assert.equal(p.nodes['settings-test-output'].hidden, false);
  p.edit('api-base-url', 'http://new-service/v1');
  await p.check();
  assert.equal(calls, 1);
});

test('图生图测试先选参考图，提交 multipart；测试时阻止重复请求及离开，图片加载失败不冒充成功', async () => {
  let finish, calls = 0;
  const p = page((url, options) => {
    calls++;
    assert.equal(options.body.get('referenceImage').name, 'reference.png');
    assert.equal(options.body.get('type'), 'image_to_image');
    return new Promise(resolve => { finish = resolve; });
  }, '3', 'image_to_image');
  await p.check();
  assert.match(p.nodes['settings-error'].textContent, /请先选择/);
  assert.equal(calls, 0);
  p.nodes['api-test-reference-image'].files = [new File(['image'], 'reference.png', { type: 'image/png' })];
  const checking = p.check();
  await p.check();
  assert.equal(calls, 1);
  assert.equal(p.nodes['api-test-reference-image'].disabled, true);
  let prevented = false;
  p.beforeUnload({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  finish({ ok: true, json: async () => ({ verified: true, kind: 'image', image: 'https://image.test/result.png', message: '图片调用成功。' }) });
  await checking;
  assert.equal(p.nodes['settings-test-image'].src, 'https://image.test/result.png');
  assert.equal(p.nodes['settings-status'].dataset.state, 'pending');
  p.nodes['settings-test-image'].onload();
  assert.equal(p.nodes['settings-status'].dataset.state, 'verified');
  p.nodes['settings-test-image'].onerror();
  assert.equal(p.nodes['settings-status'].dataset.state, 'unverified');
  assert.match(p.nodes['settings-error'].textContent, /图片无法显示/);
  assert.equal(p.nodes['api-test-reference-image'].disabled, false);
});

test('实际测试网络失败提示可能已经扣费，不自动重试，也不留下成功状态', async () => {
  let calls = 0;
  const p = page(async () => { calls++; throw new TypeError('fetch failed'); }, '3');
  await p.check();
  assert.equal(calls, 1);
  assert.match(p.nodes['settings-error'].textContent, /可能已计费/);
  assert.equal(p.nodes['settings-status'].dataset.state, 'unverified');
  assert.equal(p.nodes['check-api-connection'].disabled, false);
});

test('列表页无需详情表单也能切换类型筛选，不发起模型请求', () => {
  const redirects = [];
  let change;
  const filter = { value: 'llm', addEventListener(event, handler) { change = handler; } };
  runInNewContext(script, {
    document: { getElementById: id => id === 'api-filter' ? filter : null },
    window: { location: { assign: url => redirects.push(url) } },
  });
  change();
  filter.value = 'all';
  change();
  assert.deepEqual(redirects, ['/settings?type=llm', '/settings']);
});

test('未保存修改离开时提醒，网络错误保留输入；未保存的新配置不会检查连接', async () => {
  let calls = 0;
  const p = page(async () => { calls++; throw new TypeError('fetch failed'); });
  await p.check();
  assert.equal(calls, 0);
  let prevented = false;
  const event = { preventDefault() { prevented = true; } };
  p.beforeUnload(event);
  assert.equal(prevented, false);
  p.edit('api-key', 'typed-key');
  p.beforeUnload(event);
  assert.equal(prevented, true);
  await p.save();
  assert.equal(calls, 1);
  assert.equal(p.nodes['api-key'].value, 'typed-key');
  assert.match(p.nodes['settings-error'].textContent, /网络连接失败/);
  assert.equal(p.nodes['save-api-settings'].disabled, false);
});
