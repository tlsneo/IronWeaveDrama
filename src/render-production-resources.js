import { escapeHtml, deleteButton } from './html.js';
import { findProductionAsset, readAssetImage } from './production-assets.js';
import { findLook, lookInputs, readLookImage } from './looks.js';
import { renderImageDialog } from './render-image-dialog.js';

const html = value => escapeHtml(String(value ?? ''));
const labels = { props: '道具', costumes: '服饰', looks: '定妆' };

function detailId(query, key, label) {
  const raw = query.get(key);
  if (query.getAll(key).length !== 1 || !/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw Object.assign(new Error(`${label}不存在`), { status: 404 });
  }
  return Number(raw);
}
function deleteResource(url, item, kind) {
  const consequence = kind === 'looks'
    ? '定妆资料和旧图片将删除，无法恢复；新生成媒体保留在项目历史供播放/交付核对，旧来源不可再采用；已关联分镜的定妆选择会失效，需重新选择或取消；不会删除基础演员、服饰或道具。'
    : '素材资料和参考图片将删除，无法恢复；已有定妆将解除这项素材关联，旧生成图保留为旧依据待核对。';
  return deleteButton(`${url}/${item.id}/delete`, item.name, `确定删除${labels[kind]}“${item.name}”（#${item.id}）？${consequence}`);
}
function feedback() {
  return `<p id="production-error" class="form-error" role="alert"></p>
    <p id="production-status" class="field-help" role="status" aria-live="polite"></p>
    <section id="production-recovery" class="production-recovery" hidden aria-label="未完成的生成图片">
      <p id="production-recovery-message">生成未成功完成。已持久化的无效／旧依据图片仅供核对，不代表生成成功；刷新后也可从图片历史找回。</p>
      <a id="production-recovery-link" target="_blank" rel="noopener">查看保留的图片</a>
    </section>`;
}
function toolbar(base, url, item, kind) {
  return `<div class="character-edit-toolbar"><a class="episode-back" href="${base}">← ${labels[kind]}库</a>
    <div class="item-actions"><button class="create-button" type="submit">保存资料</button>${deleteResource(url, item, kind)}</div></div>`;
}
function nameField(item) {
  return `<div class="form-field field-wide"><label for="production-name">名称</label><input id="production-name" name="name" value="${html(item.name)}" maxlength="80" required></div>`;
}
function preview(url, image, name, empty, id = '') {
  return image
    ? `<a href="${html(url)}" target="_blank" rel="noopener"><img${id ? ` id="${id}"` : ''} class="character-board-image production-preview-image" src="${html(url)}" alt="${html(name)}"></a><p class="field-help">${html(image.width)} × ${html(image.height)}</p>`
    : `<div class="character-board-empty"><p>${empty}</p></div>`;
}

