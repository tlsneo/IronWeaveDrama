import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { imagePoint, paintSegment, replayMask, maskPixels } from '../public/image-mask.js';

const script = (await readFile(new URL('../public/image-editor.js', import.meta.url), 'utf8')).replace(/^import .*;\n/, '');
function page() {
  const nodes = {}, downloads = [];
  function node() {
    const events = {};
    return {
      dataset: {}, style: {}, disabled: false, hidden: false, textContent: '', value: '',
      addEventListener(name, handler) { (events[name] ??= []).push(handler); },
      fire(name, event = {}) { return Promise.all((events[name] ?? []).map(handler => handler({ preventDefault() {}, ...event }))); },
      click() { if (!this.disabled) return this.fire('click'); },
      setAttribute(name, value) { this[name] = value; }, getAttribute(name) { return this[name]; },
      getContext() { return { putImageData: data => { this.pixels = data.data; } }; },
    };
  }
  const tools = ['paint', 'erase', 'pan'].map(tool => Object.assign(node(), { dataset: { maskTool: tool } }));
  const ids = ['character-image-edit-dialog', 'edit-character-image', 'character-board-image', 'image-edit-stage', 'image-edit-source', 'image-edit-overlay', 'image-edit-brush', 'image-edit-brush-value', 'image-edit-undo', 'image-edit-redo', 'image-edit-clear', 'image-edit-export', 'image-edit-error', 'image-edit-selection', 'image-edit-zoom-value', 'character-edit-instruction', 'image-edit-cursor', 'character-form', 'image-edit-zoom-in', 'image-edit-zoom-out', 'image-edit-fit', 'image-edit-close'];
  ids.forEach(id => { nodes[id] = node(); });
  Object.assign(nodes['character-image-edit-dialog'], { querySelectorAll: () => tools, showModal() { this.open = true; }, close() { this.open = false; this.fire('close'); } });
  Object.assign(nodes['image-edit-stage'], { clientWidth: 400, clientHeight: 200, getBoundingClientRect: () => ({ left: 100, top: 50 }), setPointerCapture(id) { this.capture = id; }, hasPointerCapture(id) { return this.capture === id; }, releasePointerCapture() { this.capture = null; } });
  nodes['character-board-image'].src = '/boards/1';
  Object.assign(nodes['image-edit-source'], { naturalWidth: 8, naturalHeight: 4 });
  nodes['image-edit-brush'].value = '100';
  runInNewContext(script, {
    imagePoint, paintSegment, replayMask, maskPixels, Uint8Array,
    ImageData: class { constructor(data) { this.data = data; } },
    document: {
      getElementById: id => nodes[id],
      createElement(tag) {
        if (tag === 'a') return { click() { downloads.push(this); } };
        const canvas = node(); canvas.toBlob = callback => { downloads.push(canvas); callback({}); }; return canvas;
      },
    },
    ResizeObserver: class { observe() {} }, requestAnimationFrame: callback => { callback(); return 1; }, cancelAnimationFrame() {},
    URL: { createObjectURL: () => 'blob:mask', revokeObjectURL() {} }, setTimeout: () => 1, clearTimeout() {},
    fetch() { throw new Error('离线修图不应调用任何接口'); },
  });
  const stroke = async (x = 325, y = 175) => {
    await nodes['image-edit-stage'].fire('pointerdown', { button: 0, pointerId: 1, clientX: x, clientY: y });
    await nodes['image-edit-stage'].fire('pointerup', { pointerId: 1 });
  };
  return { nodes, tools, downloads, stroke, open: () => nodes['edit-character-image'].click(), load: () => nodes['image-edit-source'].fire('load') };
}

