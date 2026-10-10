export function deleteButton(url, name, message) {
  return `<button class="theme-toggle delete-button" type="button" data-delete-url="${escapeHtml(url)}" data-delete-name="${escapeHtml(name)}" data-delete-message="${escapeHtml(message)}" aria-label="删除${escapeHtml(name)}">删除</button>`;
}

export function escapeHtml(value) {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}
