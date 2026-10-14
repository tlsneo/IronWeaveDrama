import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { openDatabase } from '../src/database.js';
import { renderStoryboards } from '../src/render-storyboards.js';
import { saveEpisodeStoryboards, storyboardResources } from '../src/storyboards.js';
import { storyboardLookChoices } from '../src/storyboard-looks.js';
import { lookInputs } from '../src/looks.js';

const browserScript = await readFile(new URL('../public/storyboards.js', import.meta.url), 'utf8');
const base = '/projects/1/episodes/2';
const fieldNames = ['title', 'sceneHeading', 'quote', 'mode', 'duration', 'characterIds', 'sceneId', 'framing', 'action', 'dialogue', 'sound', 'transition', 'timingReason'];
const goodShot = (title = '推门', duration = 1.2) => ({ title, sceneHeading: '场1 内景 夜', quote: '林秋推门。', mode: 'on_screen', duration,
  characterIds: [17, 18], sceneId: 20, framing: '中景，平视，固定机位', action: '门关着 → 推门 → 停下', dialogue: '林秋：你好。', sound: '门响', transition: '切', timingReason: '完成推门动作' });
const ok = result => ({ ok: true, json: async () => result });
const failed = result => ({ ok: false, json: async () => result });
function leave(handler) {
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  handler(event); if (event.prevented) assert.equal(event.returnValue, ''); return event.prevented;
}
function node(properties = {}) {
  const events = {};
  return { value: '', textContent: '', disabled: false, hidden: false, dataset: {}, attributes: {},
    addEventListener(event, handler) { events[event] = handler; },
    fire(event, data = {}) { return events[event]?.({ preventDefault() {}, ...data }); },
    setAttribute(key, value) { this.attributes[key] = value; },
    focus() { this.focused = true; }, reportValidity() { this.reported = true; }, checkValidity() { return !this.invalid; }, ...properties };
}
function card(shot = {}) {
  const fields = Object.fromEntries(fieldNames.filter(name => name !== 'characterIds').map(name => [name, node({ value: String(shot[name] ?? ''),
    checkValidity() { return !this.invalid && (!['title', 'sceneHeading', 'quote', 'framing', 'action', 'timingReason', 'duration'].includes(name) || !!this.value.trim()); } })]));
  const characters = [17, 18, 999].map(id => node({ value: String(id), checked: shot.characterIds?.includes(id) ?? false }));
  const previews = characters.map(() => node({ hidden: true }));
  const looks = characters.map((character, index) => {
    const saved = shot.characterLooks?.find(binding => binding.characterId === Number(character.value));
    const imageId = saved ? saved.imageId : 700 + index;
    const option = { value: `look-${index}`, dataset: { lookId: String(saved?.lookId ?? 70 + index), inputRevision: saved?.inputRevision ?? 'a'.repeat(64), imageId: String(imageId ?? 0), imageUrl: imageId === null ? '' : `/projects/1/looks/${saved?.lookId ?? 70 + index}/images/${imageId}` } };
    const select = node({ value: saved ? option.value : '', dataset: { characterId: character.value }, options: [{ value: '', dataset: {} }, option] });
    Object.defineProperty(select, 'selectedOptions', { get() { return [this.options.find(option => option.value === this.value) ?? this.options[0]]; } });
    return select;
  });
  const parts = Object.fromEntries(['number', 'title', 'duration', 'scene'].map(name => [`[data-storyboard-${name}]`, node()]));
  parts.details = node({ open: true });
  const actions = Object.fromEntries(['up', 'down', 'delete'].map(action => [action, node({ dataset: { storyboardAction: action } })]));
  const result = node({ fields, characters, looks, previews, parts, actions,
    querySelector(selector) {
      const previewId = /^\[data-storyboard-look-preview="(\d+)"\]$/.exec(selector)?.[1];
      if (previewId) return previews[characters.findIndex(character => character.value === previewId)];
      const name = /^\[data-storyboard-field="(\w+)"\]$/.exec(selector)?.[1];
      if (name) { assert.ok(fields[name], `Unknown field: ${name}`); return fields[name]; }
      const action = /^\[data-storyboard-action="(\w+)"\]$/.exec(selector)?.[1];
      if (action) return actions[action];
      assert.ok(parts[selector], `Unknown card selector: ${selector}`); return parts[selector];
    },
    querySelectorAll(selector) {
      if (selector === '[data-storyboard-field]') return Object.values(fields);
      if (selector === '[data-storyboard-look]') return looks;
      assert.equal(selector, '[data-storyboard-character]'); return characters;
    },
    cloneNode() { return card(shot); },
    remove() { const index = this.parent.items.indexOf(this); if (index !== -1) this.parent.items.splice(index, 1); },
  });
  for (const button of Object.values(actions)) button.closest = selector => {
    if (selector === '[data-storyboard-action]') return button;
    assert.equal(selector, '[data-storyboard-shot]'); return result;
  };
  return result;
}
function page(fetch, { shots = [], confirmed = true, stale = false, revision = '0', hasScript = true, hasShots = shots.length > 0 } = {}) {
  const names = ['form', 'shots', 'shot-template', 'max-seconds', 'api', 'generate', 'save', 'add', 'clear', 'error', 'status', 'recovery', 'recovery-text', 'count', 'total', 'empty', 'dirty', 'duration-error'];
  const nodes = Object.fromEntries(names.map(name => [name, node()])), events = {}, main = { inert: false }, confirmations = [], reloads = [];
  const form = nodes.form, list = nodes.shots;
  form.dataset = { url: `${base}/storyboards`, generateUrl: `${base}/generate-storyboards`, clearUrl: `${base}/clear-storyboards`, revision,
    scriptRevision: '4', resourceRevision: 'resources-current', hasShots: String(hasShots), stale: String(stale), hasScript: String(hasScript) };
  list.items = shots.map(card); list.items.forEach(item => { item.parent = list; });
  list.querySelectorAll = selector => { assert.equal(selector, '[data-storyboard-shot]'); return list.items; };
  list.appendChild = item => { item.parent = list; list.items.push(item); };
  list.insertBefore = (item, before) => { const old = list.items.indexOf(item); if (old !== -1) list.items.splice(old, 1); list.items.splice(list.items.indexOf(before), 0, item); };
  nodes['shot-template'].content = { firstElementChild: card({ mode: 'on_screen', characterIds: [], sceneId: null }) };
  nodes['max-seconds'].value = '5';
  Object.assign(nodes.api, { value: '3', selectedOptions: [{ dataset: { model: 'shot-model', baseUrl: 'https://model.test/v1' } }] });
  nodes.generate.textContent = '生成分镜'; nodes.save.textContent = '确认并保存分镜'; nodes.clear.textContent = '删除全部镜头'; nodes.recovery.hidden = true;
  runInNewContext(browserScript, {
    document: { getElementById(id) { assert.ok(id.startsWith('storyboard-')); assert.ok(nodes[id.slice(11)], `Unknown id: ${id}`); return nodes[id.slice(11)]; },
      querySelector(selector) { assert.equal(selector, 'main'); return main; } },
    window: { confirm(message) { confirmations.push(message); return typeof confirmed === 'function' ? confirmed(message) : confirmed; }, addEventListener(event, handler) { events[event] = handler; },
      location: { hash: '', reload() { assert.equal(main.inert, false); assert.equal(nodes.generate.disabled, false); assert.equal(nodes.save.disabled, false);
        reloads.push({ hash: this.hash, guarded: leave(events.beforeunload) }); } } },
    fetch, URLSearchParams, TypeError, Error,
  });
  return { nodes, form, list, main, confirmations, reloads,
    generate: () => nodes.generate.fire('click'), save: () => form.fire('submit'), add: () => nodes.add.fire('click'), clear: () => nodes.clear.fire('click'),
    input(input, value, event = 'input') { input.value = String(value); return form.fire(event, { target: input }); },
    action(item, action) { return list.fire('click', { target: item.actions[action] }); },
    beforeUnload: () => leave(events.beforeunload) };
}

