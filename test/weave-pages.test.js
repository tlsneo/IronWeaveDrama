import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/database.js';
import { renderOperations, renderProduction } from '../src/render-generation.js';

function fixture(t) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  db.exec("INSERT INTO projects VALUES(1,'隔离页面','写实','16:9'); INSERT INTO seasons VALUES(1,1,'第一季',1); INSERT INTO episodes VALUES(1,1,'第一集',1)");
  return db;
}

test('制作页按有效 Weave 配置筛选，历史协议标签和缺失选项不再启用旧路径或隐藏可用配置', t => {
  const db = fixture(t);
  const insert = db.prepare('INSERT INTO api_configs(id,name,type,base_url,api_key,model) VALUES(?,?,?,?,?,?)');
  insert.run(1, '没有协议行的视频', 'video', 'http://127.0.0.1:1/v1', 'synthetic-only', 'ironweave');
  insert.run(2, '历史标签视频', 'video', 'http://127.0.0.1:1/v1', 'synthetic-only', 'ironweave');
  insert.run(3, '不合规模型', 'video', 'http://127.0.0.1:1/v1', 'synthetic-only', 'old-image-model');
  insert.run(4, '缺少版本地址', 'video', 'http://127.0.0.1:1', 'synthetic-only', 'ironweave');
  insert.run(5, '旧遮罩配置', 'image_edit', 'http://127.0.0.1:1/v1', 'synthetic-only', 'ironweave');
  db.exec("INSERT INTO api_protocols(config_id,protocol,video_profiles) VALUES(2,'legacy','[{\"size\":\"1024x576\",\"frames\":124,\"fps\":24}]'),(3,'ironweave2','[{\"size\":\"1024x576\",\"frames\":999,\"fps\":24}]'),(4,'ironweave2','[{\"size\":\"1024x576\",\"frames\":888,\"fps\":24}]')");
  const before = JSON.stringify({ configs: db.prepare('SELECT * FROM api_configs').all(), options: db.prepare('SELECT * FROM api_protocols').all() });
  const html = renderProduction(db, 1, 1, new URLSearchParams());
  assert.match(html, /124 帧/);
  assert.doesNotMatch(html, /999 帧|888 帧|synthetic-only|旧同步 JSON|旧遮罩配置/);
  assert.equal(JSON.stringify({ configs: db.prepare('SELECT * FROM api_configs').all(), options: db.prepare('SELECT * FROM api_protocols').all() }), before);
  assert.equal(db.prepare('SELECT count(*) AS n FROM generation_operations').get().n, 0);
});

test('明确未受理的操作显示真实拒绝，不冒称提交未知或提供无任务恢复按钮', t => {
  const db = fixture(t), id = '965375ee-5e5a-46bb-b187-23f779f3ddc1';
  db.prepare("INSERT INTO generation_operations(id,project_id,kind,target_id,config_id,config_json,source_json,request_json,local_state,active,error) VALUES(?,NULL,'test',1,1,'{}','{}','{}','rejected',0,'Weave 已拒绝：unsupported_capability，未受理。')").run(id);
  const html = renderOperations(db, null);
  assert.match(html, /未受理/);
  assert.match(html, /unsupported_capability/);
  assert.doesNotMatch(html, /提交未知|交付确认未确定|data-operation-action="[^"]+\/recover"|解除防重锁/);
});

test('ACK 确定拒绝与未知提交的页面用语不混淆，保存媒体和恢复入口仍保留', t => {
  const db = fixture(t), id = '965375ee-5e5a-46bb-b187-23f779f3ddc1';
  db.prepare("INSERT INTO generation_operations(id,project_id,kind,target_id,config_id,config_json,source_json,request_json,task_id,task_state,local_state,metadata_json,active,error) VALUES(?,NULL,'test',1,1,'{}','{}','{}',?,'failed','saved',?,0,'交付确认已被拒绝（delivery_expired）；本地媒体保留。')").run(id, id, JSON.stringify({ mime_type: 'image/png', bytes: 3, sha256: 'a'.repeat(64) }));
  const html = renderOperations(db, null);
  assert.match(html, /交付确认已被拒绝/);
  assert.match(html, /\/media/);
  assert.doesNotMatch(html, /交付确认未确定/);
  assert.match(html, /\/recover/);
});
