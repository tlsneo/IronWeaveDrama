import { imagePoint, paintSegment, replayMask, maskPixels } from './image-mask.js';

const dialog = document.getElementById('character-image-edit-dialog');
if (dialog) {
  const button = document.getElementById('edit-character-image');
  const source = document.getElementById('character-board-image');
  const stage = document.getElementById('image-edit-stage');
  const image = document.getElementById('image-edit-source');
  const overlay = document.getElementById('image-edit-overlay');
  const brush = document.getElementById('image-edit-brush');
  const brushValue = document.getElementById('image-edit-brush-value');
  const undoButton = document.getElementById('image-edit-undo');
  const redoButton = document.getElementById('image-edit-redo');
  const clearButton = document.getElementById('image-edit-clear');
  const exportButton = document.getElementById('image-edit-export');
  const errorElement = document.getElementById('image-edit-error');
  const status = document.getElementById('image-edit-selection');
  const zoomValue = document.getElementById('image-edit-zoom-value');
  const prompt = document.getElementById('character-edit-instruction');
  const cursorElement = document.getElementById('image-edit-cursor');
  let cursor = { x: 0, y: 0 };
  const tools = [...dialog.querySelectorAll('[data-mask-tool]')];
  let width = 0, height = 0, mask = new Uint8Array(), operations = [], undone = [];
  let tool = 'paint', zoom = 1, pan = { x: 0, y: 0 }, pointer = null, frame, sourceUrl = '', ready = false, exporting = false;

  function view() {
    const scale = Math.min(stage.clientWidth / width, stage.clientHeight / height) * zoom;
    return { scale, x: (stage.clientWidth - width * scale) / 2 + pan.x, y: (stage.clientHeight - height * scale) / 2 + pan.y };
  }
  function updateView() {
    if (!ready) return;
    const v = view();
    for (const layer of [image, overlay]) {
      layer.style.width = `${width}px`;
      layer.style.height = `${height}px`;
      layer.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.scale})`;
    }
    zoomValue.textContent = `${Math.round(zoom * 100)}%`;
    cursorElement.style.width = cursorElement.style.height = `${brush.value}px`;
    cursorElement.style.left = `${v.x + cursor.x * v.scale - Number(brush.value) / 2}px`;
    cursorElement.style.top = `${v.y + cursor.y * v.scale - Number(brush.value) / 2}px`;
  }
  function render() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (!ready) return;
      overlay.getContext('2d').putImageData(new ImageData(maskPixels(mask, true), width, height), 0, 0);
    });
  }
  function selectionChanged() {
    const selected = mask.some(Boolean);
    undoButton.disabled = !ready || !operations.length || !!pointer;
    redoButton.disabled = !ready || !undone.length || !!pointer;
    clearButton.disabled = !ready || !selected || !!pointer;
    exportButton.disabled = !ready || !selected || !!pointer || exporting;
    status.textContent = !ready ? '原图加载中…' : selected ? '红色区域为修图选区' : '用画笔涂选需要修改的位置';
    render();
  }
  function rebuild() { mask = replayMask(width, height, operations); selectionChanged(); }
  function resetView() { if (pointer) return; zoom = 1; pan = { x: 0, y: 0 }; updateView(); }
  function zoomBy(factor, anchor) {
    if (!ready || pointer) return;
    const old = view();
    const next = Math.max(0.1, Math.min(16, zoom * factor));
    const ratio = next / zoom;
    const a = anchor ?? { x: stage.clientWidth / 2, y: stage.clientHeight / 2 };
    zoom = next;
    pan = {
      x: a.x - (a.x - old.x) * ratio - (stage.clientWidth - width * old.scale * ratio) / 2,
      y: a.y - (a.y - old.y) * ratio - (stage.clientHeight - height * old.scale * ratio) / 2,
    };
    updateView();
  }
  function setTool(value) {
    tool = value;
    stage.dataset.tool = tool;
    tools.forEach(item => item.setAttribute('aria-pressed', String(item.dataset.maskTool === tool)));
  }
  function point(event) { return imagePoint(event.clientX, event.clientY, stage.getBoundingClientRect(), view()); }
  function endStroke(event) {
    if (!pointer || (event && pointer.id !== event.pointerId)) return;
    const id = pointer.id;
    pointer = null;
    if (stage.hasPointerCapture(id)) stage.releasePointerCapture(id);
    selectionChanged();
  }

  button.addEventListener('click', () => {
    if (button.disabled || document.getElementById('character-form').inert || !source.getAttribute('src')) return;
    errorElement.textContent = '';
    if (!dialog.open) dialog.showModal();
    if (sourceUrl === source.src && ready) { updateView(); return; }
    sourceUrl = source.src;
    ready = false;
    width = height = 0;
    mask = new Uint8Array(); operations = []; undone = [];
    prompt.value = '';
    zoom = 1; pan = { x: 0, y: 0 };
    setTool('paint');
    overlay.width = overlay.height = 1;
    selectionChanged();
    image.src = sourceUrl;
  });
  image.addEventListener('load', () => {
    if (image.src !== sourceUrl) return;
    width = image.naturalWidth; height = image.naturalHeight;
    // shortcut: 编辑器最多处理 1600 万像素，遇到更大生产图片时再做分块遮罩。
    if (!width || !height || width * height > 16000000) {
      ready = false;
      errorElement.textContent = '当前编辑器支持最多 1600 万像素的图片。';
      status.textContent = '原图尺寸超出编辑器限制';
      return;
    }
    overlay.width = width; overlay.height = height;
    mask = new Uint8Array(width * height);
    ready = true;
    cursor = { x: width / 2, y: height / 2 };
    cursorElement.hidden = true;
    resetView(); selectionChanged();
  });
  image.addEventListener('error', () => { ready = false; errorElement.textContent = '原图加载失败，请关闭后重新打开。'; selectionChanged(); status.textContent = '原图不可用'; });
  tools.forEach(item => item.addEventListener('click', () => { if (!pointer) setTool(item.dataset.maskTool); }));
  brush.addEventListener('input', () => { brushValue.textContent = brush.value; updateView(); });
  undoButton.addEventListener('click', () => { if (pointer || !operations.length) return; undone.push(operations.pop()); rebuild(); });
  redoButton.addEventListener('click', () => { if (pointer || !undone.length) return; operations.push(undone.pop()); rebuild(); });
  clearButton.addEventListener('click', () => { if (pointer || clearButton.disabled) return; operations.push({ clear: true }); undone = []; mask.fill(0); selectionChanged(); });
  document.getElementById('image-edit-zoom-in').addEventListener('click', () => zoomBy(1.25));
  document.getElementById('image-edit-zoom-out').addEventListener('click', () => zoomBy(0.8));
  document.getElementById('image-edit-fit').addEventListener('click', resetView);
  stage.addEventListener('wheel', event => {
    event.preventDefault();
    const rect = stage.getBoundingClientRect();
    zoomBy(event.deltaY < 0 ? 1.1 : 1 / 1.1, { x: event.clientX - rect.left, y: event.clientY - rect.top });
  }, { passive: false });
  stage.addEventListener('pointerdown', event => {
    if (!ready || pointer || event.button !== 0) return;
    const start = point(event);
    if (tool !== 'pan' && (start.x < 0 || start.y < 0 || start.x >= width || start.y >= height)) return;
    event.preventDefault();
    cursorElement.hidden = true;
    stage.setPointerCapture(event.pointerId);
    pointer = { id: event.pointerId, tool, x: event.clientX, y: event.clientY, pan: { ...pan } };
    if (tool !== 'pan') {
      const stroke = { points: [start], radius: Math.max(Math.SQRT1_2, Number(brush.value) / view().scale / 2), erase: tool === 'erase' };
      operations.push(stroke); undone = [];
      pointer.stroke = stroke;
      paintSegment(mask, width, height, start, start, stroke.radius, stroke.erase);
      render();
    }
    selectionChanged();
  });
  stage.addEventListener('pointermove', event => {
    if (!pointer || event.pointerId !== pointer.id) return;
    if (pointer.tool === 'pan') {
      pan = { x: pointer.pan.x + event.clientX - pointer.x, y: pointer.pan.y + event.clientY - pointer.y };
      updateView();
    } else {
      const stroke = pointer.stroke, next = point(event);
      paintSegment(mask, width, height, stroke.points.at(-1), next, stroke.radius, stroke.erase);
      stroke.points.push(next); render();
    }
  });
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) stage.addEventListener(event, endStroke);
  stage.addEventListener('keydown', event => {
    if (!ready || pointer || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' ', '+', '=', '-'].includes(event.key)) return;
    event.preventDefault();
    if (['+', '=', '-'].includes(event.key)) { zoomBy(event.key === '-' ? 0.8 : 1.25); return; }
    if (event.key === ' ' && tool !== 'pan') {
      const stroke = { points: [{ ...cursor }], radius: Math.max(Math.SQRT1_2, Number(brush.value) / view().scale / 2), erase: tool === 'erase' };
      operations.push(stroke); undone = [];
      paintSegment(mask, width, height, cursor, cursor, stroke.radius, stroke.erase);
      selectionChanged();
    } else if (event.key !== ' ') {
      const dx = event.key === 'ArrowRight' ? 10 : event.key === 'ArrowLeft' ? -10 : 0;
      const dy = event.key === 'ArrowDown' ? 10 : event.key === 'ArrowUp' ? -10 : 0;
      if (tool === 'pan') { pan.x += dx; pan.y += dy; }
      else {
        cursor.x = Math.max(0, Math.min(width - 1, cursor.x + dx / view().scale));
        cursor.y = Math.max(0, Math.min(height - 1, cursor.y + dy / view().scale));
      }
    }
    cursorElement.hidden = tool === 'pan';
    updateView();
  });
  stage.addEventListener('blur', () => { cursorElement.hidden = true; });
  exportButton.addEventListener('click', async () => {
    if (exportButton.disabled || exporting) return;
    exporting = true; exportButton.disabled = true;
    errorElement.textContent = '';
    let url, timer;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').putImageData(new ImageData(maskPixels(mask), width, height), 0, 0);
      const blob = await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('遮罩导出超时，请重试。')), 10000);
        canvas.toBlob(value => value ? resolve(value) : reject(new Error('遮罩导出失败。')), 'image/png');
      });
      url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = 'character-mask.png'; link.click();
    } catch (error) { errorElement.textContent = error.message; }
    finally {
      clearTimeout(timer);
      if (url) setTimeout(() => URL.revokeObjectURL(url), 60000);
      exporting = false; selectionChanged();
    }
  });
  document.getElementById('image-edit-close').addEventListener('click', () => { endStroke(); dialog.close(); });
  dialog.addEventListener('close', () => endStroke());
  new ResizeObserver(updateView).observe(stage);
}
