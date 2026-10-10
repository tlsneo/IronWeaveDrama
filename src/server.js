import { mkdirSync } from 'node:fs';
import { createApp } from './app.js';
import { openDatabase } from './database.js';

const dataDirectory = new URL('../data/', import.meta.url);
mkdirSync(dataDirectory, { recursive: true });
const server = createApp(openDatabase(new URL('drama.sqlite', dataDirectory)));

server.on('error', (error) => {
  console.error(`启动失败：${error.message}`);
  process.exitCode = 1;
});

server.listen(Number(process.env.PORT ?? 3000), '0.0.0.0', () => {
  console.log(`IronWeaveDrama 已启动，监听 0.0.0.0:${server.address().port}（访问时请使用服务器 IP）`);
});
