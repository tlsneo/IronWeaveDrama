import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const script = await readFile(new URL('../public/episode-script.js', import.meta.url), 'utf8');
function page(fetch, confirmed = true) {
  const events = {}, nodes = {}, main = { inert: false }, details = { open: false };
  let confirmations = 0;
  for (const id of ['episode-script-form', 'episode-script-source', 'episode-script-text', 'episode-script-notes', 'episode-script-api', 'generate-episode-script', 'save-episode-script', 'episode-script-error', 'episode-script-status', 'episode-script-recovery', 'episode-script-recovery-text']) {
    nodes[id] = { value: '', textContent: '', disabled: false, dataset: {}, focus() {}, closest: () => details, addEventListener(event, handler) { events[`${id}:${event}`] = handler; } };
  }
  nodes['episode-script-form'].dataset = { url: '/projects/1/episodes/2/script', generateUrl: '/projects/1/episodes/2/generate-script', revision: '0' };
  nodes['episode-script-source'].value = '原小说片段';
  Object.assign(nodes['episode-script-api'], { value: '3', selectedOptions: [{ dataset: { model: 'writer-model', baseUrl: 'https://writer.test/v1' } }] });
  nodes['generate-episode-script'].textContent = '生成剧本'; nodes['save-episode-script'].textContent = '保存剧本';
  nodes['episode-script-recovery'].hidden = true;
  runInNewContext(script, {
    document: { getElementById: id => nodes[id], querySelector: () => main },
    window: { confirm() { confirmations++; return confirmed; }, addEventListener(event, handler) { events[event] = handler; } },
    URLSearchParams, TypeError, Error, fetch,
  });
  return { nodes, main, details, confirmations: () => confirmations,
    generate: () => events['generate-episode-script:click'](), save: () => events['episode-script-form:submit']({ preventDefault() {} }),
    input(id, value) { nodes[id].value = value; events['episode-script-form:input']({ target: nodes[id] }); },
    beforeUnload: event => events.beforeunload(event),
  };
}
const ok = result => ({ ok: true, json: async () => result });

test('首次点击直接生成，先保存原文再请求所选模型；锁定操作、防重复请求，成功回填并显示说明，不弹首次付费确认', async () => {
  const calls = []; let finish, started;
  const atModel = new Promise(resolve => { started = resolve; });
  const p = page((url, options) => {
    calls.push({ url, body: options.body });
    if (url.endsWith('/script')) return Promise.resolve(ok({ revision: 1 }));
    started(); return new Promise(resolve => { finish = resolve; });
  });
  const pending = p.generate();
  assert.equal(p.nodes['generate-episode-script'].textContent, '生成中…'); assert.equal(p.main.inert, true);
  await p.generate(); await p.save(); await atModel;
  assert.equal(calls.length, 2); assert.equal(calls[0].body.get('source'), '原小说片段');
  assert.equal(calls[0].body.get('revision'), '0'); assert.equal(calls[1].body.get('revision'), '1');
  assert.equal(calls[1].body.get('apiConfigId'), '3'); assert.equal(calls[1].body.get('model'), 'writer-model');
  assert.equal(calls[1].body.has('source'), false); assert.equal(p.confirmations(), 0);
  let prevented = false; p.beforeUnload({ preventDefault() { prevented = true; } }); assert.equal(prevented, true);
  finish(ok({ script: '场1\n赵孟华\n你在干什么？', notes: '合并准备过程', revision: 2, message: '已生成并保存' })); await pending;
  assert.equal(p.nodes['episode-script-text'].value, '场1\n赵孟华\n你在干什么？');
  assert.equal(p.nodes['episode-script-notes'].value, '合并准备过程'); assert.equal(p.details.open, true);
  assert.equal(p.nodes['episode-script-form'].dataset.revision, '2'); assert.equal(p.main.inert, false);
  prevented = false; p.beforeUnload({ preventDefault() { prevented = true; } }); assert.equal(prevented, false);
});

