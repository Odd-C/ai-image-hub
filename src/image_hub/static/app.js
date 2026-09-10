(() => {
  'use strict';

  const models = window.IMAGE_HUB_MODELS || [];
  const core = window.ImageHubCanvasCore;
  if (!core) throw new Error('画布核心模块未加载');
  const projectId = window.IMAGE_HUB_PROJECT_ID || '';
  const csrfHeaders = {'X-CSRF-Token': window.IMAGE_HUB_CSRF || ''};
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const providerNames = {libtv: 'LibTV', lovart: 'Lovart', api: 'API'};
  const statusNames = {queued: '排队中', running: '生成中', succeeded: '已完成', failed: '失败', recovery_required: '需要恢复'};
  const sentimentNames = {adopted: '采用', satisfied: '满意', dissatisfied: '不满意'};
  const state = {version: 4, viewport: {x: 0, y: 0, zoom: 1}, nodes: [], selectedIds: new Set(), connecting: null};
  const localFiles = new Map();
  const objectUrls = new Map();
  const extensionHooks = new Set();
  let canvasClipboard = null;
  let saveTimer = null;
  let pollTimer = null;
  let drag = null;
  let pan = null;
  let minimapDrag = null;
  let minimapGeometry = null;
  let resizeObserver = null;
  let renderFrame = 0;
  let linkFrame = 0;
  let pendingUploadPoint = null;
  let activePickerId = '';
  let context = null;
  let lastActivation = {id: '', time: 0};
  let escapeArmed = false;
  let suppressClick = false;
  let pointerSelectionId = '';

  window.ImageHubResultActions = Object.freeze({register(handler) { if (typeof handler !== 'function') throw new TypeError('result action hook must be a function'); extensionHooks.add(handler); return () => extensionHooks.delete(handler); }});

  function emitResult(item, event = 'refresh') {
    const detail = Object.freeze({event, generationId: item.generationId || item.id, artifactUrl: item.artifactUrl || '', prompt: item.prompt || '', provider: item.provider || '', model: item.modelLabel || '', parameters: Object.freeze({...item.parameters}), sentiment: item.sentiment || ''});
    extensionHooks.forEach(handler => { try { handler(detail); } catch (error) { console.warn('结果扩展处理失败', error); } });
    window.dispatchEvent(new CustomEvent('imagehub:result-action', {detail}));
  }
  function uid(prefix) { const raw = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`; return `${prefix}-${raw.replace(/[^a-z0-9]/gi, '')}`; }
  function escapeHtml(value = '') { const div = document.createElement('div'); div.textContent = String(value); return div.innerHTML; }
  const icons = Object.freeze({
    open: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5M19 5l-8 8"/><path d="M17 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h5"/></svg>',
    download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m-4-4 4 4 4-4M5 19h14"/></svg>',
    remove: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5"/></svg>'
  });
  function downloadUrl(url) { if (!url) return ''; return `${url}${url.includes('?') ? '&' : '?'}download=true`; }
  function toast(message, error = false) { const el = $('#toast'); el.textContent = message; el.className = `toast show${error ? ' error' : ''}`; window.setTimeout(() => { el.className = 'toast'; }, 2400); }
  async function responseJson(response) { const payload = await response.json().catch(() => ({})); if (response.status === 401) location.href = '/login'; if (!response.ok) throw new Error(payload.detail || '操作失败'); return payload; }
  function profileById(id) { return core.profileById(models, id); }
  function providerLabel(value) { return providerNames[value] || value || '平台'; }
  function comboValue(ratio, resolution) { return `${ratio}|${resolution}`; }
  function combos(profile) { return profile ? profile.ratios.flatMap(ratio => profile.resolutions.map(resolution => ({ratio, resolution, value: comboValue(ratio, resolution)}))) : []; }
  function nodeById(id) { return state.nodes.find(node => node.id === id); }
  function sourceNode(id) { const node = nodeById(id); return node && (node.type === 'image' || (node.type === 'generation_result' && node.status === 'succeeded')) ? node : null; }
  function requestNodes() { return state.nodes.filter(node => node.type === 'generation_request'); }
  function worldPoint(clientX, clientY) { const rect = $('#canvas-viewport').getBoundingClientRect(); return {x: (clientX - rect.left - state.viewport.x) / state.viewport.zoom, y: (clientY - rect.top - state.viewport.y) / state.viewport.zoom}; }
  function serializeNode(node) { const copy = {...node}; if (copy.localOnly) copy.src = ''; delete copy.uploading; delete copy.submitting; return copy; }

  function scheduleSave() { $('#save-state').innerHTML = '<i></i>保存中'; clearTimeout(saveTimer); saveTimer = setTimeout(saveCanvas, 450); }
  async function saveCanvas() {
    try {
      await responseJson(await fetch(`/api/projects/${projectId}/canvas`, {method: 'PUT', headers: {'Content-Type': 'application/json', ...csrfHeaders}, body: JSON.stringify({version: 4, viewport: state.viewport, nodes: state.nodes.map(serializeNode)})}));
      $('#save-state').innerHTML = '<i></i>已保存';
    } catch (error) { $('#save-state').innerHTML = '<i class="error"></i>保存失败'; console.warn('画布保存失败', error); }
  }

  function defaultRequest(x, y, inherited = {}) {
    const profile = core.chooseRequestProfile(models, inherited.profileId || '');
    const firstCombo = combos(profile)[0] || {ratio: '1:1', resolution: '2K'};
    const compatible = combos(profile).find(item => item.ratio === inherited.ratio && item.resolution === inherited.resolution) || firstCombo;
    return {id: uid('request'), type: 'generation_request', x, y, width: 350, expanded: true, prompt: inherited.prompt || '', provider: profile?.provider || inherited.provider || '', profileId: profile?.id || inherited.profileId || '', ratio: compatible.ratio, resolution: compatible.resolution, quality: inherited.quality || profile?.qualities?.[0] || 'standard', count: 1, profileUnavailable: Boolean(inherited.profileId && !profile), orderedInputIds: inherited.inputId ? [inherited.inputId] : [], parentGenerationId: inherited.parentGenerationId || '', submitting: false};
  }
  function addRequest(x, y, inherited = {}) { const node = defaultRequest(x, y, inherited); state.nodes.push(node); selectNode(node.id, false, false); scheduleSave(); requestAnimationFrame(() => $(`[data-node-id="${node.id}"] textarea`)?.focus()); return node; }
  function addInput(requestId, sourceId) { const request = nodeById(requestId); if (!request || request.type !== 'generation_request' || !sourceNode(sourceId)) return false; request.orderedInputIds ||= []; if (request.orderedInputIds.includes(sourceId)) return false; request.orderedInputIds.push(sourceId); render(); scheduleSave(); return true; }

  function removeIds(ids) {
    const removed = new Set(ids);
    removed.forEach(id => { if (objectUrls.has(id)) URL.revokeObjectURL(objectUrls.get(id)); objectUrls.delete(id); localFiles.delete(id); });
    state.nodes = core.removePresentationNodes(state.nodes, removed);
    state.selectedIds = new Set([...state.selectedIds].filter(id => !removed.has(id)));
    render(); scheduleSave();
  }
  function selectNode(id, additive = false, focus = true) {
    const node = nodeById(id); if (!node) return;
    if (additive) { if (state.selectedIds.has(id)) state.selectedIds.delete(id); else state.selectedIds.add(id); }
    else state.selectedIds = new Set([id]);
    if (node.type === 'generation_request' && state.selectedIds.has(id)) {
      requestNodes().forEach(request => { if (request.id === id) request.expanded = true; else if (!request.submitting) request.expanded = false; });
    }
    render();
    if (focus) requestAnimationFrame(() => $(`[data-node-id="${id}"]`)?.focus({preventScroll: true}));
  }
  function activateRequestInPlace(node) {
    if (!node || node.type !== 'generation_request' || !node.expanded || (state.selectedIds.size === 1 && state.selectedIds.has(node.id))) return;
    state.selectedIds = new Set([node.id]);
    $$('.canvas-node').forEach(element => {
      const selected = element.dataset.nodeId === node.id;
      element.classList.toggle('selected', selected);
      element.setAttribute('aria-selected', String(selected));
      if (!selected) $('.node-details', element)?.remove();
    });
    scheduleLinks();
  }
  function clearSelection() { if (!state.selectedIds.size) return; state.selectedIds.clear(); render(); }

  function copySelection() {
    if (!state.selectedIds.size) return false;
    canvasClipboard = {nodes: state.nodes.map(node => structuredClone(serializeNode(node))), selectedIds: [...state.selectedIds]};
    toast(`已复制 ${state.selectedIds.size} 个画布节点`); return true;
  }
  function pasteClipboard(point) {
    if (!canvasClipboard?.selectedIds.length) return false;
    const selected = canvasClipboard.nodes.filter(node => canvasClipboard.selectedIds.includes(node.id));
    const minX = Math.min(...selected.map(node => node.x)); const minY = Math.min(...selected.map(node => node.y));
    const viewport = $('#canvas-viewport').getBoundingClientRect();
    const target = point || worldPoint(viewport.left + viewport.width / 2, viewport.top + viewport.height / 2);
    const outcome = core.clonePresentationNodes(canvasClipboard.nodes, canvasClipboard.selectedIds, uid, {x: target.x - minX + 24, y: target.y - minY + 24});
    outcome.clones.forEach(clone => {
      const oldId = Object.keys(outcome.idMap).find(id => outcome.idMap[id] === clone.id);
      if (clone.type === 'image' && oldId && localFiles.has(oldId)) { localFiles.set(clone.id, localFiles.get(oldId)); clone.src = objectUrls.get(oldId) || nodeById(oldId)?.src || ''; }
    });
    state.nodes.push(...outcome.clones); state.selectedIds = new Set(outcome.clones.map(node => node.id)); render(); scheduleSave(); toast(`已粘贴 ${outcome.clones.length} 个节点`); return true;
  }

  function modelPickerMarkup(node, profile) {
    const grouped = models.reduce((map, item) => { (map[item.provider] ||= []).push(item); return map; }, {});
    const label = profile ? `${providerLabel(profile.provider)} · ${profile.label}` : '请选择平台与模型';
    return `<div class="model-picker"><button type="button" class="model-trigger" data-model-trigger role="combobox" aria-expanded="${activePickerId === node.id}" aria-haspopup="listbox" aria-controls="models-${node.id}"><span>${escapeHtml(label)}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 10 4 4 4-4"/></svg></button><div class="model-menu" id="models-${node.id}" role="listbox" ${activePickerId === node.id ? '' : 'hidden'}>${Object.entries(grouped).map(([provider, items]) => `<div class="model-group" role="group" aria-label="${escapeHtml(providerLabel(provider))}"><div class="model-group-label">${escapeHtml(providerLabel(provider))}</div>${items.map(item => `<button type="button" role="option" data-profile-option="${escapeHtml(item.id)}" aria-selected="${item.id === node.profileId}" ${item.enabled ? '' : 'disabled'}><span>${escapeHtml(item.label)}</span>${item.id === node.profileId ? '<b aria-hidden="true">✓</b>' : ''}${item.enabled ? '' : '<small>未配置</small>'}</button>`).join('')}</div>`).join('')}</div></div>`;
  }
  function requestMarkup(node) {
    const profile = profileById(node.profileId);
    const inputRows = (node.orderedInputIds || []).map((id, index) => { const source = nodeById(id); if (!source) return ''; return `<li draggable="true" data-input-id="${id}" data-request-id="${node.id}"><span class="input-index">图${index + 1}</span><img src="${escapeHtml(source.src || source.artifactUrl || '')}" alt=""><span class="drag-label">拖动排序</span><button type="button" data-remove-input="${id}" aria-label="移除图${index + 1}">×</button></li>`; }).join('');
    const comboOptions = combos(profile).map(item => `<option value="${item.value}" ${item.ratio === node.ratio && item.resolution === node.resolution ? 'selected' : ''}>${item.ratio} · ${item.resolution}</option>`).join('');
    const quality = profile?.qualities?.length > 1 ? `<details class="more-settings"><summary>更多设置</summary><label>质量<select data-field="quality">${profile.qualities.map(value => `<option ${value === node.quality ? 'selected' : ''}>${escapeHtml(value)}</option>`).join('')}</select></label></details>` : '';
    const availability = core.requestAvailability(profile);
    return `<article class="canvas-node request-node ${node.expanded ? 'expanded' : ''} ${state.selectedIds.has(node.id) ? 'selected' : ''}" data-node-id="${node.id}" data-node-type="generation_request" aria-selected="${state.selectedIds.has(node.id)}" tabindex="-1" style="left:${node.x}px;top:${node.y}px;width:${node.width}px"><button class="input-port" type="button" aria-label="参考图输入端口"></button><button class="request-output-port" type="button" tabindex="-1" aria-label="生成结果输出端口"></button><header class="node-header"><div><span>生图器</span><small>${(node.orderedInputIds || []).length} 张输入</small></div><div><button type="button" data-toggle-request aria-label="${node.expanded ? '收起' : '展开'}生图器">${node.expanded ? '−' : '+'}</button><button type="button" data-delete-node aria-label="从画布移除">×</button></div></header><div class="request-body">${inputRows ? `<ol class="request-inputs">${inputRows}</ol>` : '<p class="no-inputs">无参考图，可直接文生图</p>'}<label class="prompt-label">提示词<textarea data-field="prompt" maxlength="12000" required placeholder="描述要生成或修改的画面">${escapeHtml(node.prompt)}</textarea></label><label>平台 · 模型${modelPickerMarkup(node, profile)}</label><div class="request-settings"><label>比例 · 分辨率<select data-field="combo">${comboOptions}</select></label><label>数量<select data-field="count">${[1,2,3,4].map(value => `<option value="${value}" ${value === Number(node.count) ? 'selected' : ''}>${value} 张</option>`).join('')}</select></label></div>${quality}${availability.enabled ? '' : `<p class="unavailable-model" role="status">${escapeHtml(availability.message)}</p>`}<button class="generate-button" type="button" data-generate ${availability.enabled || node.submitting ? '' : 'disabled'}>${node.submitting ? '正在提交…' : '生成图片'}</button></div></article>`;
  }
  function sentimentMarkup(node) { if (node.status !== 'succeeded' || node.presentationProxy) return ''; return `<div class="sentiment-actions" aria-label="结果评价">${Object.entries(sentimentNames).map(([key, label]) => `<button type="button" data-sentiment="${key}" class="${node.sentiment === key ? 'selected' : ''}" aria-pressed="${node.sentiment === key}">${label}</button>`).join('')}</div>`; }
  function mediaMarkup(node) {
    if (node.type === 'image') {
      if (node.needsReselect || (node.localOnly && !localFiles.has(node.id))) return '<div class="result-state upload-missing"><strong>需要重新选择图片</strong><small>刷新后需重新授权本地文件</small><button type="button" data-reselect-image>重新选择图片</button></div>';
      return `<img src="${escapeHtml(node.src || '')}" alt="${escapeHtml(node.name || '参考图片')}">`;
    }
    if (node.status === 'succeeded' && node.artifactUrl) return `<img src="${escapeHtml(node.artifactUrl)}" alt="生成结果">`;
    return `<div class="result-state ${escapeHtml(node.status)}"><span class="status-spinner"></span><strong>${escapeHtml(statusNames[node.status] || node.status)}</strong>${node.error ? `<small>${escapeHtml(node.error)}</small>` : ''}</div>`;
  }
  function detailMarkup(node) {
    if (!state.selectedIds.has(node.id)) return '';
    if (node.type === 'image') return `<aside class="node-details image-details"><strong>${escapeHtml(node.name || '参考图片')}</strong><span>${node.naturalWidth || '?'} × ${node.naturalHeight || '?'} px</span><div><button type="button" data-open-viewer>打开大图</button></div></aside>`;
    if (node.type !== 'generation_result' || node.status !== 'succeeded') return '';
    const p = node.parameters || {};
    return `<aside class="node-details result-details"><strong>生成详情</strong><p>${escapeHtml(node.prompt || '—')}</p><dl><div><dt>平台 · 模型</dt><dd>${escapeHtml(providerLabel(node.provider))} · ${escapeHtml(node.modelLabel || '—')}</dd></div><div><dt>规格</dt><dd>${escapeHtml(p.ratio || '—')} · ${escapeHtml(p.resolution || '—')}</dd></div>${p.quality ? `<div><dt>质量</dt><dd>${escapeHtml(p.quality)}</dd></div>` : ''}<div><dt>状态 · 创建</dt><dd>${escapeHtml(statusNames[node.status] || node.status)} · ${escapeHtml(node.createdAt || '当前会话')}</dd></div><div><dt>输入与沿袭</dt><dd>${Number(node.inputCount || 0)} 张${node.parentGenerationId ? ' · 有父结果' : ''}</dd></div></dl></aside>`;
  }
  function imageMarkup(node) {
    const result = node.type === 'generation_result'; const label = result ? `${providerLabel(node.provider)} · ${node.modelLabel || '生成结果'}` : (node.name || '参考图片'); const available = node.artifactUrl || node.src || '';
    const openAction = available ? `<button type="button" data-open-viewer aria-label="打开原图" title="打开原图">${icons.open}</button>` : '';
    const downloadAction = result && node.artifactUrl ? `<a href="${escapeHtml(downloadUrl(node.artifactUrl))}" download aria-label="下载原图" title="下载原图">${icons.download}</a>` : '';
    const retryAction = node.canRetry && !node.presentationProxy ? '<button class="retry-action" type="button" data-retry aria-label="安全重试" title="安全重试">重试</button>' : '';
    const actions = `<div class="node-action-rail"><div class="file-actions">${openAction}${downloadAction}${retryAction}</div><div class="remove-actions"><button type="button" data-delete-node aria-label="从画布移除" title="从画布移除">${icons.remove}</button></div></div>`;
    return `<article class="canvas-node image-node ${result ? 'result-node' : ''} ${state.selectedIds.has(node.id) ? 'selected' : ''}" data-node-id="${node.id}" data-node-type="${node.type}" aria-selected="${state.selectedIds.has(node.id)}" tabindex="-1" style="left:${node.x}px;top:${node.y}px;width:${node.width}px"><div class="image-frame" style="aspect-ratio:${node.aspect || '4/3'}">${mediaMarkup(node)}</div><footer class="image-node-bar result-footer"><span title="${escapeHtml(label)}">${escapeHtml(label)}</span>${actions}</footer>${sentimentMarkup(node)}${result ? '<button class="derived-input-port" type="button" tabindex="-1" aria-label="生成结果输入端口"></button>' : ''}${node.type === 'image' || node.status === 'succeeded' ? '<button class="output-port" type="button" aria-label="从这张图片创建连接"></button>' : ''}${detailMarkup(node)}</article>`;
  }

  function curvePath(a, b) { const bend = Math.max(70, Math.abs(b.x - a.x) * .45); return `M ${a.x} ${a.y} C ${a.x + bend} ${a.y}, ${b.x - bend} ${b.y}, ${b.x} ${b.y}`; }
  function portWorld(nodeId, selector) { const port = $(`[data-node-id="${nodeId}"] ${selector}`); const viewport = $('#canvas-viewport'); if (!port || !viewport) return null; return core.rectCenterToWorld(port.getBoundingClientRect(), viewport.getBoundingClientRect(), state.viewport); }
  function renderLinksNow() {
    const lines = [];
    requestNodes().forEach(request => (request.orderedInputIds || []).forEach((sourceId, index) => { const source = sourceNode(sourceId); const a = source && portWorld(source.id, '.output-port'); const b = portWorld(request.id, '.input-port'); if (!a || !b) return; const lx = b.x - 30 - index * 12; const ly = b.y - 10 - index * 14; lines.push(`<path class="input-link" data-source="${source.id}" data-target="${request.id}" data-order="${index + 1}" data-start-x="${a.x}" data-start-y="${a.y}" data-end-x="${b.x}" data-end-y="${b.y}" d="${curvePath(a, b)}"/><text class="input-order" x="${lx}" y="${ly}">${index + 1}</text>`); }));
    state.nodes.filter(node => node.type === 'generation_result' && node.requestId && nodeById(node.requestId)).forEach(result => { const a = portWorld(result.requestId, '.request-output-port'); const b = portWorld(result.id, '.derived-input-port'); if (a && b) lines.push(`<path class="derived-link" data-source="${result.requestId}" data-target="${result.id}" data-start-x="${a.x}" data-start-y="${a.y}" data-end-x="${b.x}" data-end-y="${b.y}" d="${curvePath(a, b)}"/>`); });
    if (state.connecting) lines.push(`<path class="temporary-link" d="${curvePath(state.connecting.start, state.connecting.current)}"/>`);
    $('#canvas-links').innerHTML = lines.join(''); updateMinimap();
  }
  function scheduleLinks() { cancelAnimationFrame(linkFrame); linkFrame = requestAnimationFrame(renderLinksNow); }
  function applyViewport() { $('#canvas-world').style.transform = `translate(${state.viewport.x}px,${state.viewport.y}px) scale(${state.viewport.zoom})`; $('#zoom-reset').textContent = `${Math.round(state.viewport.zoom * 100)}%`; scheduleLinks(); }
  function observeLayout() { resizeObserver?.disconnect(); resizeObserver = new ResizeObserver(() => scheduleLinks()); $$('.canvas-node').forEach(el => resizeObserver.observe(el)); }
  function render() { cancelAnimationFrame(renderFrame); $('#canvas-nodes').innerHTML = state.nodes.map(node => node.type === 'generation_request' ? requestMarkup(node) : imageMarkup(node)).join(''); $('#canvas-empty').hidden = state.nodes.length > 0; applyViewport(); renderFrame = requestAnimationFrame(() => { observeLayout(); scheduleLinks(); }); }

  function nodeWorldRects() { return state.nodes.map(node => { const el = $(`[data-node-id="${node.id}"]`); const rect = el?.getBoundingClientRect(); return {x: node.x, y: node.y, width: node.width, height: rect ? rect.height / state.viewport.zoom : 240, type: node.type}; }); }
  function updateMinimap() {
    const svg = $('#minimap-map'); if (!svg || svg.hidden) return;
    const viewportRect = $('#canvas-viewport').getBoundingClientRect(); const visible = core.visibleWorld(viewportRect, state.viewport); const rects = nodeWorldRects();
    minimapGeometry = core.minimapGeometry(rects, visible);
    svg.innerHTML = rects.map((rect, index) => { const m = minimapGeometry.nodes[index]; return `<rect class="mini-node ${rect.type}" x="${m.x}" y="${m.y}" width="${m.width}" height="${m.height}"/>`; }).join('') + `<rect class="mini-viewport" x="${minimapGeometry.viewport.x}" y="${minimapGeometry.viewport.y}" width="${minimapGeometry.viewport.width}" height="${minimapGeometry.viewport.height}"/>`;
    svg.dataset.nodeCount = String(rects.length);
  }
  function recenterFromMinimap(event) { if (!minimapGeometry) return; const rect = $('#minimap-map').getBoundingClientRect(); const map = {x: (event.clientX - rect.left) * 176 / rect.width, y: (event.clientY - rect.top) * 112 / rect.height}; const world = core.minimapPointToWorld(map, minimapGeometry); const viewport = $('#canvas-viewport').getBoundingClientRect(); state.viewport.x = viewport.width / 2 - world.x * state.viewport.zoom; state.viewport.y = viewport.height / 2 - world.y * state.viewport.zoom; applyViewport(); }

  async function imageSize(src) { return new Promise(resolve => { const image = new Image(); image.onload = () => resolve({w: image.naturalWidth, h: image.naturalHeight}); image.onerror = () => resolve({w: 4, h: 3}); image.src = src; }); }
  async function addFiles(files, point) { const valid = [...files].filter(file => /^image\/(png|jpeg|webp)$/.test(file.type)); for (let index = 0; index < valid.length; index += 1) { const file = valid[index]; const id = uid('image'); const src = URL.createObjectURL(file); const size = await imageSize(src); state.nodes.push({id, type: 'image', x: point.x + index * 32, y: point.y + index * 32, width: 280, aspect: `${size.w}/${size.h}`, naturalWidth: size.w, naturalHeight: size.h, src, name: file.name, localOnly: true, needsReselect: false}); localFiles.set(id, file); objectUrls.set(id, src); } render(); scheduleSave(); }
  function reselectImage(node) { const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/png,image/jpeg,image/webp'; input.addEventListener('change', async () => { const file = input.files?.[0]; if (!file || !/^image\/(png|jpeg|webp)$/.test(file.type)) return; if (objectUrls.has(node.id)) URL.revokeObjectURL(objectUrls.get(node.id)); const src = URL.createObjectURL(file); const size = await imageSize(src); localFiles.set(node.id, file); objectUrls.set(node.id, src); Object.assign(node, {src, name: file.name, aspect: `${size.w}/${size.h}`, naturalWidth: size.w, naturalHeight: size.h, localOnly: true, needsReselect: false}); render(); scheduleSave(); }, {once: true}); input.click(); }

  function cancelConnection() { if (!state.connecting) return false; state.connecting = null; $('.canvas-shell')?.classList.remove('connecting'); $$('.request-node.drop-target').forEach(node => node.classList.remove('drop-target')); scheduleLinks(); return true; }
  function beginConnection(event, node) { event.preventDefault(); event.stopPropagation(); const start = portWorld(node.id, '.output-port'); if (!start) return; state.connecting = {sourceId: node.id, pointerId: event.pointerId, start, current: start}; $('.canvas-shell')?.classList.add('connecting'); event.currentTarget.setPointerCapture?.(event.pointerId); scheduleLinks(); }
  function finishConnection(event) { if (!state.connecting || event.pointerId !== state.connecting.pointerId) return; const connection = state.connecting; state.connecting = null; $('.canvas-shell')?.classList.remove('connecting'); const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('.request-node'); if (target) addInput(target.dataset.nodeId, connection.sourceId); else { const invalid = document.elementFromPoint(event.clientX, event.clientY)?.closest('.canvas-node,.canvas-toolbar,.workspace-bar'); const viewport = document.elementFromPoint(event.clientX, event.clientY)?.closest('#canvas-viewport'); if (viewport && !invalid) { const p = worldPoint(event.clientX, event.clientY); const source = sourceNode(connection.sourceId); addRequest(p.x, p.y, {inputId: source.id, parentGenerationId: source.generationId || '', profileId: source.profileId, ratio: source.parameters?.ratio, resolution: source.parameters?.resolution}); } else scheduleLinks(); } }
  function startNodeDrag(event, node) {
    if (event.button !== 0 || event.target.closest('button,input,textarea,select,a,summary,[draggable="true"]')) return;
    event.preventDefault(); event.stopPropagation();
    pointerSelectionId = node.id;
    if (['image', 'generation_result'].includes(node.type)) {
      const now = performance.now();
      if (lastActivation.id === node.id && now - lastActivation.time < 430) { lastActivation = {id: '', time: 0}; openViewer(node); return; }
      lastActivation = {id: node.id, time: now};
    }
    if (!state.selectedIds.has(node.id)) selectNode(node.id, event.shiftKey, false);
    const origins = [...state.selectedIds].map(id => { const item = nodeById(id); return item && {id, x: item.x, y: item.y}; }).filter(Boolean);
    drag = {pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, origins, moved: false}; event.currentTarget.setPointerCapture?.(event.pointerId); origins.forEach(item => $(`[data-node-id="${item.id}"]`)?.classList.add('dragging'));
  }
  function movePointer(event) {
    if (state.connecting && event.pointerId === state.connecting.pointerId) { state.connecting.current = worldPoint(event.clientX, event.clientY); $$('.request-node.drop-target').forEach(node => node.classList.remove('drop-target')); document.elementFromPoint(event.clientX, event.clientY)?.closest('.request-node')?.classList.add('drop-target'); scheduleLinks(); return; }
    if (drag && event.pointerId === drag.pointerId) { const dx = (event.clientX - drag.startX) / state.viewport.zoom; const dy = (event.clientY - drag.startY) / state.viewport.zoom; if (Math.hypot(dx, dy) > 2) drag.moved = true; drag.origins.forEach(origin => { const node = nodeById(origin.id); if (!node) return; node.x = origin.x + dx; node.y = origin.y + dy; const el = $(`[data-node-id="${node.id}"]`); if (el) { el.style.left = `${node.x}px`; el.style.top = `${node.y}px`; } }); scheduleLinks(); return; }
    if (pan && event.pointerId === pan.pointerId) { const dx = event.clientX - pan.startX; const dy = event.clientY - pan.startY; if (Math.hypot(dx, dy) > 4) pan.moved = true; state.viewport.x = pan.x + dx; state.viewport.y = pan.y + dy; applyViewport(); }
  }
  function endPointer(event) {
    if (state.connecting) finishConnection(event);
    if (drag && event.pointerId === drag.pointerId) { drag.origins.forEach(item => $(`[data-node-id="${item.id}"]`)?.classList.remove('dragging')); suppressClick = drag.moved; drag = null; scheduleSave(); }
    if (pan && event.pointerId === pan.pointerId) { if (!pan.moved) clearSelection(); suppressClick = pan.moved; pan = null; scheduleSave(); }
  }
  function reorderInput(requestId, sourceId, beforeId) { const request = nodeById(requestId); if (!request) return; const list = request.orderedInputIds.filter(id => id !== sourceId); const target = list.indexOf(beforeId); list.splice(target < 0 ? list.length : target, 0, sourceId); request.orderedInputIds = list; render(); scheduleSave(); }

  async function sourceFile(node) { if (localFiles.has(node.id)) return localFiles.get(node.id); if (node?.type === 'image' && node.localOnly) throw new Error('本地参考图需要重新选择后才能生成'); if (!node?.artifactUrl) throw new Error('参考图不可用，请重新选择'); const response = await fetch(node.artifactUrl); if (!response.ok) throw new Error('无法读取历史结果原图'); const blob = await response.blob(); return new File([blob], `generation-${node.generationId || node.id}.${blob.type.includes('png') ? 'png' : blob.type.includes('webp') ? 'webp' : 'jpg'}`, {type: blob.type}); }
  async function submitOne(request, resultNode) { const data = new FormData(); data.append('prompt', request.prompt.trim()); data.append('profile_id', request.profileId); data.append('ratio', request.ratio); data.append('resolution', request.resolution); data.append('quality', request.quality || 'standard'); data.append('parent_generation_id', request.parentGenerationId || ''); data.append('idempotency_key', uid('generation').replace(/-/g, '').slice(0, 64)); for (const id of request.orderedInputIds || []) data.append('references', await sourceFile(sourceNode(id))); const payload = await responseJson(await fetch(`/api/projects/${projectId}/generations`, {method: 'POST', headers: csrfHeaders, body: data})); resultNode.generationId = payload.id; resultNode.status = payload.status; scheduleSave(); return payload; }
  async function generate(request) {
    if (!request.prompt.trim()) { toast('请先输入提示词', true); $(`[data-node-id="${request.id}"] textarea`)?.focus(); return; }
    const profile = profileById(request.profileId); if (!profile?.enabled) { toast('当前模型不可用，请选择已启用模型', true); return; }
    const missing = core.firstMissingLocalInput(state.nodes, request, id => localFiles.has(id)); if (missing) { selectNode(missing.id); toast('本地参考图需要重新选择后才能生成', true); return; }
    const count = Math.max(1, Math.min(4, Number(request.count) || 1)); const baseX = request.x + request.width + 140; const resultWidth = 260;
    const results = Array.from({length: count}, (_, index) => ({id: uid('result'), type: 'generation_result', requestId: request.id, x: baseX + (index % 2) * (resultWidth + 36), y: request.y + Math.floor(index / 2) * 390, width: resultWidth, aspect: request.ratio.replace(':', '/'), status: 'queued', prompt: request.prompt, profileId: request.profileId, provider: profile.provider, modelLabel: profile.label, parameters: {ratio: request.ratio, resolution: request.resolution, quality: request.quality, count}, inputCount: request.orderedInputIds.length, sentiment: ''}));
    request.submitting = true; state.nodes.push(...results); render(); scheduleSave(); await Promise.all(results.map(async result => { try { await submitOne(request, result); } catch (error) { result.status = 'failed'; result.error = error.message; } })); request.submitting = false; render(); scheduleSave(); startPolling();
  }
  function updateResults(items) { let changed = false; const byId = new Map(items.map(item => [item.id, item])); state.nodes.filter(node => node.type === 'generation_result' && node.generationId).forEach(node => { const item = byId.get(node.generationId); if (!item) return; const before = `${node.status}|${node.artifactUrl}|${node.sentiment}`; Object.assign(node, {status: item.status, artifactUrl: item.artifact_url, error: item.error, canRetry: item.can_retry, sentiment: item.sentiment || '', provider: item.provider, modelLabel: item.model_label, prompt: item.prompt, parameters: item.parameters, profileId: item.profile_id || '', profileUnavailable: item.profile_available === false, parentGenerationId: item.parent_generation_id, createdAt: item.created_at || node.createdAt}); if (before !== `${node.status}|${node.artifactUrl}|${node.sentiment}`) { changed = true; emitResult(node); } }); if (changed) { render(); scheduleSave(); } return state.nodes.some(node => node.type === 'generation_result' && ['queued', 'running'].includes(node.status)); }
  async function poll() { clearTimeout(pollTimer); try { const data = await responseJson(await fetch(`/api/projects/${projectId}/generations?limit=100`)); if (updateResults(data.items)) pollTimer = setTimeout(poll, 2500); } catch (error) { console.warn('任务状态刷新失败', error); pollTimer = setTimeout(poll, 5000); } }
  function startPolling() { poll(); }
  async function setSentiment(node, value, button) { if (!node.generationId) return; button.disabled = true; try { await responseJson(await fetch(`/api/projects/${projectId}/generations/${node.generationId}/sentiment`, {method: 'POST', headers: {'Content-Type': 'application/json', ...csrfHeaders}, body: JSON.stringify({sentiment: value})})); node.sentiment = value; render(); scheduleSave(); emitResult(node, 'sentiment'); toast(`已标记为${sentimentNames[value]}`); } catch (error) { toast(error.message, true); button.disabled = false; } }
  async function retry(node) { try { const data = await responseJson(await fetch(`/api/projects/${projectId}/generations/${node.generationId}/retry`, {method: 'POST', headers: csrfHeaders})); Object.assign(node, {status: data.status, error: '', canRetry: false}); render(); scheduleSave(); startPolling(); } catch (error) { toast(error.message, true); } }

  function importLegacy(payload) { const loaded = Array.isArray(payload.nodes) ? payload.nodes : []; state.viewport = {x: Number(payload.viewport?.x) || 0, y: Number(payload.viewport?.y) || 0, zoom: Number(payload.viewport?.zoom) || 1}; state.nodes = core.restoreCanvasNodes(loaded.filter(node => ['image', 'generation_request', 'generation_result'].includes(node.type))); if (!state.nodes.length && payload.draft) { const d = payload.draft; state.nodes.push(defaultRequest(220, 160, {profileId: d.profile, ratio: d.ratio, resolution: d.resolution, prompt: d.prompt})); } }
  function focusAndCenterNode(node) { const viewport = $('#canvas-viewport'); const rect = viewport.getBoundingClientRect(); const height = $(`[data-node-id="${node.id}"]`)?.getBoundingClientRect().height / state.viewport.zoom || 300; state.selectedIds = new Set([node.id]); state.viewport.x = rect.width / 2 - (node.x + node.width / 2) * state.viewport.zoom; state.viewport.y = rect.height / 2 - (node.y + height / 2) * state.viewport.zoom; render(); scheduleSave(); }
  async function applyHistoryQuery() { const query = new URLSearchParams(location.search); const action = query.get('action'); const generationId = query.get('generation'); if (!generationId || !['locate', 'continue'].includes(action)) return; try { const item = await responseJson(await fetch(`/api/projects/${projectId}/generations/${generationId}`)); const outcome = core.historyAction(state.nodes, item, action, uid); render(); if (action === 'continue') addRequest(outcome.result.x + outcome.result.width + 120, outcome.result.y, outcome.request); else focusAndCenterNode(outcome.result); if (outcome.createdResult) scheduleSave(); } catch (error) { toast(error.message, true); } }
  function fitView() { if (!state.nodes.length) { state.viewport = {x: 0, y: 0, zoom: 1}; applyViewport(); return; } const rects = nodeWorldRects(); const minX = Math.min(...rects.map(n => n.x)); const minY = Math.min(...rects.map(n => n.y)); const maxX = Math.max(...rects.map(n => n.x + n.width)); const maxY = Math.max(...rects.map(n => n.y + n.height)); const viewport = $('#canvas-viewport').getBoundingClientRect(); const zoom = Math.max(.35, Math.min(1, (viewport.width - 100) / Math.max(1, maxX - minX), (viewport.height - 100) / Math.max(1, maxY - minY))); state.viewport = {x: 50 - minX * zoom, y: 50 - minY * zoom, zoom}; applyViewport(); scheduleSave(); }
  function zoomAt(next, cx, cy) { closeContextMenu(); const rect = $('#canvas-viewport').getBoundingClientRect(); const old = state.viewport.zoom; const zoom = Math.max(.35, Math.min(1.8, next)); const px = cx - rect.left; const py = cy - rect.top; const wx = (px - state.viewport.x) / old; const wy = (py - state.viewport.y) / old; state.viewport.x = px - wx * zoom; state.viewport.y = py - wy * zoom; state.viewport.zoom = zoom; applyViewport(); scheduleSave(); }

  function openViewer(node) { const url = node.artifactUrl || node.src; if (!url || !['image', 'generation_result'].includes(node.type) || (node.type === 'generation_result' && node.status !== 'succeeded')) return; const dialog = $('#image-viewer'); const image = $('img', dialog); image.src = url; image.alt = node.name || '生成结果完整预览'; $('#viewer-title').textContent = node.name || '生成结果大图'; $('[data-view-original]', dialog).href = url; const download = $('[data-view-download]', dialog); download.href = downloadUrl(url); download.hidden = node.type === 'image' && !node.artifactUrl; dialog.showModal(); }
  function visibleWorldCenter() { const rect = $('#canvas-viewport').getBoundingClientRect(); return {x: (rect.width / 2 - state.viewport.x) / state.viewport.zoom, y: (rect.height / 2 - state.viewport.y) / state.viewport.zoom}; }
  function restoreWorldCenter(center) { const rect = $('#canvas-viewport').getBoundingClientRect(); state.viewport.x = rect.width / 2 - center.x * state.viewport.zoom; state.viewport.y = rect.height / 2 - center.y * state.viewport.zoom; applyViewport(); scheduleLinks(); scheduleSave(); }
  function setSidebarCollapsed(collapsed) { const center = visibleWorldCenter(); $('#workspace-layout').classList.toggle('sidebar-collapsed', collapsed); $('#sidebar-collapse').setAttribute('aria-expanded', String(!collapsed)); $('#sidebar-collapse').setAttribute('aria-label', collapsed ? '展开项目侧栏' : '收起项目侧栏'); $('#sidebar-collapse').title = collapsed ? '展开项目侧栏' : '收起项目侧栏'; localStorage.setItem('image-hub-sidebar-collapsed', String(collapsed)); requestAnimationFrame(() => restoreWorldCenter(center)); }
  let drawerReturnFocus = null;
  function setProjectDrawer(open) { const layout = $('#workspace-layout'); const button = $('#mobile-projects-button'); if (!matchMedia('(max-width: 768px)').matches) open = false; if (open) drawerReturnFocus = document.activeElement; layout.classList.toggle('drawer-open', open); document.body.classList.toggle('project-drawer-open', open); $('#project-scrim').hidden = !open; button.setAttribute('aria-expanded', String(open)); if (open) requestAnimationFrame(() => $('.project-list-item.current', $('#project-sidebar'))?.focus()); else drawerReturnFocus?.focus?.({preventScroll: true}); scheduleLinks(); }
  function openNewProjectDialog() { setProjectDrawer(false); const dialog = $('#new-project-dialog'); dialog.showModal(); requestAnimationFrame(() => $('input[name="name"]', dialog).focus()); }
  function closeViewer() { const dialog = $('#image-viewer'); if (dialog.open) dialog.close(); $('img', dialog).removeAttribute('src'); }
  function closeShortcut() { $('#shortcut-popover').hidden = true; }
  function openShortcut() { closeContextMenu(); const pop = $('#shortcut-popover'); pop.hidden = false; $('[data-close-overlay]', pop).focus(); }
  function closeContextMenu(restore = false) { const menu = $('#context-menu'); if (menu.hidden) return false; menu.hidden = true; if (restore && context?.focusId) $(`[data-node-id="${context.focusId}"]`)?.focus(); context = null; return true; }
  function contextItems(node) {
    if (!node) return [{label: '上传图片', action: 'upload'}, {label: '新建生图', action: 'request'}, {label: '粘贴', action: 'paste', disabled: !canvasClipboard}, {label: '适应内容', action: 'fit'}, {label: '快捷键', action: 'shortcuts'}];
    const common = [{label: '复制', action: 'copy'}, {label: '从画布移除', action: 'remove'}];
    if (node.type === 'generation_request') return [...common, {label: node.expanded ? '收起' : '展开', action: 'toggle'}];
    return [...common, {label: '打开大图', action: 'open', disabled: !(node.src || node.artifactUrl)}, {label: '下载', action: 'download', disabled: !(node.src || node.artifactUrl)}, {label: '从此图创建生图', action: 'derive'}];
  }
  function openContextMenu(event, node) { event.preventDefault(); closeShortcut(); activePickerId = ''; const menu = $('#context-menu'); const point = worldPoint(event.clientX, event.clientY); context = {nodeId: node?.id || '', point, focusId: node?.id || ''}; menu.innerHTML = contextItems(node).map(item => `<button type="button" role="menuitem" data-context-action="${item.action}" ${item.disabled ? 'disabled' : ''}>${item.label}</button>`).join(''); menu.hidden = false; const margin = 8; const rect = menu.getBoundingClientRect(); menu.style.left = `${Math.max(margin, Math.min(event.clientX, innerWidth - rect.width - margin))}px`; menu.style.top = `${Math.max(margin, Math.min(event.clientY, innerHeight - rect.height - margin))}px`; menu.focus(); $('button:not(:disabled)', menu)?.focus(); }
  function runContextAction(action) { const node = nodeById(context?.nodeId); const point = context?.point; if (action === 'upload') { pendingUploadPoint = point; $('#canvas-upload').click(); } else if (action === 'request') addRequest(point.x, point.y); else if (action === 'paste') pasteClipboard(point); else if (action === 'fit') fitView(); else if (action === 'shortcuts') openShortcut(); else if (node) { if (action === 'copy') { if (!state.selectedIds.has(node.id)) state.selectedIds = new Set([node.id]); copySelection(); } else if (action === 'remove') removeIds(state.selectedIds.has(node.id) ? state.selectedIds : [node.id]); else if (action === 'toggle') { node.expanded = !node.expanded; render(); scheduleSave(); } else if (action === 'open') openViewer(node); else if (action === 'download') { const a = document.createElement('a'); a.href = `${node.artifactUrl || node.src}?download=true`; a.download = ''; a.click(); } else if (action === 'derive') addRequest(node.x + node.width + 120, node.y, {inputId: node.id, parentGenerationId: node.generationId || '', profileId: node.profileId, ratio: node.parameters?.ratio, resolution: node.parameters?.resolution}); } closeContextMenu(); }

  function setPickerOpen(node, open) {
    if (activePickerId && activePickerId !== node.id) {
      const old = $(`[data-node-id="${activePickerId}"]`); $('[data-model-trigger]', old)?.setAttribute('aria-expanded', 'false'); const oldMenu = $('.model-menu', old); if (oldMenu) oldMenu.hidden = true;
    }
    activePickerId = open ? node.id : '';
    const root = $(`[data-node-id="${node.id}"]`); const trigger = $('[data-model-trigger]', root); const menu = $('.model-menu', root);
    trigger?.setAttribute('aria-expanded', String(open)); if (menu) menu.hidden = !open;
    if (open) requestAnimationFrame(() => $('[role="option"]:not(:disabled)', menu)?.focus());
  }
  function closeActivePicker() { if (!activePickerId) return false; const node = nodeById(activePickerId); if (node) setPickerOpen(node, false); else activePickerId = ''; return true; }
  function selectProfile(node, profileId) {
    const old = comboValue(node.ratio, node.resolution); const profile = profileById(profileId); if (!profile?.enabled) return;
    node.profileId = profile.id; node.provider = profile.provider; const valid = combos(profile); const chosen = valid.find(item => item.value === old) || valid[0];
    node.ratio = chosen?.ratio || '1:1'; node.resolution = chosen?.resolution || '2K'; node.quality = profile.qualities?.includes(node.quality) ? node.quality : (profile.qualities?.[0] || 'standard');
    const root = $(`[data-node-id="${node.id}"]`); const trigger = $('[data-model-trigger]', root); const combo = $('[data-field="combo"]', root);
    $('span', trigger).textContent = `${providerLabel(profile.provider)} · ${profile.label}`;
    $$('[role="option"]', root).forEach(option => { const selected = option.dataset.profileOption === profile.id; option.setAttribute('aria-selected', String(selected)); $('b', option)?.remove(); if (selected) option.insertAdjacentHTML('beforeend', '<b aria-hidden="true">✓</b>'); });
    if (combo) { combo.innerHTML = valid.map(item => `<option value="${item.value}" ${item.value === comboValue(node.ratio, node.resolution) ? 'selected' : ''}>${item.ratio} · ${item.resolution}</option>`).join(''); combo.value = comboValue(node.ratio, node.resolution); }
    setPickerOpen(node, false); if (!valid.some(item => item.value === old)) toast('已切换为该模型支持的默认尺寸'); scheduleSave(); trigger?.focus({preventScroll: true});
  }
  function activateImageNode(node) { const now = performance.now(); if (lastActivation.id === node.id && now - lastActivation.time < 430) { lastActivation = {id: '', time: 0}; openViewer(node); } else lastActivation = {id: node.id, time: now}; }

  document.addEventListener('DOMContentLoaded', async () => {
    try { const payload = await responseJson(await fetch(`/api/projects/${projectId}/canvas`)); importLegacy(payload.state || {}); } catch (error) { toast(error.message, true); }
    render(); await applyHistoryQuery(); startPolling(); document.fonts?.ready.then(scheduleLinks);
    const collapsed = localStorage.getItem('image-hub-sidebar-collapsed') === 'true'; $('#workspace-layout').classList.toggle('sidebar-collapsed', collapsed); $('#sidebar-collapse').setAttribute('aria-expanded', String(!collapsed));
    if (matchMedia('(max-width: 420px)').matches) { $('#minimap-map').hidden = true; $('#minimap-toggle').setAttribute('aria-expanded', 'false'); }
    const viewport = $('#canvas-viewport');
    $('#canvas-upload').addEventListener('change', event => { const rect = viewport.getBoundingClientRect(); const point = pendingUploadPoint || worldPoint(rect.left + 180, rect.top + 150); pendingUploadPoint = null; addFiles(event.target.files, point); event.target.value = ''; });
    $('#add-request').addEventListener('click', () => { const rect = viewport.getBoundingClientRect(); const p = worldPoint(rect.left + rect.width / 2 - 175, rect.top + 140); addRequest(p.x, p.y); });
    $('[data-empty-action="request"]').addEventListener('click', () => $('#add-request').click());
    $('#fit-view').addEventListener('click', fitView); $('#zoom-in').addEventListener('click', () => zoomAt(state.viewport.zoom + .1, innerWidth / 2, innerHeight / 2)); $('#zoom-out').addEventListener('click', () => zoomAt(state.viewport.zoom - .1, innerWidth / 2, innerHeight / 2)); $('#zoom-reset').addEventListener('click', () => zoomAt(1, innerWidth / 2, innerHeight / 2));
    viewport.addEventListener('dragover', event => { event.preventDefault(); viewport.classList.add('file-over'); }); viewport.addEventListener('dragleave', () => viewport.classList.remove('file-over')); viewport.addEventListener('drop', event => { event.preventDefault(); viewport.classList.remove('file-over'); if (event.dataTransfer.files.length) addFiles(event.dataTransfer.files, worldPoint(event.clientX, event.clientY)); });
    viewport.addEventListener('wheel', event => { event.preventDefault(); zoomAt(state.viewport.zoom * (event.deltaY < 0 ? 1.08 : .92), event.clientX, event.clientY); }, {passive: false});
    viewport.addEventListener('pointerdown', event => { closeContextMenu(); const nodeEl = event.target.closest('.canvas-node'); const node = nodeEl && nodeById(nodeEl.dataset.nodeId); if (event.target.closest('.output-port') && node) return beginConnection(event, node); if (node) return startNodeDrag(event, node); if (event.button === 0 && (event.target === viewport || event.target.closest('.canvas-world'))) { pan = {pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: state.viewport.x, y: state.viewport.y, moved: false}; viewport.setPointerCapture?.(event.pointerId); } });
    viewport.addEventListener('pointermove', movePointer); viewport.addEventListener('pointerup', endPointer); viewport.addEventListener('pointercancel', event => { cancelConnection(); if (drag?.pointerId === event.pointerId) drag = null; if (pan?.pointerId === event.pointerId) pan = null; });
    viewport.addEventListener('contextmenu', event => { const el = event.target.closest('.canvas-node'); openContextMenu(event, el ? nodeById(el.dataset.nodeId) : null); });
    $('#canvas-nodes').addEventListener('dblclick', event => { const el = event.target.closest('.image-node'); const node = el && nodeById(el.dataset.nodeId); if (node) openViewer(node); });
    $('#canvas-nodes').addEventListener('focusin', event => { const root = event.target.closest('.request-node.expanded'); if (root && event.target.closest('textarea,select,input,button,[role="option"],[role="combobox"]')) activateRequestInPlace(nodeById(root.dataset.nodeId)); });
    $('#canvas-nodes').addEventListener('input', event => { const node = nodeById(event.target.closest('.canvas-node')?.dataset.nodeId); if (node && event.target.dataset.field === 'prompt') { node.prompt = event.target.value; scheduleSave(); scheduleLinks(); } });
    $('#canvas-nodes').addEventListener('change', event => { const node = nodeById(event.target.closest('.canvas-node')?.dataset.nodeId); if (!node) return; activateRequestInPlace(node); const field = event.target.dataset.field; if (field === 'combo') [node.ratio, node.resolution] = event.target.value.split('|'); else if (field === 'count') node.count = Number(event.target.value); else if (field === 'quality') node.quality = event.target.value; scheduleSave(); });
    $('#canvas-nodes').addEventListener('click', event => {
      if (suppressClick) { suppressClick = false; return; }
      const el = event.target.closest('.canvas-node'); const node = el && nodeById(el.dataset.nodeId); if (!node) return;
      if (event.target.closest('[data-delete-node]')) removeIds([node.id]);
      else if (event.target.closest('[data-toggle-request]')) { node.expanded = !node.expanded; render(); scheduleSave(); }
      else if (event.target.closest('[data-remove-input]')) { node.orderedInputIds = node.orderedInputIds.filter(id => id !== event.target.closest('[data-remove-input]').dataset.removeInput); render(); scheduleSave(); }
      else if (event.target.closest('[data-reselect-image]')) reselectImage(node);
      else if (event.target.closest('[data-generate]')) generate(node);
      else if (event.target.closest('[data-sentiment]')) setSentiment(node, event.target.closest('[data-sentiment]').dataset.sentiment, event.target.closest('[data-sentiment]'));
      else if (event.target.closest('[data-retry]')) retry(node);
      else if (event.target.closest('[data-open-viewer]')) openViewer(node);
      else if (event.target.closest('[data-model-trigger]')) { activateRequestInPlace(node); setPickerOpen(node, activePickerId !== node.id); }
      else if (event.target.closest('[data-profile-option]')) selectProfile(node, event.target.closest('[data-profile-option]').dataset.profileOption);
      else if (node.type === 'generation_request' && node.expanded && event.target.closest('textarea,select,input,button,[role="option"],[role="combobox"]')) activateRequestInPlace(node);
      else { if (event.detail === 0 || pointerSelectionId !== node.id) selectNode(node.id, event.shiftKey); pointerSelectionId = ''; if (['image', 'generation_result'].includes(node.type)) activateImageNode(node); }
    });
    let draggedInput = null; $('#canvas-nodes').addEventListener('dragstart', event => { const row = event.target.closest('[data-input-id]'); if (!row) { event.preventDefault(); return; } draggedInput = {requestId: row.dataset.requestId, sourceId: row.dataset.inputId}; event.dataTransfer.effectAllowed = 'move'; }); $('#canvas-nodes').addEventListener('dragover', event => { if (draggedInput && event.target.closest('[data-input-id]')) event.preventDefault(); }); $('#canvas-nodes').addEventListener('drop', event => { const row = event.target.closest('[data-input-id]'); if (row && draggedInput) { event.preventDefault(); reorderInput(draggedInput.requestId, draggedInput.sourceId, row.dataset.inputId); draggedInput = null; } }); $('#canvas-nodes').addEventListener('dragend', () => { draggedInput = null; });

    $('#context-menu').addEventListener('click', event => { const action = event.target.closest('[data-context-action]')?.dataset.contextAction; if (action) runContextAction(action); });
    $('#context-menu').addEventListener('keydown', event => { const items = $$('[role="menuitem"]:not(:disabled)', event.currentTarget); const index = items.indexOf(document.activeElement); if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); } else if (event.key === 'Home') items[0]?.focus(); else if (event.key === 'End') items.at(-1)?.focus(); });
    document.addEventListener('pointerdown', event => { if (!event.target.closest('#context-menu')) closeContextMenu(); if (!event.target.closest('.model-picker')) closeActivePicker(); });
    document.addEventListener('keydown', event => {
      const editable = core.isEditableTarget(event.target); const meta = event.ctrlKey || event.metaKey; const canvasFocused = viewport === document.activeElement || Boolean(document.activeElement?.closest?.('.canvas-node'));
      if (event.key === 'Escape') { let closed = cancelConnection(); closed = closeContextMenu(true) || closed; closed = closeActivePicker() || closed; if ($('#workspace-layout').classList.contains('drawer-open')) { setProjectDrawer(false); closed = true; } if (!$('#shortcut-popover').hidden) { closeShortcut(); closed = true; } if ($('#image-viewer').open) { closeViewer(); closed = true; } if ($('#new-project-dialog').open) { $('#new-project-dialog').close(); closed = true; } if (closed) { escapeArmed = true; event.preventDefault(); return; } if (escapeArmed || state.selectedIds.size) { clearSelection(); escapeArmed = false; event.preventDefault(); } return; }
      if (editable) return;
      if (event.key === '?' ) { event.preventDefault(); openShortcut(); return; }
      if (meta && event.key.toLowerCase() === 'c' && canvasFocused) { event.preventDefault(); copySelection(); }
      else if (meta && event.key.toLowerCase() === 'v' && canvasFocused) { event.preventDefault(); pasteClipboard(); }
      else if (meta && event.key.toLowerCase() === 'a' && canvasFocused) { event.preventDefault(); state.selectedIds = new Set(state.nodes.map(node => node.id)); render(); }
      else if ((event.key === 'Delete' || event.key === 'Backspace') && canvasFocused && state.selectedIds.size) { event.preventDefault(); removeIds(state.selectedIds); }
      else if (event.key === '0' && canvasFocused) { event.preventDefault(); fitView(); }
      else if ((event.key === '+' || event.key === '=') && canvasFocused) { event.preventDefault(); zoomAt(state.viewport.zoom + .1, innerWidth / 2, innerHeight / 2); }
      else if ((event.key === '-' || event.key === '_') && canvasFocused) { event.preventDefault(); zoomAt(state.viewport.zoom - .1, innerWidth / 2, innerHeight / 2); }
    });
    $('#canvas-nodes').addEventListener('keydown', event => { if (!event.target.matches('[role="option"]')) return; const items = $$('[role="option"]:not(:disabled)', event.target.closest('.model-menu')); const index = items.indexOf(event.target); if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); } else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.target.click(); } });

    $('#mobile-projects-button').addEventListener('click', () => setProjectDrawer(!$('#workspace-layout').classList.contains('drawer-open')));
    $('#project-scrim').addEventListener('click', () => setProjectDrawer(false));
    $('#sidebar-collapse').addEventListener('click', () => setSidebarCollapsed(!$('#workspace-layout').classList.contains('sidebar-collapsed')));
    $$('[data-new-project]').forEach(button => button.addEventListener('click', openNewProjectDialog));
    $('#project-sidebar').addEventListener('click', event => { if (event.target.closest('a')) setProjectDrawer(false); });
    $$('[data-close-dialog]').forEach(button => button.addEventListener('click', () => $('#new-project-dialog').close())); $$('[data-close-viewer]').forEach(button => button.addEventListener('click', closeViewer)); $('[data-close-overlay]').addEventListener('click', closeShortcut);
    $('#new-project-dialog').addEventListener('click', event => { if (event.target === event.currentTarget) event.currentTarget.close(); }); $('#image-viewer').addEventListener('click', event => { if (event.target === event.currentTarget) closeViewer(); });
    $('#minimap-toggle').addEventListener('click', () => { const svg = $('#minimap-map'); svg.hidden = !svg.hidden; $('#minimap-toggle').setAttribute('aria-expanded', String(!svg.hidden)); if (!svg.hidden) updateMinimap(); });
    $('#minimap-map').addEventListener('pointerdown', event => { event.preventDefault(); minimapDrag = event.pointerId; event.currentTarget.setPointerCapture?.(event.pointerId); recenterFromMinimap(event); }); $('#minimap-map').addEventListener('pointermove', event => { if (minimapDrag === event.pointerId) recenterFromMinimap(event); }); $('#minimap-map').addEventListener('pointerup', event => { if (minimapDrag === event.pointerId) { minimapDrag = null; scheduleSave(); } });
    window.addEventListener('resize', () => { if (!matchMedia('(max-width: 768px)').matches && $('#workspace-layout').classList.contains('drawer-open')) setProjectDrawer(false); scheduleLinks(); });
  });
})();