test('clear all deletes immediately after confirmation, including stale/invalid and local-only shots; locks duplicates and updates totals only after success', async () => {
  for (const revision of ['0', '8']) {
    const calls = []; let finish;
    const p = page((url, options) => { calls.push({ url, body: options.body }); return new Promise(resolve => { finish = resolve; }); },
      { shots: [goodShot(), goodShot('第二镜')], hasShots: revision !== '0', revision, stale: true, hasScript: false });
    p.nodes.save.disabled = true; p.nodes.api.value = ''; p.input(p.nodes['max-seconds'], '0');
    p.list.items[0].fields.title.invalid = true;
    const pending = p.clear();
    assert.equal(p.confirmations.length, 1); assert.match(p.confirmations[0], /本集全部已保存镜头.*立即生效.*无法撤销/);
    assert.match(p.confirmations[0], /不会删除剧本.*其他集.*不会调用模型/);
    assert.equal(p.main.inert, true); assert.equal(p.nodes.clear.textContent, '删除中…'); assert.equal(p.list.items.length, 2);
    await p.clear(); await p.generate(); await p.save(); p.add();
    assert.equal(calls.length, 1); assert.equal(calls[0].url, `${base}/clear-storyboards`);
    assert.deepEqual(Object.fromEntries(calls[0].body), { revision, confirmed: 'yes' });
    assert.equal(p.beforeUnload(), true);
    finish(ok({ revision: revision === '0' ? 0 : 9, message: '本集全部镜头已删除' })); await pending;
    assert.equal(p.list.items.length, 0); assert.equal(p.nodes.count.textContent, '0 镜头'); assert.match(p.nodes.total.textContent, /0 分 0\.0 秒/);
    assert.equal(p.nodes.empty.hidden, false); assert.equal(p.nodes.clear.disabled, true);
    assert.equal(p.nodes.clear.textContent, '删除全部镜头'); assert.equal(p.form.dataset.stale, 'false');
    assert.equal(p.form.dataset.dirty, ''); assert.equal(p.form.dataset.hasShots, 'false'); assert.equal(p.beforeUnload(), false);
    assert.deepEqual(p.reloads, [{ hash: '', guarded: false }]);
    await p.clear(); assert.equal(calls.length, 1);
  }
});

test('clear all cancellation preserves everything; empty page disables it, adding local shots enables it, paid recovery needs separate discard consent', async () => {
  const p = page(() => assert.fail('cancel must not submit'), { shots: [goodShot()], confirmed: false });
  p.input(p.list.items[0].fields.title, '保留未保存编辑'); p.nodes.recovery.hidden = false; p.nodes['recovery-text'].value = '付费返回文本';
  await p.clear(); assert.equal(p.list.items.length, 1); assert.equal(p.list.items[0].fields.title.value, '保留未保存编辑');
  assert.equal(p.nodes['recovery-text'].value, '付费返回文本'); assert.equal(p.beforeUnload(), true); assert.equal(p.reloads.length, 0);
  const empty = page(() => assert.fail('empty/cancelled page must not submit'), { confirmed: false });
  assert.equal(empty.nodes.clear.disabled, true); await empty.clear(); assert.equal(empty.confirmations.length, 0);
  empty.add(); assert.equal(empty.nodes.clear.disabled, false); await empty.clear(); assert.equal(empty.list.items.length, 1);
  let confirmations = 0;
  const recovery = page(() => assert.fail('recovery cancellation must not submit'), { shots: [goodShot()], confirmed: () => ++confirmations === 1 });
  recovery.nodes.recovery.hidden = false; recovery.nodes['recovery-text'].value = '付费返回文本';
  await recovery.clear(); assert.equal(confirmations, 2); assert.match(recovery.confirmations[1], /复制.*放弃/);
  assert.equal(recovery.list.items.length, 1); assert.equal(recovery.nodes['recovery-text'].value, '付费返回文本'); assert.equal(recovery.beforeUnload(), true);
});

