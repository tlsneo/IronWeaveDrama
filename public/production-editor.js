(() => {
  const form = document.getElementById('production-clip-form');
  if (!form) return;
  const pictures = [...form.querySelectorAll('[data-clip-picture]')];
  const container = document.getElementById('clip-subjects');
  const template = document.getElementById('clip-subject-template');
  const review = document.getElementById('clip-mapping-review');
  const reviewed = document.getElementById('clip-mapping-reviewed');
  const error = document.getElementById('clip-editor-error');
  const rows = () => [...container.querySelectorAll('[data-clip-subject]')];
  const selected = () => [...form.querySelectorAll('[data-clip-picture]')].filter(picture => picture.checked);
  function changed() { review.hidden = false; reviewed.checked = false; form.dataset.dirty = 'true'; }
  function refresh() {
    const chosen = selected();
    pictures.forEach(picture => { picture.parentElement.querySelector('[data-picture-number]').textContent = picture.checked ? `<Picture ${chosen.indexOf(picture) + 1}>` : ''; });
    rows().forEach((row, index) => {
      row.querySelector('[data-subject-number]').textContent = `<Subject ${index + 1}>`;
      row.querySelectorAll('[data-subject-picture]').forEach(input => {
        const number = chosen.findIndex(p => p.value === input.value) + 1;
        input.disabled = !number && !input.checked;
        input.parentElement.querySelector('[data-subject-picture-number]').textContent = number ? `<Picture ${number}>` : '（未选作参考图）';
      });
    });
  }
  function subjects() {
    const chosen = selected();
    return rows().map((row, index) => ({ number: index + 1, description: row.querySelector('[data-subject-description]').value.trim(),
      pictures: [...row.querySelectorAll('[data-subject-picture]')].filter(input => input.checked).map(input => chosen.findIndex(p => p.value === input.value) + 1) }));
  }
  form.addEventListener('click', event => {
    const button = event.target.closest('[data-picture-up], [data-picture-down]');
    if (!button) return;
    const figure = button.closest('figure');
    if (button.hasAttribute('data-picture-up') && figure.previousElementSibling) figure.parentElement.insertBefore(figure, figure.previousElementSibling);
    else if (button.hasAttribute('data-picture-down') && figure.nextElementSibling) figure.parentElement.insertBefore(figure.nextElementSibling, figure);
    else return;
    changed(); refresh();
  });
  form.addEventListener('change', event => {
    if (event.target.matches('[data-clip-picture], [data-subject-picture]')) { changed(); refresh(); }
  });
  document.getElementById('add-clip-subject').addEventListener('click', () => {
    if (rows().length >= 100) { error.textContent = '最多100个主体。'; return; }
    container.append(template.content.cloneNode(true)); changed(); refresh();
  });
  container.addEventListener('click', event => {
    const button = event.target.closest('[data-remove-subject]');
    if (!button || !window.confirm('删除此主体映射？请重新核对六段中的 Subject 编号。')) return;
    button.closest('[data-clip-subject]').remove(); changed(); refresh();
  });
  function valid(values) { return values.every(subject => subject.description && subject.pictures.length && subject.pictures.every(number => number > 0)); }
  document.getElementById('sync-clip-subjects').addEventListener('click', () => {
    const values = subjects();
    if (!valid(values)) { error.textContent = '每个主体须填写描述并关联仍被选中的参考图。'; return; }
    if (!window.confirm('用当前主体描述和图片映射替换第一段？其他五段不变，请核对其中引用。')) return;
    form.elements.namedItem('subject_definitions').value = values.length ? values.map(subject => `<Subject ${subject.number}> ${subject.description} (${subject.pictures.map(number => `<Picture ${number}>`).join(', ')})`).join('\n') : 'No external subjects.';
    changed(); error.textContent = '';
  });
  form.addEventListener('submit', event => {
    error.textContent = '';
    const values = subjects();
    if (!valid(values) || (!review.hidden && !reviewed.checked)) {
      event.preventDefault(); event.stopImmediatePropagation();
      error.textContent = !valid(values) ? '主体描述或参考图关联不完整；被取消的图片仍被主体引用，请重新核对。' : '请核对 Picture／Subject 编号及六段引用，并勾选确认。';
      return;
    }
    form.elements.namedItem('pictures').value = JSON.stringify(selected().map(picture => JSON.parse(picture.dataset.picture)));
    form.elements.namedItem('subjects').value = JSON.stringify(values);
  });
  refresh();
})();
