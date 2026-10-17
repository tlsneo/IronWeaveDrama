import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';

const MiB = 1024 * 1024;
const states = new Set('accepted planning queued dispatched preparing running delivering cancelling cancelled failed succeeded'.split(' '));
const types = new Set('accepted state heartbeat output_begin output_end transfer_error error cancelled'.split(' '));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function protocolError(message) { throw Object.assign(new Error(message), { status: 502 }); }
const check = (value, message) => { if (!value) protocolError(message); };
const positive = value => Number.isSafeInteger(value) && value > 0;
export function receipt(value) {
  check(positive(value?.bytes) && /^[0-9a-f]{64}$/.test(value?.sha256), '回执长度或哈希无效。');
  return { bytes: value.bytes, sha256: value.sha256 };
}
export function windowFields(value) {
  const dates = ['delivery_ready_at', 'delivery_expires_at'];
  check(dates.every(key => typeof value[key] === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value[key]) && Number.isFinite(Date.parse(value[key])) && new Date(value[key]).toISOString() === value[key]), '交付期限格式无效。');
  check(value.delivery_timeout_ms === 1800000 && Date.parse(value.delivery_expires_at) - Date.parse(value.delivery_ready_at) === 1800000, '交付期限不是固定的 30 分钟。');
}
export function metadata(value, expected) {
  receipt(value); windowFields(value);
  check(['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm'].includes(value.mime_type), '媒体类型不受支持。');
  const video = value.mime_type.startsWith('video/');
  check(value.bytes <= (video ? 1024 * MiB : 32 * MiB), '媒体超过交付上限。');
  check(positive(value.width) && positive(value.height) && value.width * value.height <= 64000000, '媒体尺寸无效。');
  if (video) check(positive(value.frames) && positive(value.fps) && positive(value.duration_ms) && typeof value.has_audio === 'boolean', '视频技术属性无效。');
  if (expected) {
    check(expected.size === `${value.width}x${value.height}`, '媒体尺寸与请求不符。');
    check(Boolean(expected.frames) === video && (!video || (expected.frames === value.frames && expected.fps === value.fps)), '媒体类型、帧数或帧率与请求不符。');
  }
  return value;
}

