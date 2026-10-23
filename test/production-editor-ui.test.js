import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const code = await readFile(new URL('../public/production-editor.js', import.meta.url), 'utf8');
function node(props = {}) { const events = {}; return { value: '', textContent: '', dataset: {}, hidden: false, checked: false, addEventListener(name, fn) { events[name] = fn; }, fire(name, event = {}) { let stopped = false; events[name]?.({ preventDefault() { stopped = true; }, stopImmediatePropagation() { stopped = true; }, ...event }); return stopped; }, ...props }; }
function fixture(confirmed = true) {
  const pictures = [1, 2].map(id => { const number = node(); return node({ value: String(id), checked: true, dataset: { picture: JSON.stringify({ table: 'scene_images', id, label: `scene${id}` }) }, parentElement: { querySelector() { return number; } } }); });
  const number = node(), description = node({ value: 'A room' });
  const mapped = pictures.map(p => { const label = node(); return node({ value: p.value, checked: true, parentElement: { querySelector() { return label; } } }); });
  const row = node({ querySelector(selector) { return selector === '[data-subject-number]' ? number : description; }, querySelectorAll() { return mapped; } });
  const fields = Object.fromEntries(['pictures', 'subjects', 'subject_definitions'].map(name => [name, node()]));
  const form = node({ querySelectorAll() { return pictures; }, elements: { namedItem(name) { return fields[name]; } } });
  const container = node({ querySelectorAll() { return [row]; } });
  const ids = { 'production-clip-form': form, 'clip-subjects': container, 'clip-subject-template': node(), 'clip-mapping-review': node({ hidden: true }), 'clip-mapping-reviewed': node(), 'clip-editor-error': node(), 'add-clip-subject': node(), 'sync-clip-subjects': node() };
  runInNewContext(code, { document: { getElementById(id) { return ids[id]; } }, window: { confirm() { return confirmed; } } });
  return { ids, pictures, mapped, fields, form, description, change() { form.fire('change', { target: { matches() { return true; } } }); }, submit() { return form.fire('submit'); } };
}
test('可视化图和多图主体提交实际图片对象，不混入缩略图字段，不调用模型', () => {
  const f = fixture(); assert.equal(f.submit(), false);
  assert.deepEqual(JSON.parse(f.fields.subjects.value), [{ number: 1, description: 'A room', pictures: [1, 2] }]);
  assert.deepEqual(JSON.parse(f.fields.pictures.value).map(p => p.id), [1, 2]);
});
test('调整图片顺序按身份保留主体映射，但必须人工确认正文编号，不自动改六段', () => {
  const f = fixture(); f.mapped[1].checked = false; f.fields.subject_definitions.value = 'original text';
  f.pictures.reverse(); f.change();
  assert.equal(f.form.dataset.dirty, 'true'); assert.equal(f.ids['clip-mapping-review'].hidden, false);
  assert.equal(f.submit(), true); assert.equal(f.fields.subject_definitions.value, 'original text');
  f.ids['clip-mapping-reviewed'].checked = true; assert.equal(f.submit(), false);
  assert.deepEqual(JSON.parse(f.fields.subjects.value)[0].pictures, [2]);
  assert.deepEqual(JSON.parse(f.fields.pictures.value).map(p => p.id), [2, 1]);
});
test('取消仍被主体使用的参考图不能静默丢映射，需显式取消主体引用', () => {
  const f = fixture(); f.pictures[0].checked = false; f.change(); f.ids['clip-mapping-reviewed'].checked = true;
  assert.equal(f.mapped[0].disabled, false); assert.equal(f.mapped[0].checked, true); assert.equal(f.submit(), true);
  f.mapped[0].checked = false; assert.equal(f.submit(), false);
  assert.deepEqual(JSON.parse(f.fields.subjects.value)[0].pictures, [1]);
});
test('写入第一段须确认，仅格式化人工描述及真实映射；取消保留原文', () => {
  const f = fixture(); f.ids['sync-clip-subjects'].fire('click');
  assert.equal(f.fields.subject_definitions.value, '<Subject 1> A room (<Picture 1>, <Picture 2>)');
  assert.equal(f.ids['clip-mapping-reviewed'].checked, false);
  const cancel = fixture(false); cancel.fields.subject_definitions.value = 'keep'; cancel.ids['sync-clip-subjects'].fire('click'); assert.equal(cancel.fields.subject_definitions.value, 'keep');
});
