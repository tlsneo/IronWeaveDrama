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
        referencePanel.hidden = !['image_to_image', 'image_edit'].includes(typeSelect.value);
        document.getElementById('api-base-url').value = result.baseUrl;
        document.getElementById('api-model').value = result.model;
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
      checkButton.textContent = '测试模型（可能计费）';
    }
  }

  function markDirty() {
    dirty = true;
    checkButton.disabled = true;
    statusElement.textContent = '配置已修改，请先保存再测试模型。';
    statusElement.dataset.state = 'unverified';
    referencePanel.hidden = !['image_to_image', 'image_edit'].includes(typeSelect.value);
  }
  form.addEventListener('input', markDirty);
  form.addEventListener('change', markDirty);
  form.addEventListener('submit', event => {
    event.preventDefault();
    return submit(`/settings/api${form.dataset.id ? `/${form.dataset.id}` : ''}`, new URLSearchParams(new FormData(form)), true);
  });
  checkButton.addEventListener('click', () => {
    if (busy || !configured || dirty || !form.dataset.id) return;
    const needsImage = ['image_to_image', 'image_edit'].includes(typeSelect.value);
    const image = referenceInput.files[0];
    if (needsImage && (!image || image.size > 5 * 1024 * 1024)) {
      errorElement.textContent = image ? '参考图最多 5 MiB。' : '请先选择测试参考图。';
      return;
    }
    if (!window.confirm('将实际调用这条配置已保存的模型一次，可能消耗额度或扣费。不会自动重试。是否继续？')) return;
    const body = needsImage ? new FormData() : new URLSearchParams();
    body.set('chargeConfirmed', 'yes');
    body.set('type', typeSelect.value);
    body.set('model', document.getElementById('api-model').value);
    body.set('baseUrl', document.getElementById('api-base-url').value);
    if (needsImage) body.set('referenceImage', image);
    if (typeSelect.value === 'video') {
      const choice = window.prompt('请输入已保存视频参数组合的序号（从 0 开始）；本次为单文件测试，不代表实机能力已验证。');
      if (choice === null) return;
      const prompt = window.prompt('请输入本次视频测试的完整提示词（不会自动扩写）：');
      if (!prompt) return;
      body.set('profileIndex', choice); body.set('prompt', prompt);
    }
    return submit(`/settings/api/${form.dataset.id}/check`, body, false);
  });
  window.addEventListener('beforeunload', event => {
    if (dirty || busy) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
}
