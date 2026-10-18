import { escapeHtml } from './html.js';
import { readSceneReference, sceneRevision, sceneImageUrl } from './scene-images.js';
import { renderImageDialog } from './render-image-dialog.js';

export function renderSceneImages(database, projectId, scene) {
  const project = database.prepare('SELECT style, aspect_ratio FROM projects WHERE id = ?').get(projectId);
  const revision = sceneRevision(scene, project);
  const image = database.prepare('SELECT id, revision, reference_id FROM scene_images WHERE scene_id = ? AND valid = 1 AND cleared = 0 ORDER BY id DESC LIMIT 1').get(scene.id);
  const latest = database.prepare('SELECT id, valid, width, height FROM scene_images WHERE scene_id = ? AND cleared = 0 ORDER BY id DESC LIMIT 1').get(scene.id);
  const reference = readSceneReference(database, scene.id);
  const type = reference ? 'image_to_image' : 'text_to_image'; const apiName = reference ? '图生图' : '文生图';
  const configs = database.prepare('SELECT id, name, model, base_url AS baseUrl FROM api_configs WHERE type = ? ORDER BY id').all(type);
  const editConfigs = database.prepare("SELECT id, name, model FROM api_configs WHERE type = 'image_edit' ORDER BY id").all();
  const base = `/projects/${projectId}/scenes/${scene.id}`;
  return { preview: `<aside class="character-preview" aria-label="场景参考图预览">
    <div class="character-preview-heading"><h3>场景参考图</h3><span>${escapeHtml(project.aspect_ratio)}</span></div>
    <a id="scene-board-link" ${latest ? `href="${sceneImageUrl(projectId, scene.id, latest.id)}"` : 'hidden'} target="_blank" rel="noopener"><img id="scene-board-image" class="character-board-image" style="aspect-ratio: ${project.aspect_ratio.replace(':', ' / ')}" ${latest ? `src="${sceneImageUrl(projectId, scene.id, latest.id)}"` : ''} alt="${escapeHtml(scene.name)}的场景参考图生成结果"></a>
    <div id="scene-board-empty" class="character-board-empty" style="aspect-ratio: ${project.aspect_ratio.replace(':', ' / ')}" ${latest ? 'hidden' : ''}><span aria-hidden="true">${escapeHtml([...scene.name][0])}</span><p>尚未生成场景参考图</p></div>
    <p id="scene-board-note" class="field-help" role="status">${latest && !latest.valid ? `上方为本次未通过的生成结果（${latest.width} × ${latest.height}），未替换原场景参考图。` : ''}</p>
    <form id="scene-generation-form" class="character-generation" data-kind="scene" data-url="${base}/generate" data-revision="${revision}" data-board-id="${latest?.id ?? ''}" data-reference-id="${reference?.id ?? ''}" data-reference-url="${base}/reference-image" data-api-name="${apiName}">
      <div class="character-reference">
        ${reference ? `<a href="${base}/references/${reference.id}" target="_blank" rel="noopener"><img class="character-reference-image" src="${base}/references/${reference.id}" alt="${escapeHtml(scene.name)}的环境参考图"></a>` : ''}
        <div><span class="character-reference-label">环境参考图</span><div class="character-image-actions">
          <input id="scene-reference-file" type="file" accept="image/png,image/jpeg,image/webp" hidden aria-label="上传场景环境参考图">
          <button id="upload-scene-reference" class="theme-toggle" type="button">${reference ? '替换图片' : '上传图片'}</button>
          <button id="clear-scene-reference" class="theme-toggle" type="button" ${reference ? '' : 'disabled'}>移除参考图</button>
        </div></div>
      </div>
      <div class="form-field"><label for="scene-image-size">输出尺寸（宽x高）</label><input id="scene-image-size" name="size" type="text" value="" required pattern="[1-9][0-9]*x[1-9][0-9]*" data-aspect-ratio="${escapeHtml(project.aspect_ratio)}" aria-describedby="scene-image-size-help"><p id="scene-image-size-help" class="field-help">填写本次尺寸，须严格符合 ${escapeHtml(project.aspect_ratio)} 比例和 Iron 已验证组合；不缩放、不自动选择尺寸。</p></div>
      <div class="form-field"><label for="scene-image-api">${apiName} API</label><select id="scene-image-api" name="apiConfigId" required>${configs.length !== 1 ? `<option value="">选择${apiName}配置</option>` : ''}${configs.map(config => `<option value="${config.id}" data-model="${escapeHtml(config.model)}" data-base-url="${escapeHtml(config.baseUrl)}">${escapeHtml(config.name)} · ${escapeHtml(config.model)}</option>`).join('')}</select></div>
      <div class="character-image-actions">
        <button id="generate-scene-image" class="create-button" type="button" ${configs.length ? '' : 'disabled'}>生成图片</button>
        <button id="edit-scene-image" class="theme-toggle" type="button" aria-controls="scene-image-edit-dialog" aria-haspopup="dialog" ${latest ? '' : 'disabled'}>AI修图</button>
        <button id="clear-scene-image" class="theme-toggle" type="button" ${latest ? '' : 'disabled'}>清空图像</button>
      </div>
      ${!configs.length ? `<p class="field-help">尚无${apiName}配置，请先到<a href="/settings?type=${type}">设置</a>添加。</p>` : ''}
      <p class="field-help">生成无人环境参考图，沿用项目画风和比例；点击生成才调用模型，可能计费。上传／移除参考图不会调用模型。</p>
      <p id="scene-generation-error" class="form-error" role="alert"></p>
      <p id="scene-generation-status" class="field-help" role="status" aria-live="polite">${image && (image.revision !== revision || image.reference_id !== (reference?.id ?? null)) ? '现有图片对应旧资料或参考图；修改后不会自动重新生成。' : ''}</p>
    </form>
  </aside>`, dialog: renderImageDialog(editConfigs, 'scene') };
}
