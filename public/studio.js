const dialog = document.getElementById('name-dialog');
const form = document.getElementById('name-form');
const nameInput = document.getElementById('creation-name');
const seasonInput = document.getElementById('creation-season-id');
const formError = document.getElementById('name-error');
const pageError = document.getElementById('studio-error');
const saveButton = form.querySelector('[type="submit"]');
let moving = false;

async function save(url, body) {
  const response = await fetch(url, { method: 'POST', body });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? '保存失败，请重试。');
  window.location.assign(result.redirect);
}

function showError(element, error) {
  element.textContent = error instanceof TypeError ? '网络连接失败，请检查连接后重试。' : error.message;
}

document.addEventListener('click', async (event) => {
  const edit = event.target.closest('[data-name-dialog]');
  if (edit) {
    document.getElementById('name-dialog-title').textContent = edit.dataset.title;
    nameInput.value = edit.dataset.name;
    seasonInput.value = edit.dataset.seasonId;
    form.dataset.url = edit.dataset.url;
    formError.textContent = '';
    dialog.showModal();
    nameInput.select();
    return;
  }
  const move = event.target.closest('[data-move-url]');
  if (!move || move.disabled || moving) return;
  moving = true;
  move.disabled = true;
  pageError.textContent = '';
  try {
    await save(move.dataset.moveUrl, new URLSearchParams({ direction: move.dataset.direction }));
  } catch (error) {
    showError(pageError, error);
  } finally {
    moving = false;
    move.disabled = false;
  }
});

document.getElementById('cancel-name').addEventListener('click', () => {
  if (!saveButton.disabled) dialog.close();
});
dialog.addEventListener('cancel', (event) => {
  if (saveButton.disabled) event.preventDefault();
});
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (saveButton.disabled) return;
  saveButton.disabled = true;
  saveButton.textContent = '保存中…';
  formError.textContent = '';
  try {
    await save(form.dataset.url, new URLSearchParams(new FormData(form)));
  } catch (error) {
    showError(formError, error);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = '保存';
  }
});
