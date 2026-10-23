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
    'api-test-reference': { hidden: !['image_to_image', 'video'].includes(type) },
    'api-test-reference-image': { files: [], disabled: false },
    'settings-test-output': { textContent: '', hidden: true },
    'settings-test-image': { hidden: true, removeAttribute() { delete this.src; } },
    'api-key': { value: '', required: !id },
    'api-key-state': { textContent: '' },
    'api-base-url': { value: 'http://localhost:3001/v1' },
    'api-model': { value: type === 'llm' ? 'my-model' : 'ironweave', readOnly: type !== 'llm' },
    'api-test-video': { hidden: type !== 'video' },
    'api-test-profile': { value: '0', disabled: false, replaceChildren(...options) { this.options = options; this.value = options[0]?.value || ''; } },
    'api-test-prompt': { value: '  完整提示词\n第二行  ', disabled: false },
    'settings-error': { textContent: '' },
    'settings-status': { textContent: '', dataset: {} },
  };
  const redirects = [];
  runInNewContext(script, {
    document: { getElementById: key => nodes[key], createElement: () => ({}) },
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
    assert.equal(options.body.getAll('referenceImages').map(file => file.name).join(','), 'reference.png,second.png');
    assert.equal(options.body.get('type'), 'image_to_image');
    return new Promise(resolve => { finish = resolve; });
  }, '3', 'image_to_image');
  await p.check();
  assert.match(p.nodes['settings-error'].textContent, /请先选择/);
  assert.equal(calls, 0);
  p.nodes['api-test-reference-image'].files = [new File(['image'], 'reference.png', { type: 'image/png' }), new File(['second'], 'second.png', { type: 'image/png' })];
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


test('视频测试真实事件发送五张有序参考、已选 profile 和原文提示词，结果不放入 img', async () => {
  let calls = 0;
  const p = page(async (url, options) => {
    calls++;
    assert.equal(url, '/settings/api/3/check');
    assert.ok(options.body instanceof FormData);
    assert.equal(options.body.get('profileIndex'), '0');
    assert.equal(options.body.get('prompt'), '  完整提示词\n第二行  ');
    assert.equal(options.body.get('apiKey'), null);
    assert.equal(options.body.get('referenceImage'), null);
    assert.deepEqual(options.body.getAll('referenceImages').map(file => file.name), ['0.png','1.png','2.png','3.png','4.png']);
    return { ok: true, json: async () => ({ kind: 'video', verified: true, operation: { mediaUrl: '/operations/test/media' }, message: '视频已保存，请在操作历史查看。' }) };
  }, '3', 'video');
  assert.equal(p.nodes['api-test-reference'].hidden, false);
  p.nodes['api-test-reference-image'].files = Array.from({length:5}, (_, i) => new File([String(i)], `${i}.png`, {type:'image/png'}));
  await p.check(); assert.equal(calls, 1);
  assert.equal(p.nodes['settings-test-image'].hidden, true); assert.equal(p.nodes['settings-test-image'].src, undefined);
  assert.equal(p.nodes['settings-status'].dataset.state, 'verified');
});

test('前端图片数量、合计和单张限制先阻止请求，视频空提示词和未选组合不提交', async () => {
  let calls=0;
  const p = page(async () => { calls++; }, '3', 'video');
  for (const files of [Array.from({length:52},()=>({size:1})), [{size:32*1024*1024+1}], [{size:17*1024*1024},{size:17*1024*1024}]]) {
    p.nodes['api-test-reference-image'].files=files; await p.check(); assert.equal(calls,0);
  }
  p.nodes['api-test-reference-image'].files=[];
  p.nodes['api-test-prompt'].value=' '; await p.check(); assert.equal(calls,0);
  p.nodes['api-test-prompt'].value='完整提示词'; p.nodes['api-test-profile'].value=''; await p.check(); assert.equal(calls,0);
});

test('保存媒体不发送协议选择且固定模型，文字模型独立可编辑', async () => {
  const requests=[];
  const p=page(async (_url, options)=>{ requests.push(options.body); return {ok:true,json:async()=>({...result,type:options.body.get('type'),model:options.body.get('model')})}; },'3','llm');
  p.edit('api-model','chat-custom'); await p.save(); assert.equal(requests.at(-1).get('model'),'chat-custom');
  p.choose('video'); assert.equal(p.nodes['api-model'].readOnly,true); await p.save();
  assert.equal(requests.at(-1).get('model'),'ironweave'); assert.equal(requests.at(-1).get('protocol'),null);
  p.choose('llm'); assert.equal(p.nodes['api-model'].readOnly,false); assert.equal(p.nodes['api-model'].value,'chat-custom');
});


test('无参考视频的 12000 字中文提示词使用 FormData，原文和费用确认不变', async () => {
  const prompt = '字'.repeat(12000);
  let body;
  const p = page(async (_url, options) => {
    body = options.body;
    return { ok: true, json: async () => ({ kind: 'video', verified: true, message: '视频已保存。' }) };
  }, '3', 'video');
  p.nodes['api-test-prompt'].value = prompt;
  await p.check();
  assert.ok(body instanceof FormData);
  assert.equal(body.get('prompt'), prompt);
  assert.equal(body.get('profileIndex'), '0');
  assert.equal(body.get('chargeConfirmed'), 'yes');
  assert.equal(body.get('apiKey'), null);
  assert.equal(body.getAll('referenceImages').length, 0);
  assert.equal(p.confirmations.length, 1);
  assert.equal(p.nodes['settings-status'].dataset.state, 'verified');
});
