import { readFile } from 'node:fs/promises';
import { apiTypes, readApiConfig } from './settings.js';
import { escapeHtml } from './html.js';

export async function renderSettings(database, query) {
  const filter = query.get('type') ?? 'all';
  if (query.getAll('type').length > 1 || (filter !== 'all' && !apiTypes.has(filter))) throw Object.assign(new Error('API 类型不存在'), { status: 404 });
  const listUrl = filter === 'all' ? '/settings' : `/settings?type=${filter}`;
  const template = await readFile(new URL('../views/settings.html', import.meta.url), 'utf8');
  let content;
  if (query.has('config') || query.has('new')) {
    let config;
    if (query.has('config')) {
      const raw = query.get('config');
      const id = Number(raw);
      if (query.has('new') || query.getAll('config').length !== 1 || !/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(id)) throw Object.assign(new Error('API 配置不存在'), { status: 404 });
      config = readApiConfig(database, id);
    } else {
      if (query.getAll('new').length !== 1 || query.get('new') !== '1') throw Object.assign(new Error('配置页面不存在'), { status: 404 });
      config = { name: '', type: filter === 'all' ? 'text_to_image' : filter, baseUrl: '', apiKey: '', model: '' };
    }
    content = `<section class="creation-panel settings-panel" aria-labelledby="api-config-title">
      <a class="episode-back" href="${escapeHtml(listUrl)}">← 配置列表</a>
      <div class="settings-panel-heading"><h3 id="api-config-title">${escapeHtml(config.name || '添加 API 配置')}</h3><span>OpenAI 兼容</span></div>
      <form id="api-config-form" action="/settings/api${config.id ? `/${config.id}` : ''}" method="post" data-id="${config.id ?? ''}" data-configured="${Boolean(config.apiKey)}" autocomplete="off">
        <div class="form-field"><label for="api-name">配置名称</label><input id="api-name" name="name" type="text" value="${escapeHtml(config.name)}" maxlength="80" required></div>
        <div class="form-field"><label for="api-type">API 类型</label><select id="api-type" name="type">${[...apiTypes].map(([value, label]) => `<option value="${value}" ${value === config.type ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
        <div class="form-field"><label for="api-base-url">Base URL</label><input id="api-base-url" name="baseUrl" type="url" value="${escapeHtml(config.baseUrl)}" maxlength="2048" required aria-describedby="api-url-help"><p id="api-url-help" class="field-help">填写包含版本前缀的基础地址，程序不会自动补 /v1。模型测试会按类型请求聊天、生图或图片编辑接口。</p></div>
        <div class="form-field"><label for="api-key">API Key</label><input id="api-key" name="apiKey" type="password" maxlength="4096" autocomplete="new-password" ${config.apiKey ? '' : 'required'} aria-describedby="api-key-state"><p id="api-key-state" class="field-help">${config.apiKey ? '这条配置已保存密钥。留空保持原密钥，填写新值则替换。' : '请填写这条配置的密钥。'}</p></div>
        <div class="form-field"><label for="api-model">模型名称</label><input id="api-model" name="model" type="text" value="${escapeHtml(config.model)}" maxlength="200" required></div>
        <div class="dialog-actions"><button id="save-api-settings" class="create-button" type="submit">保存配置</button></div>
      </form>
      <div id="api-test-reference" ${['image_to_image', 'image_edit'].includes(config.type) ? '' : 'hidden'}>
        <div class="form-field"><label for="api-test-reference-image">测试参考图</label><input id="api-test-reference-image" type="file" accept="image/png,image/jpeg,image/webp" aria-describedby="api-reference-help"><p id="api-reference-help" class="field-help">PNG、JPEG 或 WebP，最多 5 MiB。图生图和编辑测试使用 OpenAI 兼容 /images/edits multipart 协议；参考图只用于本次测试，不存入角色库。</p></div>
      </div>
      <div class="settings-check"><button id="check-api-connection" class="theme-toggle" type="button" ${config.apiKey ? '' : 'disabled'}>测试模型（可能计费）</button><p class="field-help">先保存配置，再实际调用所填模型。文本发送一次短请求；图片请求生成或编辑一张。可能扣费，不自动重试；图片生成可能需要几分钟。</p></div>
      <p id="settings-error" class="form-error" role="alert"></p>
      <p id="settings-status" class="settings-status" role="status" aria-live="polite"></p>
      <pre id="settings-test-output" class="settings-test-output" hidden></pre>
      <img id="settings-test-image" class="settings-test-image" alt="模型实际测试返回的图片" referrerpolicy="no-referrer" hidden>
      <p class="field-help">配置由所有项目共用，密钥不回传到页面。保存配置不会调用模型；角色板生成流程尚未接入。</p>
    </section>`;
  } else {
    const configs = filter === 'all'
      ? database.prepare("SELECT id, name, type, base_url AS baseUrl, model, api_key <> '' AS hasApiKey FROM api_configs ORDER BY id DESC").all()
      : database.prepare("SELECT id, name, type, base_url AS baseUrl, model, api_key <> '' AS hasApiKey FROM api_configs WHERE type = ? ORDER BY id DESC").all(filter);
    content = `<div class="settings-list-toolbar">
      <form class="settings-type-selector form-field" action="/settings" method="get">
        <label for="api-filter">API 类型</label><select id="api-filter" name="type"><option value="all" ${filter === 'all' ? 'selected' : ''}>全部类型</option>${[...apiTypes].map(([value, label]) => `<option value="${value}" ${value === filter ? 'selected' : ''}>${label}</option>`).join('')}</select>
        <noscript><button class="theme-toggle" type="submit">筛选</button></noscript>
      </form>
      <a class="create-button settings-link" href="/settings?new=1${filter === 'all' ? '' : `&amp;type=${filter}`}">＋ 添加配置</a>
    </div>
    <p class="api-config-count">共 ${configs.length} 条配置</p>`;
    content += configs.length ? `<section class="project-grid" aria-label="API 配置列表">${configs.map(config => `<article class="project-card api-config-card">
      <a class="project-link api-config-link" href="/settings?config=${config.id}${filter === 'all' ? '' : `&amp;type=${filter}`}">
        <span class="api-type-badge">${apiTypes.get(config.type)}</span>
        <h3>${escapeHtml(config.name)}</h3>
        <dl class="api-card-meta"><div><dt>模型</dt><dd>${escapeHtml(config.model)}</dd></div><div><dt>接口地址</dt><dd>${escapeHtml(config.baseUrl)}</dd></div></dl>
        <p class="api-card-footer"><span>${config.hasApiKey ? '密钥已配置' : '密钥未配置'}</span><span>查看配置 →</span></p>
      </a>
    </article>`).join('')}</section>` : `<section class="studio-empty"><h3>${filter === 'all' ? '还没有 API 配置' : `还没有${apiTypes.get(filter)}`}</h3><p>点击“添加配置”，选择用途并填写接口信息。同一类型可以添加多条配置。</p></section>`;
  }
  return template.replace('<!-- API_SETTINGS -->', () => content);
}
