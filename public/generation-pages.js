(() => {
  const notice = document.getElementById('generation-notice');
  let busy = false;
  async function submit(url, body, button) {
    if (busy) return;
    busy = true; button.disabled = true; notice.textContent = '操作进行中。';
    try {
      const generate = url.endsWith('/generate');
      const transfer = generate || url.endsWith('/recover');
      const response = transfer ? await window.IronGeneration.request(url, { method: 'POST', body }) : await fetch(url, { method: 'POST', body });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '操作失败。');
      notice.textContent = result.message || '已保存；交付确认与人工采用状态请查看历史。';
      if (result.redirect) window.location.assign(result.redirect);
      else if (generate) window.location.assign(`${/^\/projects\/\d+/.exec(url)?.[0] || ''}/operations`);
      else window.location.reload();
    } catch (error) { notice.textContent = error.message; }
    finally { busy = false; button.disabled = false; }
  }
  document.querySelectorAll('[data-generation-page]').forEach(form => form.addEventListener('submit', event => {
    event.preventDefault();
    const url = new URL(form.action).pathname;
    if (url.endsWith('/generate') && !window.confirm('实际调用一次所选模型，可能计费。能力仍需 Iron 已验证配置支持，是否继续？')) return;
    submit(url, new URLSearchParams(new FormData(form)), form.querySelector('button'));
  }));
  document.querySelectorAll('[data-operation-action]').forEach(button => button.addEventListener('click', () => {
    if (button.dataset.confirm && !window.confirm(button.dataset.confirm)) return;
    submit(button.dataset.operationAction, new URLSearchParams({ confirmed: 'yes' }), button);
  }));
})();