function renderList(db, projectId, kind, query) {
  const label = labels[kind], base = `/projects/${projectId}?resource=${kind}`, url = `/projects/${projectId}/${kind}`;
  const q = (query.get('q') ?? '').trim(), rawPage = query.get('page') ?? '1';
  if (q.length > 80 || query.getAll('q').length > 1 || query.getAll('page').length > 1 || !/^[1-9]\d*$/.test(rawPage) || !Number.isSafeInteger(Number(rawPage))) {
    throw Object.assign(new Error('搜索名称最多 80 字，页码必须为正整数。'), { status: 400 });
  }
  const isLook = kind === 'looks';
  const where = `WHERE project_id = ? ${isLook ? '' : 'AND kind = ?'} AND instr(lower(name), lower(?)) > 0`;
  const table = isLook ? 'looks' : 'production_assets';
  const params = isLook ? [projectId, q] : [projectId, kind, q];
  const total = db.prepare(`SELECT count(*) AS count FROM ${table} ${where}`).get(...params).count;
  const pages = Math.max(1, Math.ceil(total / 50)), page = Math.min(Number(rawPage), pages);
  const imageColumn = isLook
    ? '(SELECT id FROM look_images WHERE look_id = looks.id AND valid = 1 AND cleared = 0 ORDER BY id DESC LIMIT 1)'
    : '(SELECT id FROM production_asset_images WHERE asset_id = production_assets.id AND cleared = 0 ORDER BY id DESC LIMIT 1)';
  const items = db.prepare(`SELECT id, name, ${imageColumn} AS image_id FROM ${table} ${where} ORDER BY id DESC LIMIT 50 OFFSET ?`).all(...params, (page - 1) * 50);
  const actions = `<button class="create-button" type="button" data-name-dialog data-url="${url}" data-title="创建${label}" data-name="" data-season-id="">＋ 创建${label}</button>`;
  const search = `<div class="character-list-toolbar"><form class="character-search" action="/projects/${projectId}" method="get">
    <input type="hidden" name="resource" value="${kind}"><label class="visually-hidden" for="production-search">搜索${label}名称</label>
    <input id="production-search" name="q" type="search" value="${html(q)}" maxlength="80" placeholder="搜索${label}名称"><button class="theme-toggle" type="submit">搜索</button>
    ${q ? `<a class="clear-search" href="${base}">清除</a>` : ''}</form><span class="character-total">共 ${total} 项${label}</span></div>`;
  const list = items.length ? `<div class="project-grid character-grid">${items.map(item => `<article class="project-card character-card">
    <a class="project-link" href="${base}&amp;${isLook ? 'look' : 'asset'}=${item.id}"><div class="project-cover character-cover" aria-hidden="true">${item.image_id ? `<img src="${url}/${item.id}/images/${item.image_id}" alt="" loading="lazy">` : `<span>${html([...item.name][0])}</span>`}</div>
    <div class="project-details"><h3>${html(item.name)}</h3><p class="character-card-info">#${item.id}</p><span class="character-status">${item.image_id ? isLook ? '有生成图 · 进入核对依据' : '已上传参考图' : isLook ? '尚无当前生成图' : '尚无参考图'}</span></div></a>
    <div class="card-actions">${deleteResource(url, item, kind)}</div></article>`).join('')}</div>`
    : `<section class="studio-empty"><h3>${q ? `没有匹配的${label}` : `尚无${label}`}</h3><p>${q ? '更换名称搜索，或清除筛选。' : `点击创建${label}，先保存名称，再完善资料。`}</p></section>`;
  const pageLink = number => html(`/projects/${projectId}?${new URLSearchParams({ resource: kind, q, page: String(number) })}`);
  const pagination = pages > 1 ? `<nav class="character-pagination" aria-label="${label}分页">${page > 1 ? `<a href="${pageLink(page - 1)}">← 上一页</a>` : '<span>← 上一页</span>'}<span>第 ${page} / ${pages} 页 · 每页 50 条</span>${page < pages ? `<a href="${pageLink(page + 1)}">下一页 →</a>` : '<span>下一页 →</span>'}</nav>` : '';
  return { title: label, description: isLook ? '独立定妆库 · 手动选择演员与素材，保存后显式生成；不绑定本集或分镜。' : `${label}库 · 仅管理名称、说明和参考图，不自动生成素材。`, actions, content: `<section data-production-resources>${search}${list}${pagination}</section>` };
}

export function renderProductionAssets(db, projectId, kind, query) {
  if (kind !== 'props' && kind !== 'costumes') throw Object.assign(new Error('素材类型无效'), { status: 400 });
  if (!query.has('asset')) return renderList(db, projectId, kind, query);
  const id = detailId(query, 'asset', labels[kind]), asset = findProductionAsset(db, projectId, kind, id);
  const reference = readAssetImage(db, id), url = `/projects/${projectId}/${kind}`, detail = `${url}/${id}`;
  const content = `<section data-production-resources>
    <div class="character-editor">
      <form id="production-form" data-kind="asset" data-url="${detail}" data-reference-id="${reference?.id ?? 0}" aria-label="${labels[kind]}资料">
        ${toolbar(`/projects/${projectId}?resource=${kind}`, url, asset, kind)}<input type="hidden" name="revision" value="${html(asset.revision)}">
        <fieldset class="character-fieldset"><legend>${labels[kind]}资料</legend><div class="character-fields">${nameField(asset)}
          <div class="form-field field-wide"><label for="production-description">说明</label><textarea id="production-description" name="description" maxlength="1000" rows="6">${html(asset.description)}</textarea></div></div></fieldset>
      </form>
      <aside class="character-preview" aria-label="素材参考图"><div class="character-preview-heading"><h3>参考图</h3></div>
        ${preview(reference ? `${detail}/images/${reference.id}` : '', reference, `${asset.name}的参考图`, '尚未上传参考图')}
        <div class="form-field"><label for="production-reference-file">选择 PNG、JPEG 或 WebP（≤ 5 MiB）</label><input id="production-reference-file" type="file" accept="image/png,image/jpeg,image/webp"></div>
        <div class="character-image-actions"><button id="production-upload" class="theme-toggle" type="button">${reference ? '上传并替换参考图' : '上传参考图'}</button><button id="production-clear-reference" class="theme-toggle" type="button" ${reference ? '' : 'disabled'}>移除参考图</button></div>
        <p class="field-help">资料有修改时请先保存，再上传／移除图片。选择文件不会自动上传；这些操作不会调用模型。</p>
      </aside>
    </div>${feedback()}</section>`;
  return { title: asset.name, description: `${labels[kind]}库 · #${id} · 删除或更换参考图后，旧定妆生成图保留待核对。`, actions: '', content };
}

