import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
const code = await readFile(new URL('../public/generation-stream.js', import.meta.url), 'utf8');
function fixture(fetch, storage = new Map()) {
  const nodes = [], events = new Map();
  const element = tag => ({ tag, children: [], style: {}, setAttribute() {}, append(...children) { this.children.push(...children); }, remove() { this.removed = true; } });
  const window = { addEventListener: (name, handler) => events.set(name, handler), confirm: () => true };
  runInNewContext(code, { window, document: { createElement: element, body: { append(node) { nodes.push(node); } } }, sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) }, fetch, AbortController, TextDecoder, Date, JSON, Map, Error });
  return { request: window.IronGeneration.request, nodes, events, storage };
}
const wire = events => new Response(events.map(event => JSON.stringify(event)).join('\n') + '\n', { headers: { 'Content-Type': 'application/x-ndjson' } });
test('显式 NDJSON 协商、任意分块最终业务结果；正常 EOF 不触发取消或自动采用', async () => {
  let signal, calls = 0;
  const f = fixture(async (_url, options) => { calls++; assert.equal(options.headers.Accept, 'application/x-ndjson'); signal = options.signal; return wire([{ type: 'operation', operationId: 'fixture-id' }, { type: 'progress', event: { state: 'delivering', progress: { current: 2, total: 3, unit: 'bytes' } } }, { type: 'result', status: 200, result: { operation: { deliveryConfirmed: false }, message: '保存成功，确认未确定' } }]); });
  const response = await f.request('/projects/1/scenes/1/generate', { method: 'POST' }); assert.equal(response.ok, true); assert.equal((await response.json()).operation.deliveryConfirmed, false); assert.equal(signal.aborted, false); assert.equal(calls, 1);
  assert.equal(f.storage.get('ironweave-pending-operations'), '{}');
});
test('停止、离页与重复点击贯通 AbortSignal；提交未知和返回页面保留恢复提示，不再次 POST', async () => {
  let calls = 0, signal;
  const f = fixture((_url, options) => { calls++; signal = options.signal; return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('stopped')))); });
  const pending = f.request('/projects/1/looks/1/generate', { method: 'POST' });
  await assert.rejects(f.request('/projects/1/looks/1/generate'), /未核对/);
  f.nodes[0].children[1].onclick(); await assert.rejects(pending, /stopped/); assert.equal(signal.aborted, true); assert.equal(calls, 1);
  const returned = fixture(() => { throw new Error('不得自动请求'); }, f.storage); assert.equal(returned.nodes.length, 1); assert.match(returned.nodes[0].children[0].textContent, /未确认操作/);
  await assert.rejects(returned.request('/projects/1/looks/1/generate'), /未核对/);
  const other = fixture((_url, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('left')))));
  const leaving = other.request('/projects/2/scenes/1/generate'); other.events.get('pagehide')(); await assert.rejects(leaving, /left/);
});
test('缺最终结果、超限进度或尾随事件不能冒充成功；旧 JSON 调用仍可读取', async () => {
  for (const value of [wire([{ type: 'operation', operationId: 'id' }]), wire([{ type: 'result', status: 200, result: {} }, { type: 'progress', event: { state: 'running' } }]), new Response('x'.repeat(140000), { headers: { 'Content-Type': 'application/x-ndjson' } })]) {
    const f = fixture(async () => value); await assert.rejects(f.request('/projects/1/scenes/1/generate')); assert.notEqual(f.storage.get('ironweave-pending-operations'), '{}');
  }
  const f = fixture(async () => Response.json({ valid: true })); assert.deepEqual(await (await f.request('/legacy')).json(), { valid: true });
});