test('clear all failure/conflict/unknown result retains edits, snapshots and paid recovery without retry or fake success', async () => {
  for (const response of [failed({ error: '分镜已变化，没有删除镜头' }), ok({}), null]) {
    let calls = 0;
    const p = page(async () => { calls++; if (!response) throw new TypeError('network'); return response; }, { shots: [goodShot()], revision: '7' });
    p.input(p.list.items[0].fields.title, '保留编辑'); p.nodes.recovery.hidden = false; p.nodes['recovery-text'].value = '付费返回文本';
    await p.clear(); assert.equal(calls, 1); assert.equal(p.list.items[0].fields.title.value, '保留编辑');
    assert.equal(p.form.dataset.revision, '7'); assert.equal(p.form.dataset.hasShots, 'true'); assert.equal(p.form.dataset.dirty, 'true');
    assert.equal(p.nodes.count.textContent, '1 镜头'); assert.equal(p.nodes.recovery.hidden, false); assert.equal(p.nodes['recovery-text'].value, '付费返回文本');
    assert.equal(p.main.inert, false); assert.equal(p.nodes.clear.disabled, false); assert.equal(p.nodes.clear.textContent, '删除全部镜头');
    assert.equal(p.reloads.length, 0); assert.equal(p.beforeUnload(), true); assert.match(p.nodes.error.textContent, /分镜已变化|删除结果未确认/);
    assert.doesNotMatch(p.nodes.error.textContent, /可能已计费/);
  }
});

test('first generation submits only current snapshots and selected LLM, revision zero valid; locks duplicates, then reloads after unlock', async () => {
  const calls = []; let finish;
  const p = page((url, options) => { calls.push({ url, body: options.body }); return new Promise(resolve => { finish = resolve; }); });
  assert.equal(p.beforeUnload(), false);
  const pending = p.generate(); assert.equal(p.main.inert, true); assert.equal(p.nodes.generate.textContent, '生成中…');
  await p.generate(); await p.save(); p.add(); assert.equal(calls.length, 1); assert.equal(p.list.items.length, 0);
  assert.equal(p.beforeUnload(), true); assert.equal(p.confirmations.length, 0);
  assert.equal(calls[0].url, `${base}/generate-storyboards`);
  assert.deepEqual(Object.fromEntries(calls[0].body), { revision: '0', scriptRevision: '4', resourceRevision: 'resources-current', maxShotSeconds: '5',
    apiConfigId: '3', model: 'shot-model', baseUrl: 'https://model.test/v1', replaceConfirmed: 'no' });
  finish(ok({ revision: 1, message: '已生成草稿', redirect: '/projects/1?view=storyboards&episode=2#storyboard-panel' })); await pending;
  assert.equal(p.form.dataset.revision, '1'); assert.equal(p.nodes.generate.textContent, '生成分镜');
  assert.deepEqual(p.reloads, [{ hash: 'storyboard-panel', guarded: false }]);
});

test('manual confirmation sends all shot fields, numeric duration/resource IDs and null scene; saves once without model calls', async () => {
  const calls = [], p = page(async (url, options) => { calls.push({ url, body: options.body }); return ok({ revision: 2, message: '已确认', redirect: '/projects/1?view=storyboards&episode=2' }); }, { shots: [goodShot()], revision: '1' });
  const item = p.list.items[0];
  p.input(item.fields.title, '人工改稿'); p.input(item.fields.sceneId, ''); p.input(p.nodes['max-seconds'], '5.0');
  assert.equal(p.beforeUnload(), true); assert.equal(p.nodes.dirty.textContent, '有未保存修改');
  await p.save(); assert.equal(calls.length, 1); assert.equal(calls[0].url, `${base}/storyboards`);
  const body = calls[0].body, shots = JSON.parse(body.get('shots'));
  assert.deepEqual(shots, [{ ...goodShot(), title: '人工改稿', sceneId: null, characterLooks: [] }]);
  assert.equal(body.get('revision'), '1'); assert.equal(body.get('scriptRevision'), '4'); assert.equal(body.get('resourceRevision'), 'resources-current');
  assert.equal(body.get('maxShotSeconds'), '5'); assert.equal(body.has('apiConfigId'), false); assert.equal(body.has('replaceConfirmed'), false);
  assert.equal(p.form.dataset.dirty, ''); assert.equal(p.beforeUnload(), false); assert.equal(p.reloads.length, 1);
});

test('manual look selection sends numeric per-visible-actor snapshots, keeps text and duration unchanged, no paid request or auto-selection', async () => {
  const calls = [], p = page(async (url, options) => { calls.push({ url, body: options.body }); return ok({ revision: 2 }); }, { shots: [goodShot()], revision: '1' });
  const item = p.list.items[0], select = item.looks[0];
  assert.equal(select.disabled, false); assert.equal(item.looks[2].disabled, true); assert.equal(select.value, '');
  p.input(select, select.options[1].value, 'change'); assert.equal(item.previews[0].hidden, false);
  assert.equal(item.previews[0].attributes.href, '/projects/1/looks/70/images/700'); assert.equal(p.beforeUnload(), true);
  await p.save(); assert.equal(calls.length, 1); assert.equal(calls[0].url, `${base}/storyboards`); assert.equal(calls[0].body.has('apiConfigId'), false);
  assert.deepEqual(JSON.parse(calls[0].body.get('shots')), [{ ...goodShot(), characterLooks: [{ characterId: 17, lookId: 70, inputRevision: 'a'.repeat(64), imageId: 700 }] }]);
});