// 原生请求只设网络空闲时限；FormData 由标准 Request 编码，禁止猜版本、重定向和重发。
export async function ironRequest(config, endpoint, { method = 'POST', body, signal, accept = 'multipart/mixed', idleMs = 60000 } = {}) {
  const url = new URL(config.baseUrl + endpoint);
  check(['http:', 'https:'].includes(url.protocol), '接口地址无效。');
  const headers = { Authorization: `Bearer ${config.apiKey}`, Accept: accept, 'X-IronWeave-Protocol': '2', 'Accept-Encoding': 'identity' };
  let encoded;
  if (body !== undefined) {
    if (!(body instanceof FormData)) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
    encoded = new Request(url, { method, headers, body });
  }
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method, headers: encoded ? Object.fromEntries(encoded.headers) : headers, agent: false, signal, highWaterMark: 65536 }, res => {
      res.setTimeout(idleMs, () => res.destroy(new Error('网络读取空闲超时。')));
      resolve(res);
    });
    const connecting = setTimeout(() => req.destroy(new Error('网络连接空闲超时。')), idleMs);
    req.once('socket', socket => { if (socket.connecting) socket.once('connect', () => clearTimeout(connecting)); else clearTimeout(connecting); });
    req.once('close', () => clearTimeout(connecting));
    req.setTimeout(idleMs, () => req.destroy(new Error('网络读写空闲超时。')));
    req.on('error', reject);
    if (encoded?.body) pipeline(Readable.fromWeb(encoded.body), req).catch(reject);
    else req.end();
  });
}
function strictJson(text) {
  const value = JSON.parse(text), stack = [];
  const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g) || [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '{') stack.push(new Set());
    else if (token === '[') stack.push(null);
    else if (token === '}' || token === ']') stack.pop();
    else if (token.startsWith('"') && tokens[i + 1] === ':' && stack.at(-1)) {
      const name = JSON.parse(token); check(!stack.at(-1).has(name), 'JSON 字段重复。'); stack.at(-1).add(name);
    }
  }
  return value;
}
async function smallBody(response) {
  const chunks = []; let bytes = 0;
  for await (const chunk of response) { bytes += chunk.length; check(bytes <= 65536, '响应正文过大。'); chunks.push(chunk); }
  try { return strictJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { protocolError('接口没有返回有效 JSON。'); }
}
async function requireOk(response) {
  if (response.statusCode === 200) {
    const seen = new Set();
    for (let i = 0; i < (response.rawHeaders?.length ?? 0); i += 2) {
      const key = response.rawHeaders[i].toLowerCase();
      if (['content-type', 'content-length', 'content-encoding', 'x-ironweave-protocol', 'x-ironweave-task-id', 'x-ironweave-sha256', 'x-ironweave-delivery-expires-at', 'accept-ranges'].includes(key)) {
        check(!seen.has(key), '响应协议头重复。'); seen.add(key);
      }
    }
    return;
  }
  const status = response.statusCode;
  let code = 'request_failed';
  try { const value = await smallBody(response); if (/^[a-z_]{1,80}$/.test(value?.error?.code)) code = value.error.code; }
  finally { response.destroy(); }
  throw Object.assign(new Error(`IronWeave HTTP ${status}：${code}；未自动重新生成。`), { status: 502, upstreamStatus: status, code });
}

export class BoundedReader {
  constructor(stream) { this.iterator = stream[Symbol.asyncIterator](); this.chunk = Buffer.alloc(0); this.offset = 0; this.ended = false; this.peak = 0; }
  async available() {
    while (this.offset === this.chunk.length && !this.ended) {
      const next = await this.iterator.next(); this.ended = !!next.done;
      this.chunk = next.done ? Buffer.alloc(0) : (Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value)); this.offset = 0;
      check(this.chunk.length <= MiB, '传输块超过 1 MiB 缓冲上限。'); this.peak = Math.max(this.peak, this.chunk.length);
    }
    return this.chunk.length - this.offset;
  }
  async take(max) { check(await this.available(), '媒体或 MIME 意外截断。'); const n = Math.min(max, this.chunk.length - this.offset); const part = this.chunk.subarray(this.offset, this.offset + n); this.offset += n; return part; }
  async exact(n) { check(n <= 65536, '控制正文超过上限。'); const result = Buffer.alloc(n); let offset = 0; while (offset < n) { const part = await this.take(n - offset); part.copy(result, offset); offset += part.length; } return result; }
  async match(text) { check((await this.exact(Buffer.byteLength(text))).equals(Buffer.from(text)), 'MIME 边界、CRLF 或关闭标记无效。'); }
  async headers() {
    const bytes = []; let end = '';
    while (!end.endsWith('\r\n\r\n')) { check(bytes.length < 8192, 'MIME 头超过 8 KiB。'); const byte = (await this.exact(1))[0]; bytes.push(byte); end = (end + String.fromCharCode(byte)).slice(-4); }
    check(bytes.every(byte => byte < 128), 'MIME 头必须为 ASCII。');
    const lines = Buffer.from(bytes).toString('ascii').slice(0, -4).split('\r\n'); const headers = {};
    for (const line of lines) { const match = /^([A-Za-z0-9-]+):[ \t]*([^\r\n]+)$/.exec(line); check(match, 'MIME 头格式无效。'); const key = match[1].toLowerCase(); check(!Object.hasOwn(headers, key), 'MIME 头重复。'); headers[key] = match[2].trim(); }
    check(/^[1-9]\d*$/.test(headers['content-length']) && positive(Number(headers['content-length'])), 'part 长度无效。');
    check(typeof headers['content-type'] === 'string', 'part 缺少媒体类型。');
    return { type: headers['content-type'], length: Number(headers['content-length']) };
  }
}

