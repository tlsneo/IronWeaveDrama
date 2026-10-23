(() => {
  const form = document.getElementById('character-generation-form') ?? document.getElementById('scene-generation-form');
  if (!form) return;
  const kind = form.dataset.kind ?? 'character'; const resourceLabel = kind === 'scene' ? '场景' : '角色';
  const imageLabel = kind === 'scene' ? '场景参考图' : '角色板';
  const characterForm = document.getElementById(`${kind}-form`);
  const button = document.getElementById(`generate-${kind}-image`);
  const clearButton = document.getElementById(`clear-${kind}-image`);
  const api = document.getElementById(`${kind}-image-api`);
  const size = document.getElementById(`${kind}-image-size`);
  size.addEventListener('input', () => size.setCustomValidity(''));
  const errorElement = document.getElementById(`${kind}-generation-error`);
  const statusElement = document.getElementById(`${kind}-generation-status`);
  const boardLink = document.getElementById(`${kind}-board-link`);
  const boardImage = document.getElementById(`${kind}-board-image`);
  const boardEmpty = document.getElementById(`${kind}-board-empty`);
  const boardNote = document.getElementById(`${kind}-board-note`);
  let busy = false;

  function showImage(source, note) {
    boardImage.src = source;
    boardLink.href = source;
    boardLink.hidden = false;
    boardEmpty.hidden = true;
    boardNote.textContent = note;
  }

  form.addEventListener('submit', event => event.preventDefault());
  async function run(action, activeButton, label) {
    if (busy || activeButton.disabled || characterForm.inert) return;
    errorElement.textContent = '';
    if (characterForm.dataset.dirty) { errorElement.textContent = `${resourceLabel}资料有未保存的修改，请先保存资料。`; return; }
    const body = new URLSearchParams({ boardId: form.dataset.boardId ?? '' });
    if (action !== 'clear-image') {
      body.set('referenceId', form.dataset.referenceId ?? '');
      if (!api.value) { errorElement.textContent = `请选择${form.dataset.apiName ?? '文生图'}配置。`; return; }
      const [width, height] = size.value.split('x').map(Number), [w, h] = size.dataset.aspectRatio.split(':').map(Number);
      size.setCustomValidity('');
      if (![width, height].every(Number.isSafeInteger) || width <= 0 || height <= 0 || size.value !== `${width}x${height}` || width * height > 64000000 || width * h !== height * w) size.setCustomValidity(`请填写规范正整数宽x高，最多 64,000,000 像素，须符合 ${size.dataset.aspectRatio} 比例。`);
      if (!size.reportValidity()) return;
      body.set('size', size.value);
      const option = api.selectedOptions[0];
      body.set('apiConfigId', api.value);
      body.set('chargeConfirmed', 'yes');
      body.set('revision', form.dataset.revision);
      body.set('model', option.dataset.model);
      body.set('baseUrl', option.dataset.baseUrl);
    }
    busy = true;
    activeButton.disabled = true;
    form.inert = true;
    characterForm.inert = true;
    activeButton.textContent = action === 'clear-image' ? '清空中…' : '生成中…';
    statusElement.textContent = '';
    try {
      const response = await (action === 'generate' && window.IronGeneration ? window.IronGeneration.request : fetch)(form.dataset.url.replace(/generate$/, action), { method: 'POST', body });
      const result = await response.json();
      if (!response.ok) {
        if (result.recoveryImage) {
          showImage(result.recoveryImage, `图片已生成但未能保存。请点击上方图片打开并另存，原${imageLabel}不变。`);
          form.dataset.boardId = '';
          clearButton.disabled = true;
        }
        throw new Error(result.error ?? '图片操作失败。');
      }
      statusElement.textContent = result.message ?? '';
      if (result.operation) { window.location.assign(form.dataset.url.split('/').slice(0, 3).join('/') + '/operations'); return; }
      if (result.valid || result.cleared) {
        busy = false;
        window.location.reload();
      } else {
        showImage(result.imageUrl, result.message);
        form.dataset.boardId = result.imageUrl.split('/').pop();
        clearButton.disabled = false;
      }
    } catch (error) {
      errorElement.textContent = error instanceof TypeError
        ? action === 'clear-image' ? '清空结果未确认，请刷新查看。' : `未收到图片结果，请先刷新${resourceLabel}页或查看服务商记录。请求可能已计费，不要直接重复提交。`
        : error.message;
      statusElement.textContent = '';
    } finally {
      busy = false;
      form.inert = false;
      characterForm.inert = false;
      activeButton.disabled = false;
      activeButton.textContent = label;
    }
  }
  button.addEventListener('click', () => run('generate', button, '生成图片'));
  clearButton.addEventListener('click', () => run('clear-image', clearButton, '清空图像'));
  window.addEventListener('beforeunload', event => {
    if (busy) { event.preventDefault(); event.returnValue = ''; }
  });
})();
