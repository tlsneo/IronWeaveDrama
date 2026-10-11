import { escapeHtml } from './html.js';
import { occurrenceModes, readEpisodeResources, resourceChoices } from './episode-resources.js';

function modes(kind, selected) {
  return Object.entries(occurrenceModes).filter(([key]) => kind === 'character' || !['off_screen', 'inner_voice'].includes(key)).map(([key, label]) => `<option value="${key}" ${selected === key ? 'selected' : ''}>${label}</option>`).join('');
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
  <div class="occurrence-fields"><div class="form-field"><label>出现方式<select data-resource-mode>${modes(kind, item.mode)}</select></label></div>
    <div class="form-field"><label>本次使用说明<textarea data-resource-details maxlength="1000" rows="2">${escapeHtml(item.details)}</textarea></label></div></div>`;
}
export function renderEpisodeResources(database, projectId, episodeId, draft, configs) {
  const batch = readEpisodeResources(database, episodeId);
  const choices = { character: resourceChoices(database, projectId, 'character'), scene: resourceChoices(database, projectId, 'scene') };
  const base = `/projects/${projectId}/episodes/${episodeId}`;
  const candidates = batch.candidates.length ? `<form id="episode-resource-candidates" data-url="${base}/confirm-resources" data-batch-revision="${batch.revision}" data-script-revision="${batch.scriptRevision}">
    <h4>待确认的提取草稿 · ${batch.candidates.length} 项</h4>
    ${batch.scriptRevision !== draft.revision ? '<p class="form-error">剧本已变化，这份草稿不能直接确认。请重新提取。</p>' : ''}
    <p class="field-help">已有资源只关联不修改。同类同名的新建项共用一个资源，请统一描述；不同资源请使用可区分的名称。相同原文位置优先保留你已确认的关联。</p>
    ${batch.candidates.map((candidate, index) => `<fieldset class="resource-candidate" data-resource-candidate data-kind="${candidate.kind}"><legend>${candidate.kind === 'character' ? '角色' : '场景'} · ${escapeHtml(candidate.name)}</legend>
      <p class="field-help">${escapeHtml(candidate.sceneHeading || '未标场标题')} · ${batch.scriptRevision === draft.revision ? `正文第 ${draft.script.slice(0, candidate.sourceStart).split('\n').length} 行起` : '旧版位置，待核对'}</p><blockquote class="occurrence-quote">${escapeHtml(candidate.quote)}</blockquote>
      ${candidate.needsReview ? '<p class="form-error">原文位置无法唯一对应旧记录，请核对本条与下方旧记录后明确选择；不会自动恢复已移除的关联。</p>' : ''}
      ${selectionFields(candidate.kind, candidate, choices[candidate.kind], candidate.suggestedId, candidate.ignored)}
    </fieldset>`).join('')}
    <p class="form-error" data-resource-error role="alert"></p>
    <button class="create-button" type="submit" ${batch.scriptRevision !== draft.revision ? 'disabled' : ''}>确认保存本集关联</button>
  </form>` : '';
  const occurrences = batch.occurrences.map(row => {
    const resourceId = row.kind === 'character' ? row.character_id : row.scene_id;
    const resource = choices[row.kind].find(item => item.id === resourceId);
    const stale = row.script_revision !== draft.revision;
    const status = row.ignored ? '已移除关联' : !resource ? '资源已删除，需重新关联' : stale ? '剧本已变化，待核对' : '已确认';
    const url = resource ? `/projects/${projectId}?resource=${row.kind === 'character' ? `characters&character=${resource.id}` : `scenes&scene=${resource.id}`}` : '';
    return `<details class="resource-occurrence" id="occurrence-${row.id}"><summary><span>${row.kind === 'character' ? '角色' : '场景'} · ${escapeHtml(resource?.name ?? row.source_name)}</span><span class="character-status">${status}</span></summary>
      <div class="occurrence-body"><p class="field-help">${escapeHtml(row.scene_heading || '未标场标题')} · ${occurrenceModes[row.mode]} · 提取依据版本 ${row.script_revision}${resource ? ` · <a href="${url}">查看共享资源及全剧出现位置 →</a>` : ''}</p>
        <blockquote class="occurrence-quote">${escapeHtml(row.quote)}</blockquote>
        <form data-occurrence-form data-url="${base}/resource-occurrences/${row.id}" data-revision="${row.revision}" data-script-revision="${draft.revision}">
          ${selectionFields(row.kind, row, choices[row.kind], resourceId, !!row.ignored)}
          <div class="form-field"><label>剧本场标题<input data-scene-heading maxlength="300" value="${escapeHtml(row.scene_heading)}"></label></div>
          <div class="form-field"><label>定位原文（必须是当前剧本中唯一的连续片段）<textarea data-source-quote maxlength="1000" rows="3">${escapeHtml(row.quote)}</textarea></label></div>
          <p class="form-error" data-resource-error role="alert"></p><button class="theme-toggle" type="submit">保存这条出场记录</button>
        </form>
      </div></details>`;
  }).join('');
  return `<section id="episode-resources" class="creation-panel episode-resources-panel" aria-labelledby="episode-resources-title">
    <div class="episode-resource-heading"><h3 id="episode-resources-title">本集人物与场景</h3><button id="extract-episode-resources" class="create-button" type="button" data-url="${base}/extract-resources" data-batch-revision="${batch.revision}" data-has-candidates="${batch.candidates.length > 0}" ${configs.length ? '' : 'disabled'}>提取／同步人物与场景</button></div>
    <p class="field-help">只读取本集已保存剧本，使用上方所选大语言模型。点击才调用模型；修改后可再次提取。确认后只更新本集出场记录，不修改已有档案或其他集。</p>
    ${candidates}
    <h4>已保存出场记录 · ${batch.occurrences.length} 条</h4>
    ${occurrences || '<p class="field-help">还没有出场记录。提取后先核对，再确认关联或新建。</p>'}
  </section>`;
}
export function renderResourceAppearances(database, projectId, kind, id, query) {
  const raw = query.get('occurrencePage') ?? '1';
  if (query.getAll('occurrencePage').length > 1 || !/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw Object.assign(new Error('出现位置页码无效。'), { status: 400 });
  const column = kind === 'character' ? 'character_id' : 'scene_id';
  const from = `FROM episode_occurrences o JOIN episodes e ON e.id = o.episode_id JOIN seasons s ON s.id = e.season_id LEFT JOIN episode_scripts d ON d.episode_id = e.id WHERE o.${column} = ? AND s.project_id = ? AND o.ignored = 0`;
  const count = database.prepare(`SELECT count(*) AS count ${from}`).get(id, projectId).count;
  const pages = Math.max(1, Math.ceil(count / 50)); const page = Math.min(Number(raw), pages);
  const rows = database.prepare(`SELECT o.*, s.name AS season_name, e.name AS episode_name, d.revision AS current_revision ${from} ORDER BY s.position, s.id, e.position, e.id, o.source_start, o.id LIMIT 50 OFFSET ?`).all(id, projectId, (page - 1) * 50);
  const base = `/projects/${projectId}?${kind === 'character' ? `resource=characters&character=${id}` : `resource=scenes&scene=${id}`}`;
  return `<section class="creation-panel resource-appearances" aria-labelledby="resource-appearances-title"><h3 id="resource-appearances-title">全剧出现位置 · ${count} 处</h3>
    ${rows.map(row => `<article class="resource-appearance"><a href="/projects/${projectId}?view=episode&episode=${row.episode_id}#occurrence-${row.id}">${escapeHtml(row.season_name)} / ${escapeHtml(row.episode_name)} / ${escapeHtml(row.scene_heading || '未标场标题')} →</a>
      <p class="field-help">${occurrenceModes[row.mode]}${row.script_revision !== row.current_revision ? ' · 剧本已变化，待核对' : ''}${row.details ? ` · ${escapeHtml(row.details)}` : ''}</p><blockquote class="occurrence-quote">${escapeHtml(row.quote)}</blockquote></article>`).join('') || '<p class="field-help">还没有确认的出场关联。</p>'}
    ${pages > 1 ? `<nav class="character-pagination" aria-label="出现位置分页">${page > 1 ? `<a href="${base}&occurrencePage=${page - 1}">← 上一页</a>` : '<span>← 上一页</span>'}<span>第 ${page} / ${pages} 页 · 每页 50 条</span>${page < pages ? `<a href="${base}&occurrencePage=${page + 1}">下一页 →</a>` : '<span>下一页 →</span>'}</nav>` : ''}
  </section>`;
}