export function renderLooks(db, projectId, query) {
  if (!query.has('look')) return renderList(db, projectId, 'looks', query);
  const id = detailId(query, 'look', '定妆'), look = findLook(db, projectId, id);
  const inputs = lookInputs(db, projectId, look), current = readLookImage(db, id);
  const url = `/projects/${projectId}/looks`, detail = `${url}/${id}`;
  const characters = db.prepare('SELECT id, name FROM characters WHERE project_id = ? ORDER BY name, id').all(projectId);
  const assets = db.prepare('SELECT id, kind, name, description, (SELECT id FROM production_asset_images WHERE asset_id = production_assets.id AND cleared = 0 ORDER BY id DESC LIMIT 1) AS image_id FROM production_assets WHERE project_id = ? ORDER BY kind, name, id').all(projectId);
  const selected = new Set(inputs.assets.map(asset => asset.id));
  const configs = db.prepare("SELECT id, name, model, base_url AS baseUrl FROM api_configs WHERE type = 'image_to_image' ORDER BY id").all();
  const editConfigs = db.prepare("SELECT id, name, model FROM api_configs WHERE type = 'image_edit' ORDER BY id").all();
  const history = db.prepare('SELECT id, width, height, valid, cleared, revision, model, created_at FROM look_images WHERE look_id = ? ORDER BY id DESC LIMIT 20').all(id);
  const stale = current && current.revision !== inputs.revision;
  const references = [{ label: '基础演员', name: inputs.character?.name ?? '未选择', image: inputs.character?.image },
    ...inputs.assets.map(asset => ({ label: labels[asset.kind], name: asset.name, image: asset.image,
      url: asset.image ? `/projects/${projectId}/${asset.kind}/${asset.id}/images/${asset.image.id}` : '' }))];
  const content = `<section data-production-resources>
    <div class="character-editor">
      <form id="production-form" data-kind="look" data-url="${detail}" aria-label="定妆资料">
        ${toolbar(`/projects/${projectId}?resource=looks`, url, look, 'looks')}<input type="hidden" name="revision" value="${html(look.revision)}">
        <fieldset class="character-fieldset"><legend>手动选择与提示词</legend><div class="character-fields">${nameField(look)}
          <div class="form-field field-wide"><label for="production-character">基础演员</label><select id="production-character" name="characterId"><option value="">暂不选择（可保存草稿）</option>${characters.map(character => `<option value="${character.id}" ${character.id === look.character_id ? 'selected' : ''}>${html(character.name)} · #${character.id}</option>`).join('')}</select></div>
          <div class="form-field field-wide"><label for="production-prompt">提示词（自行填写，不自动改写）</label><textarea id="production-prompt" name="prompt" maxlength="12000" rows="8">${html(look.prompt)}</textarea></div></div>
          <p class="field-help">保留基础演员身份与四视图格式，固定横向16:9；用自写提示词指定服饰、道具及其佩戴／持有方式。不自动搭配、不改动基础演员。保存只存资料和选择，不调用模型。</p>
        </fieldset>
        ${['costumes', 'props'].map(kind => `<fieldset class="character-fieldset production-choices"><legend>${labels[kind]}（可多选，合计最多 50 件）</legend>${assets.filter(asset => asset.kind === kind).map(asset => `<div class="production-choice"><label><input type="checkbox" name="assetId" value="${asset.id}" ${selected.has(asset.id) ? 'checked' : ''}><span>${html(asset.name)} · #${asset.id}<small>${html(asset.description)}</small></span></label>${asset.image_id ? `<a href="/projects/${projectId}/${kind}/${asset.id}/images/${asset.image_id}" target="_blank" rel="noopener">查看参考图</a>` : '<span class="field-help">缺少参考图</span>'}</div>`).join('') || `<p class="field-help">本项目尚无${labels[kind]}。先到<a href="/projects/${projectId}?resource=${kind}">${labels[kind]}库</a>创建。</p>`}</fieldset>`).join('')}
      </form>
      <aside class="character-preview" aria-label="定妆预览与生成"><div class="character-preview-heading"><h3>当前定妆图</h3><span>${html(inputs.aspectRatio)}</span></div>
        ${preview(current ? `${detail}/images/${current.id}` : '', current, `${look.name}的定妆生成图`, '尚无当前有效的定妆图', 'look-board-image')}
        <div class="character-image-actions"><button id="edit-look-image" class="theme-toggle" type="button" ${current ? '' : 'disabled'}>AI修图</button></div>
        <p class="field-help">沿用基础演员的遮罩工具；可绘制和导出选区，真实遮罩修图接口尚未接入，不调用模型。</p>
        <p id="look-image-note" class="${stale ? 'form-error' : 'field-help'}">${stale ? '当前图使用旧依据，待核对；不会自动重新生成。' : current ? '生成结果仍需人工核对。' : ''}</p>
        <p class="field-help">项目风格：${html(inputs.style)}</p>
        <h4>实际参考图顺序（保存后更新）</h4>
        <ol id="look-reference-order" class="production-reference-order">${references.map((reference, index) => `<li><strong>参考图 ${index + 1} · ${reference.label} · ${html(reference.name)}</strong>${reference.image ? `<a href="${html(reference.url ?? reference.image.url)}" target="_blank" rel="noopener"><img src="${html(reference.url ?? reference.image.url)}" alt="参考图 ${index + 1}：${html(reference.name)}" loading="lazy"></a>` : '<span class="field-help">尚无参考图</span>'}</li>`).join('')}</ol>
        <form id="look-generation-form" class="character-generation" data-url="${detail}/generate" data-revision="${html(look.revision)}" data-input-revision="${html(inputs.revision)}" data-missing="${inputs.missing.length > 0}" data-image-id="${current?.id ?? 0}">
          <div class="form-field"><label for="look-api">图生图 API</label><select id="look-api" name="apiConfigId" required>${configs.length !== 1 ? '<option value="">选择图生图配置</option>' : ''}${configs.map(config => `<option value="${config.id}" data-model="${html(config.model)}" data-base-url="${html(config.baseUrl)}">${html(config.name)} · ${html(config.model)}</option>`).join('')}</select></div>
          ${inputs.missing.length ? `<div id="look-missing" class="form-error" role="alert"><p>生成前请补齐以下条件并保存：</p><ul>${inputs.missing.map(reason => `<li>${html(reason)}</li>`).join('')}</ul></div>` : ''}
          ${configs.length ? '' : '<p class="field-help">尚无图生图配置，请到<a href="/settings?type=image_to_image">设置</a>添加。</p>'}
          <div class="character-image-actions"><button id="look-generate" class="create-button" type="submit" ${inputs.missing.length || !configs.length ? 'disabled' : ''}>生成定妆图</button><button id="look-clear-image" class="theme-toggle" type="button" ${current ? '' : 'disabled'}>清除当前图</button></div>
          <p class="field-help">先保存选项，再点击生成；生成会调用所选图生图模型，可能计费，不另弹费用确认。不先自动保存，不自动重试；失败保留输入及可核对的历史图片。</p>
        </form>
      </aside>
    </div>${feedback()}
    <section class="production-history" aria-labelledby="look-history-title"><h3 id="look-history-title">最近图片历史（最多 20 张）</h3>
      <p class="field-help">无效／已清除图片仍可查看，不作为当前图；清除不删除历史。</p>
      ${history.length ? `<ul>${history.map(image => `<li><a href="${detail}/images/${image.id}" target="_blank" rel="noopener">查看图片 #${image.id}</a><span>${!image.valid ? '无效' : '有效'}${image.cleared ? ' · 已清除' : ''}${image.revision !== inputs.revision ? ' · 旧依据待核对' : ''} · ${html(image.width)} × ${html(image.height)} · ${html(image.model)} · ${html(image.created_at)}</span></li>`).join('')}</ul>` : '<p class="field-help">尚无生成图片。</p>'}
    </section>${renderImageDialog(editConfigs, 'look')}</section>`;
  return { title: look.name, description: `独立定妆库 · #${id} · 一个基础演员，可选多件服饰与道具；可在分镜出镜角色旁手动关联。`, actions: '', content };
}
