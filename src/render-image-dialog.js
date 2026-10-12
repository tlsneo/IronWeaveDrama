import { escapeHtml } from './html.js';

export function renderImageDialog(configs, kind = 'character') {
  return `<dialog id="${kind}-image-edit-dialog" class="project-dialog image-edit-dialog" data-kind="${kind}" aria-labelledby="image-edit-title">
      <div class="image-edit-heading"><h2 id="image-edit-title">AI修图</h2><button id="image-edit-close" class="theme-toggle" type="button">关闭</button></div>
      <p id="image-edit-error" class="form-error" role="alert"></p>
      <div class="image-edit-layout">
        <section aria-label="遮罩绘制区">
          <div class="image-edit-tools">
            <button class="theme-toggle" type="button" data-mask-tool="paint" aria-pressed="true">画笔</button>
            <button class="theme-toggle" type="button" data-mask-tool="erase" aria-pressed="false">橡皮擦</button>
            <button class="theme-toggle" type="button" data-mask-tool="pan" aria-pressed="false">平移</button>
            <label>笔刷 <input id="image-edit-brush" type="range" min="2" max="160" value="36"><span id="image-edit-brush-value">36</span></label>
            <button id="image-edit-undo" class="theme-toggle" type="button" disabled>撤销</button>
            <button id="image-edit-redo" class="theme-toggle" type="button" disabled>重做</button>
            <button id="image-edit-clear" class="theme-toggle" type="button" disabled>清空选区</button>
          </div>
          <div id="image-edit-stage" class="image-edit-stage" data-tool="paint" tabindex="0" role="group" aria-label="原图和遮罩画布" aria-describedby="image-edit-keyboard-help">
            <img id="image-edit-source" alt="修图原图" draggable="false">
            <canvas id="image-edit-overlay" aria-label="独立遮罩选区，不修改原图"></canvas>
            <span id="image-edit-cursor" class="image-edit-cursor" hidden></span>
          </div>
          <p id="image-edit-keyboard-help" class="visually-hidden">方向键移动画笔定位点，空格涂抹或擦除；平移模式下方向键移动画面，加减键缩放。</p>
          <div class="image-edit-tools image-edit-view-tools">
            <button id="image-edit-zoom-out" class="theme-toggle" type="button" aria-label="缩小">−</button><span id="image-edit-zoom-value">100%</span>
            <button id="image-edit-zoom-in" class="theme-toggle" type="button" aria-label="放大">＋</button>
            <button id="image-edit-fit" class="theme-toggle" type="button">适合窗口</button>
            <button id="image-edit-export" class="theme-toggle" type="button" disabled>下载遮罩</button>
          </div>
          <p id="image-edit-selection" class="field-help" role="status" aria-live="polite">原图加载中…</p>
        </section>
        <aside>
          <div class="form-field"><label for="${kind}-edit-api">编辑图片 API</label><select id="${kind}-edit-api">${configs.length !== 1 ? '<option value="">选择编辑图片配置</option>' : ''}${configs.map(config => `<option value="${config.id}">${escapeHtml(config.name)} · ${escapeHtml(config.model)}</option>`).join('')}</select></div>
          <div class="form-field"><label for="${kind}-edit-instruction">修改要求</label><textarea id="${kind}-edit-instruction" maxlength="2000" rows="7"></textarea></div>
          <button id="submit-${kind}-edit" class="create-button" type="button" disabled aria-describedby="image-edit-unavailable">开始修图</button>
          <p id="image-edit-unavailable" class="field-help">遮罩接口待接入，当前不会调用模型。</p>
        </aside>
      </div>
    </dialog>`;
}
