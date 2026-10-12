import { escapeHtml } from './html.js';
import { occurrenceModes, isVisualOccurrence, readEpisodeResources, resourceChoices } from './episode-resources.js';

function modes(selected) {
  return Object.entries(occurrenceModes).map(([key, label]) => `<option value="${key}" ${selected === key ? 'selected' : ''}>${label}</option>`).join('');
}
function selectionFields(kind, item, choices, selected, ignored = false) {
  const name = item.name ?? item.source_name;
  return `<div class="form-field"><label>关联${kind === 'character' ? '角色' : '场景'}<select data-resource-choice required>
    <option value="" ${!selected && !ignored ? 'selected' : ''}>请选择，不自动新建</option>
    ${choices.map(resource => `<option value="${resource.id}" data-name="${escapeHtml(resource.name)}" ${selected === resource.id && !ignored ? 'selected' : ''}>${escapeHtml(resource.name)} · #${resource.id}</option>`).join('')}
    <option value="new">确认新建资源</option><option value="ignore" ${ignored ? 'selected' : ''}>不关联／移除关联（不删除资源）</option>
  </select></label></div>
  <div data-new-resource hidden><div class="form-field"><label>新资源名称<input data-resource-name maxlength="80" value="${escapeHtml(name)}" disabled></label></div>
    <div class="form-field"><label>${kind === 'character' ? '剧本明确的身份／外貌（未知留空，年龄不自动填写）' : '固定环境描述（本场时间、光照放在使用说明）'}<textarea data-resource-description maxlength="1000" rows="3" disabled>${escapeHtml(item.description ?? '')}</textarea></label></div></div>
  <div class="occurrence-fields"><div class="form-field"><label>画面类型<select data-resource-mode>${modes(item.mode)}</select></label></div>
    <div class="form-field"><label>本次使用说明<textarea data-resource-details maxlength="1000" rows="2">${escapeHtml(item.details)}</textarea></label></div></div>`;
}
function resourceGroups(items, choices) {
  const groups = new Map();
  for (const item of items) {
    const resource = choices[item.kind].find(row => row.id === (item.suggestedId ?? item.character_id ?? item.scene_id));
    const name = resource?.name ?? item.name ?? item.source_name;
    const key = JSON.stringify([item.kind, resource ? resource.id : name]);
    if (!groups.has(key)) groups.set(key, { kind: item.kind, name, items: [] });
    groups.get(key).items.push(item);
  }
  return [...groups.values()];
}
export function renderEpisodeResources(database, projectId, episodeId, draft, configs) {
  const batch = readEpisodeResources(database, episodeId);
  const choices = { character: resourceChoices(database, projectId, 'character'), scene: resourceChoices(database, projectId, 'scene') };
  const base = `/projects/${projectId}/episodes/${episodeId}`;
  function removeButton(type, items, name, whole = false) {
    const targets = type === 'candidates' ? items.map(item => item.index) : items.map(item => ({ id: item.id, revision: item.revision }));
    const label = `删除${whole ? '本集整项' : '这一处'}：${name}`;
    return `<button type="button" class="resource-remove" data-resource-remove data-url="${base}/remove-resources" data-batch-revision="${batch.revision}" data-script-revision="${draft.revision}" data-targets="${escapeHtml(JSON.stringify({ type, items: targets }))}" data-name="${escapeHtml(name)}" data-whole="${whole}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"><svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7m4-7v7"/></svg></button>`;
  }
  const candidateGroups = resourceGroups(batch.candidates.map((item, index) => ({ ...item, index })), choices);
  const candidates = batch.candidates.length ? `<form id="episode-resource-candidates" data-url="${base}/confirm-resources" data-batch-revision="${batch.revision}" data-script-revision="${batch.scriptRevision}">
    <h4>待确认的提取草稿 · ${candidateGroups.length} 项资源 · ${batch.candidates.length} 处画面出场</h4>
    ${batch.scriptRevision !== draft.revision ? '<p class="form-error">剧本已变化，这份草稿不能直接确认。请重新提取。</p>' : ''}
    <p class="field-help">每项资源只列一次，下面保留各场的画面出场位置；每处关联仍可单独修正。已有档案只关联不修改，同名不同档案不合并。同类同名的新建项共用一个资源，请统一描述；不同资源请使用可区分的名称。</p>
    ${candidateGroups.map(group => `<fieldset class="resource-candidate resource-group"><legend>${group.kind === 'character' ? '角色' : '场景'} · ${escapeHtml(group.name)} · ${group.items.length} 处 ${removeButton('candidates', group.items, group.name, true)}</legend>
      ${group.items.map(candidate => `<div class="resource-position" data-resource-candidate data-candidate-index="${candidate.index}" data-kind="${candidate.kind}">
        <p class="field-help resource-position-heading">${escapeHtml(candidate.sceneHeading || '未标场标题')} · ${occurrenceModes[candidate.mode]} · ${batch.scriptRevision === draft.revision ? `正文第 ${draft.script.slice(0, candidate.sourceStart).split('\n').length} 行起` : '旧版位置，待核对'} ${removeButton('candidates', [candidate], candidate.name)}</p><blockquote class="occurrence-quote">${escapeHtml(candidate.quote)}</blockquote>
        ${candidate.needsReview ? '<p class="form-error">原文位置无法唯一对应旧记录，请核对本条与下方旧记录后明确选择；不会自动恢复已移除的关联。</p>' : ''}
        ${selectionFields(candidate.kind, candidate, choices[candidate.kind], candidate.suggestedId, candidate.ignored)}
      </div>`).join('')}
    </fieldset>`).join('')}
    <p class="form-error" data-resource-error role="alert"></p>
    <button class="create-button" type="submit" ${batch.scriptRevision !== draft.revision ? 'disabled' : ''}>确认保存本集关联</button>
  </form>` : '';
  const visible = batch.occurrences.filter(isVisualOccurrence);
  const current = visible.filter(row => !row.ignored && !row.needs_review && row.script_revision === draft.revision && choices[row.kind].some(item => item.id === (row.character_id ?? row.scene_id)));
  const review = visible.filter(row => !row.ignored && !current.includes(row));
  function record(row) {
    const resourceId = row.character_id ?? row.scene_id;
    const resource = choices[row.kind].find(item => item.id === resourceId);
    const stale = row.script_revision !== draft.revision;
    const status = row.ignored ? '已移除关联' : !resource ? '资源已删除，需重新关联' : row.needs_review ? '本次提取未发现，待核对' : stale ? '剧本已变化，待核对' : '已确认';
    const url = resource ? `/projects/${projectId}?resource=${row.kind === 'character' ? `characters&character=${resource.id}` : `scenes&scene=${resource.id}`}` : '';
    return `<details class="resource-occurrence" id="occurrence-${row.id}"><summary><span>${escapeHtml(row.scene_heading || '未标场标题')} · ${occurrenceModes[row.mode]}</span><span class="character-status">${status}</span>${!row.ignored ? removeButton('occurrences', [row], resource?.name ?? row.source_name) : ''}</summary>
      <div class="occurrence-body"><p class="field-help">提取依据版本 ${row.script_revision}${resource ? ` · <a href="${url}">查看共享资源及全剧出现位置 →</a>` : ''}</p>
        <blockquote class="occurrence-quote">${escapeHtml(row.quote)}</blockquote>
        <form data-occurrence-form data-url="${base}/resource-occurrences/${row.id}" data-revision="${row.revision}" data-script-revision="${draft.revision}">
          ${selectionFields(row.kind, row, choices[row.kind], resourceId, !!row.ignored)}
          <div class="form-field"><label>剧本场标题<input data-scene-heading maxlength="300" value="${escapeHtml(row.scene_heading)}"></label></div>
          <div class="form-field"><label>定位原文（必须是当前剧本中唯一的连续片段）<textarea data-source-quote maxlength="1000" rows="3">${escapeHtml(row.quote)}</textarea></label></div>
          <p class="form-error" data-resource-error role="alert"></p><button class="theme-toggle" type="submit">保存这条出场记录</button>
        </form>
      </div></details>`;
  }
  function records(rows) {
    return resourceGroups(rows, choices).map(group => `<fieldset class="resource-candidate resource-group"><legend>${group.kind === 'character' ? '角色' : '场景'} · ${escapeHtml(group.name)} · ${group.items.length} 处 ${group.items.some(row => !row.ignored) ? removeButton('occurrences', group.items.filter(row => !row.ignored), group.name, true) : ''}</legend>${group.items.map(record).join('')}</fieldset>`).join('');
  }
  return `<section id="episode-resources" class="creation-panel episode-resources-panel" aria-labelledby="episode-resources-title">
    <div class="episode-resource-heading"><h3 id="episode-resources-title">本集人物与场景</h3><button id="extract-episode-resources" class="create-button" type="button" data-url="${base}/extract-resources" data-batch-revision="${batch.revision}" data-has-candidates="${batch.candidates.length > 0}" ${configs.length ? '' : 'disabled'}>${batch.revision ? '重新提取人物与场景' : '提取人物与场景'}</button></div>
    <p class="field-help">只提取本集已保存剧本中实际呈现的人物和地点；仅被提及、只有声音或文字而未出镜的不列入。回忆／想象画面真正出场的保留。每次点击都重新调用所选模型，显示本次识别结果；删除只影响当前结果，不屏蔽下一次提取。不改已有档案或其他集。</p>
    <p id="episode-resource-remove-error" class="form-error" role="alert"></p>
    ${candidates}
    ${batch.candidates.length ? '<details class="resource-review"><summary>查看重新提取前已确认的资源</summary>' : ''}
    <h4>已确认人物与场景 · ${resourceGroups(current, choices).length} 项资源 · ${current.length} 处画面出场</h4>
    ${records(current) || '<p class="field-help">还没有已确认的画面出场资源。提取后先核对，再确认关联或新建。</p>'}
    ${batch.candidates.length ? '</details>' : ''}
    ${review.length ? `<details class="resource-review"><summary>待核对记录 · ${review.length} 处</summary><p class="field-help">旧记录保留供修正，不重复计入已确认资源。</p>${records(review)}</details>` : ''}
  </section>`;
}
export function renderResourceAppearances(database, projectId, kind, id, query) {
  const raw = query.get('occurrencePage') ?? '1';
  if (query.getAll('occurrencePage').length > 1 || !/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw Object.assign(new Error('出现位置页码无效。'), { status: 400 });
  const column = kind === 'character' ? 'character_id' : 'scene_id';
  const from = `FROM episode_occurrences o JOIN episodes e ON e.id = o.episode_id JOIN seasons s ON s.id = e.season_id LEFT JOIN episode_scripts d ON d.episode_id = e.id WHERE o.${column} = ? AND s.project_id = ? AND o.ignored = 0 AND o.mode IN ('on_screen', 'memory', 'imagination')`;
  const count = database.prepare(`SELECT count(*) AS count ${from}`).get(id, projectId).count;
  const pages = Math.max(1, Math.ceil(count / 50)); const page = Math.min(Number(raw), pages);
  const rows = database.prepare(`SELECT o.*, s.name AS season_name, e.name AS episode_name, d.revision AS current_revision ${from} ORDER BY s.position, s.id, e.position, e.id, o.source_start, o.id LIMIT 50 OFFSET ?`).all(id, projectId, (page - 1) * 50);
  const base = `/projects/${projectId}?${kind === 'character' ? `resource=characters&character=${id}` : `resource=scenes&scene=${id}`}`;
  return `<section class="creation-panel resource-appearances" aria-labelledby="resource-appearances-title"><h3 id="resource-appearances-title">全剧出现位置 · ${count} 处</h3>
    ${rows.map(row => `<article class="resource-appearance"><a href="/projects/${projectId}?view=episode&episode=${row.episode_id}#occurrence-${row.id}">${escapeHtml(row.season_name)} / ${escapeHtml(row.episode_name)} / ${escapeHtml(row.scene_heading || '未标场标题')} →</a>
      <p class="field-help">${occurrenceModes[row.mode]}${row.needs_review ? ' · 本次提取未发现，待核对' : row.script_revision !== row.current_revision ? ' · 剧本已变化，待核对' : ''}${row.details ? ` · ${escapeHtml(row.details)}` : ''}</p><blockquote class="occurrence-quote">${escapeHtml(row.quote)}</blockquote></article>`).join('') || '<p class="field-help">还没有确认的出场关联。</p>'}
    ${pages > 1 ? `<nav class="character-pagination" aria-label="出现位置分页">${page > 1 ? `<a href="${base}&occurrencePage=${page - 1}">← 上一页</a>` : '<span>← 上一页</span>'}<span>第 ${page} / ${pages} 页 · 每页 50 条</span>${page < pages ? `<a href="${base}&occurrencePage=${page + 1}">下一页 →</a>` : '<span>下一页 →</span>'}</nav>` : ''}
  </section>`;
}
