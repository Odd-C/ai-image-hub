const models = window.IMAGE_HUB_MODELS || [];
const $ = (selector) => document.querySelector(selector);
const labels = {libtv: 'LibTV', lovart: 'Lovart', api: 'API', queued: '排队中', running: '生成中', succeeded: '已完成', failed: '失败', recovery_required: '需人工恢复'};
const sentimentLabels = {satisfied: '满意', adopted: '采用', dissatisfied: '不满意'};
const projectId = window.IMAGE_HUB_PROJECT_ID || '';
let historyItems = [];
let refreshTimer = null;
let selectedReferenceFiles = [];
let lightboxItems = [];
let lightboxIndex = 0;
let lightboxScale = 1;
let lightboxPanX = 0;
let lightboxPanY = 0;
let lightboxDrag = null;
const csrfHeaders = {'X-CSRF-Token': window.IMAGE_HUB_CSRF || ''};

function newIdempotencyKey() {
  const key = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}-${Math.random()}`;
  $('#idempotency-key').value = key.replaceAll('-', '').replaceAll('.', '');
}

function escapeHtml(value = '') {
  const node = document.createElement('div');
  node.textContent = value;
  return node.innerHTML;
}

function toast(message, error = false) {
  const node = $('#toast');
  node.textContent = message;
  node.className = `toast show ${error ? 'error' : ''}`;
  setTimeout(() => node.className = 'toast', 2600);
}

async function responseJson(response) {
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) location.href = '/login';
  if (!response.ok) throw new Error(data.detail || '操作失败');
  return data;
}

function renderModelOptions(preferredId = '') {
  const provider = $('#provider-select').value;
  const profiles = models.filter(item => item.provider === provider);
  $('#profile-select').innerHTML = profiles.map(item => `<option value="${escapeHtml(item.id)}" ${item.enabled ? '' : 'disabled'}>${escapeHtml(item.label)}${item.enabled ? '' : '（未配置）'}</option>`).join('');
  if (preferredId && profiles.some(item => item.id === preferredId)) $('#profile-select').value = preferredId;
  renderCapabilities();
}

function renderCapabilities() {
  const profile = models.find(item => item.id === $('#profile-select').value);
  if (!profile) {
    $('#ratio-select').innerHTML = '';
    $('#resolution-select').innerHTML = '';
    $('#quality-select').innerHTML = '';
    $('#generate-button').disabled = true;
    $('#availability-note').textContent = '该平台没有可用模型';
    return;
  }
  $('#ratio-select').innerHTML = profile.ratios.map(value => `<option>${value}</option>`).join('');
  $('#resolution-select').innerHTML = profile.resolutions.map(value => `<option>${value}</option>`).join('');
  $('#quality-select').innerHTML = profile.qualities.map(value => `<option>${value}</option>`).join('');
  $('#generate-button').disabled = !profile.enabled;
  $('#availability-note').textContent = profile.enabled ? `${labels[profile.provider]} · ${profile.label}` : '管理员尚未配置此模型';
}

function initModelControls() {
  const providers = [...new Set(models.map(item => item.provider))];
  $('#provider-select').innerHTML = providers.map(value => `<option value="${value}">${labels[value]}</option>`).join('');
  renderModelOptions();
}

function referenceKey(file) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function syncReferenceInput() {
  const transfer = new DataTransfer();
  selectedReferenceFiles.forEach(file => transfer.items.add(file));
  $('#references').files = transfer.files;
  $('#reference-preview').innerHTML = selectedReferenceFiles.map((file, index) => `<figure><img src="${URL.createObjectURL(file)}"><figcaption>${index + 1}<span>${escapeHtml(file.name)}</span></figcaption><button type="button" class="remove-reference" data-remove-reference="${index}" aria-label="移除 ${escapeHtml(file.name)}">×</button></figure>`).join('');
}

function addReferenceFiles(files) {
  const profile = models.find(item => item.id === $('#profile-select').value);
  const limit = profile?.max_references || 14;
  const known = new Set(selectedReferenceFiles.map(referenceKey));
  for (const file of files) {
    if (!known.has(referenceKey(file))) {
      selectedReferenceFiles.push(file);
      known.add(referenceKey(file));
    }
  }
  if (selectedReferenceFiles.length > limit) {
    selectedReferenceFiles = selectedReferenceFiles.slice(0, limit);
    toast(`该模型参考图最多 ${limit} 张`, true);
  }
  syncReferenceInput();
}

function resultCard(item, compact = false) {
  const date = new Date(item.created_at).toLocaleString('zh-CN', {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'});
  const media = item.artifact_url ? `<button type="button" class="result-image image-review-trigger" data-action="preview" data-id="${item.id}" aria-label="放大查看生成结果"><img src="${item.artifact_url}" loading="lazy" alt="生成结果"><span class="image-review-hint">点击放大</span></button>` : `<div class="result-placeholder ${item.status}"><span>${item.status === 'running' ? '◌' : item.status === 'failed' ? '!' : '…'}</span><b>${labels[item.status] || item.status}</b></div>`;
  const sentiments = !compact && item.status === 'succeeded' ? `<div class="sentiment-row">${Object.entries(sentimentLabels).map(([key, value]) => `<button data-action="sentiment" data-id="${item.id}" data-value="${key}" class="sentiment ${item.sentiment === key ? 'active' : ''}">${value}</button>`).join('')}</div>` : '';
  const references = item.references.length ? `<div class="history-references">${item.references.slice(0, 4).map(ref => `<img src="/generations/${item.id}/references/${ref.id}" loading="lazy" title="参考图 ${ref.position}">`).join('')}<small>${item.references.length} 张参考图</small></div>` : '';
  return `<article class="result-card ${compact ? 'compact' : ''}" data-id="${item.id}">${media}<div class="result-content"><div class="result-meta"><span>${labels[item.provider] || item.provider} · ${escapeHtml(item.model_label)}</span><time>${date}</time></div><p>${escapeHtml(item.prompt)}</p>${references}${item.error ? `<small class="error-text">${escapeHtml(item.error)}</small>` : ''}<div class="card-actions"><button data-action="reuse" data-id="${item.id}" class="secondary">再次使用</button>${item.artifact_url ? `<a href="${item.artifact_url}?download=true" class="secondary">下载</a>` : ''}${item.can_retry ? `<button data-action="retry" data-id="${item.id}" class="secondary">安全重试</button>` : ''}</div>${sentiments}</div></article>`;
}

function updateLightbox() {
  const item = lightboxItems[lightboxIndex];
  if (!item) return;
  lightboxScale = 1;
  lightboxPanX = 0;
  lightboxPanY = 0;
  $('#lightbox-image').src = item.artifact_url;
  applyLightboxTransform();
  $('#lightbox-title').textContent = item.model_label;
  $('#lightbox-counter').textContent = `${lightboxIndex + 1} / ${lightboxItems.length}`;
  $('#lightbox-prompt').textContent = item.prompt;
  $('#lightbox-meta').textContent = `${labels[item.provider] || item.provider} · ${item.parameters.resolution || ''} · ${item.parameters.ratio || ''}`;
  $('#lightbox-download').href = `${item.artifact_url}?download=true`;
  $('#lightbox-zoom').textContent = '100%';
}

function openLightbox(itemId) {
  lightboxItems = historyItems.filter(item => item.artifact_url);
  lightboxIndex = Math.max(0, lightboxItems.findIndex(item => item.id === itemId));
  updateLightbox();
  $('#lightbox').showModal();
  document.body.classList.add('lightbox-open');
}

function closeLightbox() {
  $('#lightbox').close();
  document.body.classList.remove('lightbox-open');
}

function applyLightboxTransform() {
  $('#lightbox-image').style.transform = `translate3d(${lightboxPanX}px, ${lightboxPanY}px, 0) scale(${lightboxScale})`;
  $('#lightbox-zoom').textContent = `${Math.round(lightboxScale * 100)}%`;
}

function setLightboxScale(nextScale) {
  lightboxScale = Math.min(4, Math.max(0.5, nextScale));
  if (lightboxScale <= 1) {
    lightboxPanX = 0;
    lightboxPanY = 0;
  }
  applyLightboxTransform();
}

function resetLightboxView() {
  lightboxScale = 1;
  lightboxPanX = 0;
  lightboxPanY = 0;
  applyLightboxTransform();
}

function handleLightboxAction(action) {
  if (action === 'close') closeLightbox();
  if (action === 'zoom-in') setLightboxScale(lightboxScale + 0.25);
  if (action === 'zoom-out') setLightboxScale(lightboxScale - 0.25);
  if (action === 'reset') resetLightboxView();
  if (action === 'previous' || action === 'next') {
    const direction = action === 'previous' ? -1 : 1;
    lightboxIndex = (lightboxIndex + direction + lightboxItems.length) % lightboxItems.length;
    updateLightbox();
  }
}

async function loadHistory() {
  const query = new URLSearchParams({q: $('#search-input')?.value || '', provider: $('#filter-provider')?.value || '', sentiment: $('#filter-sentiment')?.value || ''});
  try {
    const data = await responseJson(await fetch(`/api/projects/${projectId}/generations?${query}`));
    historyItems = data.items;
    $('#recent-list').innerHTML = data.items.length ? data.items.slice(0, 4).map(item => resultCard(item, true)).join('') : '<div class="empty-state">还没有生成任务</div>';
    $('#history-grid').innerHTML = data.items.length ? data.items.map(item => resultCard(item)).join('') : '<div class="empty-state">没有符合条件的历史记录</div>';
    const active = data.items.some(item => ['queued', 'running'].includes(item.status));
    clearTimeout(refreshTimer);
    if (active) refreshTimer = setTimeout(loadHistory, 3500);
  } catch (error) { toast(error.message, true); }
}

function reuseItem(item) {
  $('#prompt').value = item.prompt;
  $('#prompt-count').textContent = item.prompt.length;
  $('#parent-id').value = item.id;
  $('#provider-select').value = item.provider;
  renderModelOptions(`${item.provider}:${item.model_id}`);
  if ([...$('#ratio-select').options].some(option => option.value === item.parameters.ratio)) $('#ratio-select').value = item.parameters.ratio;
  if ([...$('#resolution-select').options].some(option => option.value === item.parameters.resolution)) $('#resolution-select').value = item.parameters.resolution;
  if ([...$('#quality-select').options].some(option => option.value === item.parameters.quality)) $('#quality-select').value = item.parameters.quality;
  switchView('create');
  $('#prompt').focus();
  toast('已载入历史提示词与参数；参考图请按需重新上传');
}

async function handleAction(event) {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const item = historyItems.find(row => row.id === target.dataset.id);
  if (target.dataset.action === 'preview' && item) return openLightbox(item.id);
  if (target.dataset.action === 'reuse' && item) return reuseItem(item);
  try {
    target.disabled = true;
    if (target.dataset.action === 'sentiment') {
      await responseJson(await fetch(`/api/projects/${projectId}/generations/${target.dataset.id}/sentiment`, {method: 'POST', headers: {'Content-Type': 'application/json', ...csrfHeaders}, body: JSON.stringify({sentiment: target.dataset.value})}));
      toast(`已标记为${sentimentLabels[target.dataset.value]}`);
    } else if (target.dataset.action === 'retry') {
      await responseJson(await fetch(`/api/projects/${projectId}/generations/${target.dataset.id}/retry`, {method: 'POST', headers: csrfHeaders}));
      toast('任务已重新排队');
    }
    await loadHistory();
  } catch (error) { toast(error.message, true); target.disabled = false; }
}

function switchView(name) {
  document.querySelectorAll('.view').forEach(node => node.classList.toggle('active', node.id === `${name}-view`));
  document.querySelectorAll('.nav-tab').forEach(node => node.classList.toggle('active', node.dataset.view === name));
  if (name === 'history') loadHistory();
}

function debounce(fn, wait = 300) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), wait); };
}

async function loadProjectDraft() {
  if (!projectId) return;
  try {
    const payload = await responseJson(await fetch(`/api/projects/${projectId}/canvas`));
    const draft = payload.state?.draft;
    if (!draft) return;
    $('#prompt').value = draft.prompt || '';
    $('#prompt-count').textContent = $('#prompt').value.length;
    if (draft.provider) $('#provider-select').value = draft.provider;
    renderModelOptions(draft.profile);
    if (draft.profile) $('#profile-select').value = draft.profile;
    renderCapabilities();
    if ([...$('#ratio-select').options].some(item => item.value === draft.ratio)) $('#ratio-select').value = draft.ratio;
    if ([...$('#resolution-select').options].some(item => item.value === draft.resolution)) $('#resolution-select').value = draft.resolution;
    if ([...$('#quality-select').options].some(item => item.value === draft.quality)) $('#quality-select').value = draft.quality;
  } catch (error) { toast(error.message, true); }
}

const saveProjectDraft = debounce(async () => {
  if (!projectId) return;
  const draft = {
    prompt: $('#prompt').value,
    provider: $('#provider-select').value,
    profile: $('#profile-select').value,
    ratio: $('#ratio-select').value,
    resolution: $('#resolution-select').value,
    quality: $('#quality-select').value,
  };
  try {
    await responseJson(await fetch(`/api/projects/${projectId}/canvas`, {
      method: 'PUT', headers: {'Content-Type': 'application/json', ...csrfHeaders},
      body: JSON.stringify({draft}),
    }));
  } catch (error) { console.warn('项目草稿自动保存失败', error); }
}, 500);

document.addEventListener('DOMContentLoaded', async () => {
  initModelControls();
  newIdempotencyKey();
  $('#provider-select').addEventListener('change', () => renderModelOptions());
  $('#profile-select').addEventListener('change', renderCapabilities);
  $('#prompt').addEventListener('input', event => $('#prompt-count').textContent = event.target.value.length);
  $('#references').addEventListener('change', event => addReferenceFiles([...event.target.files]));
  $('#dropzone').addEventListener('dragover', event => { event.preventDefault(); $('#dropzone').classList.add('dragging'); });
  $('#dropzone').addEventListener('dragleave', () => $('#dropzone').classList.remove('dragging'));
  $('#dropzone').addEventListener('drop', event => { event.preventDefault(); $('#dropzone').classList.remove('dragging'); addReferenceFiles([...event.dataTransfer.files]); });
  $('#reference-preview').addEventListener('click', event => {
    const button = event.target.closest('[data-remove-reference]');
    if (!button) return;
    selectedReferenceFiles.splice(Number(button.dataset.removeReference), 1);
    syncReferenceInput();
  });
  $('#lightbox').addEventListener('click', event => {
    const button = event.target.closest('[data-lightbox-action]');
    if (button) return handleLightboxAction(button.dataset.lightboxAction);
    if (event.target === $('#lightbox')) closeLightbox();
  });
  $('#lightbox-stage').addEventListener('wheel', event => {
    event.preventDefault();
    setLightboxScale(lightboxScale + (event.deltaY < 0 ? 0.15 : -0.15));
  }, {passive: false});
  $('#lightbox-image').addEventListener('pointerdown', event => {
    event.preventDefault();
    lightboxDrag = {x: event.clientX, y: event.clientY, panX: lightboxPanX, panY: lightboxPanY};
    $('#lightbox-image').setPointerCapture(event.pointerId);
    $('#lightbox-image').classList.add('dragging');
  });
  $('#lightbox-image').addEventListener('pointermove', event => {
    if (!lightboxDrag) return;
    lightboxPanX = lightboxDrag.panX + event.clientX - lightboxDrag.x;
    lightboxPanY = lightboxDrag.panY + event.clientY - lightboxDrag.y;
    applyLightboxTransform();
  });
  const endLightboxDrag = event => {
    if (!lightboxDrag) return;
    lightboxDrag = null;
    $('#lightbox-image').classList.remove('dragging');
    if ($('#lightbox-image').hasPointerCapture(event.pointerId)) {
      $('#lightbox-image').releasePointerCapture(event.pointerId);
    }
  };
  $('#lightbox-image').addEventListener('pointerup', endLightboxDrag);
  $('#lightbox-image').addEventListener('pointercancel', endLightboxDrag);
  document.addEventListener('keydown', event => {
    if (!$('#lightbox').open) return;
    if (event.key === 'Escape') closeLightbox();
    if (event.key === 'ArrowLeft') handleLightboxAction('previous');
    if (event.key === 'ArrowRight') handleLightboxAction('next');
    if (event.key === '+' || event.key === '=') handleLightboxAction('zoom-in');
    if (event.key === '-') handleLightboxAction('zoom-out');
  });
  document.querySelectorAll('.nav-tab').forEach(button => button.addEventListener('click', () => switchView(button.dataset.view)));
  document.body.addEventListener('click', handleAction);
  $('#generation-form').addEventListener('input', saveProjectDraft);
  $('#generation-form').addEventListener('change', saveProjectDraft);
  $('#refresh-button').addEventListener('click', loadHistory);
  ['#search-input', '#filter-provider', '#filter-sentiment'].forEach(selector => $(selector).addEventListener(selector === '#search-input' ? 'input' : 'change', debounce(loadHistory)));
  $('#generation-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = $('#generate-button');
    button.disabled = true;
    button.textContent = '正在提交…';
    try {
      const result = await responseJson(await fetch(`/api/projects/${projectId}/generations`, {method: 'POST', headers: csrfHeaders, body: new FormData(event.target)}));
      toast(`任务 ${result.id.slice(0, 8)} 已进入队列`);
      event.target.reset();
      selectedReferenceFiles = [];
      $('#prompt-count').textContent = '0';
      syncReferenceInput();
      $('#parent-id').value = '';
      newIdempotencyKey();
      initModelControls();
      await loadHistory();
    } catch (error) { toast(error.message, true); }
    button.innerHTML = '开始生成 <span>→</span>';
    renderCapabilities();
  });
  await loadProjectDraft();
  loadHistory();
});
