(() => {
  const forms = [...document.querySelectorAll('#episode-resource-candidates, [data-occurrence-form]')];
  if (!forms.length) return;
  const main = document.querySelector('main');
  const scriptForm = document.getElementById('episode-script-form');
  let busy = false;
  function fields(target) {
    const choice = target.querySelector('[data-resource-choice]');
    const action = choice.value === 'new' ? 'new' : choice.value === 'ignore' ? 'ignore' : 'existing';
    const selection = { action, mode: target.querySelector('[data-resource-mode]').value, details: target.querySelector('[data-resource-details]').value };
    if (action === 'existing') {
      selection.resourceId = Number(choice.value); selection.resourceName = choice.selectedOptions[0]?.dataset.name;
    } else if (action === 'new') {
      selection.name = target.querySelector('[data-resource-name]').value; selection.description = target.querySelector('[data-resource-description]').value;
    }
    return selection;
  }
  function showNew(target) {
    const visible = target.querySelector('[data-resource-choice]').value === 'new';
    target.querySelector('[data-new-resource]').hidden = !visible;
    for (const input of target.querySelectorAll('[data-resource-name], [data-resource-description]')) input.disabled = !visible;
    target.querySelector('[data-resource-name]').required = visible;
  }
  for (const form of forms) {
    const targets = form.id === 'episode-resource-candidates' ? [...form.querySelectorAll('[data-resource-candidate]')] : [form];
    targets.forEach(showNew);
    form.addEventListener('input', () => { form.dataset.dirty = 'true'; });
    form.addEventListener('change', () => { form.dataset.dirty = 'true'; targets.forEach(showNew); });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const button = form.querySelector('[type="submit"]');
      const error = form.querySelector('[data-resource-error]');
      if (busy || main.inert || button.disabled) return;
      error.textContent = '';
      if (scriptForm?.dataset.dirty) { error.textContent = '剧本还有未保存修改，请先保存并重新核对提取版本，再确认关联。'; return; }
      const body = new URLSearchParams();
      if (form.id === 'episode-resource-candidates') {
        body.set('batchRevision', form.dataset.batchRevision); body.set('scriptRevision', form.dataset.scriptRevision);
        body.set('selections', JSON.stringify(targets.map(fields)));
      } else {
        const selection = fields(form);
        selection.sceneHeading = form.querySelector('[data-scene-heading]').value; selection.quote = form.querySelector('[data-source-quote]').value;
        body.set('revision', form.dataset.revision); body.set('scriptRevision', form.dataset.scriptRevision); body.set('selection', JSON.stringify(selection));
      }
      const label = button.textContent; let redirect;
      busy = true; main.inert = true; button.disabled = true; button.textContent = '保存中…';
      try {
        const response = await fetch(form.dataset.url, { method: 'POST', body });
        let result; try { result = await response.json(); } catch { throw new TypeError('响应无法识别'); }
        if (!response.ok) throw new Error(result.error ?? '关联保存失败。');
        form.dataset.dirty = '';
        redirect = result.redirect;
      } catch (errorValue) {
        error.textContent = errorValue instanceof TypeError ? '保存结果未确认，请保留输入并刷新核对；不会自动重试。' : errorValue.message;
      } finally { busy = false; main.inert = false; button.disabled = false; button.textContent = label; }
      if (redirect) { window.location.hash = redirect.split('#')[1] ?? ''; window.location.reload(); }
    });
  }
  if (/^#occurrence-\d+$/.test(window.location.hash)) {
    const target = document.getElementById(window.location.hash.slice(1));
    if (target) { target.open = true; target.scrollIntoView(); }
  }
  window.addEventListener('beforeunload', event => {
    if (busy || forms.some(form => form.dataset.dirty)) { event.preventDefault(); event.returnValue = ''; }
  });
})();