test('unchecking actor disables and omits its look without erasing local choice; recheck restores it, missing-image selection uses null', async () => {
  let submitted; const p = page(async (url, options) => { submitted = JSON.parse(options.body.get('shots')); return ok({ revision: 2 }); }, { shots: [goodShot()] });
  const item = p.list.items[0], select = item.looks[0]; p.input(select, select.options[1].value);
  item.characters[0].checked = false; p.form.fire('change', { target: item.characters[0] });
  assert.equal(select.disabled, true); assert.equal(item.previews[0].hidden, true); assert.equal(select.value, 'look-0');
  item.characters[0].checked = true; p.form.fire('change', { target: item.characters[0] }); assert.equal(select.disabled, false); assert.equal(item.previews[0].hidden, false);
  select.options[1].dataset.imageId = '0'; select.options[1].dataset.imageUrl = ''; p.input(select, select.value);
  assert.equal(item.previews[0].hidden, true); await p.save(); assert.equal(submitted[0].characterLooks[0].imageId, null);
  const uncheck = page(async (url, options) => { submitted = JSON.parse(options.body.get('shots')); return ok({ revision: 1 }); }, { shots: [{ ...goodShot(), characterLooks: [{ characterId: 17, lookId: 70, inputRevision: 'a'.repeat(64), imageId: 700 }] }] });
  uncheck.list.items[0].characters[0].checked = false; uncheck.form.fire('change', { target: uncheck.list.items[0].characters[0] }); await uncheck.save();
  assert.deepEqual(submitted[0].characterIds, [18]); assert.deepEqual(submitted[0].characterLooks, []);
});

test('look save failure keeps snapshots/dirty and no retry; invalid metadata stops save and unsafe preview URL is never navigable', async () => {
  let calls = 0; const p = page(async () => { calls++; return failed({ error: '定妆版本已变化' }); }, { shots: [goodShot()] });
  const select = p.list.items[0].looks[0]; p.input(select, select.options[1].value); await p.save();
  assert.equal(calls, 1); assert.equal(select.value, 'look-0'); assert.equal(p.form.dataset.dirty, 'true'); assert.equal(p.main.inert, false); assert.equal(p.reloads.length, 0);
  select.options[1].dataset.imageId = 'not-an-id'; await p.save(); assert.equal(calls, 1); assert.match(p.nodes.error.textContent, /定妆版本无效/);
  for (const url of ['javascript:alert(1)', '/projects/2/looks/70/images/700', 'https://other.invalid/image.png']) {
    select.options[1].dataset.imageUrl = url; p.input(select, select.value); assert.equal(p.list.items[0].previews[0].hidden, true); assert.equal(p.list.items[0].previews[0].attributes.href, '');
  }
});

test('regeneration warns it replaces costume choices; failure does not migrate or discard them', async () => {
  const selected = { characterId: 17, lookId: 70, inputRevision: 'b'.repeat(64), imageId: 700 };
  let body; const p = page(async (url, options) => { body = options.body; return failed({ error: '生成未成功' }); }, { shots: [{ ...goodShot(), characterLooks: [selected] }] });
  await p.generate(); assert.match(p.confirmations[0], /镜头、定妆选择.*不会自动迁移定妆选择/); assert.equal(body.has('shots'), false);
  assert.equal(p.list.items[0].looks[0].selectedOptions[0].dataset.inputRevision, selected.inputRevision); assert.equal(p.reloads.length, 0);
});

test('generation replacement confirmation includes saved, dirty and deleted-all shots; cancellation has no save or paid request', async () => {
  for (const options of [{ shots: [goodShot()] }, { shots: [], hasShots: false }, { shots: [], hasShots: true }]) {
    const p = page(() => assert.fail('Cancel must not submit'), { ...options, confirmed: false });
    if (!options.hasShots && !options.shots.length) p.input(p.nodes['max-seconds'], '6');
    await p.generate(); assert.equal(p.confirmations.length, 1); assert.match(p.confirmations[0], /不会先自动保存/);
    assert.equal(p.reloads.length, 0); assert.equal(p.main.inert, false);
  }
});

test('failed paid generation does not autosave or change any inputs, snapshots or dirty state; recovery is copyable and guards unload', async () => {
  const calls = [], raw = '</textarea><script>alert(1)</script>未保存的分镜';
  const p = page(async (url, options) => { calls.push({ url, body: options.body }); return failed({ error: '模型输出无效', recoveryText: raw }); }, { shots: [goodShot()], revision: '7' });
  p.input(p.list.items[0].fields.action, '人工动作'); p.input(p.nodes['max-seconds'], '4');
  const before = JSON.stringify(p.list.items[0].fields.action.value);
  await p.generate(); assert.equal(calls.length, 1); assert.equal(calls[0].url, `${base}/generate-storyboards`);
  assert.equal(calls[0].body.get('replaceConfirmed'), 'yes'); assert.equal(calls[0].body.has('shots'), false);
  assert.equal(JSON.stringify(p.list.items[0].fields.action.value), before); assert.equal(p.nodes['max-seconds'].value, '4');
  assert.equal(p.nodes.api.value, '3'); assert.equal(p.form.dataset.revision, '7'); assert.equal(p.form.dataset.dirty, 'true');
  assert.equal(p.nodes.recovery.hidden, false); assert.equal(p.nodes['recovery-text'].value, raw);
  assert.equal(p.nodes.error.textContent, '模型输出无效'); assert.equal(p.main.inert, false); assert.equal(p.nodes.generate.disabled, false);
  assert.equal(p.reloads.length, 0); assert.equal(p.beforeUnload(), true);
});

test('network or malformed response warns about possible billing and never retries; successful explicit generation clears recovery and dirty before reload', async () => {
  for (const response of [() => { throw new TypeError('network'); }, () => ({ ok: true, json: async () => { throw new SyntaxError('bad JSON'); } }), () => ok({ message: 'missing revision' })]) {
    let calls = 0;
    const p = page(async () => { calls++; return response(); }, { shots: [goodShot()] });
    await p.generate(); assert.equal(calls, 1); assert.match(p.nodes.error.textContent, /可能已计费/);
    assert.equal(p.main.inert, false); assert.equal(p.reloads.length, 0); assert.equal(p.list.items[0].fields.title.value, '推门');
  }
  let calls = 0;
  const p = page(async () => ++calls === 1 ? failed({ error: '返回格式无效', recoveryText: '付费内容' }) : ok({ revision: 2, redirect: '/projects/1?view=storyboards&episode=2' }), { shots: [goodShot()] });
  p.input(p.list.items[0].fields.title, '编辑稿'); await p.generate(); assert.equal(p.beforeUnload(), true);
  await p.generate(); assert.equal(calls, 2); assert.equal(p.confirmations.length, 3);
  assert.match(p.confirmations[2], /模型返回文本.*复制.*放弃/);
  assert.equal(p.nodes.recovery.hidden, true); assert.equal(p.nodes['recovery-text'].value, '');
  assert.equal(p.form.dataset.dirty, ''); assert.equal(p.reloads[0].guarded, false);
});

