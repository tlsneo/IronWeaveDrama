import { sourceStatus } from './generation-source.js';
import { escapeHtml as e } from './html.js';
import { listOperations } from './generation-operations.js';
import { readEpisodeStoryboards } from './storyboards.js';
import { findEpisode } from './episode-scripts.js';
import { sectionNames, clipSource, readClip, shotSource, shotPictures } from './video-production.js';
import { readApiConfig, requireWeaveConfig } from './settings.js';

function page(title, body) { return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${e(title)}</title><link rel="stylesheet" href="/styles.css"><body><main style="max-width:1100px;margin:auto;padding:24px"><h1>${e(title)}</h1><p id="generation-notice" role="status" aria-live="polite"></p>${body}</main><script src="/generation-stream.js"></script><script src="/generation-pages.js"></script></body></html>`; }
const input = (name, label, value = '') => `<label>${e(label)}<input name="${name}" value="${e(String(value))}" required></label>`;
const area = (name, label, value) => `<label style="display:block;margin:16px 0">${e(label)}<textarea style="display:block;width:100%;min-height:100px" name="${name}">${e(String(value))}</textarea></label>`;
export function renderOperations(db, projectId) {
  const prefix = projectId === null ? '' : `/projects/${projectId}`;
  return page('生成历史与交付核对', `<a href="${prefix || '/settings'}">返回</a><p>本地保存、交付确认、来源有效性和人工采用分别判断。恢复只 GET 同一文件或核对固定 ACK，不会重复生成。资料变化的历史媒体不能覆盖当前版本。</p>${listOperations(db, projectId).map(op => `<article class="creation-panel"><h2>${e(op.kind)} · ${op.targetId}</h2><p>操作 ${e(op.id)} / 任务 ${e(op.taskId || (op.localState === 'rejected' ? '未受理' : '提交未知'))}</p><p>来源版本：${e(String(op.sourceVersion ?? '—'))} · ${e(String(op.sourceHash ?? ''))}</p><p>来源状态：${e(op.sourceStatus.label)} — ${e(op.sourceStatus.reason)}</p><p>本地：${e(op.localState)}；远端：${e(op.taskState || (op.localState === 'rejected' ? '未创建任务' : '未知'))}；${op.deliveryConfirmed ? '交付已确认' : op.localState === 'rejected' ? '请求未受理，无交付' : '交付尚未确认'}；${op.adopted ? op.sourceStatus.state === 'current' ? '已人工采用' : '曾采用，当前已失效' : '未采用'}</p><p>${e(op.error)}</p>${op.mediaUrl ? op.metadata.mime_type.startsWith('video/') ? `<video controls preload="metadata" style="max-width:100%" src="${op.mediaUrl}"></video>` : `<a href="${op.mediaUrl}"><img style="max-width:360px" src="${op.mediaUrl}" alt="历史生成图片"></a>` : ''}<div>${!op.deliveryConfirmed && op.localState !== 'rejected' ? `<button data-operation-action="${prefix}/operations/${op.id}/recover">恢复 / 核对同一回执</button>` : ''}${op.mediaUrl && !op.adopted && projectId !== null ? `<button data-operation-action="${prefix}/operations/${op.id}/adopt" ${op.sourceStatus.state !== 'current' ? 'disabled aria-disabled="true"' : ''} data-confirm="我已核对图片/视频与当前来源，确认人工采用。交付未确认时也只采用本地完整文件。">人工采用</button>` : ''}${op.active ? `<button data-operation-action="${prefix}/operations/${op.id}/release" data-confirm="只解除本地防重锁，不等于取消远端任务。再次生成可能重复计费，确定已人工核对？">已人工核对，解除防重锁</button>` : ''}</div></article>`).join('') || '<p>没有生成历史。</p>'}`);
}
export function renderProduction(db, projectId, episodeId, query) {
  findEpisode(db, projectId, episodeId);
  const base = `/projects/${projectId}/episodes/${episodeId}`, plan = readEpisodeStoryboards(db, episodeId);
  const configs = db.prepare("SELECT id FROM api_configs WHERE type IN ('text_to_image','image_to_image','video') ORDER BY id").all()
    .map(({ id }) => readApiConfig(db, id)).filter(config => {
      try { requireWeaveConfig(config); return true; }
      catch (error) { if (error.status === 400) return false; throw error; }
    });
  const options = type => configs.filter(c => type.includes(c.type)).map(c => `<option value="${c.id}">${e(c.name)}</option>`).join('');
  const clips = db.prepare('SELECT id,name,revision FROM video_clips WHERE project_id=? AND episode_id=? ORDER BY id').all(projectId, episodeId);
  let body = `<a href="/projects/${projectId}?view=storyboards&amp;episode=${episodeId}">返回文字分镜</a> · <a href="/projects/${projectId}/operations">图片/视频历史、恢复与人工采用</a><p>此页只调用有效的 Weave 配置；旧配置须在设置中核对地址和模型后保存。不增加文字模型、云端或自动续写。登记参数不代表真实模型已验证。</p>`;
  let hash = '', sourceError = '';
  try { hash = shotSource(db, projectId, episodeId).hash; } catch (error) { sourceError = error.message; }
  if (sourceError) body += `<p role="alert">${e(sourceError)}</p>`;
  body += '<h2>每镜构图</h2>';
  for (const [i, shot] of plan.shots.entries()) {
    let refs = [], unavailable = sourceError;
    try { refs = shotPictures(db, projectId, episodeId, i + 1).pictures; } catch (error) { unavailable = error.message; }
    body += `<details><summary>镜头 ${i + 1}：${e(shot.title)}</summary><p>${e(unavailable || JSON.stringify(refs))}</p><form data-generation-page action="${base}/shots/${i + 1}/generate"><input type="hidden" name="revision" value="${plan.revision}"><input type="hidden" name="sourceHash" value="${hash}"><input type="hidden" name="chargeConfirmed" value="yes"><label>图片配置<select name="apiConfigId" required><option value="">请选择</option>${options([refs.length ? 'image_to_image' : 'text_to_image'])}</select></label>${input('size', '输出尺寸（必须为 Iron 已验证组合）')}${area('prompt', '人工核对构图提示词，素材按上方顺序实际上传', `${shot.framing}\n${shot.action}\n${shot.dialogue}`)}<button ${unavailable ? 'disabled' : ''}>生成构图图（可能计费）</button></form></details>`;
  }
  body += `<h2>片段</h2><p><a href="${base}/media">新片段</a> ${clips.map(c => `<a href="${base}/media?clip=${c.id}">${e(c.name)} v${c.revision}</a>`).join(' · ')}</p>`;
  const clip = query.has('clip') ? readClip(db, projectId, episodeId, Number(query.get('clip'))) : null;
  let source;
  const indices = clip ? JSON.parse(clip.shots_json) : plan.shots.length ? [1] : [];
  try { source = clipSource(db, projectId, episodeId, indices); } catch { source = { pictures: [] }; }
  const pictures = clip ? JSON.parse(clip.pictures_json) : source.pictures;
  const sections = clip ? JSON.parse(clip.sections_json) : {};
  const profiles = configs.filter(c => c.type === 'video').flatMap(c => c.videoProfiles);
  const profile = clip ? JSON.parse(clip.profile_json) : null;
  body += `<p>Picture 编号从 1 开始，严格对应 pictures 数组顺序；Subject 是内容单位，可以引用多张图片。六段画面描述使用英文，对白与画面文字保留原语言。修改镜头列表后先保存刷新，重新核对可选素材，不能自动丢图或替换版本。</p><p>当前镜头真实可选素材：</p><pre>${e(JSON.stringify(source.pictures, null, 2))}</pre><form data-generation-page action="${base}/clips${clip ? `/${clip.id}` : ''}"><input type="hidden" name="revision" value="${clip?.revision ?? 0}">${input('name', '片段名称', clip?.name ?? '')}${area('shots', '镜头序号 JSON；数组顺序是片段顺序', JSON.stringify(indices))}${area('pictures', '实际 Picture 素材数组（从上方列表选取，可重排）', JSON.stringify(pictures, null, 2))}${area('subjects', 'Subject 映射 JSON：number、pictures（Picture 编号数组）、description', clip?.subjects_json ?? '[]')}<label>显式帧数组合<select name="profile" required><option value="">请选择；无选项时先在设置登记参数</option>${profiles.map(p => `<option value="${e(JSON.stringify(p))}" ${profile && JSON.stringify(p) === JSON.stringify(profile) ? 'selected' : ''}>${e(p.size)} · ${p.frames} 帧 / ${p.fps} FPS = ${p.frames / p.fps} 秒</option>`).join('')}</select></label>${sectionNames.map(key => area(key, key, sections[key] ?? (key === 'summary' ? '[reference generation] ' : key === 'non_diegetic_music' ? 'N/A' : ''))).join('')}<button>保存片段版本（不调用模型）</button></form>`;
  const adopted = clip?.adopted_operation_id ? db.prepare('SELECT * FROM generation_operations WHERE id=?').get(clip.adopted_operation_id) : null;
  const adoptionLabel = adopted && sourceStatus(db, adopted).state !== 'current' ? '曾采用，当前已失效' : '已采用视频';
  if (clip) body += `<form data-generation-page action="${base}/clips/${clip.id}/generate"><input type="hidden" name="revision" value="${clip.revision}"><input type="hidden" name="chargeConfirmed" value="yes"><label>视频配置<select name="apiConfigId" required><option value="">请选择</option>${options(['video'])}</select></label><button>生成单个最终视频（可能计费）</button></form><p>片段版本 ${clip.revision}；${adoptionLabel}：${e(clip.adopted_operation_id || '无')}。旧视频在历史中保留；采用前会再次核对来源与版本。</p>`;
  return page('镜头构图与视频片段', body);
}
