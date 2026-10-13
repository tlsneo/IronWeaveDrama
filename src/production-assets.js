import { inTransaction } from './database.js';
import { imageDetails } from './images.js';

export function productionReject(status, message, extra = {}) { throw Object.assign(new Error(message), { status, ...extra }); }
export function productionInteger(form, key, minimum = 0) {
  const raw = form.get(key), number = Number(raw);
  if (form.getAll(key).length !== 1 || typeof raw !== 'string' || !/^(0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(number) || number < minimum) productionReject(400, '编号或版本缺失、重复或无效，请刷新核对。');
  return number;
}
export function productionText(form, key, maximum, required = false) {
  const value = form.get(key);
  if (form.getAll(key).length !== 1 || typeof value !== 'string' || value.includes('\0') || value.length > maximum || (required && !value.trim())) productionReject(400, '名称、说明或提示词缺失、重复、过长或格式无效。');
  return key === 'prompt' ? value : value.trim();
}
export function findProductionAsset(database, projectId, kind, id) {
  const asset = database.prepare('SELECT * FROM production_assets WHERE id = ? AND project_id = ? AND kind = ?').get(id, projectId, kind);
  if (!asset) productionReject(404, '素材不存在。');
  return asset;
}
export function readAssetImage(database, assetId) {
  return database.prepare('SELECT id, mime, width, height, length(image) AS bytes, created_at FROM production_asset_images WHERE asset_id = ? AND cleared = 0 ORDER BY id DESC LIMIT 1').get(assetId) ?? null;
}
export function saveProductionAsset(database, projectId, kind, id, form) {
  if (!['props', 'costumes'].includes(kind) || !database.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)) productionReject(404, '项目或素材分类不存在。');
  return inTransaction(database, () => {
    const name = productionText(form, 'name', 80, true);
    let revision = 1;
    if (id) {
      const asset = findProductionAsset(database, projectId, kind, id);
      if (productionInteger(form, 'revision', 1) !== asset.revision) productionReject(409, '素材已变化，请保留输入后刷新。');
      const description = productionText(form, 'description', 1000);
      revision = asset.revision;
      if (name !== asset.name || description !== asset.description) {
        revision++;
        database.prepare('UPDATE production_assets SET name = ?, description = ?, revision = ? WHERE id = ?').run(name, description, revision, id);
      }
    } else id = Number(database.prepare('INSERT INTO production_assets (project_id, kind, name) VALUES (?, ?, ?)').run(projectId, kind, name).lastInsertRowid);
    return { id, revision, redirect: `/projects/${projectId}?resource=${kind}&asset=${id}` };
  });
}
export async function saveAssetReference(database, projectId, kind, id, form) {
  findProductionAsset(database, projectId, kind, id);
  const file = form.get('referenceImage');
  if (form.getAll('referenceImage').length !== 1 || !file || typeof file.arrayBuffer !== 'function' || file.size <= 0 || file.size > 5 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) productionReject(400, '参考图须为 PNG、JPEG 或 WebP，最多 5 MiB。');
  const image = Buffer.from(await file.arrayBuffer());
  let details;
  try { details = imageDetails(image); } catch { productionReject(400, '参考图无法读取，请上传有效图片。'); }
  if (details.mime !== file.type || details.width > 16384 || details.height > 16384 || details.width * details.height > 67108864) productionReject(400, '参考图类型不符或尺寸过大，请缩小后上传。');
  return inTransaction(database, () => {
    const asset = findProductionAsset(database, projectId, kind, id), current = readAssetImage(database, id);
    if (productionInteger(form, 'revision', 1) !== asset.revision || productionInteger(form, 'referenceId') !== (current?.id ?? 0)) productionReject(409, '素材或参考图已变化，没有替换图片，请刷新核对。');
    const imageId = Number(database.prepare('INSERT INTO production_asset_images (asset_id, image, mime, width, height) VALUES (?, ?, ?, ?, ?)').run(id, image, details.mime, details.width, details.height).lastInsertRowid);
    const revision = asset.revision + 1;
    database.prepare('UPDATE production_assets SET revision = ? WHERE id = ?').run(revision, id);
    return { id: imageId, revision, redirect: `/projects/${projectId}?resource=${kind}&asset=${id}` };
  });
}
export function clearAssetReference(database, projectId, kind, id, form) {
  return inTransaction(database, () => {
    const asset = findProductionAsset(database, projectId, kind, id), current = readAssetImage(database, id);
    if (form.getAll('confirmed').length !== 1 || form.get('confirmed') !== 'yes') productionReject(400, '移除参考图须明确确认。');
    if (productionInteger(form, 'revision', 1) !== asset.revision || productionInteger(form, 'referenceId', 1) !== current?.id) productionReject(409, '素材或参考图已变化，没有移除图片。');
    // 清除当前图时不让更早的参考图重新成为当前图，历史链接仍保留。
    database.prepare('UPDATE production_asset_images SET cleared = 1 WHERE asset_id = ?').run(id);
    const revision = asset.revision + 1;
    database.prepare('UPDATE production_assets SET revision = ? WHERE id = ?').run(revision, id);
    return { revision, redirect: `/projects/${projectId}?resource=${kind}&asset=${id}` };
  });
}
