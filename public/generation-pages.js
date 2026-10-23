(() => {
  const notice = document.getElementById('generation-notice');
  const main = document.querySelector('main');
  const forms = [...document.querySelectorAll('[data-generation-page]')];
  let busy = false;
  const dirty = () => forms.some(form => form.dataset.dirty === 'true');
  function allowNavigation(except) {
    return !forms.some(form => form !== except && form.dataset.dirty === 'true') || window.confirm('操作成功后将刷新页面，其他未保存输入会丢失。请先保存或复制；是否放弃其他输入并继续？');
  }
  async function submit(url, body, button, form) {
    if (busy || main.inert || button.disabled) return;
    if (!allowNavigation(form)) return;
    busy = true; button.disabled = true; main.inert = true; notice.textContent = '操作进行中。';
    let destination, reload = false;
    try {
      const generate = url.endsWith('/generate');
      const transfer = generate || url.endsWith('/recover');
      const response = transfer ? await window.IronGeneration.request(url, { method: 'POST', body }) : await fetch(url, { method: 'POST', body });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '操作失败。');
      notice.textContent = result.message || '已保存；请核对结果并人工采用。';
      destination = result.redirect;
      // 制作页原地展示结果；不在保存成功之前丢弃任何输入。
      reload = !destination;
      forms.forEach(item => { item.dataset.dirty = ''; });
    } catch (error) { notice.textContent = error instanceof TypeError ? '操作结果未确认，输入已保留；请到生成历史核对，不会自动重试。' : error.message; }
    finally { busy = false; main.inert = false; button.disabled = false; }
    if (destination) window.location.assign(destination);
    else if (reload) window.location.reload();
  }
  forms.forEach(form => {
    for (const event of ['input', 'change']) form.addEventListener(event, () => { form.dataset.dirty = 'true'; });
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (busy || main.inert) return;
      if (form.hasAttribute('data-clip-generate') && document.getElementById('production-clip-form')?.dataset.dirty === 'true') {
        notice.textContent = '片段有未保存修改，请先保存再生成视频。'; return;
      }
      const url = new URL(form.action).pathname;
      submit(url, new URLSearchParams(new FormData(form)), form.querySelector('[type="submit"]') || form.querySelector('button'), form);
    });
  });
  document.querySelectorAll('[data-operation-action]').forEach(button => button.addEventListener('click', () => {
    if (busy || main.inert || button.disabled) return;
    if (button.dataset.confirm && !window.confirm(button.dataset.confirm)) return;
    submit(button.dataset.operationAction, new URLSearchParams({ confirmed: 'yes' }), button);
  }));
  window.addEventListener('beforeunload', event => { if (busy || dirty()) { event.preventDefault(); event.returnValue = ''; } });
})();
