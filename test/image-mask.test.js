import assert from 'node:assert/strict';
import { test } from 'node:test';
import { imagePoint, paintSegment, replayMask, maskPixels } from '../public/image-mask.js';

test('画布坐标按 CSS 缩放和平移换算为原图坐标，不重复应用屏幕像素倍率', () => {
  assert.deepEqual(imagePoint(275, 150, { left: 100, top: 50 }, { x: 25, y: 50, scale: 0.5 }), { x: 300, y: 100 });
  assert.deepEqual(imagePoint(275, 150, { left: 100, top: 50 }, { x: -125, y: -100, scale: 2 }), { x: 150, y: 100 });
});

test('连续笔划没有中间空洞，擦除不改变相邻选区，越界笔划安全裁切', () => {
  const mask = new Uint8Array(100);
  paintSegment(mask, 10, 10, { x: -3, y: 4.5 }, { x: 15, y: 4.5 }, 0.5);
  assert.equal(mask.reduce((a, b) => a + b), 10);
  for (let x = 0; x < 10; x++) assert.equal(mask[40 + x], 1);
  paintSegment(mask, 10, 10, { x: 4.5, y: 4.5 }, { x: 5.5, y: 4.5 }, 0.5, true);
  assert.deepEqual([...mask.slice(40, 50)], [1, 1, 1, 1, 0, 0, 1, 1, 1, 1]);
  paintSegment(mask, 10, 10, { x: -20, y: -20 }, { x: -10, y: -10 }, 1);
  assert.equal(mask.reduce((a, b) => a + b), 8);
});

test('清空、撤销和重做通过笔划重放恢复，遮罩是独立数据而不是原图副本', () => {
  const paint = { points: [{ x: 1.5, y: 1.5 }, { x: 3.5, y: 1.5 }], radius: 0.5 };
  const erase = { points: [{ x: 2.5, y: 1.5 }], radius: 0.5, erase: true };
  const mask = replayMask(5, 3, [paint, erase]);
  assert.deepEqual([...mask.slice(5, 10)], [0, 1, 0, 1, 0]);
  assert.equal(replayMask(5, 3, [paint, erase, { clear: true }]).some(Boolean), false);
  assert.deepEqual(replayMask(5, 3, [paint, erase]), mask);
  assert.equal(replayMask(5, 3, [paint]).reduce((a, b) => a + b), 3);
});

test('预览仅选区半透明红色；导出原尺寸黑白不透明 PNG 像素，白色代表选区', () => {
  assert.deepEqual([...maskPixels(new Uint8Array([0, 1]), true)], [255, 65, 65, 0, 255, 65, 65, 115]);
  assert.deepEqual([...maskPixels(new Uint8Array([0, 1]))], [0, 0, 0, 255, 255, 255, 255, 255]);
});
