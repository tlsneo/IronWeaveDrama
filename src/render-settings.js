import { readFile } from 'node:fs/promises';
import { apiTypes, readApiConfig } from './settings.js';
import { escapeHtml, deleteButton } from './html.js';

export async function renderSettings(database, query) {
  const labels = new Map([...apiTypes, ['image_edit', '遮罩编辑配置（已停用）']]);
  const filter = query.get('type') ?? 'all';
  if (query.getAll('type').length > 1 || (filter !== 'all' && !labels.has(filter))) throw Object.assign(new Error('API 类型不存在'), { status: 404 });
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
      if (filter === 'image_edit') throw Object.assign(new Error('遮罩编辑已停用，不能新建配置。'), { status: 400 });
      config = { name: '', type: filter === 'all' ? 'text_to_image' : filter, baseUrl: '', apiKey: '', model: filter === 'llm' ? '' : 'ironweave' };
    }
    if (config.type === 'image_edit') {
      content = `<section class="creation-panel settings-panel"><a href="${escapeHtml(listUrl)}">← 配置列表</a><h3>${escapeHtml(config.name)}</h3><p>遮罩编辑配置已停用。原记录和历史作品保留，不转换为图生图，也不提供测试或修改入口。</p><dl><dt>原模型</dt><dd>${escapeHtml(config.model)}</dd><dt>原地址</dt><dd>${escapeHtml(config.baseUrl)}</dd></dl></section>`;
      return template.replace('<!-- API_SETTINGS -->', () => content);
    }
    content = `<section class="creation-panel settings-panel" aria-labelledby="api-config-title">
      <a class="episode-back" href="${escapeHtml(listUrl)}">← 配置列表</a>
      <div class="settings-panel-heading"><h3 id="api-config-title">${escapeHtml(config.name || '添加 API 配置')}</h3><span>媒体统一 Weave · 文字独立聊天</span></div>
      <form id="api-config-form" action="/settings/api${config.id ? `/${config.id}` : ''}" method="post" data-id="${config.id ?? ''}" data-configured="${Boolean(config.apiKey)}" autocomplete="off">
        <div class="form-field"><label for="api-name">配置名称</label><input id="api-name" name="name" type="text" value="${escapeHtml(config.name)}" maxlength="80" required></div>
        <div class="form-field"><label for="api-type">API 类型</label><select id="api-type" name="type">${[...apiTypes].map(([value, label]) => `<option value="${value}" ${value === config.type ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
        <div class="form-field"><label for="api-base-url">Base URL</label><input id="api-base-url" name="baseUrl" type="url" value="${escapeHtml(config.baseUrl)}" maxlength="2048" required aria-describedby="api-url-help"><p id="api-url-help" class="field-help">图片和视频仅调用 Weave protocol 2，地址须以 /v1 结尾，不自动补齐。文字使用独立聊天接口，不受媒体模型限制。</p></div>
        <div class="form-field"><label for="api-key">API Key</label><input id="api-key" name="apiKey" type="password" maxlength="4096" autocomplete="new-password" ${config.apiKey ? '' : 'required'} aria-describedby="api-key-state"><p id="api-key-state" class="field-help">${config.apiKey ? '这条配置已保存密钥。留空保持原密钥，填写新值则替换。' : '请填写这条配置的密钥。'}</p></div>
        <div class="form-field"><label for="api-model">模型名称（媒体固定 ironweave，文字可编辑）</label><input id="api-model" name="model" type="text" value="${escapeHtml(config.model)}" maxlength="200" ${config.type === 'llm' ? '' : 'readonly'} required><p class="field-help">媒体保存时固定为 ironweave；旧值仅展示，必须主动保存正确配置后才能测试。不会自动迁移地址或密钥。</p></div>
        <div class="form-field"><label for="api-test-size">测试图片尺寸（宽x高，仅用于本页测试）</label><input id="api-test-size" name="testSize" value="${escapeHtml(config.testSize || '1024x1024')}" required pattern="[1-9][0-9]*x[1-9][0-9]*"></div>
        <div class="form-field"><label for="api-video-profiles">视频参数组合 JSON（手工登记，不代表实机已验证）</label><textarea id="api-video-profiles" name="videoProfiles">${escapeHtml(JSON.stringify(config.videoProfiles || []))}</textarea><p>每项仅 size、frames、fps。未登记则不能生成视频，Iron 仍须通过已验证配置校验；不取整时长、不自动改速。</p></div>
        <div class="dialog-actions"><button id="save-api-settings" class="create-button" type="submit">保存配置</button></div>
      </form>
      <div id="api-test-reference" ${['image_to_image', 'video'].includes(config.type) ? '' : 'hidden'}>
        <div class="form-field"><label for="api-test-reference-image">测试参考图（按选择顺序）</label><input id="api-test-reference-image" name="referenceImages" type="file" multiple accept="image/png,image/jpeg,image/webp" aria-describedby="api-reference-help"><p id="api-reference-help" class="field-help">静态 PNG、JPEG 或 WebP，最多 51 张，每张及合计最多 32 MiB，按选择顺序发送 image[]，不补图或删图。当前 Qwen 已验双参考、H3 已验五参考；其他数量是否支持由 Weave 判断，不能视为全部能力。参考图只用于本次测试，不存入角色库。</p></div>
      </div>
      <div id="api-test-video" ${config.type === 'video' ? '' : 'hidden'}>
        <div class="form-field"><label for="api-test-profile">本次视频参数（从已保存组合中选择）</label><select id="api-test-profile"><option value="">请选择参数组合</option>${(config.videoProfiles || []).map((profile, index) => `<option value="${index}">${escapeHtml(profile.size)} · ${escapeHtml(String(profile.frames))} 帧 · ${escapeHtml(String(profile.fps))} fps</option>`).join('')}</select></div>
        <div class="form-field"><label for="api-test-prompt">本次视频完整提示词</label><textarea id="api-test-prompt" maxlength="24000"></textarea><p class="field-help">最多 12000 个 Unicode 字符，原文传递。可明确不选参考图发起无素材测试，但不代表当前 H3 支持无图；五图请求需选择五张实际素材。</p></div>
      </div>
      <p><a href="/operations">查看测试操作、恢复与交付确认</a></p>
      <div class="settings-check"><button id="check-api-connection" class="theme-toggle" type="button" ${config.apiKey ? '' : 'disabled'}>测试模型（可能计费）</button><p class="field-help">先保存配置，再实际调用所填模型。文字独立发送一次聊天请求；图片或视频统一调用 Weave。可能扣费，不自动重试；生成耗时由服务决定。视频结果在操作历史查看和播放。</p></div>
      <p id="settings-error" class="form-error" role="alert"></p>
      <p id="settings-status" class="settings-status" role="status" aria-live="polite"></p>
      <pre id="settings-test-output" class="settings-test-output" hidden></pre>
      <img id="settings-test-image" class="settings-test-image" alt="模型实际测试返回的图片" referrerpolicy="no-referrer" hidden>
      <p class="field-help">配置由所有项目共用，密钥不回传到页面。保存配置不会调用模型；本页测试尺寸不会作为业务生成的默认尺寸。</p>
    </section>`;
  } else {
    const configs = filter === 'all'
      ? database.prepare("SELECT id, name, type, base_url AS baseUrl, model, api_key <> '' AS hasApiKey FROM api_configs ORDER BY id DESC").all()
      : database.prepare("SELECT id, name, type, base_url AS baseUrl, model, api_key <> '' AS hasApiKey FROM api_configs WHERE type = ? ORDER BY id DESC").all(filter);
    content = `<div class="settings-list-toolbar">
      <form class="settings-type-selector form-field" action="/settings" method="get">
        <label for="api-filter">API 类型</label><select id="api-filter" name="type"><option value="all" ${filter === 'all' ? 'selected' : ''}>全部类型</option>${[...labels].map(([value, label]) => `<option value="${value}" ${value === filter ? 'selected' : ''}>${label}</option>`).join('')}</select>
        <noscript><button class="theme-toggle" type="submit">筛选</button></noscript>
      </form>
      ${filter === 'image_edit' ? '<p>遮罩编辑已停用，原记录只读保留。</p>' : `<a class="create-button settings-link" href="/settings?new=1${filter === 'all' ? '' : `&amp;type=${filter}`}">＋ 添加配置</a>`}
    </div>
    <p class="api-config-count">共 ${configs.length} 条配置</p>`;
    content += configs.length ? `<section class="project-grid" aria-label="API 配置列表">${configs.map(config => `<article class="project-card api-config-card">
      <a class="project-link api-config-link" href="/settings?config=${config.id}${filter === 'all' ? '' : `&amp;type=${filter}`}">
        <span class="api-type-badge">${escapeHtml(labels.get(config.type) || '不支持的历史配置')}</span>
        <h3>${escapeHtml(config.name)}</h3>
        <dl class="api-card-meta"><div><dt>模型</dt><dd>${escapeHtml(config.model)}</dd></div><div><dt>接口地址</dt><dd>${escapeHtml(config.baseUrl)}</dd></div></dl>
        <p class="api-card-footer"><span>${config.hasApiKey ? '密钥已配置' : '密钥未配置'}</span><span>查看配置 →</span></p>
      </a>
      <div class="card-actions">${deleteButton(`/settings/api/${config.id}/delete`, config.name, `确定删除 API 配置“${config.name}”？地址、密钥及模型配置将删除，已生成的图片不受影响。`)}</div>
    </article>`).join('')}</section>` : `<section class="studio-empty"><h3>${filter === 'all' ? '还没有 API 配置' : `还没有${labels.get(filter)}`}</h3><p>点击“添加配置”，选择用途并填写接口信息。同一类型可以添加多条配置。</p></section>`;
  }
  return template.replace('<!-- API_SETTINGS -->', () => content);
}
