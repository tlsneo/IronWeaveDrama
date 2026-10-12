(() => {
  const form = document.getElementById('storyboard-form');
  if (!form) return;
  const main = document.querySelector('main');
  const get = id => document.getElementById(`storyboard-${id}`);
  const list = get('shots'), template = get('shot-template'), maxSeconds = get('max-seconds');
  const api = get('api'), generate = get('generate'), save = get('save'), add = get('add');
  const error = get('error'), status = get('status'), recovery = get('recovery'), recoveryText = get('recovery-text');
  const textFields = ['title', 'sceneHeading', 'quote', 'mode', 'framing', 'action', 'dialogue', 'sound', 'transition', 'timingReason'];
  const cards = () => [...list.querySelectorAll('[data-storyboard-shot]')];
  const field = (card, name) => card.querySelector(`[data-storyboard-field="${name}"]`);
  let busy = false, nextId = cards().length;

  function refresh() {
    const shots = cards(), max = Number(maxSeconds.value);
    const validMax = Number.isInteger(max) && max >= 1 && max <= 15;
    let ticks = 0, invalid = false, overflow = false, previousHeading;
    shots.forEach((card, index) => {
      const duration = field(card, 'duration'), seconds = Number(duration.value);
      const valid = Number.isFinite(seconds) && seconds > 0 && Math.abs(seconds * 10 - Math.round(seconds * 10)) < 1e-8;
      const over = validMax && Number.isFinite(seconds) && seconds > max;
      if (Number.isFinite(seconds) && seconds > 0) ticks += Math.round(seconds * 10);
      invalid ||= !valid; overflow ||= over;
      duration.max = maxSeconds.value;
      duration.setAttribute('aria-invalid', String(!valid || over));
      card.dataset.invalidDuration = String(!valid || over);
      card.querySelector('[data-storyboard-number]').textContent = `镜头 ${index + 1}`;
      card.querySelector('[data-storyboard-title]').textContent = field(card, 'title').value || '新镜头';
      card.querySelector('[data-storyboard-duration]').textContent = `${duration.value || '—'} 秒`;
      const heading = field(card, 'sceneHeading').value;
      const group = card.querySelector('[data-storyboard-scene]');
      group.textContent = heading || '尚未填写场标题'; group.hidden = index > 0 && heading === previousHeading;
      previousHeading = heading;
      card.querySelector('[data-storyboard-action="up"]').disabled = index === 0;
      card.querySelector('[data-storyboard-action="down"]').disabled = index === shots.length - 1;
    });
    get('count').textContent = `${shots.length} 镜头`;
    get('total').textContent = `本集计划估算 ${Math.floor(ticks / 600)} 分 ${((ticks % 600) / 10).toFixed(1)} 秒（非实际片长）`;
    get('empty').hidden = shots.length > 0;
    add.disabled = shots.length >= 300;
    get('duration-error').textContent = !validMax ? '单镜头上限必须是 1–15 秒的整数。'
      : overflow ? `有镜头超过 ${max} 秒上限，请手动修改；已有时长未自动更改。`
        : invalid ? '镜头时长必须大于 0，并以 0.1 秒为步进。' : '';
    return validMax && !invalid && !overflow;
  }
  function changed() {
    form.dataset.dirty = 'true'; get('dirty').textContent = '有未保存修改'; refresh();
  }
  function shotsPayload() {
    return cards().map(card => {
      const shot = Object.fromEntries(textFields.map(name => [name, field(card, name).value]));
      shot.duration = Number(field(card, 'duration').value);
      shot.characterIds = [...card.querySelectorAll('[data-storyboard-character]')].filter(input => input.checked).map(input => Number(input.value));
      shot.sceneId = field(card, 'sceneId').value === '' ? null : Number(field(card, 'sceneId').value);
      return shot;
    });
  }
  function validateSave() {
    if (form.dataset.stale === 'true') { error.textContent = '剧本或资源已变化，旧版不能直接确认；请先复制保留，再依据当前版本重新生成。'; return false; }
    if (!refresh()) { error.textContent = get('duration-error').textContent; return false; }
    for (const card of cards()) {
      for (const input of card.querySelectorAll('[data-storyboard-field]')) {
        if (!input.checkValidity()) {
          card.querySelector('details').open = true; input.focus(); input.reportValidity();
          error.textContent = '请补全镜头必填字段并检查长度、时长。'; return false;
        }
      }
    }
    return true;
  }
  async function post(url, body) {
    const response = await fetch(url, { method: 'POST', body });
    let result;
    try { result = await response.json(); } catch { throw new TypeError('服务响应无法识别'); }
    if (!response.ok) {
      if (typeof result.recoveryText === 'string' && result.recoveryText) {
        recoveryText.value = result.recoveryText; recovery.hidden = false;
      }
      throw new Error(result.error || '分镜操作失败。');
    }
    if (!result || !Number.isSafeInteger(result.revision) || result.revision < 0) throw new TypeError('分镜版本响应无效');
    return result;
  }
  async function run(generating) {
    const active = generating ? generate : save;
    if (busy || main.inert || active.disabled) return;
    error.textContent = ''; status.textContent = '';
    if (form.dataset.hasScript !== 'true') { error.textContent = '请先到剧本页保存本集剧本正文。'; return; }
    const max = Number(maxSeconds.value);
    if (!Number.isInteger(max) || max < 1 || max > 15) { refresh(); maxSeconds.focus(); return; }
    let replacement = false;
    if (generating) {
      if (!api.value || !api.selectedOptions[0]) { error.textContent = '请选择大语言模型配置。'; api.focus(); return; }
      replacement = form.dataset.hasShots === 'true' || cards().length > 0 || form.dataset.dirty === 'true';
      if (replacement && !window.confirm('本次生成会调用模型，可能计费。成功后替换已有镜头及未保存修改；不会先自动保存，失败保留输入。是否继续？')) return;
    } else if (!validateSave()) return;
    const body = new URLSearchParams({ revision: form.dataset.revision, scriptRevision: form.dataset.scriptRevision,
      resourceRevision: form.dataset.resourceRevision, maxShotSeconds: String(max) });
    if (generating) {
      const option = api.selectedOptions[0];
      body.set('apiConfigId', api.value); body.set('model', option.dataset.model); body.set('baseUrl', option.dataset.baseUrl);
      body.set('replaceConfirmed', replacement ? 'yes' : 'no');
    } else {
      const shots = shotsPayload(), json = JSON.stringify(shots);
      if (shots.length > 300 || json.length > 512000) { error.textContent = '最多 300 镜头，镜头 JSON 不得超过 512000 字符。'; return; }
      body.set('shots', json);
    }
    const label = active.textContent;
    busy = true; main.inert = true; active.disabled = true;
    active.textContent = generating ? '生成中…' : '保存中…';
    status.textContent = generating ? '正在生成文字分镜，请勿重复提交或离开。' : '正在确认保存分镜…';
    let result;
    try {
      result = await post(generating ? form.dataset.generateUrl : form.dataset.url, body);
      form.dataset.revision = String(result.revision); form.dataset.dirty = '';
      recovery.hidden = true; recoveryText.value = ''; status.textContent = result.message || '分镜已保存。';
    } catch (failure) {
      status.textContent = '';
      error.textContent = failure instanceof TypeError
        ? generating ? '未收到生成结果，请先复制当前输入，再刷新或查看服务商记录；请求可能已计费，不要直接重复提交。'
          : '保存结果未确认，请先复制保留当前输入，再刷新核对。'
        : failure.message;
    } finally {
      busy = false; main.inert = false; active.disabled = false; active.textContent = label;
    }
    if (result) {
      window.location.hash = typeof result.redirect === 'string' ? result.redirect.split('#')[1] || '' : '';
      window.location.reload();
    }
  }
  form.addEventListener('submit', event => { event.preventDefault(); return run(false); });
  generate.addEventListener('click', () => run(true));
  form.addEventListener('input', event => { if (event.target !== api) changed(); });
  form.addEventListener('change', event => { if (event.target !== api) changed(); });
  add.addEventListener('click', () => {
    if (busy || main.inert || add.disabled) return;
    if (cards().length >= 300) { error.textContent = '最多 300 镜头。'; return; }
    const card = template.content.firstElementChild.cloneNode(true);
    card.id = `storyboard-shot-${++nextId}`;
    const max = Number(maxSeconds.value);
    field(card, 'duration').value = String(Number.isInteger(max) && max >= 1 && max <= 15 ? Math.min(3, max) : 3);
    list.appendChild(card); changed(); field(card, 'title').focus();
  });
  list.addEventListener('click', event => {
    const button = event.target.closest('[data-storyboard-action]');
    if (!button || busy || main.inert || button.disabled) return;
    const card = button.closest('[data-storyboard-shot]'), shots = cards(), index = shots.indexOf(card);
    if (index === -1) { error.textContent = '镜头已不存在，请保留输入后刷新核对。'; return; }
    const action = button.dataset.storyboardAction;
    if (action === 'delete') {
      if (!window.confirm(`删除当前编辑列表中的镜头 ${index + 1}？确认保存后生效，未保存的本镜编辑会丢失。`)) return;
      card.remove();
    }
    else if (action === 'up' && index > 0) list.insertBefore(card, shots[index - 1]);
    else if (action === 'down' && index < shots.length - 1) list.insertBefore(shots[index + 1], card);
    else return;
    changed();
  });
  window.addEventListener('beforeunload', event => {
    if (busy || form.dataset.dirty === 'true' || (!recovery.hidden && recoveryText.value)) { event.preventDefault(); event.returnValue = ''; }
  });
  refresh();
})();