test('uncopied paid recovery requires explicit discard consent before saving or a fresh generation; cancel preserves all input and recovery', async () => {
  for (const action of ['save', 'generate']) {
    const p = page(() => assert.fail('Declining to discard recovery must not submit'), { shots: action === 'save' ? [goodShot()] : [], confirmed: false, revision: '7' });
    p.nodes.recovery.hidden = false; p.nodes['recovery-text'].value = '未复制的付费文本';
    if (action === 'save') p.input(p.list.items[0].fields.title, '人工改稿');
    await p[action]();
    assert.equal(p.confirmations.length, 1); assert.match(p.confirmations[0], /模型返回文本.*复制.*放弃/);
    assert.equal(p.nodes['recovery-text'].value, '未复制的付费文本'); assert.equal(p.nodes.recovery.hidden, false);
    assert.equal(p.form.dataset.revision, '7'); assert.equal(p.reloads.length, 0); assert.equal(p.main.inert, false); assert.equal(p.beforeUnload(), true);
    if (action === 'save') { assert.equal(p.list.items[0].fields.title.value, '人工改稿'); assert.equal(p.form.dataset.dirty, 'true'); }
  }
});

test('manual save may clear recovery only after discard consent; failed save retains paid recovery and edits despite consent', async () => {
  for (const success of [false, true]) {
    let calls = 0;
    const p = page(async () => { calls++; return success ? ok({ revision: 8 }) : failed({ error: '保存失败' }); }, { shots: [goodShot()], revision: '7' });
    p.nodes.recovery.hidden = false; p.nodes['recovery-text'].value = '付费返回原文'; p.input(p.list.items[0].fields.title, '编辑稿');
    await p.save(); assert.equal(calls, 1); assert.equal(p.confirmations.length, 1); assert.match(p.confirmations[0], /复制.*放弃/);
    assert.equal(p.reloads.length, Number(success)); assert.equal(p.nodes.recovery.hidden, success);
    assert.equal(p.nodes['recovery-text'].value, success ? '' : '付费返回原文'); assert.equal(p.beforeUnload(), !success);
    assert.equal(p.form.dataset.revision, success ? '8' : '7');
  }
});

test('save errors preserve edits and snapshots; conflict is not fake success; saving has duplicate lock and no retry', async () => {
  let calls = 0, finish;
  const p = page(() => { calls++; return new Promise(resolve => { finish = resolve; }); }, { shots: [goodShot()], revision: '3' });
  p.input(p.list.items[0].fields.title, '保留我'); const pending = p.save();
  await p.save(); await p.generate(); p.action(p.list.items[0], 'delete'); assert.equal(calls, 1); assert.equal(p.list.items.length, 1);
  assert.equal(p.beforeUnload(), true); finish(failed({ error: '剧本或资源已变化，请保留输入' })); await pending;
  assert.match(p.nodes.error.textContent, /已变化/); assert.equal(p.list.items[0].fields.title.value, '保留我');
  assert.equal(p.form.dataset.revision, '3'); assert.equal(p.form.dataset.dirty, 'true'); assert.equal(p.main.inert, false); assert.equal(p.nodes.save.disabled, false);
  assert.equal(p.reloads.length, 0);
  const network = page(async () => { throw new TypeError('network'); }, { shots: [goodShot()] });
  await network.save(); assert.match(network.nodes.error.textContent, /保存结果未确认/); assert.doesNotMatch(network.nodes.error.textContent, /可能已计费/);
});

test('known stale plan remains editable and copyable but cannot confirm; generation uses current snapshots and requires replacement', async () => {
  const calls = [], p = page(async (url, options) => { calls.push({ url, body: options.body }); return failed({ error: '先核对当前版本' }); }, { stale: true, shots: [goodShot()], revision: '8' });
  p.input(p.list.items[0].fields.title, '旧版复制内容'); await p.save(); assert.equal(calls.length, 0); assert.match(p.nodes.error.textContent, /旧版不能直接确认/);
  await p.generate(); assert.equal(calls.length, 1); assert.equal(calls[0].body.get('scriptRevision'), '4');
  assert.equal(calls[0].body.get('resourceRevision'), 'resources-current'); assert.equal(calls[0].body.get('replaceConfirmed'), 'yes');
  assert.equal(p.list.items[0].fields.title.value, '旧版复制内容'); assert.equal(p.beforeUnload(), true);
});

test('add, delete and reorder update local shot count, exact decimal totals and scene grouping without any API call', () => {
  const p = page(() => assert.fail('Editing must be local'), { shots: [goodShot('A', 0.1), goodShot('B', 0.2), { ...goodShot('C', 59.9), sceneHeading: '场2 外景 晨' }] });
  const [a, b, c] = p.list.items;
  assert.equal(p.nodes.count.textContent, '3 镜头'); assert.equal(p.nodes.total.textContent, '本集计划估算 1 分 0.2 秒（非实际片长）');
  assert.equal(a.parts['[data-storyboard-scene]'].hidden, false); assert.equal(b.parts['[data-storyboard-scene]'].hidden, true);
  assert.equal(c.parts['[data-storyboard-scene]'].textContent, '场2 外景 晨'); assert.equal(c.parts['[data-storyboard-scene]'].hidden, false);
  p.action(c, 'up'); assert.deepEqual(p.list.items, [a, c, b]); assert.equal(b.parts['[data-storyboard-scene]'].hidden, false);
  p.action(a, 'down'); assert.deepEqual(p.list.items, [c, a, b]); assert.equal(b.parts['[data-storyboard-scene]'].hidden, true);
  p.action(c, 'delete'); assert.equal(p.nodes.count.textContent, '2 镜头'); assert.equal(p.nodes.total.textContent, '本集计划估算 0 分 0.3 秒（非实际片长）');
  p.add(); const added = p.list.items[2]; assert.equal(added.id, 'storyboard-shot-4'); assert.equal(added.fields.title.value, ''); assert.equal(added.fields.title.focused, true);
  p.input(added.fields.duration, '0.7'); assert.equal(p.nodes.total.textContent, '本集计划估算 0 分 1.0 秒（非实际片长）');
  assert.equal(p.nodes.count.textContent, '3 镜头'); assert.equal(p.beforeUnload(), true);
  p.action(added, 'delete'); p.action(a, 'delete'); p.action(b, 'delete'); assert.equal(p.nodes.count.textContent, '0 镜头'); assert.equal(p.nodes.empty.hidden, false);
  p.add(); assert.equal(p.list.items[0].id, 'storyboard-shot-5');
});

