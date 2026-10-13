(() => {
  const root = document.querySelector('[data-production-resources]');
  if (!root) return;
  const get = id => document.getElementById(id);
  const main = document.querySelector('main'), form = get('production-form');
  const generation = get('look-generation-form'), file = get('production-reference-file');
  const error = get('production-error') ?? get('delete-error'), status = get('production-status');
  const recovery = get('production-recovery'), recoveryLink = get('production-recovery-link');
  let busy = false;
  const nameForm = get('name-form');
  nameForm?.addEventListener('formdata', event => {
    if (/^\/projects\/[1-9]\d*\/(props|costumes|looks)$/.test(nameForm.dataset.url)) event.formData.delete('seasonId');
  });

  function available(button) {
    return !busy && !main.inert && !button.disabled;
  }
  function saved() {
    if (form.dataset.dirty === 'true') {
      error.textContent = '资料或选项有未保存的修改，请先保存资料，再进行图片操作；不会自动保存。';
      return false;
    }
    return true;
  }
  function revision() {
    return form.elements.namedItem('revision').value;
  }
  function safeRedirect(value) {
    const project = (form?.dataset.url ?? root.querySelector('[data-delete-url]')?.dataset.deleteUrl)?.split('/').slice(0, 3).join('/');
    return typeof value === 'string' && !!project && !/[\s\\]/.test(value)
      && (value === project || value.startsWith(`${project}?`) || value.startsWith(`${project}/`));
  }
  function retainRecovery(result) {
    const prefix = `${form?.dataset.url}/images/`;
    const image = result.recoveryImage;
    const local = typeof image === 'string' && image.startsWith(prefix) && /^[1-9]\d*$/.test(image.slice(prefix.length));
    const data = typeof image === 'string' && image.length <= 45 * 1024 * 1024 && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image);
    if (recovery && (local || data)) {
      recoveryLink.setAttribute('href', image);
      recovery.dataset.unsaved = String(data);
      if (data) recoveryLink.setAttribute('download', `定妆未保存.${image.startsWith('data:image/jpeg') ? 'jpg' : image.startsWith('data:image/webp') ? 'webp' : 'png'}`);
      else recoveryLink.removeAttribute('download');
      const message = get('production-recovery-message');
      if (message) message.textContent = data ? '图片已生成但未能保存。请先下载本次图片；刷新或离开会丢失这份未保存结果。' : '无效／旧依据图片已保留供核对，刷新后也可从图片历史找回，不代表生成成功。';
      recovery.hidden = false;
    }
  }
  async function post(action, url, body) {
    const response = await fetch(url, { method: 'POST', body });
    let result;
    try { result = await response.json(); } catch { throw new TypeError('服务响应无法识别'); }
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new TypeError('服务响应无效');
    if (!response.ok) {
      retainRecovery(result);
      if (typeof result.error !== 'string' || !result.error) throw new TypeError('服务错误响应无效');
      throw new Error(result.error);
    }
    if (action !== 'delete' && (!Number.isSafeInteger(result.revision) || result.revision < 1)) throw new TypeError('版本响应无效');
    if (action === 'save' || action === 'generate') {
      if (!Number.isSafeInteger(result.id) || result.id < 1) throw new TypeError('保存结果无效');
    }
    if ((action === 'save' || action === 'generate' || action === 'delete') && !safeRedirect(result.redirect)) throw new TypeError('跳转响应无效');
    if (result.redirect !== undefined && !safeRedirect(result.redirect)) throw new TypeError('跳转响应无效');
    return result;
  }
  async function run(action, button, url, body) {
    if (!available(button)) return;
    if (recovery?.dataset.unsaved === 'true' && !window.confirm('本页有尚未保存的生成图片。请先下载保留；继续操作可能丢失这份付费结果，确认放弃后再继续。')) return;
    const label = button.textContent;
    busy = true; main.inert = true; button.disabled = true;
    button.textContent = action === 'generate' ? '生成中…' : action === 'delete' ? '删除中…' : action === 'upload' ? '上传中…' : action === 'save' ? '保存中…' : '清除中…';
    error.textContent = '';
    if (status) status.textContent = action === 'generate' ? '正在生成，请勿重复点击或离开；请求可能计费。' : '正在保存操作，请勿重复提交或离开。';
    let result;
    try {
      result = await post(action, url, body);
      if (form) form.dataset.dirty = '';
      if (recovery) { recovery.dataset.unsaved = ''; recovery.hidden = true; }
      if (file) file.value = '';
      if (status) status.textContent = '操作已保存。';
    } catch (failure) {
      if (status) status.textContent = '';
      error.textContent = failure instanceof TypeError
        ? action === 'generate' ? '生成结果未确认，请保留当前输入，刷新查看图片历史或核对服务商记录；请求可能已计费，不要立即重复提交。'
          : '操作结果未确认，当前输入仍保留；请先保留输入，再刷新核对，不要立即重复提交。'
        : failure.message;
    } finally {
      busy = false; main.inert = false; button.disabled = false; button.textContent = label;
    }
    // 导航前解锁并清除 dirty，避免成功操作被离页提示拦住。
    if (result) {
      if (result.redirect) window.location.assign(result.redirect);
      else window.location.reload();
    }
  }

  // 在按钮上处理，阻止通用 delete.js 再提交；只接管本页新资源的删除。
  root.querySelectorAll('[data-delete-url]').forEach(button => {
    button.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation();
      if (!available(button) || !window.confirm(button.dataset.deleteMessage)) return;
      return run('delete', button, button.dataset.deleteUrl, new URLSearchParams({ confirmed: 'yes', name: button.dataset.deleteName }));
    });
  });
  if (form) {
    const save = form.querySelector('[type="submit"]');
    const changed = () => {
      if (busy || main.inert) return;
      form.dataset.dirty = 'true';
      status.textContent = '有未保存的资料或选项；请先保存，再进行图片操作。';
    };
    form.addEventListener('input', changed);
    form.addEventListener('change', changed);
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (!available(save) || !form.reportValidity()) return;
      const body = new URLSearchParams(new FormData(form));
      if (form.dataset.kind === 'look') {
        const raw = body.getAll('assetId');
        const ids = raw.map(Number);
        if (ids.length > 50 || raw.some(value => !/^[1-9]\d*$/.test(value)) || ids.some(id => !Number.isSafeInteger(id)) || new Set(ids).size !== ids.length) {
          error.textContent = '服饰与道具合计最多选择 50 件，素材 ID 必须有效且不重复。';
          return;
        }
        body.delete('assetId'); body.set('assetIds', JSON.stringify(ids));
      }
      return run('save', save, form.dataset.url, body);
    });
  }
  if (file) {
    const upload = get('production-upload'), clear = get('production-clear-reference');
    upload.addEventListener('click', () => {
      if (!available(upload) || !saved()) return;
      const selected = file.files[0];
      if (!selected) { error.textContent = '请先选择参考图片，再点击上传。'; return; }
      if (selected.size > 5 * 1024 * 1024 || selected.size === 0) { error.textContent = '参考图不能为空且最多 5 MiB。'; return; }
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(selected.type)) { error.textContent = '请上传 PNG、JPEG 或 WebP 图片。'; return; }
      const body = new FormData();
      body.set('revision', revision()); body.set('referenceId', form.dataset.referenceId ?? '0'); body.set('referenceImage', selected);
      return run('upload', upload, `${form.dataset.url}/reference-image`, body);
    });
    clear.addEventListener('click', () => {
      if (!available(clear) || !saved() || !window.confirm('确定移除这项素材的参考图？旧定妆生成图保留为旧依据待核对；不会调用模型。')) return;
      return run('clear-reference', clear, `${form.dataset.url}/clear-reference`, new URLSearchParams({ revision: revision(), referenceId: form.dataset.referenceId ?? '0', confirmed: 'yes' }));
    });
  }
  if (generation) {
    const generate = get('look-generate'), clear = get('look-clear-image'), api = get('look-api');
    generation.addEventListener('submit', event => {
      event.preventDefault();
      if (!available(generate) || !saved()) return;
      if (generation.dataset.missing === 'true') { error.textContent = '请先补齐基础演员和所有选中素材的参考图，保存后再生成。'; return; }
      const option = api.selectedOptions[0];
      if (!api.value || !option || !option.dataset.model || !option.dataset.baseUrl) { error.textContent = '请选择有效的图生图 API 配置。'; api.focus(); return; }
      return run('generate', generate, generation.dataset.url, new URLSearchParams({
        revision: generation.dataset.revision, inputRevision: generation.dataset.inputRevision,
        apiConfigId: api.value, model: option.dataset.model, baseUrl: option.dataset.baseUrl, chargeConfirmed: 'yes',
      }));
    });
    clear.addEventListener('click', () => {
      if (!available(clear) || !saved() || !window.confirm('确定清除当前定妆图？图片仍保留在历史中，不会删除基础演员或素材，也不会调用模型。')) return;
      return run('clear-image', clear, `${form.dataset.url}/clear-image`, new URLSearchParams({ revision: revision(), imageId: generation.dataset.imageId, confirmed: 'yes' }));
    });
  }
  window.addEventListener('beforeunload', event => {
    if (busy || form?.dataset.dirty === 'true' || file?.files.length || recovery?.dataset.unsaved === 'true') { event.preventDefault(); event.returnValue = ''; }
  });
})();
