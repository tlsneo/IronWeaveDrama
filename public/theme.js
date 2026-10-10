(() => {
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  let preference;
  try {
    const saved = localStorage.getItem('ironweave-theme');
    if (saved === 'light' || saved === 'dark') preference = saved;
  } catch { /* 存储不可用时，默认跟随系统。 */ }

  function applyTheme() {
    const theme = preference ?? (systemTheme.matches ? 'dark' : 'light');
    document.documentElement.dataset.theme = theme;
    const button = document.getElementById('theme-toggle');
    if (button) button.textContent = theme === 'dark' ? '切换浅色' : '切换深色';
  }

  applyTheme();
  systemTheme.addEventListener('change', applyTheme);

  document.addEventListener('DOMContentLoaded', () => {
    const button = document.getElementById('theme-toggle');
    button.hidden = false;
    applyTheme();
    button.addEventListener('click', () => {
      preference = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem('ironweave-theme', preference);
      } catch { /* 无法保存偏好时，仍允许当前页面切换。 */ }
      applyTheme();
    });
  });
})();
