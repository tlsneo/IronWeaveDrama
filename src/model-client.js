import { generationContext } from './generation-context.js';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';

const decompressors = new Map([['gzip', createGunzip], ['deflate', createInflate], ['br', createBrotliDecompress]]);

function reject(message) {
  throw Object.assign(new Error(message), { status: 502 });
}

export function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
}

export const safeModelText = (config, value) => String(value).replaceAll(config.apiKey, '[密钥已隐藏]').replaceAll(encodeURIComponent(config.apiKey), '[密钥已隐藏]');

export async function callModel(config, endpoint, body, timeout = config.type === 'llm' ? null : 180000) {
  const signal = generationContext.getStore()?.signal;
  const headers = { Authorization: `Bearer ${config.apiKey}` };
  if (!(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  let response;
  let raw;
  let request;
  try {
    if (timeout === null) {
      const url = new URL(config.baseUrl + endpoint);
      const encoded = body instanceof FormData ? new Request(url, { method: 'POST', headers, body }) : null;
      // 原生单次连接没有 fetch 的隐式响应超时，也不会跟随重定向或重试。
      response = await new Promise((resolve, fail) => {
        request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
          method: 'POST', headers: { ...(encoded ? Object.fromEntries(encoded.headers) : headers), 'Accept-Encoding': 'gzip, deflate, br' }, agent: false, timeout: 0, signal,
        }, incoming => {
          const encoding = incoming.headers['content-encoding'];
          const decode = decompressors.get(typeof encoding === 'string' ? encoding.trim().toLowerCase() : undefined);
          const stream = decode ? incoming.pipe(decode()) : incoming;
          if (decode) incoming.on('error', error => stream.destroy(error));
          stream.on('error', fail);
          resolve({ status: incoming.statusCode, ok: incoming.statusCode >= 200 && incoming.statusCode < 300, body: stream });
        });
        request.on('error', fail);
        if (encoded) pipeline(Readable.fromWeb(encoded.body), request).catch(fail); else request.end(body);
      });
    } else {
      response = await fetch(config.baseUrl + endpoint, {
        method: 'POST', headers, body, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
      });
    }
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 32 * 1024 * 1024) reject('模型响应超过 32 MiB；请求可能已计费，没有自动重试。');
      chunks.push(chunk);
    }
    raw = Buffer.concat(chunks).toString('utf8');
  } catch (error) {
    request?.destroy();
    if (error.status) throw error;
    reject(`${timeout === null ? '模型调用失败或连接中断' : '模型调用失败或超时'}；请求可能已提交并计费，请先查看服务商记录。没有自动重试。`);
  }
  let result;
  try { result = JSON.parse(raw); } catch { reject(`模型接口未返回有效 JSON（HTTP ${response.status}）。`); }
  if (!response.ok || result?.error) {
    const detail = result?.error?.message ?? result?.error ?? result?.message;
    reject(`模型调用失败（HTTP ${response.status}）${typeof detail === 'string' ? `：${safeModelText(config, detail).slice(0, 500)}` : '，请检查模型、权限、额度和接口参数。'}`);
  }
  return result;
}

export function readTextResult(result) {
  const content = result?.choices?.[0]?.message?.content;
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n') : '';
  if (!text.trim()) reject('模型接口未返回有效文本结果，请检查模型响应及输出 token 限制。');
  return text;
}

export function readImageResult(config, result) {
  // 此解析器只接旧同步 JSON；protocol 2 由独立有界接收器处理，不猜测协议。
  if (!Array.isArray(result?.data) || result.data.length !== 1) reject('模型接口未返回单张图片结果；异步任务或非标准响应不能当作生成成功。');
  const image = result.data[0];
  if (typeof image?.b64_json === 'string' && image.b64_json) {
    if (image.b64_json.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.b64_json)) reject('模型接口返回的图片编码无效。');
    const bytes = Buffer.from(image.b64_json, 'base64');
    const mime = imageMime(bytes);
    if (!mime) reject('模型接口返回的内容不是 PNG、JPEG 或 WebP 图片。');
    return `data:${mime};base64,${bytes.toString('base64')}`;
  }
  if (typeof image?.url === 'string') {
    let url;
    try { url = new URL(image.url); } catch { reject('模型接口返回的图片地址无效。'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || image.url.length > 8192) reject('模型接口返回的图片地址无效。');
    if (image.url.includes(config.apiKey) || image.url.includes(encodeURIComponent(config.apiKey))) reject('模型接口返回的图片地址包含 API Key，为防止密钥泄漏未回传。');
    return url.href;
  }
  reject('模型接口没有返回图片地址或图片数据。');
}
