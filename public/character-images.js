(() => {
  const form = document.getElementById('character-generation-form');
  if (!form) return;
  const characterForm = document.getElementById('character-form');
  const button = document.getElementById('generate-character-image');
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
  button.addEventListener('click', async () => {
    if (busy || button.disabled || characterForm.inert) return;
    errorElement.textContent = '';
    if (characterForm.dataset.dirty) { errorElement.textContent = '角色资料有未保存的修改，请先保存资料再生成图片。'; return; }
    if (!api.value) { errorElement.textContent = '请选择文生图配置。'; return; }
    const option = api.selectedOptions[0];
    const body = new URLSearchParams({ apiConfigId: api.value, chargeConfirmed: 'yes', revision: form.dataset.revision, model: option.dataset.model, baseUrl: option.dataset.baseUrl });
    busy = true;
    button.disabled = true;
    form.inert = true;
    characterForm.inert = true;
    button.textContent = '生成中…';
    statusElement.textContent = '';
    try {
      const response = await fetch(form.dataset.url, { method: 'POST', body });
      const result = await response.json();
      if (!response.ok) {
        if (result.recoveryImage) {
          showImage(result.recoveryImage, '图片已生成但未能保存。请点击上方图片打开并另存，原角色板不变。');
        }
        throw new Error(result.error ?? '生成图片失败。');
      }
      statusElement.textContent = result.message;
      if (result.valid) {
        busy = false;
        window.location.reload();
      } else {
        showImage(result.imageUrl, result.message);
      }
    } catch (error) {
      errorElement.textContent = error instanceof TypeError ? '未收到生成结果，请先刷新角色页或查看服务商记录。请求可能已计费，不要直接重复生成。' : error.message;
      statusElement.textContent = '';
    } finally {
      busy = false;
      form.inert = false;
      characterForm.inert = false;
      button.disabled = false;
      button.textContent = '生成图片';
    }
  });
  window.addEventListener('beforeunload', event => {
    if (busy) { event.preventDefault(); event.returnValue = ''; }
  });
})();
