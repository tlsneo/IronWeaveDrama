import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const script = await readFile(new URL('../public/character-reference.js', import.meta.url), 'utf8');
function page(fetch, decode = async () => {}) {
  const events = {}, nodes = {};
  let reloads = 0, picks = 0, revoked = 0;
  const node = id => ({ disabled: false, inert: false, textContent: '', dataset: {}, addEventListener(event, handler) { events[`${id}:${event}`] = handler; } });
  for (const id of ['character-generation-form', 'character-form', 'upload-character-reference', 'clear-character-reference', 'character-reference-file', 'character-generation-error']) nodes[id] = node(id);
  nodes['character-generation-form'].dataset = { referenceId: '7', referenceUrl: '/projects/1/characters/2/reference-image' };
  Object.assign(nodes['character-reference-file'], { files: [new Blob(['png'], { type: 'image/png' })], value: 'selected.png', click() { picks++; } });
  nodes['upload-character-reference'].textContent = '替换图片'; nodes['clear-character-reference'].textContent = '移除参考图';
  runInNewContext(script, {
    document: { getElementById: id => nodes[id] },
    window: { location: { reload() { reloads++; } }, addEventListener(event, handler) { events[event] = handler; } },
    Image: class { naturalWidth = 16; naturalHeight = 9; decode = decode; },
    URL: { createObjectURL: () => 'blob:preview', revokeObjectURL() { revoked++; } }, fetch, FormData, URLSearchParams, TypeError, Error,
  });
  return { nodes, pick: () => events['upload-character-reference:click'](), upload: () => events['character-reference-file:change'](), clear: () => events['clear-character-reference:click'](), beforeUnload: event => events.beforeunload(event), reloads: () => reloads, picks: () => picks, revoked: () => revoked };
}

test('上传只打开选图器；保存参考图时锁定资料和生成操作、防重复上传，成功刷新以自动切换 API，不触发生图', async () => {
  let calls = 0, finish;
  const p = page((url, options) => {
    calls++;
    assert.equal(url, '/projects/1/characters/2/reference-image');
    assert.equal(options.body.get('referenceId'), '7');
    assert.ok(options.body.get('referenceImage') instanceof Blob);
    return new Promise(resolve => { finish = resolve; });
  });
  p.pick(); assert.equal(p.picks(), 1); assert.equal(calls, 0);
  const pending = p.upload();
  assert.equal(p.nodes['upload-character-reference'].textContent, '上传中…');
  assert.equal(p.nodes['character-generation-form'].inert, true);
  await p.upload(); await p.clear(); assert.equal(calls, 1);
  let prevented = false; p.beforeUnload({ preventDefault() { prevented = true; } }); assert.equal(prevented, true);
  finish({ ok: true, json: async () => ({ referenceId: 8 }) }); await pending;
  assert.equal(p.reloads(), 1); assert.equal(p.revoked(), 1);
  prevented = false; p.beforeUnload({ preventDefault() { prevented = true; } }); assert.equal(prevented, false);
  assert.equal(p.nodes['character-generation-form'].inert, true);
});

test('未保存资料、生成中、超大文件及不能解码的图片在上传前拒绝；失败恢复按钮并保留资料，不自动重试', async () => {
  let calls = 0;
  const p = page(async () => { calls++; return { ok: false, json: async () => ({ error: '旧页面参考图已变化' }) }; });
  p.nodes['character-form'].dataset.dirty = 'true'; await p.upload(); assert.equal(calls, 0);
  p.nodes['character-form'].dataset.dirty = ''; p.nodes['character-generation-form'].inert = true;
  await p.upload(); assert.equal(calls, 0); p.nodes['character-generation-form'].inert = false;
  p.nodes['character-reference-file'].files = [{ size: 6 * 1024 * 1024 }]; await p.upload();
  assert.match(p.nodes['character-generation-error'].textContent, /5 MiB/); assert.equal(calls, 0);
  p.nodes['character-reference-file'].files = [new Blob(['png'])]; await p.upload();
  assert.equal(calls, 1); assert.match(p.nodes['character-generation-error'].textContent, /已变化/);
  assert.equal(p.nodes['character-form'].inert, false); assert.equal(p.nodes['upload-character-reference'].textContent, '替换图片');
  const bad = page(() => { throw new Error('不应上传坏图片'); }, async () => { throw new Error('decode'); });
  await bad.upload(); assert.match(bad.nodes['character-generation-error'].textContent, /图片无法读取/);
  assert.equal(bad.revoked(), 1);
});

test('移除只提交当前参考图 ID，不触发生图；网络失败提示刷新确认，不清空资料也不自动重试', async () => {
  let calls = 0;
  const p = page(async (url, options) => {
    calls++; assert.equal(url, '/projects/1/characters/2/clear-reference');
    assert.equal(options.body.toString(), 'referenceId=7'); throw new TypeError('network');
  });
  await p.clear(); assert.equal(calls, 1); assert.equal(p.reloads(), 0);
  assert.equal(p.nodes['character-generation-form'].dataset.referenceId, '7');
  assert.match(p.nodes['character-generation-error'].textContent, /刷新查看/);
  assert.equal(p.nodes['clear-character-reference'].disabled, false);
});
