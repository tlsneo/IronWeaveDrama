(() => {
  const form = document.getElementById('character-generation-form');
  if (!form) return;
  const characterForm = document.getElementById('character-form');
  const button = document.getElementById('generate-character-image');
  const editButton = document.getElementById('edit-character-image');
  const clearButton = document.getElementById('clear-character-image');
  const api = document.getElementById('character-image-api');
  const errorElement = document.getElementById('character-generation-error');
  const statusElement = document.getElementById('character-generation-status');
  const boardLink = document.getElementById('character-board-link');
  const boardImage = document.getElementById('character-board-image');
  const boardEmpty = document.getElementById('character-board-empty');
  const boardNote = document.getElementById('character-board-note');
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
    if (characterForm.dataset.dirty) { errorElement.textContent = '角色资料有未保存的修改，请先保存资料。'; return; }
    const body = new URLSearchParams({ boardId: form.dataset.boardId ?? '' });
    if (action !== 'clear-image') {
      if (!api.value) { errorElement.textContent = '请选择文生图配置。'; return; }
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
      const response = await fetch(form.dataset.url.replace(/generate$/, action), { method: 'POST', body });
      const result = await response.json();
      if (!response.ok) {
        if (result.recoveryImage) {
          showImage(result.recoveryImage, '图片已生成但未能保存。请点击上方图片打开并另存，原角色板不变。');
          form.dataset.boardId = '';
          editButton.disabled = true;
          clearButton.disabled = true;
        }
        throw new Error(result.error ?? '图片操作失败。');
      }
      statusElement.textContent = result.message ?? '';
      if (result.valid || result.cleared) {
        busy = false;
        window.location.reload();
      } else {
        showImage(result.imageUrl, result.message);
        form.dataset.boardId = result.imageUrl.split('/').pop();
        editButton.disabled = false;
        clearButton.disabled = false;
      }
    } catch (error) {
      errorElement.textContent = error instanceof TypeError
        ? action === 'clear-image' ? '清空结果未确认，请刷新查看。' : '未收到图片结果，请先刷新角色页或查看服务商记录。请求可能已计费，不要直接重复提交。'
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