test('delete cancellation preserves DOM, totals and dirty state; new duration respects current max, saving an empty list sends an explicit clear', async () => {
  const cancel = page(() => assert.fail('Delete must stay local'), { shots: [goodShot()], confirmed: false });
  const original = cancel.list.items[0], total = cancel.nodes.total.textContent;
  cancel.action(original, 'delete'); assert.deepEqual(cancel.list.items, [original]); assert.equal(cancel.nodes.total.textContent, total);
  assert.equal(cancel.form.dataset.dirty, undefined); assert.equal(cancel.beforeUnload(), false);
  assert.match(cancel.confirmations[0], /镜头 1.*确认保存后生效/);
  const calls = [], p = page(async (url, options) => { calls.push({ url, body: options.body }); return ok({ revision: 1 }); });
  p.input(p.nodes['max-seconds'], '2'); p.add(); assert.equal(p.list.items[0].fields.duration.value, '2');
  p.action(p.list.items[0], 'delete'); await p.save();
  assert.equal(calls.length, 1); assert.equal(calls[0].url, `${base}/storyboards`); assert.equal(calls[0].body.get('shots'), '[]');
  assert.equal(calls[0].body.get('maxShotSeconds'), '2'); assert.equal(calls[0].body.has('apiConfigId'), false);
});

test('duration overflow, invalid increments and max bounds are visible, prevent save and never silently clamp; invalid local shots do not block fresh generation', async () => {
  const calls = [], p = page(async url => { calls.push(url); return failed({ error: '模型不可用' }); }, { shots: [goodShot('A', 5)] });
  const duration = p.list.items[0].fields.duration;
  p.input(p.nodes['max-seconds'], '4'); assert.equal(duration.value, '5'); assert.match(p.nodes['duration-error'].textContent, /超过 4 秒/);
  assert.equal(duration.attributes['aria-invalid'], 'true'); await p.save(); assert.equal(calls.length, 0);
  await p.generate(); assert.deepEqual(calls, [`${base}/generate-storyboards`]); assert.equal(duration.value, '5');
  for (const invalid of ['', '0', '-1', '1.25', 'NaN', 'Infinity']) {
    p.input(duration, invalid); await p.save(); assert.equal(calls.length, 1); assert.match(p.nodes['duration-error'].textContent, /0.1 秒/);
  }
  p.input(duration, '0.3'); assert.equal(p.nodes['duration-error'].textContent, '');
  for (const max of ['0', '16', '2.5', '']) {
    p.input(p.nodes['max-seconds'], max); await p.generate(); await p.save(); assert.equal(calls.length, 1);
    assert.match(p.nodes['duration-error'].textContent, /1–15 秒的整数/);
  }
});

test('blank required fields open the shot editor and stop save; no API/script and externally inert main stop paid requests', async () => {
  const p = page(() => assert.fail('Validation must precede API')); p.add(); await p.save();
  p.input(p.list.items[0].fields.duration, '1'); p.list.items[0].parts.details.open = false; await p.save();
  assert.equal(p.list.items[0].fields.title.reported, true); assert.equal(p.list.items[0].parts.details.open, true); assert.equal(p.list.items[0].fields.title.focused, true); assert.match(p.nodes.error.textContent, /必填字段/);
  p.nodes.api.value = ''; await p.generate(); assert.match(p.nodes.error.textContent, /模型配置/);
  const noScript = page(() => assert.fail('No saved script'), { hasScript: false }); await noScript.generate(); await noScript.save(); assert.match(noScript.nodes.error.textContent, /保存本集剧本/);
  const inert = page(() => assert.fail('Another operation owns the lock')); inert.main.inert = true; await inert.generate(); inert.add(); assert.equal(inert.list.items.length, 0);
});

test('unknown/deleted shot controls do not report success or mutate another shot; invalid resource IDs remain in payload for server rejection', async () => {
  const calls = [], p = page(async (url, options) => { calls.push(JSON.parse(options.body.get('shots'))); return failed({ error: '人物或场景关联无效' }); }, { shots: [{ ...goodShot(), characterIds: [999], sceneId: 999 }] });
  p.action(card(goodShot()), 'delete'); assert.match(p.nodes.error.textContent, /镜头已不存在/); assert.equal(p.list.items.length, 1);
  await p.save(); assert.deepEqual(calls[0][0].characterIds, [999]); assert.equal(calls[0][0].sceneId, 999);
  assert.equal(p.reloads.length, 0); assert.equal(p.list.items.length, 1); assert.match(p.nodes.error.textContent, /关联无效/);
});

