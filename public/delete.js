(() => {
  const errorElement = document.getElementById('delete-error');
  const main = document.querySelector('main');
  let busy = false;
  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-delete-url]');
    if (!button || button.disabled || button.closest('[inert]') || busy) return;
    event.preventDefault();
    if (!window.confirm(button.dataset.deleteMessage)) return;
    busy = true;
    button.disabled = true;
    button.textContent = '删除中…';
    main.inert = true;
    errorElement.textContent = '';
    try {
      const response = await fetch(button.dataset.deleteUrl, {
        method: 'POST', body: new URLSearchParams({ confirmed: 'yes', name: button.dataset.deleteName }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? '删除失败。');
      for (const id of ['character-form', 'scene-form', 'episode-script-form', 'episode-resource-candidates', 'storyboard-form']) {
        const form = document.getElementById(id);
        if (form) form.dataset.dirty = '';
      }
      document.querySelectorAll('[data-occurrence-form]').forEach(form => { form.dataset.dirty = ''; });
      const scriptRecovery = document.getElementById('episode-script-recovery');
      if (scriptRecovery) scriptRecovery.hidden = true;
      const storyboardRecovery = document.getElementById('storyboard-recovery');
      if (storyboardRecovery) storyboardRecovery.hidden = true;
      busy = false;
      window.location.assign(result.redirect);
    } catch (error) {
      errorElement.textContent = error instanceof TypeError ? '未收到删除结果，请刷新页面查看。' : error.message;
    } finally {
      busy = false;
      main.inert = false;
      button.disabled = false;
      button.textContent = '删除';
    }
  });
  window.addEventListener('beforeunload', event => {
    if (busy) { event.preventDefault(); event.returnValue = ''; }
  });
})();
