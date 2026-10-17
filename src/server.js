import { mkdirSync } from 'node:fs';
import { createApp } from './app.js';
import { openDatabase } from './database.js';

import { dataDirectory } from './media-files.js';
import { join } from 'node:path';
import { cleanupPendingMedia } from './media-cleanup.js';
mkdirSync(dataDirectory, { recursive: true });
const database = openDatabase(join(dataDirectory, 'drama.sqlite'));
try {
  const cleanup = await cleanupPendingMedia(database, { limit: 100 });
  if (cleanup.pending) console.warn(`媒体清理仍有 ${cleanup.pending} 项待重试；未扫描作品目录。`);
} catch { console.warn('媒体清理待办暂未完成，保留记录等待重试。'); }
const server = createApp(database);

server.on('error', (error) => {
  console.error(`启动失败：${error.message}`);
  process.exitCode = 1;
});

server.listen(Number(process.env.PORT ?? 3000), '0.0.0.0', () => {
  console.log(`IronWeaveDrama 已启动，监听 0.0.0.0:${server.address().port}（访问时请使用服务器 IP）`);
});