test('300-shot cap and oversized JSON stop save; model selection alone does not dirty the shots', async () => {
  const p = page(() => assert.fail('Too large'), { shots: Array.from({ length: 300 }, () => goodShot()) });
  assert.equal(p.nodes.add.disabled, true); p.add(); assert.equal(p.list.items.length, 300);
  for (const item of p.list.items) item.fields.dialogue.value = '中'.repeat(2000);
  await p.save(); assert.match(p.nodes.error.textContent, /512000 字符/); assert.equal(p.main.inert, false);
  let saved = 0;
  const chinese = page(async (url, options) => { saved++; assert.equal(url, `${base}/storyboards`);
    const json = options.body.get('shots'); assert.ok(json.length < 512000); assert.ok(new TextEncoder().encode(json).length > 512000); return ok({ revision: 1 });
  }, { shots: Array.from({ length: 100 }, () => ({ ...goodShot(), dialogue: '中'.repeat(2000) })) });
  await chinese.save(); assert.equal(saved, 1);
  const choice = page(() => assert.fail('Selection must not submit'));
  choice.input(choice.nodes.api, '9', 'change'); assert.equal(choice.beforeUnload(), false); assert.equal(choice.form.dataset.dirty, undefined);
});

test('browser script is a no-op away from storyboard pages', () => {
  runInNewContext(browserScript, { document: { getElementById(id) { assert.equal(id, 'storyboard-form'); return null; } } });
});

function rendererFixture(t) {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  db.exec(`INSERT INTO projects VALUES (1, '分镜测试', '国风水墨', '9:16');
    INSERT INTO seasons VALUES (1, 1, '第一季', 1);
    INSERT INTO episodes VALUES (1, 1, '第一集', 1), (2, 1, '第二集', 2);
    INSERT INTO api_configs (id, name, type, base_url, api_key, model) VALUES
      (1, '<编剧>', 'llm', 'https://model.test/v1', 'never-render-secret', 'shot-model'),
      (2, '画图模型', 'text_to_image', 'https://image.test/v1', 'image-secret', 'image-model');`);
  const script = '场1 内景 夜\n林秋推门。\n林秋：你好。\n</textarea><script>alert(1)</script>';
  db.prepare('INSERT INTO episode_scripts (episode_id, script, revision) VALUES (1, ?, 4)').run(script);
  db.exec(`INSERT INTO scenes (id, project_id, name, description) VALUES (20, 1, '客厅', '旧式客厅');
    INSERT INTO episode_occurrences (episode_id, kind, scene_id, source_name, scene_heading, quote, source_start, mode, script_revision)
      VALUES (1, 'scene', 20, '客厅', '场1 内景 夜', '林秋推门。', 9, 'on_screen', 4);
    INSERT INTO scene_references (id, scene_id, image, mime, width, height) VALUES (1, 20, x'00', 'image/png', 1, 1);`);
  const resources = storyboardResources(db, 1, 1);
  const save = shots => saveEpisodeStoryboards(db, 1, 1, new URLSearchParams({ revision: '0', scriptRevision: '4', resourceRevision: resources.revision, maxShotSeconds: '5', shots: JSON.stringify(shots) }));
  return { db, save };
}

test('renderer opens directly into planning with current snapshots and escaped resource choices, without duplicate script/resource previews or secrets', t => {
  const { db } = rendererFixture(t);
  db.exec("UPDATE scenes SET name = '<客厅>' WHERE id = 20");
  const html = renderStoryboards(db, 1, 1);
  assert.equal(typeof html, 'string');
  for (const id of ['storyboard-form', 'storyboard-recovery', 'storyboard-recovery-text', 'storyboard-shot-template']) assert.ok(html.includes(`id="${id}"`));
  assert.match(html, /data-revision="0" data-script-revision="4"/);
  assert.match(html, /id="storyboard-recovery-text"[^>]*readonly/);
  assert.doesNotMatch(html, /storyboard-script-text|storyboard-resources|storyboard-reference|查看已保存剧本|查看本集已确认资源|林秋推门。|<img/);
  assert.doesNotMatch(html, /<script>alert|episode-script-form|never-render-secret|image-secret|image-model/);
  assert.match(html, /&lt;编剧&gt; · shot-model/); assert.match(html, /data-storyboard-field="sceneId"[\s\S]*?<option value="20"[^>]*>&lt;客厅&gt;<\/option>/);
  assert.match(html, /data-storyboard-field="quote"/); assert.match(html, /根据本集已保存剧本和已确认资源生成分镜/);
  assert.match(html, /未规划 2 集 · 旧版 0 集 · 待确认 0 集/);
  assert.match(html, /data-clear-url="\/projects\/1\/episodes\/1\/clear-storyboards"/);
  assert.match(html, /id="storyboard-clear"[^>]*type="button"[^>]*disabled>删除全部镜头/);
  assert.ok(html.indexOf('id="storyboard-clear"') < html.indexOf('id="storyboard-shots"'), 'clear action is above the long shot list');
  assert.throws(() => renderStoryboards(db, 2, 1), /集不存在/);
});

