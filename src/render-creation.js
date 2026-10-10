import { escapeHtml, deleteButton } from './html.js';
import { readEpisodeScript } from './episode-scripts.js';

function nameButton(url, label, name = '', seasonId = '') {
  return `<button class="theme-toggle" type="button" data-name-dialog data-url="${url}" data-title="${label}" data-name="${escapeHtml(name)}" data-season-id="${seasonId}">${label}</button>`;
}

function moveButtons(url, name, index, count) {
  return `<div class="order-controls">
    <button class="order-button" type="button" data-move-url="${url}/move" data-direction="up" aria-label="上移${escapeHtml(name)}" ${index === 0 ? 'disabled' : ''}>↑</button>
    <button class="order-button" type="button" data-move-url="${url}/move" data-direction="down" aria-label="下移${escapeHtml(name)}" ${index === count - 1 ? 'disabled' : ''}>↓</button>
  </div>`;
}

export function renderCreation(database, projectId, view, query) {
  const base = `/projects/${projectId}`;
  const seasons = database.prepare('SELECT * FROM seasons WHERE project_id = ? ORDER BY position, id').all(projectId);
  const episodes = database.prepare('SELECT e.* FROM episodes e JOIN seasons s ON s.id = e.season_id WHERE s.project_id = ? ORDER BY s.position, s.id, e.position, e.id').all(projectId);
  const selectedSeason = query.get('season') ?? String(seasons[0]?.id ?? '');
  const episodeLink = episode => `${base}?view=episode&episode=${episode.id}`;

  if (view === 'seasons') {
    const content = seasons.map((season, seasonIndex) => {
      const items = episodes.filter(episode => episode.season_id === season.id);
      const seasonUrl = `${base}/seasons/${season.id}`;
      return `<details class="season-panel" ${String(season.id) === selectedSeason ? 'open' : ''}>
        <summary><span class="season-number">S${String(seasonIndex + 1).padStart(2, '0')}</span><span class="season-name">${escapeHtml(season.name)}</span><span class="season-count">${items.length} 集</span></summary>
        <div class="season-body">
          <div class="season-toolbar">
            <div class="item-actions">${nameButton(seasonUrl, '重命名', season.name)}${moveButtons(seasonUrl, season.name, seasonIndex, seasons.length)}${deleteButton(`${seasonUrl}/delete`, season.name, `确定删除“${season.name}”？本季全部集将一并删除，无法恢复。`)}</div>
            ${nameButton(`${base}/episodes`, '添加集', `第${items.length + 1}集`, season.id)}
          </div>
          ${items.length ? `<ol class="episode-list">${items.map((episode, index) => {
            const url = `${base}/episodes/${episode.id}`;
            return `<li class="episode-row">
              <a class="episode-link" href="${episodeLink(episode)}"><span class="episode-number">${String(index + 1).padStart(2, '0')}</span><span>${escapeHtml(episode.name)}</span></a>
              <div class="item-actions">${nameButton(url, '重命名', episode.name)}${moveButtons(url, episode.name, index, items.length)}${deleteButton(`${url}/delete`, episode.name, `确定删除“${episode.name}”？该集及其剧本、分镜将删除，无法恢复。`)}</div>
            </li>`;
          }).join('')}</ol>` : '<p class="season-empty">本季还没有集。</p>'}
        </div>
      </details>`;
    }).join('');
    return {
      title: '分季／分集管理', description: '按季组织各集，名称和顺序可以随时调整。',
      actions: nameButton(`${base}/seasons`, '添加季', `第${seasons.length + 1}季`),
      content: seasons.length ? `<div class="seasons-list">${content}</div>` : '<section class="studio-empty"><h3>还没有季</h3><p>点击“添加季”继续创建。</p></section>',
    };
  }

  if (view === 'scripts') {
    const content = seasons.map(season => {
      const items = episodes.filter(episode => episode.season_id === season.id);
      return `<section class="script-season"><h3>${escapeHtml(season.name)}</h3>
        ${items.length ? `<ul class="script-links">${items.map(episode => `<li><a href="${episodeLink(episode)}">${escapeHtml(episode.name)}<span>本集剧本 →</span></a>${deleteButton(`${base}/episodes/${episode.id}/delete`, episode.name, `确定删除“${episode.name}”？该集及其剧本、分镜将删除，无法恢复。`)}</li>`).join('')}</ul>` : `<p class="season-empty">还没有分集。<a href="${base}?view=seasons&season=${season.id}">去添加集 →</a></p>`}
      </section>`;
    }).join('');
    return { title: '剧本', description: '按季查看各集剧本入口，与分集管理使用同一份内容。', actions: '', content: content || `<section class="studio-empty"><h3>还没有季和集</h3><p><a href="${base}?view=seasons">去分季／分集管理添加 →</a></p></section>` };
  }

  const raw = query.get('episode') ?? '';
  const id = Number(raw);
  const episode = /^[1-9]\d*$/.test(raw) && Number.isSafeInteger(id) ? episodes.find(item => item.id === id) : undefined;
  if (!episode || query.getAll('episode').length !== 1) throw Object.assign(new Error('集不存在'), { status: 404 });
  const season = seasons.find(item => item.id === episode.season_id);
  const draft = readEpisodeScript(database, id);
  const configs = database.prepare("SELECT id, name, model, base_url AS baseUrl FROM api_configs WHERE type = 'llm' ORDER BY id").all();
  const content = `<a class="episode-back" href="${base}?view=seasons&season=${season.id}">← ${escapeHtml(season.name)}</a>
    <div class="episode-workspace">
      <section class="creation-panel episode-script-panel" aria-labelledby="episode-script-title">
        <h3 id="episode-script-title">本集剧本</h3>
        <form id="episode-script-form" data-url="${base}/episodes/${id}/script" data-generate-url="${base}/episodes/${id}/generate-script" data-revision="${draft.revision}">
          <div class="form-field"><label for="episode-script-source">小说原文</label><textarea id="episode-script-source" name="source" maxlength="30000" rows="10">${escapeHtml(draft.source)}</textarea></div>
          <div class="episode-script-toolbar">
            <div class="form-field"><label for="episode-script-api">大语言模型 API</label><select id="episode-script-api">${configs.length !== 1 ? '<option value="">选择大语言模型配置</option>' : ''}${configs.map(config => `<option value="${config.id}" data-model="${escapeHtml(config.model)}" data-base-url="${escapeHtml(config.baseUrl)}">${escapeHtml(config.name)} · ${escapeHtml(config.model)}</option>`).join('')}</select></div>
            <button id="generate-episode-script" class="create-button" type="button" ${configs.length ? '' : 'disabled'}>生成剧本</button>
            <button id="save-episode-script" class="theme-toggle" type="submit">保存剧本</button>
          </div>
          ${!configs.length ? '<p class="field-help">尚无大语言模型配置，请先到<a href="/settings?type=llm">设置</a>添加。</p>' : ''}
          <p id="episode-script-error" class="form-error" role="alert"></p>
          <p id="episode-script-status" class="field-help" role="status" aria-live="polite"></p>
          <div class="form-field"><label for="episode-script-text">剧本正文</label><textarea id="episode-script-text" name="script" maxlength="60000" rows="20">${escapeHtml(draft.script)}</textarea></div>
          <details class="episode-script-notes" ${draft.notes ? 'open' : ''}><summary>改编说明</summary><div class="form-field"><label class="visually-hidden" for="episode-script-notes">删并说明与原文疑点</label><textarea id="episode-script-notes" name="notes" maxlength="10000" rows="5">${escapeHtml(draft.notes)}</textarea></div></details>
        </form>
        <section id="episode-script-recovery" class="episode-script-recovery" hidden aria-label="未保存的模型返回内容"><h4>返回内容未写入剧本，请先复制保留</h4><textarea id="episode-script-recovery-text" rows="10" readonly aria-label="可手动取回的模型文本"></textarea></section>
      </section>
      <section class="creation-panel" aria-labelledby="episode-shots-title"><h3 id="episode-shots-title">分镜</h3><p>还没有分镜。</p></section>
    </div>`;
  return { title: episode.name, description: `${season.name} · 本集剧本与分镜`, actions: deleteButton(`${base}/episodes/${episode.id}/delete`, episode.name, `确定删除“${episode.name}”？该集及其剧本、分镜将删除，无法恢复。`), content };
}
