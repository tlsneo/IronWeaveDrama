import { escapeHtml } from './html.js';

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
            <div class="item-actions">${nameButton(seasonUrl, '重命名', season.name)}${moveButtons(seasonUrl, season.name, seasonIndex, seasons.length)}</div>
            ${nameButton(`${base}/episodes`, '添加集', `第${items.length + 1}集`, season.id)}
          </div>
          ${items.length ? `<ol class="episode-list">${items.map((episode, index) => {
            const url = `${base}/episodes/${episode.id}`;
            return `<li class="episode-row">
              <a class="episode-link" href="${episodeLink(episode)}"><span class="episode-number">${String(index + 1).padStart(2, '0')}</span><span>${escapeHtml(episode.name)}</span></a>
              <div class="item-actions">${nameButton(url, '重命名', episode.name)}${moveButtons(url, episode.name, index, items.length)}</div>
            </li>`;
          }).join('')}</ol>` : '<p class="season-empty">本季还没有集。</p>'}
        </div>
      </details>`;
    }).join('');
    return {
      title: '分季／分集管理', description: '按季组织各集，名称和顺序可以随时调整。',
      actions: nameButton(`${base}/seasons`, '添加季', `第${seasons.length + 1}季`),
      content: `<div class="seasons-list">${content}</div>`,
    };
  }

  if (view === 'scripts') {
    const content = seasons.map(season => {
      const items = episodes.filter(episode => episode.season_id === season.id);
      return `<section class="script-season"><h3>${escapeHtml(season.name)}</h3>
        ${items.length ? `<ul class="script-links">${items.map(episode => `<li><a href="${episodeLink(episode)}">${escapeHtml(episode.name)}<span>本集剧本 →</span></a></li>`).join('')}</ul>` : `<p class="season-empty">还没有分集。<a href="${base}?view=seasons&season=${season.id}">去添加集 →</a></p>`}
      </section>`;
    }).join('');
    return { title: '剧本', description: '按季查看各集剧本入口，与分集管理使用同一份内容。', actions: '', content };
  }

  const raw = query.get('episode') ?? '';
  const id = Number(raw);
  const episode = /^[1-9]\d*$/.test(raw) && Number.isSafeInteger(id) ? episodes.find(item => item.id === id) : undefined;
  if (!episode) throw Object.assign(new Error('集不存在'), { status: 404 });
  const season = seasons.find(item => item.id === episode.season_id);
  const content = `<a class="episode-back" href="${base}?view=seasons&season=${season.id}">← ${escapeHtml(season.name)}</a>
    <div class="episode-workspace">
      <section class="creation-panel" aria-labelledby="episode-script-title"><h3 id="episode-script-title">本集剧本</h3><p>还没有剧本内容。</p></section>
      <section class="creation-panel" aria-labelledby="episode-shots-title"><h3 id="episode-shots-title">分镜</h3><p>还没有分镜。</p></section>
    </div>`;
  return { title: episode.name, description: `${season.name} · 本集剧本与分镜`, actions: '', content };
}
