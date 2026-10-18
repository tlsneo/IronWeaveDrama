import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const script = await readFile(new URL('../public/character-images.js', import.meta.url), 'utf8');
function page(fetch, kind = 'character') {
  const events = {};
  let reloads = 0;
  const nodes = {
    'character-generation-form': { dataset: { url: '/projects/1/characters/2/generate', revision: 'revision', boardId: '7', adult: 'true' }, addEventListener(event, handler) { events[event] = handler; } },
    'character-form': { dataset: {}, inert: false },
    'generate-character-image': { disabled: false, textContent: '生成图片', addEventListener(event, handler) { events.click = handler; } },
    'character-image-size': { value: '1536x864', dataset: { aspectRatio: '16:9' }, addEventListener(event, handler) { events.sizeInput = handler; }, validityMessage: '', setCustomValidity(value) { this.validityMessage = value; }, reportValidity() { return !this.validityMessage; } },
    'character-image-api': { value: '3', selectedOptions: [{ dataset: { model: 'image-model', baseUrl: 'https://provider.test/v1' } }] },
    'edit-character-image': { disabled: false },
    'clear-character-image': { disabled: false, textContent: '清空图像', addEventListener(event, handler) { events.clear = handler; } },
    'character-generation-error': { textContent: '' }, 'character-generation-status': { textContent: '' },
    'character-board-link': { hidden: false, href: '/old-image' },
    'character-board-image': { src: '/old-image' },
    'character-board-empty': { hidden: true }, 'character-board-note': { textContent: '' },
  };
  if (kind === 'scene') { nodes['character-generation-form'].dataset.kind = 'scene'; nodes['character-generation-form'].dataset.url = '/projects/1/scenes/2/generate'; }
  runInNewContext(script, { document: { getElementById: id => kind === 'scene' ? id.includes('character') ? undefined : nodes[id.replace('scene', 'character')] : nodes[id] }, window: { confirm: () => { throw new Error('角色生成不应弹出确认窗口'); }, location: { reload() { reloads++; } }, addEventListener(event, handler) { events[event] = handler; } }, fetch, URLSearchParams, TypeError, Error });
  return { nodes, inputSize: () => events.sizeInput(), click: () => events.click(), clear: () => events.clear(), beforeUnload: event => events.beforeunload(event), reloads: () => reloads };
}

test('场景使用同一生成交互，正确提交场景路径与配置／参考图快照，未保存或正在请求时不重复生图', async () => {
  let calls = 0, finish;
  const p = page((url, options) => {
    calls++; assert.equal(url, '/projects/1/scenes/2/generate'); assert.equal(options.body.get('referenceId'), '10');
    assert.equal(options.body.get('revision'), 'revision'); assert.equal(options.body.get('apiConfigId'), '3');
    assert.equal(options.body.has('prompt'), false);
    return new Promise(resolve => { finish = resolve; });
  }, 'scene');
  p.nodes['character-generation-form'].dataset.referenceId = '10';
  p.nodes['character-form'].dataset.dirty = 'true'; await p.click(); assert.equal(calls, 0);
  assert.match(p.nodes['character-generation-error'].textContent, /场景资料/);
  p.nodes['character-form'].dataset.dirty = ''; const pending = p.click(); await p.click(); assert.equal(calls, 1);
  finish({ ok: true, json: async () => ({ valid: false, imageUrl: '/projects/1/scenes/2/images/8', message: '未替换原场景参考图' }) }); await pending;
  assert.equal(p.nodes['character-board-image'].src, '/projects/1/scenes/2/images/8'); assert.equal(p.reloads(), 0);
  assert.equal(p.nodes['character-generation-form'].dataset.boardId, '8');
});

test('场景清空与失败恢复复用同一交互，不调用角色路径，付费失败不自动重试', async () => {
  let calls = 0; const p = page(async (url, options) => {
    calls++; assert.equal(url, '/projects/1/scenes/2/clear-image'); assert.equal(options.body.get('boardId'), '7'); return { ok: true, json: async () => ({ cleared: true }) };
  }, 'scene');
  await p.clear(); assert.equal(calls, 1); assert.equal(p.reloads(), 1);
  const failed = page(async () => { throw new TypeError('network'); }, 'scene'); await failed.click();
  assert.match(failed.nodes['character-generation-error'].textContent, /刷新场景页.*可能已计费/); assert.equal(failed.reloads(), 0);
  const recovery = page(async () => ({ ok: false, json: async () => ({ recoveryImage: 'data:image/png;base64,eA==', error: '保存失败' }) }), 'scene');
  await recovery.click(); assert.match(recovery.nodes['character-board-note'].textContent, /原场景参考图不变/); assert.equal(recovery.nodes['clear-character-image'].disabled, true);
});

