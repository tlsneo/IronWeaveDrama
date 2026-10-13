const pending = new WeakMap();
export function assertLooksIdle(database, ids) {
  if (ids.some(id => pending.get(database)?.has(id))) throw Object.assign(new Error('定妆正在生成图片，请等待完成后再操作。'), { status: 409 });
}
export async function withLookLock(database, id, action) {
  assertLooksIdle(database, [id]);
  if (!pending.has(database)) pending.set(database, new Set());
  const ids = pending.get(database); ids.add(id);
  try { return await action(); } finally { ids.delete(id); }
}
