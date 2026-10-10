import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const script = await readFile(new URL('../public/character-images.js', import.meta.url), 'utf8');
function page(fetch) {
  const events = {};
  let reloads = 0;
  const nodes = {
    'character-generation-form': { dataset: { url: '/projects/1/characters/2/generate', revision: 'revision' }, addEventListener(event, handler) { events[event] = handler; } },
    'character-form': { dataset: {}, inert: false },
    'generate-character-image': { disabled: false, textContent: '生成图片', addEventListener(event, handler) { events.click = handler; } },
    'character-image-api': { value: '3', selectedOptions: [{ dataset: { model: 'image-model', baseUrl: 'https://provider.test/v1' } }] },
    'character-generation-error': { textContent: '' }, 'character-generation-status': { textContent: '' },
    'character-board-link': { hidden: false, href: '/old-image' },
    'character-board-image': { src: '/old-image' },
    'character-board-empty': { hidden: true }, 'character-board-note': { textContent: '' },
  };
  runInNewContext(script, { document: { getElementById: id => nodes[id] }, window: { confirm: () => { throw new Error('角色生成不应弹出确认窗口'); }, location: { reload() { reloads++; } }, addEventListener(event, handler) { events[event] = handler; } }, fetch, URLSearchParams, TypeError, Error });
  return { nodes, click: () => events.click(), beforeUnload: event => events.beforeunload(event), reloads: () => reloads };
}

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
