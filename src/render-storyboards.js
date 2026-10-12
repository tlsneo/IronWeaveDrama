import { escapeHtml } from './html.js';
import { findEpisode, readEpisodeScript } from './episode-scripts.js';
import { readEpisodeStoryboards, storyboardResources, projectStoryboardSummary, formatStoryboardDuration } from './storyboards.js';

const modes = { on_screen: '现实画面', memory: '回忆画面', imagination: '想象画面' };
const textFields = [
  ['title', '镜头标题', 120, 0, true],
  ['sceneHeading', '剧本场标题（与已保存剧本完全一致）', 300, 0, true],
  ['quote', '定位原文（唯一、连续的剧本片段）', 1500, 3, true],
  ['framing', '景别／机位／构图／镜头运动', 500, 3, true],
  ['action', '画面内容／动作（承接与推进，可保持状态）', 1500, 3, true],
  ['dialogue', '对白（说话人＋剧本原句，可留空）', 2000, 3, false],
  ['sound', '声音／环境音（可留空）', 1000, 2, false],
  ['transition', '转场（可留空）', 500, 2, false],
  ['timingReason', '时长依据（动作、对白如何容纳）', 500, 2, true],
];
const html = value => escapeHtml(String(value ?? ''));

export function renderStoryboards(db, projectId, episodeId) {
  findEpisode(db, projectId, episodeId);
  const script = readEpisodeScript(db, episodeId);
  const plan = readEpisodeStoryboards(db, episodeId);
  const resources = storyboardResources(db, projectId, episodeId);
  const summary = projectStoryboardSummary(db, projectId);
  const configs = db.prepare("SELECT id, name, model, base_url AS baseUrl FROM api_configs WHERE type = 'llm' ORDER BY id").all();
  const base = `/projects/${projectId}/episodes/${episodeId}`;
  const stale = plan.shots.length > 0 && (plan.scriptRevision !== script.revision || plan.resourceRevision !== resources.revision);
  const total = plan.shots.reduce((sum, shot) => sum + Math.round(shot.duration * 10), 0) / 10;

  function card(shot = {}, index = 0, template = false) {
    const characters = shot.characterIds ?? [];
    const missingCharacters = characters.filter(id => !resources.characters.some(resource => resource.id === id));
    const missingScene = shot.sceneId != null && !resources.scenes.some(resource => resource.id === shot.sceneId);
    const invalidMode = shot.mode !== undefined && (typeof shot.mode !== 'string' || !Object.hasOwn(modes, shot.mode));
    return `<article class="storyboard-shot" data-storyboard-shot ${template ? '' : `id="storyboard-shot-${index + 1}"`}>
      <h4 class="storyboard-scene" data-storyboard-scene ${index && plan.shots[index - 1]?.sceneHeading === shot.sceneHeading ? 'hidden' : ''}>${html(shot.sceneHeading || '尚未填写场标题')}</h4>
      <details ${index === 0 ? 'open' : ''}>
        <summary><span class="storyboard-shot-number" data-storyboard-number>镜头 ${index + 1}</span><strong data-storyboard-title>${html(shot.title || '新镜头')}</strong><span class="storyboard-shot-duration" data-storyboard-duration>${html(shot.duration ?? '—')} 秒</span></summary>
        <div class="storyboard-shot-body">
          <div class="storyboard-shot-actions"><button type="button" class="order-button" data-storyboard-action="up" aria-label="上移镜头">↑</button><button type="button" class="order-button" data-storyboard-action="down" aria-label="下移镜头">↓</button><button type="button" class="theme-toggle delete-button" data-storyboard-action="delete">删除镜头</button></div>
          <div class="storyboard-fields">${textFields.slice(0, 3).map(field => textControl(field, shot)).join('')}
            <div class="form-field"><label>画面类型<select data-storyboard-field="mode" required>${invalidMode ? '<option value="" selected>画面类型无效，请重新选择</option>' : ''}${Object.entries(modes).map(([value, label]) => `<option value="${value}" ${shot.mode === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label></div>
            <div class="form-field"><label>计划时长（秒，0.1 秒步进）<input type="number" data-storyboard-field="duration" min="0.1" max="${plan.maxShotSeconds}" step="0.1" required value="${html(shot.duration)}" aria-describedby="storyboard-duration-error"></label></div>
            <fieldset class="storyboard-character-choices"><legend>出镜角色（本集已确认资源，可多选）</legend>${resources.characters.map(resource => `<label><input type="checkbox" data-storyboard-character value="${resource.id}" ${characters.includes(resource.id) ? 'checked' : ''}>${html(resource.name)}</label>`).join('') || '<p class="field-help">还没有已确认角色；可继续设计文字分镜。</p>'}${missingCharacters.map(id => `<label class="form-error"><input type="checkbox" data-storyboard-character value="${html(id)}" checked>已失效角色 #${html(id)}，请取消并重新选择</label>`).join('')}</fieldset>
            <div class="form-field"><label>关联场景<select data-storyboard-field="sceneId"><option value="">不关联场景</option>${resources.scenes.map(resource => `<option value="${resource.id}" ${shot.sceneId === resource.id ? 'selected' : ''}>${html(resource.name)}</option>`).join('')}${missingScene ? `<option value="${html(shot.sceneId)}" selected>已失效场景 #${html(shot.sceneId)}，请重新选择</option>` : ''}</select></label></div>
            ${textFields.slice(3).map(field => textControl(field, shot)).join('')}
          </div>
        </div>
      </details>
    </article>`;
  }
  function textControl([key, label, limit, rows, required], shot) {
    const attrs = `data-storyboard-field="${key}" maxlength="${limit}" ${required ? 'required' : ''}`;
    return `<div class="form-field storyboard-field-${key}"><label>${label}${rows ? `<textarea ${attrs} rows="${rows}">${html(shot[key])}</textarea>` : `<input ${attrs} value="${html(shot[key])}">`}</label></div>`;
  }

  return `<section id="storyboard-panel" class="creation-panel storyboard-panel" aria-labelledby="storyboard-heading">
    <div class="storyboard-heading"><div><p class="eyebrow">SHOT PLANNING</p><h3 id="storyboard-heading">本集分镜 · 可编辑的镜头计划</h3></div><span class="character-status">${stale ? '旧版待核对' : plan.shots.length ? plan.reviewed ? '已人工确认' : '生成草稿 · 待确认' : '尚未规划'}</span></div>
    <p class="field-help">根据本集已保存剧本和已确认资源生成分镜，也可手动添加镜头。这里只规划文字分镜，不生成镜头图或视频；时长均为估算，不是成片实际时长。</p>
    <div class="storyboard-project-summary" aria-label="全剧分镜进度"><strong>全剧已确认且版本有效：${summary.plannedEpisodes} / ${summary.episodeCount} 集 · ${summary.shotCount} 镜头 · 估算 ${html(formatStoryboardDuration(summary.totalSeconds))}</strong><span>未规划 ${summary.unplannedEpisodes} 集 · 旧版 ${summary.staleEpisodes} 集 · 待确认 ${summary.pendingEpisodes} 集（不计入估算）</span></div>
    ${stale ? '<p id="storyboard-stale" class="form-error" role="alert">剧本或本集资源已变化。旧分镜仍可查看、复制，但不能直接确认旧版；请先保留需要的内容，再依据当前版本重新生成。</p>' : ''}
    ${!script.script.trim() ? `<p class="form-error">本集还没有已保存的剧本。请先到<a href="/projects/${projectId}?view=episode&episode=${episodeId}">剧本页</a>保存正文。</p>` : ''}
    <form id="storyboard-form" novalidate data-url="${base}/storyboards" data-generate-url="${base}/generate-storyboards" data-revision="${plan.revision}" data-script-revision="${script.revision}" data-resource-revision="${html(resources.revision)}" data-has-shots="${plan.shots.length > 0}" data-stale="${stale}" data-has-script="${!!script.script.trim()}">
      <h4>生成／编辑镜头计划</h4>
      <div class="storyboard-toolbar"><div class="form-field"><label for="storyboard-max-seconds">单镜头时长上限（1–15 秒）</label><input id="storyboard-max-seconds" type="number" min="1" max="15" step="1" required value="${plan.maxShotSeconds}"><p class="field-help">单镜上限约束镜头规划，不等于视频片段硬件上限；后续合并片段还要单独限时。</p></div><div class="form-field"><label for="storyboard-api">大语言模型 API</label><select id="storyboard-api">${configs.length !== 1 ? '<option value="">选择大语言模型配置</option>' : ''}${configs.map(config => `<option value="${config.id}" data-model="${html(config.model)}" data-base-url="${html(config.baseUrl)}">${html(config.name)} · ${html(config.model)}</option>`).join('')}</select></div><button id="storyboard-generate" class="create-button" type="button" ${configs.length && script.script.trim() ? '' : 'disabled'}>${plan.shots.length ? '重新生成分镜' : '生成分镜'}</button></div>
      <p class="field-help">生成会调用所选模型，可能计费；成功后替换当前镜头，失败保留全部输入，不自动保存、重试或续写。降低上限不会自动改写已有镜头时长。</p>
      ${configs.length ? '' : '<p class="field-help">尚无大语言模型配置，请到<a href="/settings?type=llm">设置</a>添加；仍可手动编辑。</p>'}
      <div class="storyboard-local-summary" role="status" aria-live="polite"><strong id="storyboard-count">${plan.shots.length} 镜头</strong><span id="storyboard-total">本集计划估算 ${html(formatStoryboardDuration(total))}（非实际片长）</span><span id="storyboard-dirty">${plan.reviewed && !stale ? '已确认保存' : '待人工确认'}</span></div>
      <p id="storyboard-duration-error" class="form-error" role="alert"></p><p id="storyboard-error" class="form-error" role="alert"></p><p id="storyboard-status" class="field-help" role="status" aria-live="polite"></p>
      <div id="storyboard-shots" class="storyboard-shots">${plan.shots.map((shot, index) => card(shot, index)).join('')}</div>
      <p id="storyboard-empty" class="field-help" ${plan.shots.length ? 'hidden' : ''}>还没有镜头。生成草稿，或添加空白镜头开始设计。</p>
      <div class="storyboard-footer"><button id="storyboard-add" class="theme-toggle" type="button">＋ 添加镜头</button><button id="storyboard-save" class="create-button" type="submit" ${stale ? 'disabled' : ''}>确认并保存分镜</button></div>
      <p class="field-help">保存表示已逐镜核对原文、资源和时长；生成草稿不自动视为确认。镜头按剧本场次排列，同一场标题连续展示。最多 300 镜头。</p>
    </form>
    <template id="storyboard-shot-template">${card({}, 0, true)}</template>
    <section id="storyboard-recovery" class="episode-script-recovery" hidden aria-label="未保存的模型返回内容"><h4>模型内容未保存，请先复制保留</h4><textarea id="storyboard-recovery-text" rows="10" readonly aria-label="可手动取回的模型文本"></textarea></section>
  </section>`;
}