test('手动修改提醒离开，保存只保存、不生图不生成剧本；保存失败保留输入，恢复按钮', async () => {
  let calls = 0, finish;
  const p = page((url, options) => {
    calls++; assert.equal(url, '/projects/1/episodes/2/script'); assert.equal(options.body.get('script'), '人工修改稿');
    return new Promise(resolve => { finish = resolve; });
  });
  p.input('episode-script-text', '人工修改稿');
  let prevented = false; p.beforeUnload({ preventDefault() { prevented = true; } }); assert.equal(prevented, true);
  const pending = p.save(); await p.save(); assert.equal(calls, 1);
  assert.equal(p.nodes['save-episode-script'].textContent, '保存中…');
  finish({ ok: false, json: async () => ({ error: '旧页面版本已变化' }) }); await pending;
  assert.equal(p.nodes['episode-script-text'].value, '人工修改稿'); assert.equal(p.nodes['episode-script-form'].dataset.dirty, 'true');
  assert.equal(p.nodes['save-episode-script'].disabled, false); assert.equal(p.main.inert, false);
  const retry = p.save(); finish(ok({ revision: 1 })); await retry;
  assert.equal(calls, 2); assert.equal(p.nodes['episode-script-form'].dataset.dirty, '');
});

test('空原文、缺少 API 和取消覆盖不发请求；已有稿件重新生成必须确认，当前修改先保存，失败不覆盖旧稿', async () => {
  let calls = 0;
  const p = page(async url => {
    calls++; return url.endsWith('/script') ? ok({ revision: 2 }) : { ok: false, json: async () => ({ error: '服务不可用' }) };
  });
  p.nodes['episode-script-source'].value = ''; await p.generate(); assert.equal(calls, 0);
  p.nodes['episode-script-source'].value = '原文'; p.nodes['episode-script-api'].value = '';
  await p.generate(); assert.match(p.nodes['episode-script-error'].textContent, /模型配置/); assert.equal(calls, 0);
  p.nodes['episode-script-api'].value = '3'; p.input('episode-script-text', '现有修改稿');
  await p.generate(); assert.equal(p.confirmations(), 1); assert.equal(calls, 2);
  assert.equal(p.nodes['episode-script-text'].value, '现有修改稿'); assert.equal(p.nodes['episode-script-form'].dataset.revision, '2');
  assert.match(p.nodes['episode-script-error'].textContent, /服务不可用/);
  const cancel = page(() => { throw new Error('取消不得提交'); }, false);
  cancel.input('episode-script-text', '保留我'); await cancel.generate();
  assert.equal(cancel.confirmations(), 1); assert.equal(cancel.nodes['episode-script-text'].value, '保留我');
});

test('保存失败不开始模型调用；生成网络失败提示可能计费，不自动重试；已保存原文和旧剧本保留', async () => {
  let calls = 0;
  const p = page(async () => { calls++; throw new TypeError('network'); });
  await p.generate(); assert.equal(calls, 1); assert.match(p.nodes['episode-script-error'].textContent, /保存结果未确认/);
  p.nodes['episode-script-form'].dataset.revision = '1';
  await p.generate(); assert.equal(calls, 2); assert.match(p.nodes['episode-script-error'].textContent, /可能已计费/);
  assert.equal(p.nodes['episode-script-source'].value, '原小说片段'); assert.equal(p.main.inert, false);
  assert.equal(p.nodes['generate-episode-script'].disabled, false);
  const malformed = page(async () => ({ ok: true, json: async () => { throw new SyntaxError('truncated response'); } }));
  malformed.nodes['episode-script-form'].dataset.revision = '1';
  await malformed.generate(); assert.match(malformed.nodes['episode-script-error'].textContent, /可能已计费/);
});

test('生成内容保存失败或格式不合格时独立展示取回文本，不覆盖编辑框、不执行 HTML，离开时提醒保留', async () => {
  const raw = '<script>alert(1)</script>未保存稿件';
  const p = page(async () => ({ ok: false, json: async () => ({ error: '模型格式不合格', recoveryText: raw }) }));
  p.nodes['episode-script-form'].dataset.revision = '1'; p.nodes['episode-script-text'].value = '旧稿';
  await p.generate();
  assert.equal(p.nodes['episode-script-text'].value, '旧稿'); assert.equal(p.nodes['episode-script-recovery'].hidden, false);
  assert.equal(p.nodes['episode-script-recovery-text'].value, raw);
  let prevented = false; p.beforeUnload({ preventDefault() { prevented = true; } }); assert.equal(prevented, true);
});
