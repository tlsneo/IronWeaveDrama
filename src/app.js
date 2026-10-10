import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';

const pages = new Map([
  ['/', {
    type: 'text/html; charset=utf-8',
    body: await readFile(new URL('../views/index.html', import.meta.url)),
  }],
  ['/styles.css', {
    type: 'text/css; charset=utf-8',
    body: await readFile(new URL('../public/styles.css', import.meta.url)),
  }],
  ['/theme.js', {
    type: 'text/javascript; charset=utf-8',
    body: await readFile(new URL('../public/theme.js', import.meta.url)),
  }],
]);

export function createApp() {
  return createServer((request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, {
        'Allow': 'GET, HEAD',
        'Content-Type': 'text/plain; charset=utf-8',
      });
      response.end('暂不支持此操作');
      return;
    }

    const page = pages.get(request.url.split('?')[0]);
    response.writeHead(page ? 200 : 404, {
      'Content-Type': page?.type ?? 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(request.method === 'HEAD' ? undefined : (page?.body ?? '页面不存在'));
  });
}
