const dialog = document.getElementById('create-project-dialog');
const form = document.getElementById('create-project-form');
const submitButton = form.querySelector('[type="submit"]');
const errorMessage = document.getElementById('create-project-error');

document.getElementById('create-project').addEventListener('click', () => {
  errorMessage.textContent = '';
  dialog.showModal();
});
document.getElementById('cancel-create-project').addEventListener('click', () => dialog.close());

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submitButton.disabled) return;
  submitButton.disabled = true;
  submitButton.textContent = '创建中…';
  errorMessage.textContent = '';

  try {
    const response = await fetch('/projects', {
      method: 'POST',
      body: new URLSearchParams(new FormData(form)),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? '创建失败，请重试。');
    window.location.reload();
  } catch (error) {
    errorMessage.textContent = error instanceof TypeError ? '网络连接失败，请检查连接后重试。' : error.message;
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = '创建短剧';
  }
});