test('离线编辑器打开原图，独立绘制遮罩、撤销/重做、擦除、清空与下载；不改原图、不调用模型', async () => {
  const p = page(), n = p.nodes;
  await p.open(); assert.equal(n['character-image-edit-dialog'].open, true);
  await p.load(); assert.equal(n['image-edit-export'].disabled, true);
  await p.stroke();
  assert.equal(n['image-edit-overlay'].pixels[(2 * 8 + 4) * 4 + 3], 115);
  await n['image-edit-export'].click();
  assert.equal(p.downloads[0].width, 8); assert.equal(p.downloads[0].height, 4);
  assert.equal(p.downloads[0].pixels[(2 * 8 + 4) * 4], 255);
  assert.equal(p.downloads[0].pixels[(2 * 8 + 4) * 4 + 3], 255);
  await n['image-edit-undo'].click(); assert.equal(n['image-edit-export'].disabled, true);
  await n['image-edit-redo'].click(); assert.equal(n['image-edit-export'].disabled, false);
  await p.tools[1].click(); await p.stroke(); assert.equal(n['image-edit-export'].disabled, true);
  await n['image-edit-undo'].click(); assert.equal(n['image-edit-export'].disabled, false);
  await n['image-edit-clear'].click(); assert.equal(n['image-edit-export'].disabled, true);
  await n['image-edit-undo'].click(); assert.equal(n['image-edit-export'].disabled, false);
  n['character-edit-instruction'].value = '修复手指';
  await n['image-edit-close'].click(); await p.open();
  assert.equal(n['image-edit-export'].disabled, false);
  assert.equal(n['character-edit-instruction'].value, '修复手指');
  assert.equal(n['character-board-image'].src, '/boards/1');
});

test('平移及缩放后仍按原图定位；指针取消可撤销，绘制中不能重放或导出半笔划', async () => {
  const p = page(), n = p.nodes;
  await p.open(); await p.load(); await p.tools[2].click();
  await n['image-edit-stage'].fire('pointerdown', { button: 0, pointerId: 1, clientX: 200, clientY: 150 });
  await n['image-edit-stage'].fire('pointermove', { pointerId: 1, clientX: 300, clientY: 150 });
  await n['image-edit-stage'].fire('pointerup', { pointerId: 1 });
  await p.tools[0].click(); await p.stroke(425, 175);
  assert.equal(n['image-edit-overlay'].pixels[(2 * 8 + 4) * 4 + 3], 115);
  await n['image-edit-zoom-in'].click(); assert.equal(n['image-edit-zoom-value'].textContent, '125%');
  await n['image-edit-fit'].click(); assert.equal(n['image-edit-zoom-value'].textContent, '100%');
  await n['image-edit-stage'].fire('pointerdown', { button: 0, pointerId: 2, clientX: 325, clientY: 175 });
  assert.equal(n['image-edit-undo'].disabled, true); assert.equal(n['image-edit-export'].disabled, true);
  await n['image-edit-stage'].fire('pointercancel', { pointerId: 2 });
  assert.equal(n['image-edit-undo'].disabled, false);
});

test('键盘能移动画笔、涂抹、缩放；加载失败或超大图片不能绘制，换图不沿用旧选区和要求', async () => {
  const p = page(), n = p.nodes;
  await p.open(); await p.load();
  await n['image-edit-stage'].fire('keydown', { key: 'ArrowRight' });
  await n['image-edit-stage'].fire('keydown', { key: ' ' });
  assert.equal(n['image-edit-export'].disabled, false);
  await n['image-edit-stage'].fire('keydown', { key: '+' }); assert.equal(n['image-edit-zoom-value'].textContent, '125%');
  n['character-board-image'].src = '/boards/2'; n['character-edit-instruction'].value = '旧要求';
  await n['image-edit-close'].click(); await p.open();
  assert.equal(n['character-edit-instruction'].value, ''); assert.equal(n['image-edit-export'].disabled, true);
  await n['image-edit-source'].fire('error'); assert.match(n['image-edit-error'].textContent, /加载失败/);
  n['image-edit-source'].naturalWidth = 5000; n['image-edit-source'].naturalHeight = 5000;
  await p.load(); assert.match(n['image-edit-error'].textContent, /1600 万/);
  await p.stroke(); assert.equal(n['image-edit-export'].disabled, true);
});
