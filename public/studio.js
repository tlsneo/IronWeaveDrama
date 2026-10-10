const dialog = document.getElementById('name-dialog');
const form = document.getElementById('name-form');
const nameInput = document.getElementById('creation-name');
const seasonInput = document.getElementById('creation-season-id');
const formError = document.getElementById('name-error');
const pageError = document.getElementById('studio-error');
const saveButton = form.querySelector('[type="submit"]');
const characterForm = document.getElementById('character-form');
let moving = false;

async function save(url, body) {
  const response = await fetch(url, { method: 'POST', body });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? '保存失败，请重试。');
  if (characterForm) characterForm.dataset.dirty = '';
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
function bindSave(targetForm, button, errorElement, label) {
  targetForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (button.disabled) return;
    button.disabled = true;
    targetForm.inert = true;
    button.textContent = '保存中…';
    errorElement.textContent = '';
    try {
      await save(targetForm.dataset.url, new URLSearchParams(new FormData(targetForm)));
    } catch (error) {
      showError(errorElement, error);
    } finally {
      button.disabled = false;
      targetForm.inert = false;
      button.textContent = label;
    }
  });
}

bindSave(form, saveButton, formError, '保存');
if (characterForm) {
  bindSave(characterForm, characterForm.querySelector('[type="submit"]'), document.getElementById('character-error'), '保存资料');
  characterForm.addEventListener('input', () => { characterForm.dataset.dirty = 'true'; });
  window.addEventListener('beforeunload', event => {
    if (characterForm.dataset.dirty) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
}
