import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const resourcesScript = await readFile(new URL('../public/episode-resources.js', import.meta.url), 'utf8');
const screenplayScript = await readFile(new URL('../public/episode-script.js', import.meta.url), 'utf8');
const resourceFormsSelector = '#episode-resource-candidates, [data-occurrence-form]';
const dirtyResourcesSelector = '#episode-resource-candidates[data-dirty="true"], [data-occurrence-form][data-dirty="true"]';
const ok = result => ({ ok: true, json: async () => result });
const rejected = result => ({ ok: false, json: async () => result });
const base = '/projects/1/episodes/2';
const redirect = '/projects/1?view=episode&episode=2';
const currentUrl = hash => redirect + (hash ? '#' + hash.replace(/^#/, '') : '');

function node(properties = {}) {
  const events = {};
  return {
    value: '', textContent: '', disabled: false, required: false, hidden: false, dataset: {},
    focus() { this.focused = true; },
    addEventListener(event, handler) { events[event] = handler; },
    fire(event, data = {}) { return events[event]?.({ preventDefault() {}, ...data }); },
    ...properties,
  };
}
function lookup(nodes, selector) {
  assert.ok(Object.hasOwn(nodes, selector), `Unexpected selector: ${selector}`);
  return nodes[selector];
}
function leave(handler) {
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  handler(event);
  if (event.prevented) assert.equal(event.returnValue, '');
  return event.prevented;
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function resourceTarget(choice = '17', index = 0) {
  const controls = {
    '[data-resource-choice]': node({ value: choice, selectedOptions: [{ dataset: { name: '林秋 · 已有档案' } }] }),
    '[data-resource-name]': node({ value: '林秋 · 新档案' }),
    '[data-resource-description]': node({ value: '深色外套' }),
    '[data-resource-mode]': node({ value: 'on_screen' }),
    '[data-resource-details]': node({ value: '本场雨中出现' }),
    '[data-new-resource]': node({ hidden: true }),
    '[data-scene-heading]': node({ value: '场2 外景 夜' }),
    '[data-source-quote]': node({ value: '林秋走出雨幕。' }),
  };
  return {
    controls, dataset: { candidateIndex: String(index) },
    querySelector: selector => lookup(controls, selector),
    querySelectorAll(selector) {
      assert.equal(selector, '[data-resource-name], [data-resource-description]');
      return [controls['[data-resource-name]'], controls['[data-resource-description]']];
    },
  };
}
function resourceForm(candidateChoices = null) {
  const targets = candidateChoices ? candidateChoices.map(resourceTarget) : [resourceTarget()];
  const button = node({ textContent: candidateChoices ? '确认保存本集关联' : '保存这条出场记录' });
  const error = node();
  const form = node({
    id: candidateChoices ? 'episode-resource-candidates' : '',
    dataset: candidateChoices
      ? { url: `${base}/confirm-resources`, batchRevision: '5', scriptRevision: '7' }
      : { url: `${base}/resource-occurrences/9`, revision: '3', scriptRevision: '7' },
    querySelector(selector) {
      if (selector === '[type="submit"]') return button;
      if (selector === '[data-resource-error]') return error;
      return targets[0].querySelector(selector);
    },
    querySelectorAll(selector) {
      if (selector === '[data-resource-candidate]') return targets;
      return targets[0].querySelectorAll(selector);
    },
  });
  return Object.assign(form, { targets, button, error });
}
function resourcesPage(fetch, { forms = [resourceForm(['17', 'new', 'ignore'])], scriptDirty = '', hash = '', hashTarget = null, scriptPresent = true, confirmed = true } = {}) {
  const main = { inert: false }, scriptForm = node({ dataset: { dirty: scriptDirty } });
  const events = {}, redirects = [], reloadWarnings = [], confirmations = [], removeError = node();
  runInNewContext(resourcesScript, {
    document: {
      addEventListener(event, handler) { assert.equal(event, 'click'); events.click = handler; },
      querySelector(selector) { assert.equal(selector, 'main'); return main; },
      querySelectorAll(selector) { assert.equal(selector, resourceFormsSelector); return forms; },
      getElementById(id) {
        if (id === 'episode-script-form') return scriptPresent ? scriptForm : null;
        if (id === 'episode-resource-remove-error') return removeError;
        if (id === hash.slice(1)) return hashTarget;
        throw new Error(`Unexpected id: ${id}`);
      },
    },
    window: {
      confirm(message) { confirmations.push(message); return confirmed; },
      location: { hash, assign() { assert.fail('Same-document assignment would not refresh candidates'); }, reload() {
        assert.equal(main.inert, false); reloadWarnings.push(leave(events.beforeunload));
        redirects.push({ url: currentUrl(this.hash), dirty: forms.map(form => form.dataset.dirty) });
      } },
      addEventListener(event, handler) { events[event] = handler; },
    },
    URLSearchParams, TypeError, Error, fetch,
  });
  return { forms, main, scriptForm, redirects, reloadWarnings, events, removeError, confirmations,
    remove(button) { return events.click({ preventDefault() {}, target: { closest(selector) { assert.equal(selector, '[data-resource-remove]'); return button; } } }); },
    beforeUnload: () => leave(events.beforeunload) };
}
function screenplayPage(fetch, { revision = '7', withExtract = true, confirmed = true, resources = [] } = {}) {
  const ids = ['episode-script-form', 'episode-script-source', 'episode-script-text', 'episode-script-notes', 'episode-script-api',
    'generate-episode-script', 'save-episode-script', 'episode-script-error', 'episode-script-status', 'episode-script-recovery', 'episode-script-recovery-text'];
  if (withExtract) ids.push('extract-episode-resources');
  const nodes = Object.fromEntries(ids.map(id => [id, node()]));
  const form = nodes['episode-script-form'], api = nodes['episode-script-api'], extract = nodes['extract-episode-resources'];
  const main = { inert: false }, details = { open: false }, events = {}, redirects = [], confirmations = [], reloadWarnings = [];
  form.dataset = { url: `${base}/script`, generateUrl: `${base}/generate-script`, revision };
  nodes['episode-script-source'].value = '本集小说原文';
  nodes['episode-script-text'].value = '场2 外景 夜\n林秋走出雨幕。';
  nodes['episode-script-notes'].value = '保留雨夜场景';
  nodes['episode-script-notes'].closest = selector => { assert.equal(selector, 'details'); return details; };
  api.value = '4'; api.selectedOptions = [{ dataset: { model: 'resource-model', baseUrl: 'https://model.test/v1' } }];
  nodes['generate-episode-script'].textContent = '生成剧本';
  nodes['save-episode-script'].textContent = '保存剧本';
  nodes['episode-script-recovery'].hidden = true;
  if (extract) {
    extract.textContent = '提取／同步人物与场景';
    extract.dataset = { url: `${base}/extract-resources`, batchRevision: '5', hasCandidates: 'false' };
  }
  runInNewContext(screenplayScript, {
    document: {
      getElementById: id => nodes[id] ?? null,
      querySelector(selector) {
        if (selector === 'main') return main;
        assert.equal(selector, dirtyResourcesSelector);
        return resources.find(target => target.dataset.dirty === 'true') ?? null;
      },
      querySelectorAll(selector) { assert.equal(selector, resourceFormsSelector); return resources; },
    },
    window: {
      confirm(message) { confirmations.push(message); return confirmed; },
      location: { hash: '', assign() { assert.fail('Same-document assignment would not refresh candidates'); }, reload() {
        assert.equal(main.inert, false); reloadWarnings.push(leave(events.beforeunload));
        redirects.push({ url: currentUrl(this.hash), scriptDirty: form.dataset.dirty, resourceDirty: resources.map(target => target.dataset.dirty) });
      } },
      addEventListener(event, handler) { events[event] = handler; },
    },
    URLSearchParams, TypeError, Error, fetch,
  });
  return {
    nodes, form, api, extract, main, resources, redirects, confirmations, reloadWarnings,
    extractResources: () => extract.fire('click'),
    save: () => form.fire('submit'),
    generate: () => nodes['generate-episode-script'].fire('click'),
    input(id, value) { nodes[id].value = value; form.fire('input', { target: nodes[id] }); },
    beforeUnload: () => leave(events.beforeunload),
  };
}

// Each harness evaluates only its own application script.
test('resource choices show and require new-resource fields only for new, without losing their values', () => {
  const form = resourceForm(['17', 'new', 'ignore']);
  const p = resourcesPage(() => assert.fail('Changing choices must not save'), { forms: [form] });
  assert.equal(p.beforeUnload(), false);
  for (const [index, target] of form.targets.entries()) {
    const isNew = index === 1;
    assert.equal(target.controls['[data-new-resource]'].hidden, !isNew);
    assert.equal(target.controls['[data-resource-name]'].disabled, !isNew);
    assert.equal(target.controls['[data-resource-description]'].disabled, !isNew);
    assert.equal(target.controls['[data-resource-name]'].required, isNew);
  }
  const controls = form.targets[0].controls;
  for (const choice of ['new', '17', 'ignore', 'new']) {
    controls['[data-resource-choice]'].value = choice;
    form.fire('change');
    assert.equal(controls['[data-new-resource]'].hidden, choice !== 'new');
    assert.equal(controls['[data-resource-name]'].required, choice === 'new');
    assert.equal(controls['[data-resource-description]'].disabled, choice !== 'new');
    assert.equal(controls['[data-resource-name]'].value, '林秋 · 新档案');
    assert.equal(controls['[data-resource-description]'].value, '深色外套');
  }
  assert.equal(form.dataset.dirty, 'true');
  assert.equal(p.beforeUnload(), true);
});

test('candidate confirmation sends exact existing/new/ignore snapshots, locks all resource saves, clears dirty before redirect', async () => {
  const form = resourceForm(['17', 'new', 'ignore']), occurrence = resourceForm(), response = deferred(), calls = [];
  const p = resourcesPage((url, options) => { calls.push({ url, ...options }); return response.promise; }, { forms: [form, occurrence] });
  form.fire('input');
  form.error.textContent = '旧错误';
  let prevented = false;
  const pending = form.fire('submit', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(form.error.textContent, '');
  assert.equal(p.main.inert, true);
  assert.equal(form.button.disabled, true);
  assert.equal(form.button.textContent, '保存中…');
  assert.equal(p.beforeUnload(), true);
  await form.fire('submit'); await occurrence.fire('submit');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${base}/confirm-resources`);
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual([...calls[0].body.keys()], ['batchRevision', 'scriptRevision', 'selections']);
  assert.equal(calls[0].body.get('batchRevision'), '5');
  assert.equal(calls[0].body.get('scriptRevision'), '7');
  assert.deepEqual(JSON.parse(calls[0].body.get('selections')), [
    { action: 'existing', mode: 'on_screen', details: '本场雨中出现', resourceId: 17, resourceName: '林秋 · 已有档案' },
    { action: 'new', mode: 'on_screen', details: '本场雨中出现', name: '林秋 · 新档案', description: '深色外套' },
    { action: 'ignore', mode: 'on_screen', details: '本场雨中出现' },
  ]);
  response.resolve(ok({ redirect })); await pending;
  assert.deepEqual(p.redirects, [{ url: redirect, dirty: ['', undefined] }]);
  assert.deepEqual(p.reloadWarnings, [false]);
  assert.equal(p.beforeUnload(), false);
  assert.equal(p.main.inert, false);
  assert.equal(form.button.disabled, false);
  assert.equal(form.button.textContent, '确认保存本集关联');
});

test('occurrence correction, new-resource replacement and removal post current source location and both revisions', async t => {
  for (const choice of ['17', 'new', 'ignore']) await t.test(choice, async () => {
    const form = resourceForm(), controls = form.targets[0].controls, calls = [];
    const p = resourcesPage(async (url, options) => { calls.push({ url, ...options }); return ok({ redirect: `${redirect}#occurrence-9` }); }, { forms: [form], scriptPresent: false });
    controls['[data-resource-choice]'].value = choice;
    controls['[data-resource-mode]'].value = 'memory';
    controls['[data-resource-details]'].value = '回忆中的旧宅';
    controls['[data-scene-heading]'].value = '场3 内景 日';
    controls['[data-source-quote]'].value = '回忆里，林秋推开旧宅的门。';
    form.fire('change');
    await form.fire('submit');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${base}/resource-occurrences/9`);
    assert.equal(calls[0].method, 'POST');
    assert.deepEqual([...calls[0].body.keys()], ['revision', 'scriptRevision', 'selection']);
    assert.equal(calls[0].body.get('revision'), '3');
    assert.equal(calls[0].body.get('scriptRevision'), '7');
    const selection = { mode: 'memory', details: '回忆中的旧宅', sceneHeading: '场3 内景 日', quote: '回忆里，林秋推开旧宅的门。' };
    if (choice === '17') Object.assign(selection, { action: 'existing', resourceId: 17, resourceName: '林秋 · 已有档案' });
    else if (choice === 'new') Object.assign(selection, { action: 'new', name: '林秋 · 新档案', description: '深色外套' });
    else selection.action = 'ignore';
    assert.deepEqual(JSON.parse(calls[0].body.get('selection')), selection);
    assert.deepEqual(p.redirects, [{ url: `${redirect}#occurrence-9`, dirty: [''] }]);
    assert.equal(p.beforeUnload(), false);
  });
});

test('grouped candidate DOM order must not swap character/location selections in the original extraction array', async () => {
  const form = resourceForm(['17', 'new', 'ignore']);
  form.targets.splice(0, 3, form.targets[0], form.targets[2], form.targets[1]);
  let submitted;
  resourcesPage(async (url, options) => { submitted = JSON.parse(options.body.get('selections')); return ok({ redirect }); }, { forms: [form] });
  await form.fire('submit');
  assert.deepEqual(submitted.map(item => item.action), ['existing', 'new', 'ignore']);
});

test('occurrence deep links also open the enclosing archived/review section', () => {
  const parent = { tagName: 'DETAILS', open: false, parentElement: { tagName: 'FIELDSET' } };
  const target = { open: false, parentElement: parent, scrollIntoView() { assert.equal(parent.open, true); } };
  resourcesPage(() => assert.fail('Navigation must not call models'), { hash: '#occurrence-9', hashTarget: target });
  assert.equal(target.open, true); assert.equal(parent.open, true);
});

test('删除图标先确认本集范围，发送版本与精确目标，阻止重复提交，成功刷新且没有忙碌退出提醒', async () => {
  const response = deferred(), calls = [];
  const p = resourcesPage((url, options) => { calls.push({ url, ...options }); return response.promise; });
  const button = node({ dataset: { url: `${base}/remove-resources`, batchRevision: '5', scriptRevision: '7', targets: '{"type":"candidates","items":[0,2]}', name: '林秋', whole: 'true' } });
  const pending = p.remove(button); await p.remove(button);
  assert.equal(calls.length, 1); assert.equal(p.main.inert, true); assert.equal(button.disabled, true); assert.equal(p.beforeUnload(), true);
  assert.match(p.confirmations[0], /全部出场位置.*不删除全剧共享档案.*不影响其他集/);
  assert.deepEqual(Object.fromEntries(calls[0].body), { confirmed: 'yes', batchRevision: '5', scriptRevision: '7', targets: button.dataset.targets });
  response.resolve(ok({ redirect: `${redirect}#episode-resources` })); await pending;
  assert.deepEqual(p.reloadWarnings, [false]); assert.equal(button.disabled, false); assert.equal(p.main.inert, false);
});

test('取消、未保存修改及删除失败都不丢输入、不移除DOM、不自动重试，成功前不刷新', async () => {
  const button = node({ dataset: { url: `${base}/remove-resources`, batchRevision: '5', scriptRevision: '7', targets: '{"type":"occurrences","items":[{"id":9,"revision":3}]}', name: '林秋', whole: 'false' } });
  const cancelled = resourcesPage(() => assert.fail('取消不调用'), { confirmed: false }); await cancelled.remove(button); assert.deepEqual(cancelled.redirects, []);
  const dirty = resourcesPage(() => assert.fail('未保存不调用')); dirty.forms[0].fire('input'); await dirty.remove(button);
  assert.match(dirty.removeError.textContent, /未保存/); assert.equal(dirty.forms[0].dataset.dirty, 'true');
  for (const failure of [async () => rejected({ error: '版本冲突' }), async () => { throw new TypeError('offline'); }, async () => ({ ok: true, json: async () => { throw new SyntaxError('bad json'); } })]) {
    let calls = 0; const p = resourcesPage(async () => { calls++; return failure(); }); await p.remove(button);
    assert.equal(calls, 1); assert.deepEqual(p.redirects, []); assert.ok(p.removeError.textContent); assert.equal(p.main.inert, false); assert.equal(button.disabled, false);
  }
});

test('unsaved screenplay, inert main and disabled submit prevent both candidate and occurrence saves', async t => {
  for (const candidates of [true, false]) await t.test(candidates ? 'candidates' : 'occurrence', async () => {
    let calls = 0;
    const form = resourceForm(candidates ? ['17'] : null);
    const p = resourcesPage(async () => { calls++; return ok({ redirect }); }, { forms: [form], scriptDirty: 'true' });
    form.fire('input');
    await form.fire('submit');
    assert.equal(calls, 0);
    assert.match(form.error.textContent, /剧本还有未保存修改/);
    assert.equal(form.dataset.dirty, 'true');
    assert.equal(p.main.inert, false);
    p.scriptForm.dataset.dirty = '';
    p.main.inert = true; await form.fire('submit');
    assert.equal(p.main.inert, true);
    p.main.inert = false; form.button.disabled = true; await form.fire('submit');
    assert.equal(calls, 0);
    assert.deepEqual(p.redirects, []);
    form.button.disabled = false; await form.fire('submit');
    assert.equal(calls, 1);
  });
});

test('resource server, network and malformed-response failures preserve inputs, error and dirty state without retry', async t => {
  const failures = [
    ['server', async () => rejected({ error: '关联版本已变化' }), /关联版本已变化/],
    ['network', async () => { throw new TypeError('network'); }, /保存结果未确认.*不会自动重试/],
    ['malformed', async () => ({ ok: true, json: async () => { throw new SyntaxError('invalid JSON'); } }), /保存结果未确认.*不会自动重试/],
  ];
  for (const candidates of [true, false]) for (const [kind, failure, message] of failures) {
    await t.test(`${candidates ? 'candidates' : 'occurrence'}: ${kind}`, async () => {
      const form = resourceForm(candidates ? ['new'] : null), controls = form.targets[0].controls;
      let calls = 0;
      const p = resourcesPage(async () => { calls++; return calls === 1 ? failure() : ok({ redirect }); }, { forms: [form] });
      controls['[data-resource-details]'].value = '<script>保留原样</script>';
      controls['[data-source-quote]'].value = '修改后的定位原文';
      form.fire('input');
      const inputs = Object.values(controls).map(control => control.value);
      await form.fire('submit');
      assert.equal(calls, 1);
      assert.deepEqual(Object.values(controls).map(control => control.value), inputs);
      assert.equal(form.dataset.dirty, 'true');
      assert.match(form.error.textContent, message);
      const error = form.error.textContent;
      form.fire('input'); assert.equal(form.error.textContent, error);
      assert.equal(p.beforeUnload(), true);
      assert.equal(p.main.inert, false);
      assert.equal(form.button.disabled, false);
      assert.equal(form.button.textContent, candidates ? '确认保存本集关联' : '保存这条出场记录');
      assert.deepEqual(p.redirects, []);
      await form.fire('submit');
      assert.equal(calls, 2);
      assert.equal(form.error.textContent, '');
      assert.equal(p.beforeUnload(), false);
    });
  }
});

test('resource save warns while busy even when clean, and only clears its own dirty state', async () => {
  const form = resourceForm(['17']), other = resourceForm(), response = deferred();
  const p = resourcesPage(() => response.promise, { forms: [form, other] });
  assert.equal(p.beforeUnload(), false);
  const pending = form.fire('submit');
  assert.equal(p.beforeUnload(), true);
  other.fire('input');
  response.resolve(ok({ redirect })); await pending;
  assert.deepEqual(p.redirects, [{ url: redirect, dirty: ['', 'true'] }]);
  assert.deepEqual(p.reloadWarnings, [true]);
  assert.equal(p.beforeUnload(), true);
});

test('resource deep links open and scroll only matching numeric occurrence targets; empty pages are safe', () => {
  for (const [hash, exists, opens] of [['#occurrence-9', true, true], ['#occurrence-99', false, false], ['#occurrence-x', true, false], ['#occurrence-9-extra', true, false], ['', true, false]]) {
    const target = { open: false, scrolled: 0, scrollIntoView() { this.scrolled++; } };
    resourcesPage(() => assert.fail('Deep links must not save'), { hash, hashTarget: exists ? target : null });
    assert.equal(target.open, opens);
    assert.equal(target.scrolled, opens ? 1 : 0);
  }
  const p = resourcesPage(() => assert.fail('Empty page must not save'), { forms: [] });
  assert.deepEqual(p.events, {});
});

test('extraction happens only on explicit click, skips saving clean persisted scripts, snapshots selected config and clears resource dirty before redirect', async () => {
  const calls = [], resources = [resourceForm(['17']), resourceForm()];
  const p = screenplayPage(async (url, options) => { calls.push({ url, ...options }); return ok({ message: '提取完成', redirect }); }, { resources });
  assert.equal(calls.length, 0);
  p.input('episode-script-api', '12');
  p.api.selectedOptions = [{ dataset: { model: 'selected-model', baseUrl: 'https://selected.test/v1' } }];
  assert.equal(p.form.dataset.dirty, undefined);
  assert.equal(p.beforeUnload(), false);
  assert.equal(calls.length, 0);
  await p.extractResources();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${base}/extract-resources`);
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(Object.fromEntries(calls[0].body), {
    revision: '7', batchRevision: '5', apiConfigId: '12', model: 'selected-model', baseUrl: 'https://selected.test/v1', replaceConfirmed: 'no',
  });
  assert.equal(p.confirmations.length, 0);
  assert.equal(p.nodes['episode-script-status'].textContent, '提取完成');
  assert.deepEqual(p.redirects, [{ url: redirect, scriptDirty: undefined, resourceDirty: ['', ''] }]);
  assert.deepEqual(p.reloadWarnings, [false]);
  assert.equal(p.nodes['episode-script-text'].value, '场2 外景 夜\n林秋走出雨幕。');
  assert.equal(p.nodes['episode-script-notes'].value, '保留雨夜场景');
  assert.equal(p.beforeUnload(), false);
});

test('extraction, confirmation and correction force a document reload even when the destination differs only by a fragment', async () => {
  const screenplay = screenplayPage(async () => ok({ message: '完成', redirect: `${redirect}#episode-resources` }));
  await screenplay.extractResources();
  assert.deepEqual(screenplay.redirects, [{ url: `${redirect}#episode-resources`, scriptDirty: undefined, resourceDirty: [] }]);
  assert.deepEqual(screenplay.reloadWarnings, [false]);
  for (const form of [resourceForm(['17']), resourceForm()]) {
    const fragment = form.id ? 'episode-resources' : 'occurrence-9';
    const page = resourcesPage(async () => ok({ redirect: `${redirect}#${fragment}` }), { forms: [form], hash: `#${fragment}` });
    form.fire('input'); await form.fire('submit');
    assert.deepEqual(page.redirects, [{ url: `${redirect}#${fragment}`, dirty: [''] }]);
    assert.deepEqual(page.reloadWarnings, [false]);
  }
});

test('extraction saves only dirty or revision-zero scripts first and posts the newly saved revision', async t => {
  for (const [revision, dirty] of [['0', false], ['0', true], ['7', true]]) await t.test(`${revision}, dirty=${dirty}`, async () => {
    const calls = [];
    const p = screenplayPage(async (url, options) => {
      calls.push({ url, ...options });
      return ok(url.endsWith('/script') ? { revision: 8 } : { message: '完成', redirect });
    }, { revision });
    if (dirty) p.input('episode-script-text', '人工修改后的剧本');
    const text = p.nodes['episode-script-text'].value;
    await p.extractResources();
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, `${base}/script`);
    assert.equal(calls[0].method, 'POST');
    assert.deepEqual(Object.fromEntries(calls[0].body), { source: '本集小说原文', script: text, notes: '保留雨夜场景', revision });
    assert.equal(calls[1].url, `${base}/extract-resources`);
    assert.equal(calls[1].body.get('revision'), '8');
    assert.equal(p.form.dataset.revision, '8');
    assert.equal(p.form.dataset.dirty, '');
    assert.equal(p.beforeUnload(), false);
  });
});

test('extraction validates nonblank screenplay and selected API, respects disabled/inert controls, and tolerates missing optional button', async () => {
  let calls = 0;
  const p = screenplayPage(async () => { calls++; return ok({ revision: 8 }); });
  p.nodes['episode-script-text'].value = '  \n ';
  await p.extractResources();
  assert.match(p.nodes['episode-script-error'].textContent, /剧本正文/);
  assert.equal(p.nodes['episode-script-text'].focused, true);
  p.nodes['episode-script-text'].value = '剧本'; p.api.value = '';
  await p.extractResources();
  assert.match(p.nodes['episode-script-error'].textContent, /模型配置/);
  assert.equal(p.api.focused, true);
  p.api.value = '4'; p.main.inert = true;
  await p.extractResources(); assert.equal(p.main.inert, true);
  p.main.inert = false; p.extract.disabled = true;
  await p.extractResources(); assert.equal(p.extract.disabled, true);
  assert.equal(calls, 0); assert.deepEqual(p.redirects, []);
  const optional = screenplayPage(async (url, options) => {
    calls++;
    assert.equal(url, `${base}/script`);
    assert.equal(options.body.get('script'), '场2 外景 夜\n林秋走出雨幕。');
    return ok({ revision: 8 });
  }, { withExtract: false });
  assert.equal(optional.extract, undefined);
  assert.equal(calls, 0);
  await optional.save(); assert.equal(calls, 1);
  assert.equal(optional.nodes['episode-script-status'].textContent, '原文、剧本和改编说明已保存。');
});

test('cancelled reextraction with candidates or either dirty resource form neither saves nor extracts nor clears inputs', async t => {
  for (const reason of ['candidates', 'candidate edits', 'occurrence edits']) await t.test(reason, async () => {
    const resource = resourceForm(reason === 'candidate edits' ? ['new'] : null);
    if (reason !== 'candidates') resource.dataset.dirty = 'true';
    const p = screenplayPage(() => assert.fail('Cancelled extraction must not request'), { confirmed: false, resources: [resource] });
    if (reason === 'candidates') p.extract.dataset.hasCandidates = 'true';
    p.input('episode-script-text', '未保存的新剧本');
    resource.targets[0].controls['[data-resource-details]'].value = '未保存关联说明';
    await p.extractResources();
    assert.equal(p.confirmations.length, 1);
    assert.match(p.confirmations[0], /已确认的出场记录和资源档案不会删除或覆盖/);
    assert.equal(p.form.dataset.dirty, 'true');
    assert.equal(p.form.dataset.revision, '7');
    assert.equal(p.nodes['episode-script-text'].value, '未保存的新剧本');
    assert.equal(resource.dataset.dirty, reason === 'candidates' ? undefined : 'true');
    assert.equal(resource.targets[0].controls['[data-resource-details]'].value, '未保存关联说明');
    assert.equal(p.main.inert, false); assert.equal(p.extract.disabled, false);
    assert.deepEqual(p.redirects, []);
  });
});

test('accepted reextraction confirms once and distinguishes replacing candidates from abandoning unsaved associations', async t => {
  for (const hasCandidates of [true, false]) await t.test(`candidates=${hasCandidates}`, async () => {
    const resource = resourceForm(); resource.dataset.dirty = 'true';
    const calls = [];
    const p = screenplayPage(async (url, options) => { calls.push({ url, ...options }); return ok({ redirect, message: '完成' }); }, { resources: [resource] });
    p.extract.dataset.hasCandidates = String(hasCandidates);
    await p.extractResources();
    assert.equal(p.confirmations.length, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.get('replaceConfirmed'), hasCandidates ? 'yes' : 'no');
    assert.equal(resource.dataset.dirty, '');
    assert.deepEqual(p.redirects[0].resourceDirty, ['']);
  });
});

test('pending extraction locks duplicate extraction, save and generation and warns on unload, then restores controls', async () => {
  const response = deferred(), calls = [];
  const p = screenplayPage((url, options) => { calls.push({ url, ...options }); return response.promise; });
  assert.equal(p.beforeUnload(), false);
  const pending = p.extractResources();
  assert.equal(p.main.inert, true); assert.equal(p.extract.disabled, true);
  assert.equal(p.extract.textContent, '提取中…'); assert.equal(p.beforeUnload(), true);
  await p.extractResources(); await p.save(); await p.generate();
  assert.equal(calls.length, 1); assert.equal(p.confirmations.length, 0);
  response.resolve(ok({ redirect, message: '完成' })); await pending;
  assert.equal(p.main.inert, false); assert.equal(p.extract.disabled, false);
  assert.equal(p.extract.textContent, '提取／同步人物与场景'); assert.equal(p.beforeUnload(), false);
});

test('pending pre-extraction save blocks duplicates; save failure preserves dirty script and never calls extraction', async t => {
  for (const kind of ['server', 'network', 'malformed']) await t.test(kind, async () => {
    const response = deferred(), calls = [], resource = resourceForm(); resource.dataset.dirty = 'true';
    const p = screenplayPage((url, options) => { calls.push({ url, ...options }); return response.promise; }, { resources: [resource] });
    p.input('episode-script-text', '保留人工修改稿');
    const pending = p.extractResources();
    await p.extractResources(); await p.save(); await p.generate();
    assert.equal(calls.length, 1); assert.equal(calls[0].url, `${base}/script`);
    assert.equal(p.confirmations.length, 1);
    if (kind === 'server') response.resolve(rejected({ error: '剧本版本冲突' }));
    else if (kind === 'network') response.reject(new TypeError('offline'));
    else response.resolve({ ok: true, json: async () => { throw new SyntaxError('truncated'); } });
    await pending;
    assert.equal(calls.length, 1);
    assert.match(p.nodes['episode-script-error'].textContent, kind === 'server' ? /剧本版本冲突/ : /保存结果未确认/);
    assert.equal(p.nodes['episode-script-text'].value, '保留人工修改稿');
    assert.equal(p.form.dataset.dirty, 'true'); assert.equal(p.form.dataset.revision, '7');
    assert.equal(resource.dataset.dirty, 'true');
    assert.equal(p.main.inert, false); assert.equal(p.extract.disabled, false);
    assert.equal(p.extract.textContent, '提取／同步人物与场景');
    assert.equal(p.beforeUnload(), true); assert.deepEqual(p.redirects, []);
  });
});

test('extraction errors do not retry or overwrite screenplay, resource edits or recovery text', async t => {
  for (const kind of ['server', 'network', 'malformed']) await t.test(kind, async () => {
    let calls = 0;
    const resource = resourceForm(['new']); resource.dataset.dirty = 'true';
    const p = screenplayPage(async () => {
      calls++;
      if (kind === 'server') return rejected({ error: '提取失败', recoveryText: '<script>未保存的模型输出</script>' });
      if (kind === 'network') throw new TypeError('offline');
      return { ok: true, json: async () => { throw new SyntaxError('invalid JSON'); } };
    }, { resources: [resource] });
    p.nodes['episode-script-recovery'].hidden = false;
    p.nodes['episode-script-recovery-text'].value = '此前的恢复文本';
    await p.extractResources();
    assert.equal(calls, 1);
    assert.match(p.nodes['episode-script-error'].textContent, kind === 'server' ? /提取失败/ : /可能已计费.*不要直接重复提交/);
    assert.equal(p.nodes['episode-script-text'].value, '场2 外景 夜\n林秋走出雨幕。');
    assert.equal(p.nodes['episode-script-notes'].value, '保留雨夜场景');
    assert.equal(p.nodes['episode-script-source'].value, '本集小说原文');
    assert.equal(p.form.dataset.revision, '7');
    assert.equal(resource.dataset.dirty, 'true');
    assert.equal(resource.targets[0].controls['[data-resource-name]'].value, '林秋 · 新档案');
    assert.equal(p.nodes['episode-script-recovery'].hidden, false);
    assert.equal(p.nodes['episode-script-recovery-text'].value, kind === 'server' ? '<script>未保存的模型输出</script>' : '此前的恢复文本');
    assert.equal(p.nodes['episode-script-status'].textContent, '');
    assert.equal(p.main.inert, false); assert.equal(p.extract.disabled, false);
    assert.equal(p.extract.textContent, '提取／同步人物与场景');
    assert.equal(p.beforeUnload(), true); assert.deepEqual(p.redirects, []);
    resource.dataset.dirty = '';
    assert.equal(p.beforeUnload(), true, 'Visible recovery text alone must warn before leaving');
  });
});

test('failed extraction after successful draft save retains the saved revision and recovery text without resaving or retrying', async () => {
  const calls = [], resource = resourceForm(); resource.dataset.dirty = 'true';
  const p = screenplayPage(async (url, options) => {
    calls.push({ url, ...options });
    if (url.endsWith('/script')) return ok({ revision: 8 });
    throw new TypeError('lost extraction response');
  }, { resources: [resource] });
  p.input('episode-script-text', '已保存但提取失败的稿件');
  p.nodes['episode-script-recovery'].hidden = false;
  p.nodes['episode-script-recovery-text'].value = '保留恢复草稿';
  await p.extractResources();
  assert.deepEqual(calls.map(call => call.url), [`${base}/script`, `${base}/extract-resources`]);
  assert.equal(calls[1].body.get('revision'), '8');
  assert.equal(p.form.dataset.revision, '8'); assert.equal(p.form.dataset.dirty, '');
  assert.equal(p.nodes['episode-script-text'].value, '已保存但提取失败的稿件');
  assert.equal(p.nodes['episode-script-recovery-text'].value, '保留恢复草稿');
  assert.equal(resource.dataset.dirty, 'true');
  assert.match(p.nodes['episode-script-error'].textContent, /可能已计费/);
  assert.deepEqual(p.redirects, []); assert.equal(p.main.inert, false);
});