test('资料已保存时点击直接生图，不弹确认窗；按钮变为生成中并防重复请求，成功刷新预览', async () => {
  let calls = 0, finish;
  const p = page((url, options) => {
    calls++;
    assert.equal(url, '/projects/1/characters/2/generate');
    assert.equal(options.body.get('apiConfigId'), '3');
    assert.equal(options.body.get('chargeConfirmed'), 'yes');
    assert.equal(options.body.get('revision'), 'revision');
    assert.equal(options.body.get('model'), 'image-model');
    return new Promise(resolve => { finish = resolve; });
  });
  p.nodes['character-form'].dataset.dirty = 'true';
  await p.click(); assert.equal(calls, 0);
  p.nodes['character-form'].dataset.dirty = '';
  const pending = p.click();
  assert.equal(p.nodes['generate-character-image'].textContent, '生成中…');
  assert.equal(p.nodes['generate-character-image'].disabled, true);
  assert.equal(p.nodes['character-generation-status'].textContent, '');
  await p.click(); assert.equal(calls, 1);
  assert.equal(p.nodes['character-form'].inert, true);
  let prevented = false; p.beforeUnload({ preventDefault() { prevented = true; } }); assert.equal(prevented, true);
  finish({ ok: true, json: async () => ({ valid: true, imageUrl: '/new-image', message: '已保存' }) });
  await pending;
  assert.equal(p.reloads(), 1);
  assert.equal(p.nodes['character-form'].inert, false);
});

test('生成结果直接展示在基础角色板，不另放下面链接；比例不合格提示且旧图记录不被冒充覆盖', async () => {
  const p = page(async () => ({ ok: true, json: async () => ({ valid: false, imageUrl: '/candidate-image', message: '比例不对，原角色板未替换' }) }));
  await p.click();
  assert.equal(p.nodes['character-board-image'].src, '/candidate-image');
  assert.equal(p.nodes['character-board-link'].href, '/candidate-image');
  assert.equal(p.nodes['character-board-empty'].hidden, true);
  assert.match(p.nodes['character-board-note'].textContent, /未替换/);
  assert.equal(p.reloads(), 0);
  assert.equal(p.nodes['generate-character-image'].disabled, false);
});

test('清空图像只提交当前图片 ID，锁定操作并显示清空中，成功刷新；失败不改预览', async () => {
  let calls = 0, finish;
  const p = page((url, options) => {
    calls++;
    assert.equal(url, '/projects/1/characters/2/clear-image');
    assert.equal(options.body.toString(), 'boardId=7');
    return new Promise(resolve => { finish = resolve; });
  });
  const pending = p.clear();
  await p.clear();
  assert.equal(calls, 1);
  assert.equal(p.nodes['clear-character-image'].textContent, '清空中…');
  finish({ ok: true, json: async () => ({ cleared: true }) });
  await pending;
  assert.equal(p.reloads(), 1);
  const failure = page(async () => ({ ok: false, json: async () => ({ error: '清空失败' }) }));
  await failure.clear();
  assert.equal(failure.nodes['character-board-image'].src, '/old-image');
  assert.equal(failure.nodes['clear-character-image'].disabled, false);
});

test('存在参考图时使用页面提供的图生图配置并提交参考图快照，不在浏览器改写 prompt 或偷偷退回文生图', async () => {
  let fields;
  const p = page(async (url, options) => { fields = options.body; return { ok: true, json: async () => ({ valid: true }) }; });
  p.nodes['character-generation-form'].dataset.referenceId = '8';
  p.nodes['character-generation-form'].dataset.apiName = '图生图';
  p.nodes['character-image-api'].value = '';
  await p.click(); assert.match(p.nodes['character-generation-error'].textContent, /图生图配置/); assert.equal(fields, undefined);
  p.nodes['character-image-api'].value = '9';
  await p.click(); assert.equal(fields.get('referenceId'), '8'); assert.equal(fields.get('apiConfigId'), '9');
  assert.equal(fields.has('prompt'), false);
});

test('生成失败保留预览，网络失败警告不要直接重复付费；保存失败时在角色板展示可取回的图片', async () => {
  const p = page(async () => { throw new TypeError('network'); });
  await p.click();
  assert.equal(p.nodes['character-board-image'].src, '/old-image');
  assert.match(p.nodes['character-generation-error'].textContent, /可能已计费/);
  const recovery = page(async () => ({ ok: false, json: async () => ({ error: '保存失败', recoveryImage: 'data:image/png;base64,result' }) }));
  await recovery.click();
  assert.equal(recovery.nodes['character-board-image'].src, 'data:image/png;base64,result');
  assert.match(recovery.nodes['character-board-note'].textContent, /未能保存/);
});

for (const kind of ['character', 'scene']) {
  test(`${kind}浏览器发送用户本次尺寸，坏值不发请求且保留输入`, async () => {
    const calls = [], p = page(async (_url, options) => { calls.push(options.body.get('size')); return { ok: false, json: async () => ({ error: 'controlled failure' }) }; }, kind);
    const size = p.nodes['character-image-size'];
    for (const value of ['', '01536x864', '1536X864', '1536x864\n', '1536 x864', '1024x1024', '16000x9000', '9007199254740992x1']) {
      size.value = value; await p.click(); assert.equal(calls.length, 0); assert.equal(size.value, value);
    }
    size.value = '1536x864'; p.inputSize(); assert.equal(size.validityMessage, '');
    for (const value of ['1536x864', '2560x1440']) { size.value = value; await p.click(); assert.equal(calls.at(-1), value); assert.equal(size.value, value); }
    if (kind === 'scene') { size.dataset.aspectRatio = '9:16'; size.value = '864x1536'; await p.click(); assert.equal(calls.at(-1), '864x1536'); }
  });
}