function eventValidator() {
  let taskId, seq = 0, state;
  const rank = { accepted: 0, planning: 1, queued: 2, dispatched: 3, preparing: 4, running: 5, delivering: 6, cancelling: 7 };
  return value => {
    check(value && !Array.isArray(value) && types.has(value.type) && states.has(value.state) && uuid.test(value.task_id) && Number.isSafeInteger(value.seq) && value.seq === ++seq, '事件类型、任务、状态或序号无效。');
    if (seq === 1) { check(value.type === 'accepted' && value.state === 'accepted' && Number.isSafeInteger(value.seed) && value.seed >= 0 && value.seed <= 4294967295 && typeof value.workflow_version === 'string' && value.workflow_version.length > 0, '首事件必须是有效 accepted。'); taskId = value.task_id; }
    else check(value.task_id === taskId && value.type !== 'accepted', '任务身份发生变化。');
    if (state === 'cancelling') check(['cancelling', 'cancelled', 'failed'].includes(value.state), '取消阶段不能重新开放生成或交付。');
    if (state === 'delivering') check(['delivering', 'failed'].includes(value.state), '交付阶段不能回退生成或取消。');
    if (value.type === 'state') check(rank[value.state] !== undefined && (rank[value.state] >= rank[state] || (state === 'dispatched' && value.state === 'queued')), '状态事件非法回退。');
    if (value.type === 'heartbeat') check(value.state === state, '心跳不能改变任务状态。');
    if (['output_begin', 'output_end', 'transfer_error'].includes(value.type)) check(value.state === 'delivering', '交付事件状态错误。');
    if (value.progress !== undefined) check(value.progress && Number.isSafeInteger(value.progress.current) && positive(value.progress.total) && value.progress.current >= 0 && value.progress.current <= value.progress.total && ['steps', 'frames', 'bytes'].includes(value.progress.unit), '进度字段无效。');
    if (['error', 'transfer_error'].includes(value.type)) check(value.error && typeof value.error.code === 'string' && value.error.code.length > 0 && typeof value.error.message === 'string' && ['planning', 'preparing', 'running', 'validation', 'output', 'ack'].includes(value.error.phase) && (value.type !== 'error' || value.state === 'failed'), '错误事件字段无效。');
    if (value.type === 'cancelled') check(value.state === 'cancelled' && typeof value.reason === 'string' && value.reason.trim(), '取消事件无效。');
    check(!['failed', 'cancelled', 'succeeded'].includes(value.state) || ['error', 'cancelled'].includes(value.type), '原流不能报告成功或伪造终态。');
    state = value.state; return value;
  };
}

export async function receiveMixed(response, { sink, onEvent = async () => {}, expected } = {}) {
  try {
    await requireOk(response);
    check(response.headers['x-ironweave-protocol'] === '2' && !response.headers['content-encoding'] && !response.headers['content-length'], '未协商 protocol 2 或响应被压缩/整段定长。');
    const match = /^multipart\/mixed;\s*boundary=(iw_[a-f0-9]{32})$/.exec(response.headers['content-type']); check(match, 'MIME 边界格式无效。');
    const boundary = match[1], reader = new BoundedReader(response), validateEvent = eventValidator();
    let meta, mediaRead = false, terminal = false, transferError;
    const hash = createHash('sha256'); let bytes = 0, collisionTail = Buffer.alloc(0);
    const collisionMarker = Buffer.from(`--${boundary}`);
    await reader.match(`--${boundary}\r\n`);
    while (true) {
      const header = await reader.headers();
      if (header.type === 'application/json') {
        check(header.length <= 65536 && (!meta || mediaRead), 'JSON 事件过大或媒体 part 缺失。');
        let value;
        try { value = strictJson(new TextDecoder('utf-8', { fatal: true }).decode(await reader.exact(header.length))); } catch { protocolError('事件 JSON 无效。'); }
        value = validateEvent(value);
        if (value.type === 'output_begin') { check(!meta, '重复最终媒体。'); meta = metadata(value, expected); }
        if (value.type === 'output_end') {
          check(meta && mediaRead, '缺少完整媒体。'); receipt(value); windowFields(value);
          for (const key of ['bytes', 'sha256', 'delivery_ready_at', 'delivery_expires_at', 'delivery_timeout_ms']) check(value[key] === meta[key], '固定交付元数据变化。');
          check(bytes === meta.bytes && hash.digest('hex') === meta.sha256, '媒体长度或 SHA256 不符。'); terminal = true;
        } else if (value.type === 'transfer_error') {
          receipt(value); windowFields(value);
          if (meta) for (const key of ['bytes', 'sha256', 'delivery_ready_at', 'delivery_expires_at', 'delivery_timeout_ms']) check(value[key] === meta[key], '固定回执变化。');
          transferError = value; terminal = true;
        } else if (['error', 'cancelled'].includes(value.type)) { transferError = value; terminal = true; }
        else check(!mediaRead, '媒体之后只能是 output_end 或 transfer_error。');
        await onEvent(value);
      } else {
        check(meta && !mediaRead && header.type === meta.mime_type && header.length === meta.bytes, '媒体 part 类型、顺序或长度不符。');
        while (bytes < meta.bytes) { const chunk = await reader.take(Math.min(65536, meta.bytes - bytes));
          const crossed = Buffer.concat([collisionTail, chunk.subarray(0, collisionMarker.length - 1)]); check(!chunk.includes(collisionMarker) && !crossed.includes(collisionMarker), '媒体包含已发布 MIME 边界，须整取同一产物。');
          collisionTail = Buffer.from(chunk.length >= collisionMarker.length - 1 ? chunk.subarray(chunk.length - collisionMarker.length + 1) : crossed.subarray(Math.max(0, crossed.length - collisionMarker.length + 1)));
          hash.update(chunk); await sink(chunk); bytes += chunk.length; }
        mediaRead = true;
      }
      await reader.match(`\r\n--${boundary}`);
      if (terminal) {
        await reader.match('--\r\n'); check(!(await reader.available()), '关闭边界后存在尾言。');
        if (transferError) throw Object.assign(new Error('本次传输未完成，可在操作历史核对或重取；不会重新推理。'), { status: 502, event: transferError });
        return { ...meta, peakBufferBytes: reader.peak };
      }
      await reader.match('\r\n');
    }
  } finally { response.destroy(); }
}

