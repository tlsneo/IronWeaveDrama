import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { test } from 'node:test';
import { callModel, readTextResult } from '../src/model-client.js';

const result = { choices: [{ message: { content: '完整结果' }, finish_reason: 'stop' }] };
const body = { model: 'synthetic-model', stream: false, messages: [{ role: 'user', content: '测试' }] };
async function provider(t, handler) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    requests.push({ url: request.url, headers: request.headers, body: JSON.parse(raw) });
    handler(response, requests.at(-1));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { requests, config: { type: 'llm', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'synthetic-model-secret' } };
}

test('LLM生成不创建主动超时或使用fetch隐式响应超时；允许等待响应头和完整正文，只调用一次', async t => {
  const f = await provider(t, response => {
    setTimeout(() => {
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{"choices":');
      setTimeout(() => response.end(JSON.stringify(result.choices) + '}'), 40);
    }, 80);
  });
  t.mock.method(AbortSignal, 'timeout', () => assert.fail('LLM generation must not create a deadline'));
  t.mock.method(globalThis, 'fetch', () => assert.fail('Unbounded generation must not inherit fetch header/body deadlines'));
  assert.deepEqual(await callModel(f.config, '/chat/completions', body), result);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, '/v1/chat/completions');
  assert.equal(f.requests[0].headers.authorization, 'Bearer synthetic-model-secret');
  assert.equal(f.requests[0].headers['content-type'], 'application/json');
  assert.equal(f.requests[0].headers.connection, 'close');
  assert.deepEqual(f.requests[0].body, body);
});

test('原生LLM传输仍正确解压gzip／deflate／br；未知编码不发生原型键调用', async t => {
  let encoding;
  const compressors = new Map([['gzip', gzipSync], ['deflate', deflateSync], ['br', brotliCompressSync]]);
  const f = await provider(t, response => {
    const bytes = Buffer.from(JSON.stringify(result));
    response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': encoding });
    response.end(compressors.has(encoding.toLowerCase()) ? compressors.get(encoding.toLowerCase())(bytes) : bytes);
  });
  for (encoding of ['gzip', 'GZIP', 'deflate', 'br', '__proto__']) assert.deepEqual(await callModel(f.config, '/chat/completions', body), result);
  assert.equal(f.requests.length, 5);
});

test('服务商断开连接或响应不完整时失败，无重试、不误报本地超时、不泄漏密钥', async t => {
  let phase;
  const f = await provider(t, response => {
    if (phase === 'headers') { response.destroy(); return; }
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{"choices":');
    setTimeout(() => response.destroy(), 10);
  });
  for (phase of ['headers', 'body']) {
    await assert.rejects(callModel(f.config, '/chat/completions', body), error => {
      assert.equal(error.status, 502); assert.match(error.message, /连接中断.*没有自动重试/);
      assert.doesNotMatch(error.message, /超时|synthetic-model-secret/); return true;
    });
  }
  assert.equal(f.requests.length, 2);
});

test('LLM的HTTP错误仍标记真实状态并脱敏；非JSON不会伪称成功或自动重试', async t => {
  let validJSON = true;
  const f = await provider(t, response => {
    response.writeHead(validJSON ? 503 : 200);
    response.end(validJSON ? JSON.stringify({ error: { message: 'synthetic-model-secret quota unavailable' } }) : '<html>bad gateway</html>');
  });
  await assert.rejects(callModel(f.config, '/chat/completions', body), error => {
    assert.equal(error.status, 502); assert.match(error.message, /HTTP 503.*密钥已隐藏/); assert.doesNotMatch(error.message, /synthetic-model-secret/); return true;
  });
  validJSON = false;
  await assert.rejects(callModel(f.config, '/chat/completions', body), /有效 JSON（HTTP 200）/);
  assert.equal(f.requests.length, 2);
});

test('LLM原生请求不会跟随重定向或把Authorization发往目标地址', async t => {
  const target = await provider(t, response => response.end(JSON.stringify(result)));
  const f = await provider(t, response => {
    response.writeHead(307, { Location: target.config.baseUrl + '/chat/completions' });
    response.end(JSON.stringify({ message: 'redirect denied' }));
  });
  await assert.rejects(callModel(f.config, '/chat/completions', body), /HTTP 307/);
  assert.equal(f.requests.length, 1); assert.equal(target.requests.length, 0);
});

test('取消等待限制不取消32MiB响应边界；解压后超量和损坏压缩数据均失败', async t => {
  let oversized = true;
  const compressed = gzipSync(Buffer.alloc(33 * 1024 * 1024, 97));
  const f = await provider(t, response => {
    response.writeHead(200, { 'Content-Encoding': 'gzip' }); response.end(oversized ? compressed : 'invalid-gzip');
  });
  await assert.rejects(callModel(f.config, '/chat/completions', body), error => { assert.equal(error.status, 502); assert.match(error.message, /32 MiB.*没有自动重试/); return true; });
  oversized = false;
  await assert.rejects(callModel(f.config, '/chat/completions', body), error => { assert.equal(error.status, 502); assert.match(error.message, /连接中断/); return true; });
  assert.equal(f.requests.length, 2);
});

test('显式聊天测试可设置等待边界，图片调用在联网前拒绝', async t => {
  const f = await provider(t, response => response.end(JSON.stringify(result)));
  const timeouts = [], originalTimeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', milliseconds => { timeouts.push(milliseconds); return originalTimeout(milliseconds); });
  assert.equal(readTextResult(await callModel(f.config, '/chat/completions', body, 60000)), '完整结果');
  await assert.rejects(callModel({ ...f.config, type: 'text_to_image' }, '/images/generations', body), /仅支持.*聊天/);
  assert.deepEqual(timeouts, [60000]); assert.equal(f.requests.length, 1);
});

test('显式受限测试仍会终止等待，无自动重试；不会把这种边界套到正式LLM生成', async t => {
  const f = await provider(t, response => { setTimeout(() => { if (!response.destroyed) response.end(JSON.stringify(result)); }, 150); });
  await assert.rejects(callModel(f.config, '/chat/completions', body, 30), error => { assert.equal(error.status, 502); assert.match(error.message, /失败或超时.*没有自动重试/); return true; });
  assert.ok(f.requests.length <= 1);
});

test('聊天客户端拒绝所有图片端点与FormData，不产生旧同步生成请求', async t => {
  const f = await provider(t, response => response.end(JSON.stringify(result)));
  for (const endpoint of ['/images/generations', '/images/edits', '/videos/generations']) {
    await assert.rejects(callModel(f.config, endpoint, body), /仅支持.*聊天/);
  }
  await assert.rejects(callModel(f.config, '/chat/completions', new FormData()), /仅支持.*聊天/);
  assert.equal(f.requests.length, 0);
});
