(() => {
  const form = document.getElementById('episode-script-form');
  if (!form) return;
  const main = document.querySelector('main');
  const source = document.getElementById('episode-script-source');
  const script = document.getElementById('episode-script-text');
  const notes = document.getElementById('episode-script-notes');
  const api = document.getElementById('episode-script-api');
  const generate = document.getElementById('generate-episode-script');
  const save = document.getElementById('save-episode-script');
  const errorElement = document.getElementById('episode-script-error');
  const status = document.getElementById('episode-script-status');
  const recovery = document.getElementById('episode-script-recovery');
  const recoveryText = document.getElementById('episode-script-recovery-text');
  let busy = false;

  async function post(url, body) {
    const response = await fetch(url, { method: 'POST', body });
    let result;
    try { result = await response.json(); } catch { throw new TypeError('服务响应无法识别'); }
    if (!response.ok) {
      if (result.recoveryText) { recoveryText.value = result.recoveryText; recovery.hidden = false; }
      throw new Error(result.error ?? '剧本操作失败。');
    }
    return result;
  }
  async function saveDraft() {
    const result = await post(form.dataset.url, new URLSearchParams({ source: source.value, script: script.value, notes: notes.value, revision: form.dataset.revision }));
    form.dataset.revision = String(result.revision);
    form.dataset.dirty = '';
    return result;
  }
  async function run(generating) {
    const active = generating ? generate : save;
    if (busy || active.disabled || main.inert) return;
    errorElement.textContent = ''; status.textContent = '';
    let replacement = false;
    if (generating) {
      if (!source.value.trim()) { errorElement.textContent = '请填写本集小说原文。'; source.focus(); return; }
      if (!api.value) { errorElement.textContent = '请选择大语言模型配置。'; api.focus(); return; }
      replacement = !!(script.value.trim() || notes.value.trim());
      if (replacement && !window.confirm('生成成功将替换当前剧本和改编说明。当前稿件会先保存，生成失败不会覆盖；是否继续？')) return;
    }
    const label = active.textContent;
    busy = true; active.disabled = true; main.inert = true;
    active.textContent = generating ? '生成中…' : '保存中…';
    let modelRequested = false;
    try {
      if (!generating || form.dataset.dirty || form.dataset.revision === '0') await saveDraft();
      if (generating) {
        const option = api.selectedOptions[0];
        modelRequested = true;
        const result = await post(form.dataset.generateUrl, new URLSearchParams({
          revision: form.dataset.revision, apiConfigId: api.value,
          model: option.dataset.model, baseUrl: option.dataset.baseUrl,
          replaceConfirmed: replacement ? 'yes' : 'no',
        }));
        script.value = result.script; notes.value = result.notes;
        form.dataset.revision = String(result.revision); form.dataset.dirty = '';
        notes.closest('details').open = true;
        recovery.hidden = true; recoveryText.value = '';
        status.textContent = result.message;
      } else status.textContent = '原文、剧本和改编说明已保存。';
    } catch (error) {
      errorElement.textContent = error instanceof TypeError
        ? modelRequested ? '未收到生成结果。请先刷新本集或查看服务商记录，请求可能已计费，不要直接重复提交。' : '保存结果未确认，请先保留当前输入，再刷新核对。'
        : error.message;
    } finally {
      busy = false; main.inert = false; active.disabled = false; active.textContent = label;
    }
  }
  form.addEventListener('submit', event => { event.preventDefault(); return run(false); });
  form.addEventListener('input', event => { if (event.target !== api) form.dataset.dirty = 'true'; });
  generate.addEventListener('click', () => run(true));
  window.addEventListener('beforeunload', event => {
    if (busy || form.dataset.dirty || (!recovery.hidden && recoveryText.value)) { event.preventDefault(); event.returnValue = ''; }
  });
})();
