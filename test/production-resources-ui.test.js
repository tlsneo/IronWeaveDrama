import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { DatabaseSync } from 'node:sqlite';

const script = await readFile(new URL('../public/production-resources.js', import.meta.url), 'utf8');
const renderer = await readFile(new URL('../src/render-production-resources.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../public/production-resources.css', import.meta.url), 'utf8');
// 后端由另一工作区负责：临时模块只替换已约定的读接口，SSR 的 SQL 在真实 SQLite 上执行。
const directory = await mkdtemp(join(tmpdir(), 'production-ui-'));
after(() => rm(directory, { recursive: true, force: true }));
await Promise.all([
  writeFile(join(directory, 'package.json'), '{"type":"module"}'),
  writeFile(join(directory, 'render-production-resources.js'), renderer),
  writeFile(join(directory, 'render-image-dialog.js'), await readFile(new URL('../src/render-image-dialog.js', import.meta.url), 'utf8')),
  writeFile(join(directory, 'html.js'), await readFile(new URL('../src/html.js', import.meta.url), 'utf8')),
  writeFile(join(directory, 'production-assets.js'), `
    export function findProductionAsset(db, project, kind, id) {
      const row = db.prepare('SELECT id, project_id, kind, name, description, revision FROM production_assets WHERE project_id = ? AND kind = ? AND id = ?').get(project, kind, id);
      if (!row) throw Object.assign(new Error('素材不存在'), { status: 404 });
      return row;
    }
    export function readAssetImage(db, id) {
      return db.prepare('SELECT id, mime, width, height FROM production_asset_images WHERE asset_id = ? AND cleared = 0 ORDER BY id DESC LIMIT 1').get(id) ?? null;
    }
  `),
  writeFile(join(directory, 'looks.js'), `
    export function findLook(db, project, id) {
      const row = db.prepare('SELECT id, project_id, character_id, name, prompt, revision FROM looks WHERE project_id = ? AND id = ?').get(project, id);
      if (!row) throw Object.assign(new Error('定妆不存在'), { status: 404 });
      return row;
    }
    export function lookInputs(db, project, look) {
      if (look.project_id !== project) throw new Error('跨项目输入');
      return db.testInputs;
    }
    export function readLookImage(db, id) {
      return db.prepare('SELECT id, mime, width, height, revision FROM look_images WHERE look_id = ? AND valid = 1 AND cleared = 0 ORDER BY id DESC LIMIT 1').get(id) ?? null;
    }
  `),
]);
const { renderProductionAssets, renderLooks } = await import(pathToFileURL(join(directory, 'render-production-resources.js')));
const query = text => new URLSearchParams(text);
const dangerous = '<演员 & "同名">';
function database(t) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec(`
    CREATE TABLE characters (id INTEGER PRIMARY KEY, project_id INTEGER, name TEXT);
    CREATE TABLE production_assets (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER, kind TEXT, name TEXT, description TEXT, revision INTEGER);
    CREATE TABLE production_asset_images (id INTEGER PRIMARY KEY AUTOINCREMENT, asset_id INTEGER, image BLOB, mime TEXT, width INTEGER, height INTEGER, cleared INTEGER, created_at TEXT);
    CREATE TABLE looks (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER, character_id INTEGER, name TEXT, prompt TEXT, revision INTEGER);
    CREATE TABLE look_assets (look_id INTEGER, asset_id INTEGER);
    CREATE TABLE look_images (id INTEGER PRIMARY KEY AUTOINCREMENT, look_id INTEGER, image BLOB, mime TEXT, width INTEGER, height INTEGER, valid INTEGER, cleared INTEGER, revision TEXT, model TEXT, prompt TEXT, inputs_json TEXT, created_at TEXT);
    CREATE TABLE api_configs (id INTEGER PRIMARY KEY, name TEXT, type TEXT, model TEXT, base_url TEXT, api_key TEXT);
    INSERT INTO characters VALUES (11, 7, '演员'), (12, 7, '演员'), (13, 8, '外项目演员');
    INSERT INTO production_assets VALUES (1, 7, 'costumes', '衣服', '衣服说明', 3), (2, 7, 'props', '道具', '道具说明', 4), (3, 8, 'props', '外项目道具', '', 1), (4, 7, 'props', '缺图道具', '', 1);
    INSERT INTO production_asset_images VALUES (101, 1, X'0102', 'image/png', 200, 300, 0, 'now'), (102, 2, X'0102', 'image/png', 200, 300, 1, 'now'), (103, 2, X'0102', 'image/webp', 400, 500, 0, 'now');
    INSERT INTO looks VALUES (1, 7, 11, '定妆', '提示词', 5), (2, 8, 13, '外项目定妆', '', 1), (3, 7, NULL, '草稿', '', 1);
    INSERT INTO look_assets VALUES (1, 1), (1, 2);
    INSERT INTO look_images VALUES (501, 1, X'0102', 'image/png', 600, 700, 1, 0, 'old-input', 'model', 'prompt', '{}', 'now'), (502, 1, X'0102', 'image/png', 600, 700, 0, 0, 'input-current', 'failed-model', 'prompt', '{}', 'now'), (503, 1, X'0102', 'image/png', 600, 700, 1, 1, 'old-input', 'model', 'prompt', '{}', 'now'), (504, 2, X'0102', 'image/png', 600, 700, 1, 0, 'other', 'model', 'prompt', '{}', 'now');
    INSERT INTO api_configs VALUES (21, '图生图', 'image_to_image', 'model', 'https://example.invalid/v1', 'NEVER_EXPOSE_API_KEY'), (22, '文生图不应出现', 'text_to_image', 'other', 'https://other.invalid', 'OTHER_KEY'), (23, 'LLM不应出现', 'llm', 'llm', 'https://llm.invalid', 'LLM_KEY'), (24, '编辑图片', 'image_edit', 'masked-model', 'https://edit.invalid', 'MASK_SECRET_KEY');
  `);
  sqlite.prepare('UPDATE characters SET name = ? WHERE id IN (11, 12)').run(dangerous);
  sqlite.prepare('UPDATE production_assets SET name = ?, description = ? WHERE id = 1').run(dangerous, '</textarea><script>bad()</script>');
  sqlite.prepare('UPDATE looks SET name = ?, prompt = ? WHERE id = 1').run(dangerous, '</textarea><script>bad()</script>');
  const queries = [];
  const db = {
    prepare(sql) { queries.push(sql); return sqlite.prepare(sql); },
    testInputs: {
      revision: 'input-current', character: { id: 11, name: dangerous, image: { id: 99, type: 'reference', url: '/projects/7/characters/11/references/99', mime: 'image/png', width: 20, height: 30, bytes: Buffer.from('NEVER_EXPOSE_BYTES') } },
      assets: [1, 2].map(id => ({ id, kind: id === 1 ? 'costumes' : 'props', name: '素材', description: '', image: { id: 100 + id, bytes: Buffer.from('NEVER_EXPOSE_BYTES') } })),
      missing: [], style: '<风格 & "手绘">', aspectRatio: '16:9', format: 'four-view',
    },
  };
  return { db, sqlite, queries };
}

