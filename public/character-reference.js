(() => {
  const form = document.getElementById('character-generation-form') ?? document.getElementById('scene-generation-form');
  if (!form) return;
  const kind = form.dataset.kind ?? 'character'; const label = kind === 'scene' ? '场景' : '角色';
  const characterForm = document.getElementById(`${kind}-form`);
  const upload = document.getElementById(`upload-${kind}-reference`);
  const clear = document.getElementById(`clear-${kind}-reference`);
  const input = document.getElementById(`${kind}-reference-file`);
  const errorElement = document.getElementById(`${kind}-generation-error`);
  let busy = false;

  function canChange() {
    if (busy || form.inert || characterForm.inert) return false;
    errorElement.textContent = '';
    if (characterForm.dataset.dirty) { errorElement.textContent = `${label}资料有未保存的修改，请先保存资料。`; return false; }
    return true;
  }
  async function change(removing) {
    if (!canChange() || (removing && clear.disabled)) return;
    const file = input.files[0];
    if (!removing && !file) return;
    if (!removing && file.size > 5 * 1024 * 1024) { errorElement.textContent = '参考图最多 5 MiB。'; input.value = ''; return; }
    busy = true;
    form.inert = characterForm.inert = true;
    const active = removing ? clear : upload;
    const label = active.textContent;
    active.disabled = true; active.textContent = removing ? '移除中…' : '上传中…';
    let completed = false, preview;
    try {
      let body;
      if (removing) body = new URLSearchParams({ referenceId: form.dataset.referenceId });
      else {
        preview = URL.createObjectURL(file);
        const image = new Image(); image.src = preview;
        try { await image.decode(); } catch { throw new Error('图片无法读取，请上传有效的 PNG、JPEG 或 WebP 图片。'); }
        if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth > 16384 || image.naturalHeight > 16384 || image.naturalWidth * image.naturalHeight > 67108864) throw new Error('参考图尺寸过大，请缩小后上传。');
        body = new FormData();
        body.set('referenceId', form.dataset.referenceId ?? '');
        body.set('referenceImage', file);
      }
      const response = await fetch(removing ? form.dataset.referenceUrl.replace(/reference-image$/, 'clear-reference') : form.dataset.referenceUrl, { method: 'POST', body });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? '参考图保存失败。');
      completed = true;
      busy = false;
      window.location.reload();
    } catch (error) {
      errorElement.textContent = error instanceof TypeError ? '参考图操作结果未确认，请刷新查看，不要立即重复提交。' : error.message;
    } finally {
      if (preview) URL.revokeObjectURL(preview);
      input.value = '';
      if (!completed) { busy = false; form.inert = characterForm.inert = false; active.disabled = false; active.textContent = label; }
    }
  }
  upload.addEventListener('click', () => { if (canChange()) input.click(); });
  input.addEventListener('change', () => change(false));
  clear.addEventListener('click', () => change(true));
  window.addEventListener('beforeunload', event => { if (busy) { event.preventDefault(); event.returnValue = ''; } });
})();