test('saved shots render all fields, exact scene headings, first expanded preview and explicit missing IDs; stale plan stays visible but cannot save', t => {
  const { db, save } = rendererFixture(t);
  save([{ ...goodShot('<危险标题>', 0.1), characterIds: [], sceneId: 20 }, { ...goodShot('第二镜', 0.2), characterIds: [], sceneId: null }]);
  let html = renderStoryboards(db, 1, 1);
  for (const name of fieldNames.filter(name => name !== 'characterIds')) assert.ok(html.includes(`data-storyboard-field="${name}"`), name);
  assert.match(html, /id="storyboard-shot-1"[\s\S]*?<details open>/); assert.match(html, /id="storyboard-shot-2"[\s\S]*?<details >/);
  assert.match(html, /data-storyboard-scene hidden>场1 内景 夜/); assert.match(html, /&lt;危险标题&gt;/);
  assert.match(html, /全剧已确认且版本有效：1 \/ 2 集 · 2 镜头 · 估算 0.3 秒/);
  db.exec('DELETE FROM scenes WHERE id = 20');
  html = renderStoryboards(db, 1, 1);
  assert.match(html, /id="storyboard-stale"/); assert.match(html, /data-stale="true"/);
  assert.match(html, /已失效场景 #20/); assert.match(html, /&lt;危险标题&gt;/);
  assert.match(html, /id="storyboard-save"[^>]*disabled/); assert.match(html, /旧版 1 集/);
  assert.doesNotMatch(html, /id="storyboard-clear"[^>]*disabled/);
});

test('legacy malformed mode is shown as invalid rather than silently selecting reality; viewing never rewrites it', t => {
  const { db, save } = rendererFixture(t);
  const shot = { ...goodShot(), characterIds: [], sceneId: null }; save([shot]);
  db.prepare('UPDATE episode_storyboards SET shots = ? WHERE episode_id = 1').run(JSON.stringify([{ ...shot, mode: ['memory'] }]));
  const html = renderStoryboards(db, 1, 1);
  assert.match(html, /data-storyboard-field="mode" required><option value="" selected>画面类型无效，请重新选择/);
  assert.doesNotMatch(html, /value="(?:on_screen|memory|imagination)" selected/);
  assert.deepEqual(JSON.parse(db.prepare('SELECT shots FROM episode_storyboards WHERE episode_id = 1').get().shots)[0].mode, ['memory']);
});

test('unreviewed drafts and absent script/config/resources have explicit status, disable paid generation but not manual editing', t => {
  const { db, save } = rendererFixture(t);
  save([{ ...goodShot(), characterIds: [], sceneId: null }]); db.exec('UPDATE episode_storyboards SET reviewed = 0');
  assert.match(renderStoryboards(db, 1, 1), /生成草稿 · 待确认/); assert.match(renderStoryboards(db, 1, 1), /待确认 1 集/);
  db.exec('DELETE FROM api_configs');
  const html = renderStoryboards(db, 1, 2);
  assert.match(html, /id="storyboard-generate"[^>]*disabled/); assert.match(html, /尚无大语言模型配置/);
  assert.match(html, /还没有已保存的剧本/); assert.match(html, /还没有已确认角色/);
  assert.doesNotMatch(html, /id="storyboard-add"[^>]*disabled/);
});

test('renderer limits manual looks to the visible actor, escapes names, labels draft/stale and retains selected image version without auto-updating', t => {
  const { db } = rendererFixture(t);
  db.exec(`INSERT INTO characters (id, project_id, name) VALUES (17, 1, '<林秋>'), (18, 1, '不可选演员');
    INSERT INTO character_references (character_id, image, mime, width, height) VALUES (17, x'01', 'image/png', 16, 9);
    INSERT INTO episode_occurrences (episode_id, kind, character_id, source_name, scene_heading, quote, source_start, mode, script_revision)
      VALUES (1, 'character', 17, '林秋', '场1 内景 夜', '林秋推门。', 9, 'on_screen', 4);
    INSERT INTO looks (id, project_id, character_id, name, prompt) VALUES (1, 1, 17, '<影院装>', 'PRIVATE_LOOK_PROMPT'), (2, 1, 17, '缺图草稿', ''), (3, 1, 18, 'PRIVATE_OTHER_ACTOR_LOOK', ''), (4, 1, 17, '旧图定妆', '旧衣');`);
  const inputs = id => lookInputs(db, 1, db.prepare('SELECT * FROM looks WHERE id = ?').get(id));
  const image = id => Number(db.prepare("INSERT INTO look_images (look_id, image, mime, width, height, valid, revision, model, prompt, inputs_json) VALUES (?, x'01', 'image/png', 16, 9, 1, ?, 'fake-model', 'PRIVATE_IMAGE_PROMPT', '{}')").run(id, inputs(id).revision).lastInsertRowid);
  const first = image(1); image(4); db.exec("UPDATE looks SET prompt = '新衣' WHERE id = 4");
  let html = renderStoryboards(db, 1, 1);
  assert.match(html, /data-storyboard-look data-character-id="17" disabled/); assert.match(html, /&lt;影院装&gt;/);
  assert.match(html, /缺图草稿.*缺少定妆图/); assert.match(html, /旧图定妆.*旧依据待核对/); assert.doesNotMatch(html, /PRIVATE_|<影院装>|<img/);
  const choice = storyboardLookChoices(db, 1, [17]).find(choice => choice.id === 1);
  const binding = { characterId: 17, lookId: choice.id, inputRevision: choice.inputRevision, imageId: choice.imageId };
  saveEpisodeStoryboards(db, 1, 1, new URLSearchParams({ revision: '0', scriptRevision: '4', resourceRevision: storyboardResources(db, 1, 1).revision, maxShotSeconds: '5', shots: JSON.stringify([{ ...goodShot(), characterIds: [17], sceneId: 20, characterLooks: [binding] }]) }));
  const stored = db.prepare('SELECT * FROM episode_storyboards WHERE episode_id = 1').get(); const latest = image(1);
  html = renderStoryboards(db, 1, 1);
  assert.match(html, new RegExp(`<option value="1:${first}:${binding.inputRevision}"[^>]*selected>已选版本：&lt;影院装&gt;.*图片已准备`));
  assert.match(html, new RegExp(`<option value="1:${latest}:${binding.inputRevision}"[^>]*>最新版本：&lt;影院装&gt;`));
  assert.doesNotMatch(html, new RegExp(`<option value="1:${latest}:${binding.inputRevision}"[^>]*selected`));
  assert.doesNotMatch(html, /data-stale="true"/); assert.deepEqual(db.prepare('SELECT * FROM episode_storyboards WHERE episode_id = 1').get(), stored);
  db.prepare('UPDATE look_images SET cleared = 1 WHERE id = ?').run(first);
  html = renderStoryboards(db, 1, 1); assert.match(html, /已选版本：&lt;影院装&gt;.*已失效，请取消或重选/);
  assert.match(html, new RegExp(`data-image-id="${first}" data-image-url="" selected`));
  db.exec('DELETE FROM looks WHERE id = 1'); html = renderStoryboards(db, 1, 1);
  assert.match(html, /已选版本：原定妆 · #1 · 已失效，请取消或重选/); assert.deepEqual(db.prepare('SELECT * FROM episode_storyboards WHERE episode_id = 1').get(), stored);
});