export async function fetchOutput(config, taskId, meta, { sink, signal, expected, onMetadata = async () => {} } = {}) {
  check(uuid.test(taskId), '任务编号无效。');
  if (meta) { receipt(meta); windowFields(meta); }
  const res = await ironRequest(config, `/tasks/${taskId}/output`, { method: 'GET', signal, accept: meta?.mime_type || '*/*' });
  try {
    await requireOk(res);
    const h = res.headers;
    check(h['x-ironweave-protocol'] === '2' && h['x-ironweave-task-id'] === taskId && h['accept-ranges'] === 'none' && !h['content-encoding'], '整文件重取协议或任务身份不符。');
    check(/^[1-9]\d*$/.test(h['content-length']), '重取必须声明精确长度。');
    const expires = h['x-ironweave-delivery-expires-at'];
    check(typeof expires === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(expires) && Number.isFinite(Date.parse(expires)), '重取交付期限无效。');
    const fixed = { bytes: Number(h['content-length']), sha256: h['x-ironweave-sha256'], delivery_ready_at: new Date(Date.parse(expires) - 1800000).toISOString(), delivery_expires_at: expires, delivery_timeout_ms: 1800000 };
    receipt(fixed); windowFields(fixed);
    if (meta) for (const key of ['bytes', 'sha256', 'delivery_expires_at']) check(meta[key] === fixed[key], '重取响应与固定回执不符。');
    check(!meta?.mime_type || meta.mime_type === h['content-type'], '重取媒体类型发生变化。');
    const [width, height] = expected.size.split('x').map(Number);
    meta = { ...fixed, ...meta, mime_type: h['content-type'], width, height, ...(expected.frames ? { frames: expected.frames, fps: expected.fps } : {}) };
    check(['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm'].includes(meta.mime_type) && meta.mime_type.startsWith(expected.frames ? 'video/' : 'image/') && meta.bytes <= (expected.frames ? 1024 * MiB : 32 * MiB) && positive(width) && positive(height) && width * height <= 64000000, '重取媒体类型、尺寸或长度不符。');
    await onMetadata(meta);
    const hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of res) { check(chunk.length <= MiB && bytes + chunk.length <= meta.bytes, '重取数据超过边界。'); bytes += chunk.length; hash.update(chunk); await sink(chunk); }
    check(bytes === meta.bytes && hash.digest('hex') === meta.sha256, '重取文件截断或哈希不符。'); return meta;
  } finally { res.destroy(); }
}
export async function acknowledge(config, taskId, meta, { signal } = {}) {
  check(uuid.test(taskId), '任务编号无效。'); const fixed = receipt(meta);
  const res = await ironRequest(config, `/tasks/${taskId}/ack`, { body: fixed, accept: 'application/json', signal });
  try { await requireOk(res); check(/^application\/json(?:;\s*charset=utf-8)?$/i.test(res.headers['content-type']) && !res.headers['content-encoding'], 'ACK 必须返回未压缩 JSON 正文。'); const value = await smallBody(res); check(value.task_id === taskId && value.state === 'succeeded' && value.bytes === fixed.bytes && value.sha256 === fixed.sha256, 'ACK 200 正文与保存回执不匹配。'); return value; }
  finally { res.destroy(); }
}
