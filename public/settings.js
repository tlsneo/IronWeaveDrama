const filterSelect = document.getElementById('api-filter');
if (filterSelect) {
  filterSelect.addEventListener('change', () => {
    window.location.assign(filterSelect.value === 'all' ? '/settings' : `/settings?type=${encodeURIComponent(filterSelect.value)}`);
  });
}

const form = document.getElementById('api-config-form');

if (form) {
  const saveButton = document.getElementById('save-api-settings');
  const checkButton = document.getElementById('check-api-connection');
  const typeSelect = document.getElementById('api-type');
  const keyInput = document.getElementById('api-key');
  const keyState = document.getElementById('api-key-state');
  const modelInput = document.getElementById('api-model');
  const videoPanel = document.getElementById('api-test-video');
  const profileSelect = document.getElementById('api-test-profile');
  const promptInput = document.getElementById('api-test-prompt');
  let lastType = typeSelect.value;
  let chatModel = lastType === 'llm' ? modelInput.value : '';
  const errorElement = document.getElementById('settings-error');
  const statusElement = document.getElementById('settings-status');
  const referencePanel = document.getElementById('api-test-reference');
  const referenceInput = document.getElementById('api-test-reference-image');
  const textOutput = document.getElementById('settings-test-output');
  const imageOutput = document.getElementById('settings-test-image');
  let configured = form.dataset.configured === 'true';
  let dirty = false;
  let busy = false;

  async function submit(url, body, saving) {
    if (busy) return;
    const creating = saving && !form.dataset.id;
    busy = true;
    form.inert = true;
    typeSelect.disabled = true;
    saveButton.disabled = true;
    checkButton.disabled = true;
    const activeButton = saving ? saveButton : checkButton;
    activeButton.textContent = saving ? '保存中…' : '实际调用中…';
    referenceInput.disabled = true;
    profileSelect.disabled = true;
    promptInput.disabled = true;
    errorElement.textContent = '';
    statusElement.textContent = saving ? '' : '正在实际调用模型，可能计费，请勿重复提交。';
    statusElement.dataset.state = 'pending';
    textOutput.hidden = true;
    imageOutput.hidden = true;
    imageOutput.onload = null;
    imageOutput.onerror = null;
    imageOutput.removeAttribute('src');
    try {
      const response = await (!saving && window.IronGeneration ? window.IronGeneration.request : fetch)(url, { method: 'POST', body });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? '操作失败，请重试。');
      if (saving) {
        configured = true;
        dirty = false;
        keyInput.value = '';
        keyInput.required = false;
        form.dataset.id = String(result.id);
        document.getElementById('api-name').value = result.name;
        document.getElementById('api-config-title').textContent = result.name;
        typeSelect.value = result.type;
        updateType();
        document.getElementById('api-base-url').value = result.baseUrl;
        modelInput.value = result.model;
        if (result.type === 'llm') chatModel = result.model;
        const choices = [{ value: '', label: '请选择参数组合' }, ...(result.videoProfiles || []).map((profile, index) => ({ value: String(index), label: `${profile.size} · ${profile.frames} 帧 · ${profile.fps} fps` }))];
        profileSelect.replaceChildren(...choices.map(choice => { const option = document.createElement('option'); option.value = choice.value; option.textContent = choice.label; return option; }));
        keyState.textContent = '这条配置已保存密钥。留空保持原密钥，填写新值则替换。';
      }
      statusElement.textContent = result.message;
      statusElement.dataset.state = saving ? 'saved' : result.verified ? 'verified' : 'unverified';
      if (!saving && result.kind === 'text') {
        textOutput.textContent = result.text;
        textOutput.hidden = false;
      }
      if (!saving && result.kind === 'image') {
        statusElement.dataset.state = 'pending';
        statusElement.textContent = '模型请求已返回，正在加载测试图片…';
        imageOutput.onload = () => {
          statusElement.dataset.state = result.verified ? 'verified' : 'unverified';
          statusElement.textContent = result.message;
        };
        imageOutput.onerror = () => {
          imageOutput.hidden = true;
          statusElement.dataset.state = 'unverified';
          statusElement.textContent = '图片结果无法验证，测试未通过。';
          errorElement.textContent = '接口返回了图片结果，但图片无法显示，请检查返回数据或图片地址。请求可能已计费，没有自动重试。';
        };
        imageOutput.src = result.image;
        imageOutput.hidden = false;
      }
      if (creating) window.location.assign('/settings');
    } catch (error) {
      errorElement.textContent = error instanceof TypeError
        ? saving ? '网络连接失败，请检查连接后重试。' : '未收到测试结果，请先查看服务商记录；请求可能已计费，请勿直接重复提交。'
        : error.message;
      statusElement.textContent = '';
      statusElement.dataset.state = 'unverified';
    } finally {
      busy = false;
      form.inert = false;
      typeSelect.disabled = false;
      saveButton.disabled = false;
      checkButton.disabled = !configured || dirty;
      saveButton.textContent = '保存配置';
      referenceInput.disabled = false;
      profileSelect.disabled = false;
      promptInput.disabled = false;
      checkButton.textContent = '测试模型（可能计费）';
    }
  }

  function updateType() {
    if (typeSelect.value !== lastType) {
      if (lastType === 'llm') chatModel = modelInput.value;
      modelInput.value = typeSelect.value === 'llm' ? chatModel : 'ironweave';
      lastType = typeSelect.value;
    }
    modelInput.readOnly = typeSelect.value !== 'llm';
    referencePanel.hidden = !['image_to_image', 'video'].includes(typeSelect.value);
    videoPanel.hidden = typeSelect.value !== 'video';
  }

  function markDirty() {
    dirty = true;
    checkButton.disabled = true;
    statusElement.textContent = '配置已修改，请先保存再测试模型。';
    statusElement.dataset.state = 'unverified';
    updateType();
  }
  form.addEventListener('input', markDirty);
  form.addEventListener('change', markDirty);
  form.addEventListener('submit', event => {
    event.preventDefault();
    const body = new URLSearchParams(new FormData(form));
    if (typeSelect.value !== 'llm') body.set('model', 'ironweave');
    return submit(`/settings/api${form.dataset.id ? `/${form.dataset.id}` : ''}`, body, true);
  });
  checkButton.addEventListener('click', () => {
    if (busy || !configured || dirty || !form.dataset.id) return;
    const isVideo = typeSelect.value === 'video';
    const needsImage = typeSelect.value === 'image_to_image';
    const images = needsImage || isVideo ? Array.from(referenceInput.files) : [];
    if (needsImage && !images.length) { errorElement.textContent = '请先选择测试参考图。'; return; }
    if (images.length > 51 || images.some(image => image.size > 32 * 1024 * 1024) || images.reduce((total, image) => total + image.size, 0) > 32 * 1024 * 1024) {
      errorElement.textContent = '参考图最多 51 张，每张及合计最多 32 MiB。'; return;
    }
    if (isVideo && (!/^(0|[1-9]\d*)$/.test(profileSelect.value) || !promptInput.value.trim() || [...promptInput.value].length > 12000)) {
      errorElement.textContent = '请选择已保存的视频参数组合，并填写完整提示词（最多 12000 个 Unicode 字符）。'; return;
    }
    if (!window.confirm('将实际调用这条配置已保存的模型一次，可能消耗额度或扣费。不会自动重试。是否继续？')) return;
    const body = isVideo || images.length ? new FormData() : new URLSearchParams();
    body.set('chargeConfirmed', 'yes');
    body.set('type', typeSelect.value);
    body.set('model', modelInput.value);
    body.set('baseUrl', document.getElementById('api-base-url').value);
    for (const image of images) body.append('referenceImages', image);
    if (isVideo) { body.set('profileIndex', profileSelect.value); body.set('prompt', promptInput.value); }
    return submit(`/settings/api/${form.dataset.id}/check`, body, false);
  });
  window.addEventListener('beforeunload', event => {
    if (dirty || busy) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
}
