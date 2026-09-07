const models = window.IMAGE_HUB_MODELS || [];
const $ = (selector) => document.querySelector(selector);
const labels = {libtv: 'LibTV', lovart: 'Lovart', api: 'API', queued: '排队中', running: '生成中', succeeded: '已完成', failed: '失败', recovery_required: '需人工恢复'};
const sentimentLabels = {satisfied: '满意', adopted: '采用', dissatisfied: '不满意'};
let historyItems = [];
let refreshTimer = null;
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
    $('#quality-select').innerHTML = '';
    $('#generate-button').disabled = true;
    $('#availability-note').textContent = '该平台没有可用模型';
    return;
  }
  $('#ratio-select').innerHTML = profile.ratios.map(value => `<option>${value}</option>`).join('');
  $('#quality-select').innerHTML = profile.qualities.map(value => `<option>${value}</option>`).join('');
  $('#generate-button').disabled = !profile.enabled;
  $('#availability-note').textContent = profile.enabled ? `${labels[profile.provider]} · ${profile.label}` : '管理员尚未配置此模型';
}

function initModelControls() {
  const providers = [...new Set(models.map(item => item.provider))];
  $('#provider-select').innerHTML = providers.map(value => `<option value="${value}">${labels[value]}</option>`).join('');
  renderModelOptions();
}

function renderPreviews() {
  const files = [...$('#references').files];
  if (files.length > 14) {
    $('#references').value = '';
    toast('参考图最多 14 张', true);
    return;
  }
  $('#reference-preview').innerHTML = files.map((file, index) => `<figure><img src="${URL.createObjectURL(file)}"><figcaption>${index + 1}<span>${escapeHtml(file.name)}</span></figcaption></figure>`).join('');
}

function resultCard(item, compact = false) {
  const date = new Date(item.created_at).toLocaleString('zh-CN', {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'});
  const media = item.artifact_url ? `<a class="result-image" href="${item.artifact_url}" target="_blank"><img src="${item.artifact_url}" loading="lazy" alt="生成结果"></a>` : `<div class="result-placeholder ${item.status}"><span>${item.status === 'running' ? '◌' : item.status === 'failed' ? '!' : '…'}</span><b>${labels[item.status] || item.status}</b></div>`;
  const sentiments = item.status === 'succeeded' ? `<div class="sentiment-row">${Object.entries(sentimentLabels).map(([key, value]) => `<button data-action="sentiment" data-id="${item.id}" data-value="${key}" class="sentiment ${item.sentiment === key ? 'active' : ''}">${value}</button>`).join('')}</div>` : '';
  const references = item.references.length ? `<div class="history-references">${item.references.slice(0, 4).map(ref => `<img src="/generations/${item.id}/references/${ref.id}" loading="lazy" title="参考图 ${ref.position}">`).join('')}<small>${item.references.length} 张参考图</small></div>` : '';
  return `<article class="result-card ${compact ? 'compact' : ''}" data-id="${item.id}">${media}<div class="result-content"><div class="result-meta"><span>${labels[item.provider] || item.provider} · ${escapeHtml(item.model_label)}</span><time>${date}</time></div><p>${escapeHtml(item.prompt)}</p>${references}${item.error ? `<small class="error-text">${escapeHtml(item.error)}</small>` : ''}<div class="card-actions"><button data-action="reuse" data-id="${item.id}" class="secondary">再次使用</button>${item.artifact_url ? `<a href="${item.artifact_url}?download=true" class="secondary">下载</a>` : ''}${item.can_retry ? `<button data-action="retry" data-id="${item.id}" class="secondary">安全重试</button>` : ''}</div>${sentiments}</div></article>`;
}

async function loadHistory() {
  const query = new URLSearchParams({q: $('#search-input')?.value || '', provider: $('#filter-provider')?.value || '', sentiment: $('#filter-sentiment')?.value || ''});
  try {
    const data = await responseJson(await fetch(`/api/generations?${query}`));
    historyItems = data.items;
    $('#recent-list').innerHTML = data.items.length ? data.items.slice(0, 8).map(item => resultCard(item, true)).join('') : '<div class="empty-state">还没有生成任务</div>';
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
  if ([...$('#quality-select').options].some(option => option.value === item.parameters.quality)) $('#quality-select').value = item.parameters.quality;
  switchView('create');
  $('#prompt').focus();
  toast('已载入历史提示词与参数；参考图请按需重新上传');
}

async function handleAction(event) {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const item = historyItems.find(row => row.id === target.dataset.id);
  if (target.dataset.action === 'reuse' && item) return reuseItem(item);
  try {
    target.disabled = true;
    if (target.dataset.action === 'sentiment') {
      await responseJson(await fetch(`/api/generations/${target.dataset.id}/sentiment`, {method: 'POST', headers: {'Content-Type': 'application/json', ...csrfHeaders}, body: JSON.stringify({sentiment: target.dataset.value})}));
      toast(`已标记为${sentimentLabels[target.dataset.value]}`);
    } else if (target.dataset.action === 'retry') {
      await responseJson(await fetch(`/api/generations/${target.dataset.id}/retry`, {method: 'POST', headers: csrfHeaders}));
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

document.addEventListener('DOMContentLoaded', () => {
  initModelControls();
  newIdempotencyKey();
  $('#provider-select').addEventListener('change', () => renderModelOptions());
  $('#profile-select').addEventListener('change', renderCapabilities);
  $('#prompt').addEventListener('input', event => $('#prompt-count').textContent = event.target.value.length);
  $('#references').addEventListener('change', renderPreviews);
  document.querySelectorAll('.nav-tab').forEach(button => button.addEventListener('click', () => switchView(button.dataset.view)));
  document.body.addEventListener('click', handleAction);
  $('#refresh-button').addEventListener('click', loadHistory);
  ['#search-input', '#filter-provider', '#filter-sentiment'].forEach(selector => $(selector).addEventListener(selector === '#search-input' ? 'input' : 'change', debounce(loadHistory)));
  $('#generation-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = $('#generate-button');
    button.disabled = true;
    button.textContent = '正在提交…';
    try {
      const result = await responseJson(await fetch('/api/generations', {method: 'POST', headers: csrfHeaders, body: new FormData(event.target)}));
      toast(`任务 ${result.id.slice(0, 8)} 已进入队列`);
      event.target.reset();
      $('#prompt-count').textContent = '0';
      $('#reference-preview').innerHTML = '';
      $('#parent-id').value = '';
      newIdempotencyKey();
      initModelControls();
      await loadHistory();
    } catch (error) { toast(error.message, true); }
    button.innerHTML = '开始生成 <span>→</span>';
    renderCapabilities();
  });
  loadHistory();
});
