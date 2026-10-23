import { escapeHtml as e } from './html.js';
import { readEpisodeStoryboards } from './storyboards.js';
import { findEpisode } from './episode-scripts.js';
import { sectionNames, clipSource, readClip, shotSource, shotPictures, productionSourceDigest } from './video-production.js';
import { readApiConfig, requireWeaveConfig } from './settings.js';
import { publicOperation } from './generation-operations.js';
import { sourceStatus } from './generation-source.js';

const hidden = (name, value) => `<input type="hidden" name="${name}" value="${e(String(value))}">`;
const area = (name, label, value = '') => `<label class="form-field">${e(label)}<textarea name="${name}" rows="5" maxlength="24000">${e(value)}</textarea></label>`;
const labels = ['主体定义', '片段概述', '参考素材保留方式', '逐镜动作、对白和切点', '环境声与声音', '非现场配乐'];

function pictureUrl(db, projectId, picture) {
  if (picture.operationId) return db.prepare('SELECT id FROM generation_operations WHERE id=? AND project_id=?').get(picture.operationId, projectId) ? `/projects/${projectId}/operations/${picture.operationId}/media` : '';
  const paths = { character_boards: ['characters', 'character_id', 'boards'], character_references: ['characters', 'character_id', 'references'], scene_images: ['scenes', 'scene_id', 'images'], scene_references: ['scenes', 'scene_id', 'references'], look_images: ['looks', 'look_id', 'images'] };
  const path = paths[picture.table];
  if (!path) return '';
  const ownerTable = path[0];
  const row = db.prepare(`SELECT i.${path[1]} AS owner FROM ${picture.table} i JOIN ${ownerTable} p ON p.id=i.${path[1]} WHERE i.id=? AND p.project_id=?`).get(picture.id, projectId);
  return row ? `/projects/${projectId}/${path[0]}/${row.owner}/${path[2]}/${picture.id}` : '';
}
function thumbnail(db, projectId, picture) {
  const url = pictureUrl(db, projectId, picture);
  return url ? `<a href="${e(url)}" target="_blank" rel="noopener"><img loading="lazy" src="${e(url)}" alt="${e(picture.label)}"></a>` : '<span>原图片已不可用</span>';
}
function results(db, projectId, kind, target) {
  const rows = db.prepare('SELECT * FROM generation_operations WHERE project_id=? AND kind=? AND target_id=? ORDER BY rowid DESC LIMIT 5').all(projectId, kind, target);
  return `<div class="production-results"><p>最近 5 次结果；更多结果和交付恢复见<a href="/projects/${projectId}/operations">生成历史</a>。</p>${rows.map(row => {
    const op = publicOperation(row), status = sourceStatus(db, row);
    return `<article><p>${e(op.createdAt)} · ${e(status.label)} · ${op.deliveryConfirmed ? '交付已确认' : '交付尚未确认'} · ${op.adopted ? status.state === 'current' ? '已采用' : '曾采用，当前已失效' : '未采用'}</p>${op.mediaUrl ? op.metadata.mime_type.startsWith('video/') ? `<video controls preload="metadata" src="${e(op.mediaUrl)}"></video>` : `<a href="${e(op.mediaUrl)}" target="_blank" rel="noopener"><img loading="lazy" src="${e(op.mediaUrl)}" alt="镜头构图结果"></a>` : `<p>${e(op.error || op.localState)}</p>`}${op.mediaUrl && !op.adopted ? `<button type="button" data-operation-action="/projects/${projectId}/operations/${op.id}/adopt" data-confirm="确认采用这个版本？旧结果保留，不会重新生成。" ${status.state === 'current' ? '' : 'disabled'}>采用这个版本</button>` : ''}</article>`;
  }).join('')}</div>`;
}
export function productionContent(db, projectId, episodeId, query) {
  findEpisode(db, projectId, episodeId);
  const base = `/projects/${projectId}/episodes/${episodeId}`, plan = readEpisodeStoryboards(db, episodeId);
  const configs = db.prepare("SELECT id FROM api_configs WHERE type IN ('text_to_image','image_to_image','video') ORDER BY id").all().map(({ id }) => readApiConfig(db, id)).filter(config => {
    try { requireWeaveConfig(config); return true; } catch (error) { if (error.status === 400) return false; throw error; }
  });
  const options = type => configs.filter(c => c.type === type).map(c => `<option value="${c.id}">${e(c.name)}</option>`).join('');
  const clips = db.prepare('SELECT id,name,revision FROM video_clips WHERE project_id=? AND episode_id=? ORDER BY id').all(projectId, episodeId);
  const rawClip = query.get('clip');
  if (query.getAll('clip').length > 1 || (rawClip !== null && !/^[1-9]\d*$/.test(rawClip))) throw Object.assign(new Error('片段编号无效。'), { status: 400 });
  const clip = rawClip ? readClip(db, projectId, episodeId, Number(rawClip)) : null;
  let hash = '', sourceError = '';
  try { hash = shotSource(db, projectId, episodeId).hash; } catch (error) { if (![404, 409].includes(error.status)) throw error; sourceError = error.message; }
  let body = `<nav><a href="/projects/${projectId}?view=storyboards&amp;episode=${episodeId}">← 返回文字分镜／调整定妆与场景</a> · <a href="/projects/${projectId}/operations">生成历史／交付恢复</a></nav><p>① 核对参考图并逐镜出图 → ② 选择连续镜头建片段 → ③ 编辑视频描述并保存 → ④ 生成、播放、人工采用。</p><p>只调用你的 Weave 后端，不增加文字模型、云端或自动续写。后端未启动时不会生成；失败不自动重试。登记参数不代表真实模型能力已验证。</p>${sourceError ? `<p class="form-error" role="alert">${e(sourceError)}</p>` : ''}<h2>1. 逐镜构图</h2>`;
  for (const [i, shot] of plan.shots.entries()) {
    let refs = [], unavailable = sourceError;
    try { refs = shotPictures(db, projectId, episodeId, i + 1).pictures; } catch (error) { if (![404, 409].includes(error.status)) throw error; unavailable = error.message; }
    body += `<details class="creation-panel" id="shot-${i + 1}"><summary>镜头 ${i + 1} · ${e(shot.title)} · 估算 ${e(shot.duration ?? '未填')} 秒</summary><p>${e(shot.action)}</p><p>对白：${e(shot.dialogue || '无')}</p><p>参考图按下列顺序发送；未选定妆的演员使用基础图，不代表服装已经确认。</p><div class="production-pictures">${refs.map((ref, n) => `<figure>${thumbnail(db, projectId, ref)}<figcaption>${n + 1}. ${e(ref.label)}</figcaption></figure>`).join('') || '<p>无参考图：使用文生图。</p>'}</div>${unavailable ? `<p class="form-error">${e(unavailable)}</p>` : ''}<form data-generation-page action="${base}/shots/${i + 1}/generate">${hidden('revision', plan.revision)}${hidden('sourceHash', hash)}${hidden('chargeConfirmed', 'yes')}<label>图片配置<select name="apiConfigId" required><option value="">请选择</option>${options(refs.length ? 'image_to_image' : 'text_to_image')}</select></label><label>输出尺寸<input name="size" placeholder="宽x高，以后端支持为准" pattern="[1-9][0-9]*x[1-9][0-9]*" required></label>${area('prompt', '构图提示词（人工核对，不修改原分镜）', `${shot.framing}\n${shot.action}\n${shot.dialogue}`)}<button ${unavailable ? 'disabled' : ''}>生成镜头图</button></form>${results(db, projectId, `shot:${episodeId}`, i + 1)}</details>`;
  }
  body += `<h2 id="clip-editor">2. 视频片段</h2><nav><a href="${base}/media#clip-editor">新建片段</a> ${clips.map(c => `<a href="${base}/media?clip=${c.id}#clip-editor">${e(c.name)} · v${c.revision}</a>`).join(' · ')}</nav>`;
  let indices = clip ? JSON.parse(clip.shots_json) : plan.shots.length ? [1] : [];
  if (!clip && (query.has('start') || query.has('end'))) {
    const start = Number(query.get('start')), end = Number(query.get('end'));
    if (['start', 'end'].some(key => query.getAll(key).length !== 1 || !/^[1-9]\d*$/.test(query.get(key))) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || end > plan.shots.length || end - start >= 100) throw Object.assign(new Error('请选择本集最多100个连续镜头。'), { status: 400 });
    indices = Array.from({ length: end - start + 1 }, (_, i) => start + i);
  }
  const shotOptions = selected => plan.shots.map((shot, i) => `<option value="${i + 1}" ${selected === i + 1 ? 'selected' : ''}>镜头 ${i + 1} · ${e(shot.title)}</option>`).join('');
  if (!clip) body += `<form method="get" action="${base}/media#clip-editor" data-production-range><label>起始镜头<select name="start">${shotOptions(indices[0])}</select></label><label>结束镜头<select name="end">${shotOptions(indices.at(-1))}</select></label><button ${!plan.shots.length ? 'disabled' : ''}>载入这组镜头与参考图</button></form>`;
  else body += '<p>本片段镜头顺序已保存；需要另一组镜头请新建片段，旧视频保留。</p>';
  let source, clipError = '';
  try { source = clipSource(db, projectId, episodeId, indices); } catch (error) { if (![400, 404, 409].includes(error.status)) throw error; clipError = error.message; source = { pictures: [], shots: [] }; }
  const selected = clip ? JSON.parse(clip.pictures_json) : [];
  const pictures = [...selected, ...source.pictures.filter(p => !selected.some(saved => productionSourceDigest(saved) === productionSourceDigest(p)))];
  const sections = clip ? JSON.parse(clip.sections_json) : {};
  const subjects = clip ? JSON.parse(clip.subjects_json) : [];
  const profile = clip ? JSON.parse(clip.profile_json) : null;
  const profiles = [...new Map(configs.filter(c => c.type === 'video').flatMap(c => c.videoProfiles).map(p => [JSON.stringify(p), p])).values()];
  if (profile && !profiles.some(p => JSON.stringify(p) === JSON.stringify(profile))) profiles.unshift(profile);
  const estimated = indices.reduce((sum, index) => sum + (Number(plan.shots[index - 1]?.duration) || 0), 0);
  body += `<p>镜头 ${indices.join(' → ')} · 分镜估算 ${Math.round(estimated * 10) / 10} 秒（不是实测或生成时长）。输出时长由所选帧数／帧率决定，不会自动改速、压缩对白或凑时长。</p><ol>${source.shots.map(shot => `<li><strong>${e(shot.title)}</strong><p>${e(shot.action)}</p><p>对白：${e(shot.dialogue || '无')}；声音：${e(shot.sound || '无')}</p></li>`).join('')}</ol>`;
  if (clipError) body += `<p class="form-error">${e(clipError)}</p>`;
  const stale = clip && !clipError && productionSourceDigest(source) !== productionSourceDigest(JSON.parse(clip.source_json));
  if (stale) body += '<p class="form-error">片段依据已变化。原素材选择和描述保留，请核对后保存新版；不能直接生成旧依据视频。</p>';
  body += `<form id="production-clip-form" data-generation-page action="${base}/clips${clip ? `/${clip.id}` : ''}">${hidden('revision', clip?.revision ?? 0)}${hidden('shots', JSON.stringify(indices))}${hidden('sourceHash', clipError ? '' : productionSourceDigest(source))}${hidden('pictures', JSON.stringify(selected))}${hidden('subjects', JSON.stringify(subjects))}<label class="form-field">片段名称<input name="name" maxlength="120" required value="${e(clip?.name ?? '')}"></label><fieldset><legend>选择实际参考图（按下列顺序编号，不自动挑图）</legend><p>更改选择会影响 Picture 编号，须核对六段中的引用。已有选择不会自动换新图。</p><div class="production-pictures">${pictures.map((p, i) => {
    const valid = source.pictures.some(known => productionSourceDigest(known) === productionSourceDigest(p));
    return `<figure>${thumbnail(db, projectId, p)}<label><input type="checkbox" data-clip-picture data-picture="${e(JSON.stringify(p))}" value="${i}" ${i < selected.length ? 'checked' : ''}>${e(p.label)} <span data-picture-number></span>${valid ? '' : '（旧版／已失效，须取消或换图）'}</label><button type="button" data-picture-up aria-label="上移参考图">↑</button><button type="button" data-picture-down aria-label="下移参考图">↓</button></figure>`;
  }).join('') || '<p>没有可选参考图，不会虚构素材。</p>'}</div></fieldset><fieldset><legend>主体与参考图对应关系</legend><p>一个 Subject 可引用多张图。填写英文主体描述；图片顺序不变时不会自动改写六段正文。</p><div id="clip-subjects">${subjects.map(subject => subjectRow(subject, pictures)).join('')}</div><button type="button" id="add-clip-subject">添加主体</button><button type="button" id="sync-clip-subjects">将主体映射写入第一段</button></fieldset><template id="clip-subject-template">${subjectRow({ description: '', pictures: [] }, pictures)}</template><label class="form-field">输出参数<select name="profile" required><option value="">请选择后端支持的组合</option>${profiles.map(p => `<option value="${e(JSON.stringify(p))}" ${profile && JSON.stringify(p) === JSON.stringify(profile) ? 'selected' : ''}>${e(p.size)} · ${p.frames} 帧 / ${p.fps} FPS = ${p.frames / p.fps} 秒</option>`).join('')}</select></label><details open><summary>3. 视频描述（H3 六段，可直接编辑）</summary><p>画面描述用英文，对白和画面文字保留原语言。首镜头 [Shot 1] 不写时间；后续 [Shot 2] At 00:03.500, … 的切点须递增且小于输出时长。此处不自动翻译或调用 LLM。</p>${sectionNames.map((name, i) => area(name, `${labels[i]} · ${name}`, sections[name] ?? (name === 'summary' ? '[reference generation] ' : name === 'non_diegetic_music' ? 'N/A' : ''))).join('')}</details><label id="clip-mapping-review" hidden><input type="checkbox" id="clip-mapping-reviewed">我已核对变更后的 Picture／Subject 编号及六段引用</label><p id="clip-editor-error" role="alert" class="form-error"></p><button type="submit" ${clipError ? 'disabled' : ''}>保存片段（不调用模型）</button></form>`;
  if (clip) body += `<h2>4. 生成与验收</h2><form data-generation-page data-clip-generate action="${base}/clips/${clip.id}/generate">${hidden('revision', clip.revision)}${hidden('chargeConfirmed', 'yes')}<label>视频配置<select name="apiConfigId" required><option value="">请选择</option>${options('video')}</select></label><button ${clipError || stale ? 'disabled' : ''}>生成视频</button></form><p>先保存片段再生成；结果不会自动采用。修改片段会撤销旧视频的当前采用标记，但历史文件保留。</p>${results(db, projectId, 'video', clip.id)}`;
  return body;
}
function subjectRow(subject, pictures) {
  return `<div data-clip-subject class="creation-panel"><strong data-subject-number></strong><label>英文主体描述<input data-subject-description maxlength="2000" value="${e(subject.description)}" required></label><div>${pictures.map((p, i) => `<label><input type="checkbox" data-subject-picture value="${i}" ${subject.pictures.includes(i + 1) ? 'checked' : ''}>${e(p.label)} <span data-subject-picture-number></span></label>`).join('')}</div><button type="button" data-remove-subject>删除主体</button></div>`;
}
