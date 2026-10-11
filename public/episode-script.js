(() => {
  const form = document.getElementById('episode-script-form');
  if (!form) return;
  const main = document.querySelector('main');
  const source = document.getElementById('episode-script-source');
  const script = document.getElementById('episode-script-text');
  const notes = document.getElementById('episode-script-notes');
  const api = document.getElementById('episode-script-api');
  const generate = document.getElementById('generate-episode-script');
  const extract = document.getElementById('extract-episode-resources');
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
  async function run(generating, extracting = false) {
    const active = extracting ? extract : generating ? generate : save;
    if (busy || active.disabled || main.inert) return;
    errorElement.textContent = ''; status.textContent = '';
    let replacement = false;
    if (generating || extracting) {
      const input = extracting ? script : source;
      if (!input.value.trim()) { errorElement.textContent = extracting ? '请先填写并保存本集剧本正文。' : '请填写本集小说原文。'; input.focus(); return; }
      if (!api.value) { errorElement.textContent = '请选择大语言模型配置。'; api.focus(); return; }
      if (generating) {
        replacement = !!(script.value.trim() || notes.value.trim());
        if (replacement && !window.confirm('生成成功将替换当前剧本和改编说明。当前稿件会先保存，生成失败不会覆盖；是否继续？')) return;
      } else {
        replacement = extract.dataset.hasCandidates === 'true';
        if ((replacement || document.querySelector('#episode-resource-candidates[data-dirty="true"], [data-occurrence-form][data-dirty="true"]')) && !window.confirm('重新提取会替换未确认的提取草稿，并离开当前未保存的关联输入。已确认的出场记录和资源档案不会删除或覆盖；是否继续？')) return;
      }
    }
    const label = active.textContent;
    busy = true; active.disabled = true; main.inert = true;
    active.textContent = extracting ? '提取中…' : generating ? '生成中…' : '保存中…';
    let modelRequested = false, redirect;
    try {
      if ((!generating && !extracting) || form.dataset.dirty || form.dataset.revision === '0') await saveDraft();
      if (extracting) {
        const option = api.selectedOptions[0]; modelRequested = true;
        const result = await post(extract.dataset.url, new URLSearchParams({ revision: form.dataset.revision, batchRevision: extract.dataset.batchRevision,
          apiConfigId: api.value, model: option.dataset.model, baseUrl: option.dataset.baseUrl, replaceConfirmed: replacement ? 'yes' : 'no' }));
        document.querySelectorAll('#episode-resource-candidates, [data-occurrence-form]').forEach(target => { target.dataset.dirty = ''; });
        status.textContent = result.message;
        redirect = result.redirect;
      } else if (generating) {
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
    if (redirect) { window.location.hash = redirect.split('#')[1] ?? ''; window.location.reload(); }
  }
  form.addEventListener('submit', event => { event.preventDefault(); return run(false); });
  form.addEventListener('input', event => { if (event.target !== api) form.dataset.dirty = 'true'; });
  generate.addEventListener('click', () => run(true));
  extract?.addEventListener('click', () => run(false, true));
  window.addEventListener('beforeunload', event => {
    if (busy || form.dataset.dirty || (!recovery.hidden && recoveryText.value)) { event.preventDefault(); event.returnValue = ''; }
  });
})();