test('SSR 素材详情：使用正确路径、revision、显式上传；名称/说明/确认消息转义且不提供素材生成', t => {
  const { db, queries } = database(t);
  const result = renderProductionAssets(db, 7, 'costumes', query('asset=1'));
  assert.equal(result.title, dangerous);
  assert.equal(result.actions, '');
  assert.match(result.content, /id="production-form" data-kind="asset" data-url="\/projects\/7\/costumes\/1" data-reference-id="101"/);
  assert.match(result.content, /name="revision" value="3"/);
  assert.match(result.content, /name="description" maxlength="1000"/);
  assert.match(result.content, /&lt;演员 &amp; &quot;同名&quot;&gt;/);
  assert.match(result.content, /&lt;\/textarea&gt;&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.match(result.content, /\/projects\/7\/costumes\/1\/images\/101/);
  assert.match(result.content, /id="production-reference-file" type="file" accept="image\/png,image\/jpeg,image\/webp"/);
  assert.match(result.content, /已有定妆将解除这项素材关联，旧生成图保留/);
  assert.doesNotMatch(result.content, /<script>|look-generation-form|data-model|api_key|generate/);
  assert.ok(queries.every(sql => !/\bimage\b/i.test(sql)));
  const props = renderProductionAssets(db, 7, 'props', query('asset=2')).content;
  assert.match(props, /\/projects\/7\/props\/2\/images\/103/);
  assert.doesNotMatch(props, /images\/102/);
});

test('SSR 定妆：项目内选择、同名带 ID、可存空演员、多件素材、图生图／编辑配置隔离及旧依据历史', t => {
  const { db, sqlite, queries } = database(t);
  sqlite.prepare('UPDATE api_configs SET name = ?, model = ?, base_url = ? WHERE id = 21').run(dangerous, 'model"<&', 'https://example.invalid/?a="&b=1');
  const result = renderLooks(db, 7, query('look=1'));
  assert.match(result.content, /data-kind="look" data-url="\/projects\/7\/looks\/1"/);
  assert.match(result.content, /name="revision" value="5"/);
  assert.match(result.content, /name="characterId"><option value="">暂不选择/);
  assert.match(result.content, /value="11" selected/);
  assert.match(result.content, /value="12"/);
  assert.match(result.content, /name="prompt" maxlength="12000"/);
  assert.match(result.content, /name="assetId" value="1" checked/);
  assert.match(result.content, /name="assetId" value="2" checked/);
  assert.match(result.content, /name="assetId" value="4"/);
  assert.doesNotMatch(result.content, /外项目|value="13"|name="assetId" value="3"/);
  assert.match(result.content, /id="look-generation-form"[^>]*data-url="\/projects\/7\/looks\/1\/generate"[^>]*data-revision="5" data-input-revision="input-current"/);
  assert.match(result.content, /id="look-api"/);
  assert.match(result.content, /参考图 1 · 基础演员/);
  assert.match(result.content, /参考图 2 · 服饰/);
  assert.match(result.content, /参考图 3 · 道具/);
  assert.match(result.content, /look-reference-order[\s\S]*\/projects\/7\/characters\/11\/references\/99/);
  assert.match(result.content, /data-model="model&quot;&lt;&amp;" data-base-url="https:\/\/example.invalid\/\?a=&quot;&amp;b=1"/);
  assert.doesNotMatch(result.content, /NEVER_EXPOSE|API_KEY|OTHER_KEY|LLM_KEY|MASK_SECRET_KEY|文生图不应出现|LLM不应出现|<script>/);
  assert.ok(queries.every(sql => !/\b(api_key|image|bytes)\b/i.test(sql)));
  assert.match(result.content, /当前图使用旧依据，待核对/);
  assert.match(result.content, /\/projects\/7\/looks\/1\/images\/501/);
  assert.match(result.content, /查看图片 #502<\/a><span>无效/);
  assert.match(result.content, /查看图片 #503<\/a><span>有效 · 已清除 · 旧依据待核对/);
  assert.doesNotMatch(result.content, /images\/504/);
  assert.match(result.content, /定妆资料及其全部生成图将删除.*已关联分镜的定妆选择会失效.*不会删除基础演员、服饰或道具/);
  assert.match(result.description, /可在分镜出镜角色旁手动关联/);
  assert.match(result.content, /&lt;\/textarea&gt;&lt;script&gt;/);
  assert.doesNotMatch(result.content, /id="look-generate"[^>]*disabled/);
  assert.match(css, /production-preview-image[^}]*aspect-ratio: auto/);
  assert.match(result.content, /固定横向16:9/);
  assert.match(result.content, /id="look-board-image"[^>]*src="\/projects\/7\/looks\/1\/images\/501"/);
  assert.match(result.content, /id="edit-look-image"[^>]*>AI修图/);
  assert.match(result.content, /id="look-image-edit-dialog"[^>]*data-kind="look"/);
  assert.match(result.content, /id="look-edit-api"[\s\S]*value="24">编辑图片 · masked-model/);
  assert.match(result.content, /id="submit-look-edit"[^>]*disabled/);
  assert.match(result.content, /遮罩接口待接入，当前不会调用模型/);
});

test('SSR 缺演员/素材图片禁用生成，但可保存草稿；当前依据相符时不标旧图，历史只列最近 20 张', t => {
  const { db, sqlite } = database(t);
  db.testInputs.missing = ['请选择基础演员', '道具 #4 缺少图片 <待补>'];
  const draft = renderLooks(db, 7, query('look=3')).content;
  assert.match(draft, /请选择基础演员/);
  assert.match(draft, /缺少图片 &lt;待补&gt;/);
  assert.match(draft, /id="look-generate"[^>]*disabled/);
  assert.match(draft, /<button class="create-button" type="submit">保存资料/);
  assert.match(draft, /id="look-clear-image"[^>]*disabled/);
  assert.match(draft, /id="edit-look-image"[^>]*disabled/);
  assert.doesNotMatch(draft, /id="look-board-image"/);
  db.testInputs.missing = [];
  sqlite.prepare('UPDATE look_images SET revision = ? WHERE id = 501').run('input-current');
  const same = renderLooks(db, 7, query('look=1')).content;
  assert.doesNotMatch(same, /当前图使用旧依据/);
  for (let i = 0; i < 25; i++) sqlite.prepare("INSERT INTO look_images (look_id, width, height, valid, cleared, revision, model, created_at) VALUES (1, 1, 1, 0, 0, 'input-current', 'model', 'now')").run();
  const history = renderLooks(db, 7, query('look=1')).content;
  assert.equal((history.match(/查看图片 #/g) ?? []).length, 20);
  assert.doesNotMatch(history, /查看图片 #502/);
  sqlite.exec("DELETE FROM api_configs WHERE type = 'image_to_image'");
  assert.match(renderLooks(db, 7, query('look=1')).content, /id="look-generate"[^>]*disabled/);
});

test('SSR 名称搜索与每页 50 项；仅多页出现分页；创建只复用名称弹框，详情参数隔离项目/库', t => {
  const { db, sqlite } = database(t);
  const first = renderProductionAssets(db, 7, 'props', query(''));
  assert.match(first.actions, /data-name-dialog data-url="\/projects\/7\/props"/);
  assert.doesNotMatch(first.content, /character-pagination|外项目道具/);
  assert.match(first.content, /resource=props&amp;asset=2/);
  for (let i = 0; i < 52; i++) sqlite.prepare("INSERT INTO production_assets (project_id, kind, name, description, revision) VALUES (7, 'props', ?, '', 1)").run(`Search-${i}`);
  const page1 = renderProductionAssets(db, 7, 'props', query('q=search&page=1')).content;
  assert.equal((page1.match(/<article class="project-card/g) ?? []).length, 50);
  assert.match(page1, /第 1 \/ 2 页/);
  assert.match(page1, /resource=props&amp;q=search&amp;page=2/);
  const last = renderProductionAssets(db, 7, 'props', query('q=Search&page=99')).content;
  assert.equal((last.match(/<article class="project-card/g) ?? []).length, 2);
  assert.match(last, /第 2 \/ 2 页/);
  assert.match(renderLooks(db, 7, query('')).actions, /data-url="\/projects\/7\/looks"/);
  assert.match(renderLooks(db, 7, query('q=草稿')).content, /resource=looks&amp;look=3/);
  const escaped = renderProductionAssets(db, 7, 'costumes', query('q=%3C%22%26')).content;
  assert.match(escaped, /value="&lt;&quot;&amp;"/);
  for (const params of ['page=0', 'page=-1', 'page=1.5', 'page=999999999999999999', 'page=1&page=2', 'q=a&q=b', `q=${'x'.repeat(81)}`]) {
    assert.throws(() => renderLooks(db, 7, query(params)), { status: 400 });
  }
  for (const params of ['asset=0', 'asset=1&asset=2', 'asset=1e0', 'asset=3']) assert.throws(() => renderProductionAssets(db, 7, 'props', query(params)), { status: 404 });
  assert.throws(() => renderProductionAssets(db, 7, 'props', query('asset=1')), { status: 404 });
  assert.throws(() => renderProductionAssets(db, 7, 'unknown', query('')), { status: 400 });
  for (const params of ['look=2', 'look=0', 'look=1&look=3']) assert.throws(() => renderLooks(db, 7, query(params)), { status: 404 });
});

function browser(fetch, { kind = 'look', confirm = () => true } = {}) {
  const nodes = {}, windowEvents = {}, navigation = [], events = {};
  function node(id, extra = {}) {
    const value = { id, dataset: {}, textContent: '', disabled: false, inert: false, hidden: false, attributes: {},
      addEventListener(type, handler) { (events[`${id}:${type}`] ??= []).push(handler); },
      setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; }, focus() {}, reportValidity() { return true; },
      ...extra,
    };
    nodes[id] = value;
    return value;
  }
  const main = node('main');
  const deletion = node('delete', { textContent: '删除', dataset: { deleteUrl: `/projects/7/${kind === 'asset' ? 'props' : 'looks'}/1/delete`, deleteName: '资源', deleteMessage: '删除资料和图片，解除关联或保留基础资源。' } });
  const root = node('root', { querySelectorAll: () => [deletion], querySelector: () => deletion });
  const save = node('save', { textContent: '保存资料' });
  const nameForm = node('name-form');
  const fields = { revision: '5', name: '资源<名字>', ...(kind === 'asset' ? { description: '说明' } : { characterId: '11', prompt: '原始提示词', assetId: ['1', '2'] }) };
  const form = kind === 'list' ? null : node('production-form', {
    dataset: { kind, url: `/projects/7/${kind === 'asset' ? 'props' : 'looks'}/1`, referenceId: '103' },
    querySelector: () => save, elements: { namedItem: name => ({ value: fields[name] }) },
  });
  const error = node('production-error'), status = node('production-status');
  const recovery = node('production-recovery', { hidden: true }), recoveryLink = node('production-recovery-link');
  let file;
  if (kind === 'asset') {
    let value = '';
    file = node('production-reference-file', { files: [] });
    Object.defineProperty(file, 'value', { get: () => value, set(next) { value = next; if (next === '') file.files = []; } });
    node('production-upload', { textContent: '上传参考图' });
    node('production-clear-reference', { textContent: '移除参考图' });
  }
  if (kind === 'look') {
    node('look-generation-form', { dataset: { url: '/projects/7/looks/1/generate', revision: '5', inputRevision: 'input-hash', missing: 'false', imageId: '501' } });
    node('look-api', { value: '21', selectedOptions: [{ dataset: { model: 'test-model', baseUrl: 'https://example.invalid/v1' } }] });
    node('look-generate', { textContent: '生成定妆图' });
    node('look-clear-image', { textContent: '清除当前图' });
  }
  class BrowserFormData extends FormData {
    constructor(target) {
      super();
      if (target) {
        const values = target === nameForm ? { name: '仅名称', seasonId: '9' } : fields;
        for (const [name, value] of Object.entries(values)) for (const item of Array.isArray(value) ? value : [value]) this.append(name, item);
        for (const handler of events[`${target.id}:formdata`] ?? []) handler({ formData: this });
      }
    }
  }
  const beforeUnload = () => {
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    windowEvents.beforeunload?.(event);
    return event;
  };
  runInNewContext(script, {
    document: { getElementById: id => nodes[id], querySelector: selector => selector === 'main' ? main : root },
    window: {
      confirm, addEventListener(type, handler) { windowEvents[type] = handler; },
      location: {
        assign(url) { navigation.push({ url, inert: main.inert, dirty: form?.dataset.dirty, guarded: beforeUnload().prevented }); },
        reload() { this.assign('reload'); },
      },
    },
    fetch, FormData: BrowserFormData, URLSearchParams, TypeError, Error,
  });
  async function fire(id, type) {
    const event = { stopped: false, preventDefault() {}, stopPropagation() { this.stopped = true; } };
    await Promise.all((events[`${id}:${type}`] ?? []).map(handler => handler(event)));
    return event;
  }
  return { nodes, fields, form, main, file, error, status, recovery, recoveryLink, navigation, beforeUnload, fire,
    save: () => fire('production-form', 'submit'), generate: () => fire('look-generation-form', 'submit'),
    delete: () => fire('delete', 'click'), changed: () => fire('production-form', 'input'),
    namePayload(url) { nameForm.dataset.url = url; return new BrowserFormData(nameForm); },
  };
}
const success = result => ({ ok: true, json: async () => result });
const failure = result => ({ ok: false, json: async () => result });
const savedResult = { id: 1, revision: 6, redirect: '/projects/7?resource=looks&look=1' };

test('VM 数据库写入失败的付费图片可下载，离页与下一操作须保护，取消不重试且输入不丢失', async () => {
  const image='data:image/png;base64,iVBORw0KGgo='; let calls=0;
  const p=browser(async()=>{calls++;return failure({error:'图片未能保存',recoveryImage:image});},{confirm:()=>false});
  await p.generate(); assert.equal(calls,1); assert.equal(p.recovery.hidden,false);
  assert.equal(p.recoveryLink.attributes.href,image); assert.match(p.recoveryLink.attributes.download,/\.png$/);
  assert.equal(p.recovery.dataset.unsaved,'true'); assert.equal(p.beforeUnload().prevented,true);
  await p.generate(); await p.save(); assert.equal(calls,1); assert.equal(p.fields.prompt,'原始提示词'); assert.equal(p.navigation.length,0);
  for(const invalid of ['data:text/html;base64,PHNjcmlwdD4=','data:image/svg+xml;base64,PHN2Zz4=','javascript:alert(1)']) {
    const bad=browser(async()=>failure({error:'失败',recoveryImage:invalid})); await bad.generate(); assert.equal(bad.recovery.hidden,true);
  }
});

test('真实后端接口可用时：SSR 与 schema/输入哈希/最新图元数据集成，不调用 HTTP 或模型', async t => {
  let real, assets, looks;
  try {
    [real, assets, looks] = await Promise.all([
      import('../src/render-production-resources.js'), import('../src/production-assets.js'), import('../src/looks.js'),
    ]);
  } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND') { t.skip('后端读接口尚未完成，合同替身 SSR 与 VM 测试仍运行'); return; }
    throw error;
  }
  const { openDatabase } = await import('../src/database.js');
  const db = openDatabase(':memory:'); t.after(() => db.close());
  db.prepare('INSERT INTO projects (name, style, aspect_ratio) VALUES (?, ?, ?)').run('短剧', '手绘', '3:4');
  db.prepare('INSERT INTO characters (project_id, name, age) VALUES (1, ?, 18)').run('基础演员');
  db.prepare("INSERT INTO character_references (character_id, image, mime, width, height) VALUES (1, X'0102', 'image/png', 30, 40)").run();
  const asset = assets.saveProductionAsset(db, 1, 'costumes', null, query('name=服饰'));
  assets.saveProductionAsset(db, 1, 'costumes', asset.id, new URLSearchParams({ revision: String(asset.revision), name: '服饰', description: '说明' }));
  db.prepare("INSERT INTO production_asset_images (asset_id, image, mime, width, height) VALUES (?, X'0102', 'image/png', 20, 30)").run(asset.id);
  const look = looks.saveLook(db, 1, null, query('name=定妆'));
  const saved = looks.saveLook(db, 1, look.id, new URLSearchParams({ revision: String(look.revision), name: '定妆', characterId: '1', prompt: '自写提示词', assetIds: JSON.stringify([asset.id]) }));
  const inputs = looks.lookInputs(db, 1, looks.findLook(db, 1, look.id));
  assert.deepEqual(inputs.missing, []);
  const rendered = real.renderLooks(db, 1, query(`look=${look.id}`)).content;
  assert.ok(rendered.includes(`data-input-revision="${inputs.revision}"`));
  assert.ok(rendered.includes(`data-revision="${saved.revision}"`));
  assert.match(rendered, /name="assetId" value="1" checked/);
  assert.doesNotMatch(rendered, /id="look-missing"/);
  const material = real.renderProductionAssets(db, 1, 'costumes', query(`asset=${asset.id}`)).content;
  assert.match(material, /\/projects\/1\/costumes\/1\/images\/1/);
  assert.match(material, /name="description" maxlength="1000"/);
});

test('VM 名称弹框创建素材/定妆只提交 name，不影响现有季/集创建的 seasonId', () => {
  const page = browser(() => { throw new Error('构建表单不能请求网络'); }, { kind: 'list' });
  for (const kind of ['props', 'costumes', 'looks']) {
    assert.deepEqual(Object.fromEntries(page.namePayload(`/projects/7/${kind}`)), { name: '仅名称' });
  }
  assert.deepEqual(Object.fromEntries(page.namePayload('/projects/7/episodes')), { name: '仅名称', seasonId: '9' });
});

test('VM 保存定妆：素材选择转 JSON 数字数组，原始提示词不改写；忙碌期间拒绝所有重复操作，导航前释放 inert/dirty', async () => {
  const requests = []; let finish;
  const page = browser((url, options) => { requests.push({ url, body: options.body }); return new Promise(resolve => { finish = resolve; }); });
  await page.changed();
  assert.equal(page.form.dataset.dirty, 'true'); assert.equal(page.beforeUnload().prevented, true);
  const pending = page.save();
  assert.equal(page.main.inert, true); assert.equal(page.nodes.save.disabled, true);
  await page.save(); await page.generate(); await page.delete();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/projects/7/looks/1');
  assert.equal(requests[0].body.get('assetIds'), '[1,2]'); assert.equal(requests[0].body.has('assetId'), false);
  assert.equal(requests[0].body.get('prompt'), '原始提示词'); assert.equal(requests[0].body.get('revision'), '5');
  finish(success(savedResult)); await pending;
  assert.deepEqual(page.navigation, [{ url: savedResult.redirect, inert: false, dirty: '', guarded: false }]);
  assert.equal(page.main.inert, false); assert.equal(page.nodes.save.disabled, false);
});

test('VM dirty 阻止生成/清除，不先自动保存；演员可空存稿，素材选择最多 50 件且 ID 有效', async () => {
  let calls = 0;
  const page = browser(async (url, options) => {
    calls++; assert.equal(url, '/projects/7/looks/1'); assert.equal(options.body.get('characterId'), '');
    assert.equal(options.body.get('assetIds'), '[]'); return success(savedResult);
  });
  await page.changed(); await page.generate(); await page.fire('look-clear-image', 'click');
  assert.equal(calls, 0); assert.match(page.error.textContent, /请先保存/);
  page.fields.characterId = ''; page.fields.assetId = [];
  await page.save(); assert.equal(calls, 1);
  for (const values of [Array.from({ length: 51 }, (_, i) => String(i + 1)), ['1', '1'], ['0'], ['1e2'], ['999999999999999999']]) {
    page.fields.assetId = values; await page.changed(); await page.save();
    assert.equal(calls, 1); assert.equal(page.form.dataset.dirty, 'true'); assert.match(page.error.textContent, /最多选择 50 件/);
  }
});

test('VM 显式生成只调用一次图生图，无费用弹框；正确依据/API字段，失败保留 inputs/recovery 并解锁，不重试', async () => {
  let calls = 0, finish;
  const page = browser((url, options) => {
    calls++; assert.equal(url, '/projects/7/looks/1/generate');
    assert.deepEqual(Object.fromEntries(options.body), { revision: '5', inputRevision: 'input-hash', apiConfigId: '21', model: 'test-model', baseUrl: 'https://example.invalid/v1', chargeConfirmed: 'yes' });
    return new Promise(resolve => { finish = resolve; });
  }, { confirm: () => { throw new Error('生成不能弹费用确认'); } });
  const pending = page.generate();
  await page.generate(); await page.save(); assert.equal(calls, 1); assert.equal(page.beforeUnload().prevented, true);
  finish(failure({ error: '依据已变化，图已保留', recoveryImage: '/projects/7/looks/1/images/502' })); await pending;
  assert.equal(page.recovery.hidden, false); assert.equal(page.recoveryLink.attributes.href, '/projects/7/looks/1/images/502');
  assert.equal(page.fields.prompt, '原始提示词'); assert.deepEqual(page.fields.assetId, ['1', '2']);
  assert.match(page.error.textContent, /依据已变化/); assert.equal(page.navigation.length, 0);
  assert.equal(page.main.inert, false); assert.equal(page.nodes['look-generate'].disabled, false); assert.equal(calls, 1);
  page.fields.name = '失败后仍可改'; await page.changed(); assert.equal(page.beforeUnload().prevented, true);
  assert.equal(page.recovery.hidden, false);
});

test('VM 生成成功导航前解锁；缺图、缺 API 或 SSR disabled 都不调用模型', async () => {
  let calls = 0;
  const page = browser(async () => { calls++; return success({ ...savedResult, id: 504 }); });
  page.nodes['look-generation-form'].dataset.missing = 'true';
  await page.generate(); assert.equal(calls, 0); assert.match(page.error.textContent, /所有选中素材/);
  page.nodes['look-generation-form'].dataset.missing = 'false'; page.nodes['look-api'].value = '';
  await page.generate(); assert.equal(calls, 0); assert.match(page.error.textContent, /图生图 API/);
  page.nodes['look-api'].value = '21'; page.nodes['look-generate'].disabled = true;
  await page.generate(); assert.equal(calls, 0);
  page.nodes['look-generate'].disabled = false; await page.generate(); assert.equal(calls, 1);
  assert.deepEqual(page.navigation[0], { url: savedResult.redirect, inert: false, dirty: '', guarded: false });
});

test('VM 网络/畸形响应提示结果未确认、可能计费，不导航不重试；不接受跨项目/脚本恢复链接和跳转', async () => {
  for (const respond of [
    () => { throw new TypeError('network'); },
    () => ({ ok: true, json: async () => { throw new SyntaxError('not JSON'); } }),
    () => success(null), () => success([]), () => success({ id: 2, revision: 6 }),
    () => success({ ...savedResult, revision: '6' }),
    () => success({ ...savedResult, redirect: 'javascript:alert(1)' }),
    () => success({ ...savedResult, redirect: '/projects/8?resource=looks' }),
    () => failure({ recoveryImage: '/projects/7/looks/1/images/502' }),
  ]) {
    let calls = 0; const page = browser(async () => { calls++; return respond(); });
    await page.generate();
    assert.equal(calls, 1); assert.equal(page.navigation.length, 0); assert.equal(page.main.inert, false);
    assert.match(page.error.textContent, /结果未确认.*可能已计费.*不要立即重复提交/);
    assert.equal(page.fields.prompt, '原始提示词');
  }
  for (const recoveryImage of ['javascript:alert(1)', '/projects/8/looks/1/images/2', '/projects/7/looks/2/images/2', '/projects/7/looks/1/images/2?x=<script>']) {
    const page = browser(async () => failure({ error: '<script>server failure</script>', recoveryImage }));
    await page.generate(); assert.equal(page.recovery.hidden, true); assert.equal(page.error.textContent, '<script>server failure</script>');
  }
});

test('VM 删除取消不发请求、不改 dirty；确认后只发一次且阻止通用 delete.js 冒泡，成功清 dirty 后导航', async () => {
  let calls = 0;
  const cancelled = browser(async () => { calls++; }, { confirm: () => false });
  await cancelled.changed(); const event = await cancelled.delete();
  assert.equal(event.stopped, true); assert.equal(calls, 0); assert.equal(cancelled.form.dataset.dirty, 'true');
  assert.equal(cancelled.main.inert, false); assert.equal(cancelled.nodes.delete.disabled, false);
  let finish;
  const page = browser((url, options) => {
    calls++; assert.equal(url, '/projects/7/looks/1/delete'); assert.deepEqual(Object.fromEntries(options.body), { confirmed: 'yes', name: '资源' });
    return new Promise(resolve => { finish = resolve; });
  });
  await page.changed(); const pending = page.delete(); await page.delete(); await page.save();
  assert.equal(calls, 1); assert.equal(page.main.inert, true);
  finish(success({ redirect: '/projects/7?resource=looks' })); const deleted = await pending;
  assert.equal(deleted.stopped, true);
  assert.deepEqual(page.navigation[0], { url: '/projects/7?resource=looks', inert: false, dirty: '', guarded: false });
  const list = browser(async () => success({ redirect: '/projects/7?resource=looks' }), { kind: 'list' });
  await list.delete(); assert.equal(list.navigation.length, 1); assert.equal(list.main.inert, false);
});

test('VM 删除/保存失败恢复按钮并保留 dirty、输入，不重复请求；清除当前图只发清除请求且保留历史', async () => {
  for (const action of ['save', 'delete']) {
    let calls = 0; const page = browser(async () => { calls++; return failure({ error: '并发冲突' }); });
    await page.changed(); await page[action]();
    assert.equal(calls, 1); assert.equal(page.form.dataset.dirty, 'true'); assert.equal(page.fields.prompt, '原始提示词');
    assert.equal(page.main.inert, false); assert.equal(page.navigation.length, 0); assert.match(page.error.textContent, /并发冲突/);
  }
  let calls = 0;
  const page = browser(async (url, options) => {
    calls++; assert.equal(url, '/projects/7/looks/1/clear-image');
    assert.deepEqual(Object.fromEntries(options.body), { revision: '5', imageId: '501', confirmed: 'yes' });
    return success({ revision: 6 });
  });
  await page.fire('look-clear-image', 'click'); assert.equal(calls, 1);
  assert.equal(page.navigation[0].url, 'reload'); assert.equal(page.navigation[0].inert, false);
  const cancel = browser(async () => { throw new Error('不应请求'); }, { confirm: () => false });
  await cancel.fire('look-clear-image', 'click'); assert.equal(cancel.navigation.length, 0);
});

test('VM 素材资料保存/浏览/选文件不生成；上传需显式点击、先保存，含 revision/referenceId，无图使用 0', async () => {
  let calls = 0; const paths = [];
  const page = browser(async (url, options) => {
    calls++; paths.push(url);
    if (url.endsWith('/reference-image')) {
      assert.equal(options.body.get('revision'), '5'); assert.equal(options.body.get('referenceId'), '0');
      assert.ok(options.body.get('referenceImage') instanceof Blob);
      return success({ revision: 6, referenceId: 104 });
    }
    assert.equal(options.body.get('description'), '说明'); assert.equal(options.body.has('assetIds'), false);
    return success({ ...savedResult, redirect: '/projects/7?resource=props&asset=1' });
  }, { kind: 'asset' });
  assert.equal(calls, 0);
  page.file.files = [new Blob(['png'], { type: 'image/png' })];
  await page.fire('production-reference-file', 'change'); assert.equal(calls, 0);
  await page.changed(); await page.fire('production-upload', 'click'); assert.equal(calls, 0); assert.match(page.error.textContent, /请先保存/);
  await page.save(); assert.equal(calls, 1); assert.equal(page.navigation[0].guarded, false);
  page.file.files = [new Blob(['png'], { type: 'image/png' })]; page.form.dataset.referenceId = '0';
  await page.fire('production-upload', 'click'); assert.equal(calls, 2);
  assert.deepEqual(paths, ['/projects/7/props/1', '/projects/7/props/1/reference-image']);
  assert.deepEqual(page.navigation[1], { url: 'reload', inert: false, dirty: '', guarded: false });
});

test('VM 素材上传失败保留文件和资料、解锁不重试；校验格式/5MiB，清除传确认与正确 revision/referenceId', async () => {
  let calls = 0, finish;
  const page = browser((url, options) => {
    calls++; assert.equal(url, '/projects/7/props/1/reference-image'); assert.equal(options.body.get('referenceId'), '103');
    return new Promise(resolve => { finish = resolve; });
  }, { kind: 'asset' });
  for (const selected of [{ size: 6 * 1024 * 1024, type: 'image/png' }, { size: 0, type: 'image/png' }, { size: 3, type: 'image/svg+xml' }]) {
    page.file.files = [selected]; await page.fire('production-upload', 'click'); assert.equal(calls, 0);
  }
  page.file.files = [new Blob(['png'], { type: 'image/png' })];
  const pending = page.fire('production-upload', 'click');
  await page.fire('production-upload', 'click'); await page.fire('production-clear-reference', 'click'); await page.save();
  assert.equal(calls, 1); assert.equal(page.main.inert, true);
  finish(failure({ error: '参考图已被其他页面替换' })); await pending;
  assert.equal(page.main.inert, false); assert.equal(page.file.files.length, 1); assert.equal(page.beforeUnload().prevented, true);
  assert.equal(page.nodes['production-upload'].disabled, false); assert.match(page.error.textContent, /其他页面替换/);
  assert.equal(page.fields.description, '说明'); assert.equal(page.navigation.length, 0);
  const clear = browser(async (url, options) => {
    assert.equal(url, '/projects/7/props/1/clear-reference');
    assert.deepEqual(Object.fromEntries(options.body), { revision: '5', referenceId: '103', confirmed: 'yes' });
    return success({ revision: 6 });
  }, { kind: 'asset' });
  await clear.fire('production-clear-reference', 'click'); assert.equal(clear.navigation[0].guarded, false);
  const cancelled = browser(async () => { throw new Error('不应请求'); }, { kind: 'asset', confirm: () => false });
  await cancelled.fire('production-clear-reference', 'click'); assert.equal(cancelled.navigation.length, 0);
});
