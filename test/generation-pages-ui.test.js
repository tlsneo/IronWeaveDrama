import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const script = await readFile(new URL('../public/generation-pages.js', import.meta.url), 'utf8');
const currentUrl = 'https://example.invalid/projects/7?view=production&clip=9#results';
const base = '/projects/7/clips/9';
const ok = result => ({ ok: true, json: async () => result });
const failed = result => ({ ok: false, json: async () => result });
const flush = () => new Promise(resolve => setImmediate(resolve));

function node(properties = {}) {
  const listeners = new Map();
  return {
    dataset: {}, disabled: false, textContent: '',
    addEventListener(type, listener) {
      const handlers = listeners.get(type) ?? [];
      handlers.push(listener); listeners.set(type, handlers);
    },
    fire(type) {
      const event = { prevented: false, preventDefault() { this.prevented = true; } };
      for (const listener of listeners.get(type) ?? []) listener(event);
      return event;
    },
    ...properties,
  };
}
function form(id, path, { clipGenerate = false, fallbackButton = false } = {}) {
  const button = node({ textContent: '提交' });
  return node({
    id, button, action: new URL(path, currentUrl).href,
    fields: [['revision', '3'], ['prompt', '未保存的 <原始提示词>'], ['lookId', '11'], ['lookId', '12']],
    hasAttribute(name) { assert.equal(name, 'data-clip-generate'); return clipGenerate; },
    querySelector(selector) {
      if (selector === '[type="submit"]') return fallbackButton ? null : button;
      assert.equal(selector, 'button'); return button;
    },
  });
}
function operation(path, confirm) {
  return node({ dataset: { operationAction: path, ...(confirm ? { confirm } : {}) } });
}
function browser({ forms = [], operations = [], respond = async () => ok({}), confirm = () => true } = {}) {
  const main = { inert: false }, notice = node(), events = new Map();
  const requests = [], confirmations = [], navigation = [];
  const beforeUnload = () => {
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    events.get('beforeunload')(event);
    if (event.prevented) assert.equal(event.returnValue, '');
    else assert.equal(Object.hasOwn(event, 'returnValue'), false);
    return event.prevented;
  };
  function navigate(kind, url) {
    navigation.push({ kind, url, inert: main.inert,
      disabled: [...forms.map(item => item.button), ...operations].map(item => item.disabled),
      dirty: forms.map(item => item.dataset.dirty), guarded: beforeUnload() });
  }
  const location = { href: currentUrl,
    assign(url) { navigate('assign', url); },
    reload() { navigate('reload', this.href); },
  };
  const send = channel => (url, options) => {
    const request = { channel, url, ...options };
    requests.push(request);
    return respond(request);
  };
  class BrowserFormData extends FormData {
    constructor(target) {
      super();
      assert.ok(forms.includes(target), 'Only registered forms may be serialized');
      for (const [name, value] of target.fields) this.append(name, value);
    }
  }
  runInNewContext(script, {
    document: {
      getElementById(id) {
        if (id === 'generation-notice') return notice;
        assert.equal(id, 'production-clip-form');
        return forms.find(item => item.id === id) ?? null;
      },
      querySelector(selector) { assert.equal(selector, 'main'); return main; },
      querySelectorAll(selector) {
        if (selector === '[data-generation-page]') return forms;
        assert.equal(selector, '[data-operation-action]'); return operations;
      },
    },
    window: {
      IronGeneration: { request: send('IronGeneration') }, location,
      confirm(message) { confirmations.push(message); return confirm(message); },
      addEventListener(type, listener) { assert.equal(type, 'beforeunload'); events.set(type, listener); },
    },
    fetch: send('fetch'), FormData: BrowserFormData, URL, URLSearchParams, Error, TypeError,
  });
  return { main, notice, requests, confirmations, navigation, beforeUnload,
    async fire(target, type) { const event = target.fire(type); await flush(); return event; },
  };
}
function assertNavigation(page, forms, operations = [], redirect) {
  assert.deepEqual(page.navigation, [{ kind: redirect ? 'assign' : 'reload', url: redirect || currentUrl,
    inert: false, disabled: Array(forms.length + operations.length).fill(false),
    dirty: forms.map(() => ''), guarded: false }]);
  assert.equal(page.beforeUnload(), false);
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// Only generation-pages.js runs in this fake browser; no renderer, database or network is loaded.
test('initialization is passive; input/change mark forms dirty and beforeunload guards unsaved input', () => {
  for (const event of ['input', 'change']) {
    const target = form('editor', base), action = operation(`${base}/recover`, '恢复这次操作？');
    const page = browser({ forms: [target], operations: [action] });
    assert.deepEqual(page.requests, []); assert.deepEqual(page.confirmations, []);
    assert.equal(page.beforeUnload(), false); assert.equal(page.main.inert, false);
    target.fire(event);
    assert.equal(target.dataset.dirty, 'true'); assert.equal(page.beforeUnload(), true);
    assert.deepEqual(page.requests, []); assert.deepEqual(page.confirmations, []);
  }
  assert.equal(browser().beforeUnload(), false);
});

test('generate/recover use IronGeneration, save/adopt use fetch; success reloads results or follows redirect after unlocking', async t => {
  for (const kind of ['generate', 'recover', 'save', 'adopt']) {
    for (const redirect of [undefined, '/projects/7?view=history']) await t.test(`${kind}: ${redirect ? 'redirect' : 'reload'}`, async () => {
      const isForm = kind === 'generate' || kind === 'save';
      const path = kind === 'save' ? base : `${base}/${kind}`;
      const target = form('editor', `${path}?ignored=query`, { fallbackButton: kind === 'save' });
      const action = operation(path);
      const forms = isForm ? [target] : [], operations = isForm ? [] : [action];
      const page = browser({ forms, operations, respond: async () => ok({ redirect, ...(kind === 'save' ? {} : { message: '结果已保存，待人工采用。' }) }) });
      if (isForm) target.fire('input');
      assert.deepEqual(page.requests, []); assert.deepEqual(page.confirmations, []);
      const event = await page.fire(isForm ? target : action, isForm ? 'submit' : 'click');
      if (isForm) assert.equal(event.prevented, true);
      assert.equal(page.requests.length, 1);
      const request = page.requests[0];
      assert.equal(request.url, path); assert.equal(request.method, 'POST');
      assert.equal(request.channel, ['generate', 'recover'].includes(kind) ? 'IronGeneration' : 'fetch');
      assert.ok(request.body instanceof URLSearchParams);
      assert.deepEqual([...request.body], isForm ? target.fields : [['confirmed', 'yes']]);
      assert.equal(page.notice.textContent, kind === 'save' ? '已保存；请核对结果并人工采用。' : '结果已保存，待人工采用。');
      assert.deepEqual(page.confirmations, [], 'An explicit generation must not add an initial paid popup');
      assertNavigation(page, forms, operations, redirect);
    });
  }
});

test('busy locks duplicate forms and actions, warns beforeunload even when clean, and releases all guards before navigation', async t => {
  for (const start of ['save', 'generate', 'recover', 'adopt']) await t.test(start, async () => {
    const save = form('save', base), generate = form('generate', `${base}/generate`);
    const recover = operation(`${base}/recover`), adopt = operation(`${base}/adopt`);
    const response = deferred();
    const forms = [save, generate], operations = [recover, adopt];
    const page = browser({ forms, operations, respond: () => response.promise });
    const targets = { save, generate, recover, adopt };
    const target = targets[start], isForm = forms.includes(target), button = isForm ? target.button : target;
    assert.equal(page.beforeUnload(), false);
    target.fire(isForm ? 'submit' : 'click');
    assert.equal(page.main.inert, true); assert.equal(button.disabled, true);
    assert.equal(page.notice.textContent, '操作进行中。'); assert.equal(page.beforeUnload(), true);
    for (const item of forms) assert.equal(item.fire('submit').prevented, true);
    for (const item of operations) item.fire('click');
    // Busy must remain a guard even if another script releases main.inert.
    page.main.inert = false;
    for (const item of forms) item.fire('submit');
    for (const item of operations) item.fire('click');
    assert.equal(page.requests.length, 1); assert.deepEqual(page.confirmations, []);
    assert.equal(page.beforeUnload(), true);
    response.resolve(ok({})); await flush();
    assertNavigation(page, forms, operations);
  });
});

test('external main.inert and disabled buttons prevent requests and confirmations without changing their state', async t => {
  for (const guard of ['inert', 'disabled']) await t.test(guard, async () => {
    const save = form('save', base), generate = form('generate', `${base}/generate`);
    const action = operation(`${base}/recover`, '先确认恢复');
    const forms = [save, generate], page = browser({ forms, operations: [action] });
    if (guard === 'inert') page.main.inert = true;
    else for (const button of [save.button, generate.button, action]) button.disabled = true;
    for (const target of forms) await page.fire(target, 'submit');
    await page.fire(action, 'click');
    assert.deepEqual(page.requests, []); assert.deepEqual(page.confirmations, []);
    assert.deepEqual(page.navigation, []); assert.equal(page.notice.textContent, '');
    assert.equal(page.main.inert, guard === 'inert');
    assert.equal(action.disabled, guard === 'disabled');
  });
});

test('video generation rejects dirty production-clip-form without saving, confirming, or losing inputs; saving the clip remains allowed', async () => {
  const clip = form('production-clip-form', base), video = form('video', `${base}/generate`, { clipGenerate: true });
  const page = browser({ forms: [clip, video] });
  clip.fire('input');
  const fields = structuredClone(clip.fields);
  await page.fire(video, 'submit');
  assert.match(page.notice.textContent, /片段有未保存修改，请先保存再生成视频/);
  assert.deepEqual(page.requests, []); assert.deepEqual(page.confirmations, []);
  assert.deepEqual(clip.fields, fields); assert.equal(clip.dataset.dirty, 'true');
  assert.equal(page.main.inert, false); assert.equal(video.button.disabled, false);
  assert.equal(page.beforeUnload(), true);
  await page.fire(clip, 'submit');
  assert.equal(page.requests.length, 1); assert.equal(page.requests[0].url, base);
  assert.deepEqual(page.confirmations, []); assertNavigation(page, [clip, video]);
});

test('video generation works with a clean or absent clip form and does not add a paid confirmation', async () => {
  for (const withClip of [true, false]) {
    const clip = form('production-clip-form', base), video = form('video', `${base}/generate`, { clipGenerate: true });
    const forms = withClip ? [clip, video] : [video], page = browser({ forms });
    video.fire('change');
    await page.fire(video, 'submit');
    assert.equal(page.requests.length, 1); assert.equal(page.requests[0].channel, 'IronGeneration');
    assert.deepEqual(page.confirmations, []); assertNavigation(page, forms);
  }
});

test('other dirty forms require consent before submitting; cancellation preserves every input and successful navigation alone clears dirty', async t => {
  for (const kind of ['save', 'generate', 'recover', 'adopt']) for (const accepted of [false, true]) {
    await t.test(`${kind}: ${accepted ? 'accept' : 'cancel'}`, async () => {
      const target = form('editor', kind === 'save' ? base : `${base}/generate`);
      const other = form('other', '/projects/7/clips/10');
      const action = operation(`${base}/${kind}`), isForm = ['save', 'generate'].includes(kind);
      const response = deferred(), forms = [target, other], operations = isForm ? [] : [action];
      const page = browser({ forms, operations, confirm: () => accepted, respond: () => response.promise });
      for (const item of forms) item.fire('input');
      const inputs = forms.map(item => structuredClone(item.fields));
      (isForm ? target : action).fire(isForm ? 'submit' : 'click');
      assert.equal(page.confirmations.length, 1);
      assert.match(page.confirmations[0], /操作成功后将刷新页面，其他未保存输入会丢失/);
      assert.deepEqual(forms.map(item => item.dataset.dirty), ['true', 'true']);
      assert.deepEqual(forms.map(item => item.fields), inputs);
      assert.equal(page.requests.length, accepted ? 1 : 0); assert.deepEqual(page.navigation, []);
      assert.equal(page.beforeUnload(), true);
      if (!accepted) {
        assert.equal(page.main.inert, false); assert.equal(target.button.disabled, false); assert.equal(action.disabled, false);
        assert.equal(page.notice.textContent, '');
      } else {
        assert.equal(page.main.inert, true);
        response.resolve(ok({})); await flush();
        assertNavigation(page, forms, operations);
      }
    });
  }
});

test('operation-specific confirmation can cancel, and precedes the separate confirmation to discard dirty forms', async () => {
  for (const answers of [[false], [true, false], [true, true]]) {
    const target = form('editor', base), action = operation(`${base}/adopt`, '确认采用这次结果？');
    let index = 0;
    const page = browser({ forms: [target], operations: [action], confirm: () => answers[index++] });
    target.fire('change');
    await page.fire(action, 'click');
    assert.equal(page.confirmations[0], '确认采用这次结果？');
    assert.equal(page.confirmations.length, answers.length);
    if (answers.length === 2) assert.match(page.confirmations[1], /其他未保存输入会丢失/);
    if (answers.every(Boolean)) {
      assert.equal(page.requests.length, 1); assertNavigation(page, [target], [action]);
    } else {
      assert.deepEqual(page.requests, []); assert.deepEqual(page.navigation, []);
      assert.equal(target.dataset.dirty, 'true'); assert.equal(page.beforeUnload(), true);
      assert.equal(page.main.inert, false); assert.equal(action.disabled, false);
    }
  }
});

test('HTTP, network, JSON and cancelled-operation failures retain all inputs/dirty, unlock controls and never retry or navigate', async t => {
  const failures = [
    ['server', async () => failed({ error: '<script>版本冲突</script>' }), '<script>版本冲突</script>'],
    ['server fallback', async () => failed({}), '操作失败。'],
    ['network', async () => { throw new TypeError('offline'); }, '操作结果未确认，输入已保留；请到生成历史核对，不会自动重试。'],
    ['malformed JSON', async () => ({ ok: true, json: async () => { throw new SyntaxError('invalid JSON'); } }), 'invalid JSON'],
    ['cancelled transfer', async () => { throw new Error('操作已停止，请核对历史'); }, '操作已停止，请核对历史'],
  ];
  for (const kind of ['save', 'generate', 'recover', 'adopt']) for (const [name, respond, message] of failures) {
    await t.test(`${kind}: ${name}`, async () => {
      const target = form('editor', kind === 'save' ? base : `${base}/generate`), other = form('other', `${base}/notes`);
      const action = operation(`${base}/${kind}`), isForm = ['save', 'generate'].includes(kind);
      const forms = [target, other], operations = isForm ? [] : [action];
      const page = browser({ forms, operations, respond });
      for (const item of forms) item.fire('input');
      const inputs = forms.map(item => structuredClone(item.fields));
      await page.fire(isForm ? target : action, isForm ? 'submit' : 'click');
      await flush();
      assert.equal(page.requests.length, 1, 'No automatic retry after an uncertain or failed result');
      assert.deepEqual(page.navigation, []); assert.equal(page.notice.textContent, message);
      assert.deepEqual(forms.map(item => item.fields), inputs);
      assert.deepEqual(forms.map(item => item.dataset.dirty), ['true', 'true']);
      assert.equal(page.beforeUnload(), true); assert.equal(page.main.inert, false);
      assert.equal(target.button.disabled, false); assert.equal(action.disabled, false);
      target.fire('change'); assert.equal(page.notice.textContent, message);
    });
  }
});

test('failure on a clean form clears only busy unload protection; retry happens only on another explicit submission', async () => {
  const target = form('editor', `${base}/generate`);
  const page = browser({ forms: [target], respond: async () => { throw new TypeError('offline'); } });
  await page.fire(target, 'submit');
  assert.equal(page.requests.length, 1); assert.equal(page.beforeUnload(), false);
  assert.equal(target.dataset.dirty, undefined); assert.deepEqual(page.navigation, []);
  target.fields[1][1] = '失败后继续编辑的提示词'; target.fire('input');
  await flush(); assert.equal(page.requests.length, 1);
  await page.fire(target, 'submit');
  assert.equal(page.requests.length, 2);
  assert.equal(page.requests[1].body.get('prompt'), '失败后继续编辑的提示词');
  assert.equal(target.dataset.dirty, 'true'); assert.equal(page.beforeUnload(), true);
  assert.deepEqual(page.confirmations, []); assert.deepEqual(page.navigation, []);
});
