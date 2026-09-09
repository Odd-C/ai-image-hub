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
  const state = {version: 3, viewport: {x: 0, y: 0, zoom: 1}, nodes: [], selectedId: '', connecting: null};
  const localFiles = new Map();
  const objectUrls = new Map();
  const extensionHooks = new Set();
  let saveTimer = null;
  let pollTimer = null;
  let drag = null;
  let pan = null;

  window.ImageHubResultActions = Object.freeze({
    register(handler) {
      if (typeof handler !== 'function') throw new TypeError('result action hook must be a function');
      extensionHooks.add(handler);
      return () => extensionHooks.delete(handler);
    },
  });

  function emitResult(item, event = 'refresh') {
    const context = Object.freeze({
      event, generationId: item.generationId || item.id, artifactUrl: item.artifactUrl || '',
      prompt: item.prompt || '', provider: item.provider || '', model: item.modelLabel || '',
      parameters: Object.freeze({...item.parameters}), sentiment: item.sentiment || '',
    });
    extensionHooks.forEach(handler => { try { handler(context); } catch (error) { console.warn('结果扩展处理失败', error); } });
    window.dispatchEvent(new CustomEvent('imagehub:result-action', {detail: context}));
  }

  function uid(prefix) {
    const raw = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    return `${prefix}-${raw.replace(/[^a-z0-9]/gi, '')}`;
  }

  function escapeHtml(value = '') {
    const div = document.createElement('div'); div.textContent = String(value); return div.innerHTML;
  }

  function toast(message, error = false) {
    const node = $('#toast'); node.textContent = message; node.className = `toast show${error ? ' error' : ''}`;
    window.setTimeout(() => { node.className = 'toast'; }, 2600);
  }

  async function responseJson(response) {
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) location.href = '/login';
    if (!response.ok) throw new Error(payload.detail || '操作失败');
    return payload;
  }

  function profileById(id) { return core.profileById(models, id); }
  function comboValue(ratio, resolution) { return `${ratio}|${resolution}`; }
  function combos(profile) {
    if (!profile) return [];
    return profile.ratios.flatMap(ratio => profile.resolutions.map(resolution => ({ratio, resolution, value: comboValue(ratio, resolution)})));
  }
  function worldPoint(clientX, clientY) {
    const rect = $('#canvas-viewport').getBoundingClientRect();
    return {x: (clientX - rect.left - state.viewport.x) / state.viewport.zoom, y: (clientY - rect.top - state.viewport.y) / state.viewport.zoom};
  }
  function nodeById(id) { return state.nodes.find(node => node.id === id); }
  function sourceNode(id) { const node = nodeById(id); return node && (node.type === 'image' || (node.type === 'generation_result' && node.status === 'succeeded')) ? node : null; }
  function requestNodes() { return state.nodes.filter(node => node.type === 'generation_request'); }

  function serializeNode(node) {
    const copy = {...node};
    if (copy.localOnly) copy.src = '';
    delete copy.uploading;
    return copy;
  }
  function scheduleSave() {
    $('#save-state').innerHTML = '<i></i>保存中';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveCanvas, 450);
  }
  async function saveCanvas() {
    try {
      await responseJson(await fetch(`/api/projects/${projectId}/canvas`, {
        method: 'PUT', headers: {'Content-Type': 'application/json', ...csrfHeaders},
        body: JSON.stringify({version: 3, viewport: state.viewport, nodes: state.nodes.map(serializeNode)}),
      }));
      $('#save-state').innerHTML = '<i></i>已保存';
    } catch (error) { $('#save-state').innerHTML = '<i class="error"></i>保存失败'; console.warn('画布保存失败', error); }
  }

  function defaultRequest(x, y, inherited = {}) {
    const profile = core.chooseRequestProfile(models, inherited.profileId || '');
    const firstCombo = combos(profile)[0] || {ratio: '1:1', resolution: '2K'};
    const compatible = combos(profile).find(item => item.ratio === inherited.ratio && item.resolution === inherited.resolution) || firstCombo;
    return {
      id: uid('request'), type: 'generation_request', x, y, width: 350, expanded: true,
      prompt: inherited.prompt || '', profileId: profile?.id || inherited.profileId || '', ratio: compatible.ratio,
      resolution: compatible.resolution, quality: inherited.quality || profile?.qualities?.[0] || 'standard', count: 1,
      profileUnavailable: Boolean(inherited.profileId && !profile),
      orderedInputIds: inherited.inputId ? [inherited.inputId] : [], parentGenerationId: inherited.parentGenerationId || '',
    };
  }

  function addRequest(x, y, inherited = {}) {
    const node = defaultRequest(x, y, inherited); state.nodes.push(node); state.selectedId = node.id;
    render(); scheduleSave(); requestAnimationFrame(() => $(`[data-node-id="${node.id}"] textarea`)?.focus()); return node;
  }

  function addInput(requestId, sourceId) {
    const request = nodeById(requestId);
    if (!request || request.type !== 'generation_request' || !sourceNode(sourceId)) return false;
    request.orderedInputIds ||= [];
    if (request.orderedInputIds.includes(sourceId)) return false;
    request.orderedInputIds.push(sourceId); render(); scheduleSave(); return true;
  }

  function removeNode(id) {
    const index = state.nodes.findIndex(node => node.id === id); if (index < 0) return;
    const [removed] = state.nodes.splice(index, 1);
    if (removed.type === 'image' || removed.type === 'generation_result') {
      requestNodes().forEach(request => { request.orderedInputIds = (request.orderedInputIds || []).filter(inputId => inputId !== id); });
    }
    if (objectUrls.has(id)) URL.revokeObjectURL(objectUrls.get(id));
    objectUrls.delete(id); localFiles.delete(id); render(); scheduleSave();
  }

  function requestMarkup(node) {
    const profile = profileById(node.profileId);
    const inputRows = (node.orderedInputIds || []).map((id, index) => {
      const source = nodeById(id); if (!source) return '';
      return `<li draggable="true" data-input-id="${id}" data-request-id="${node.id}"><span class="input-index">图${index + 1}</span><img src="${escapeHtml(source.src || '')}" alt=""><span class="drag-label">拖动排序</span><button type="button" data-remove-input="${id}" aria-label="移除图${index + 1}">×</button></li>`;
    }).join('');
    const unavailableOption = !profile && node.profileId ? `<option value="${escapeHtml(node.profileId)}" selected disabled>原模型已不可用</option>` : '';
    const modelOptions = unavailableOption + models.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === node.profileId ? 'selected' : ''} ${item.enabled ? '' : 'disabled'}>${escapeHtml(providerNames[item.provider] || item.provider)} · ${escapeHtml(item.label)}${item.enabled ? '' : '（未配置）'}</option>`).join('');
    const comboOptions = combos(profile).map(item => `<option value="${item.value}" ${item.ratio === node.ratio && item.resolution === node.resolution ? 'selected' : ''}>${item.ratio} · ${item.resolution}</option>`).join('');
    const quality = profile?.qualities?.length > 1 ? `<details class="more-settings"><summary>更多设置</summary><label>质量<select data-field="quality">${profile.qualities.map(value => `<option ${value === node.quality ? 'selected' : ''}>${escapeHtml(value)}</option>`).join('')}</select></label></details>` : '';
    const availability = core.requestAvailability(profile);
    const unavailable = availability.enabled ? '' : `<p class="unavailable-model" role="status">${escapeHtml(availability.message)}</p>`;
    return `<article class="canvas-node request-node ${node.expanded ? 'expanded' : ''} ${state.selectedId === node.id ? 'selected' : ''}" data-node-id="${node.id}" data-node-type="generation_request" tabindex="-1" style="left:${node.x}px;top:${node.y}px;width:${node.width}px">
      <button class="input-port" type="button" aria-label="参考图输入端口" title="拖入参考图"></button>
      <header class="node-header drag-handle"><div><span>生图器</span><small>${(node.orderedInputIds || []).length} 张输入</small></div><div><button type="button" data-toggle-request aria-label="${node.expanded ? '收起' : '展开'}生图器">${node.expanded ? '−' : '+'}</button><button type="button" data-delete-node aria-label="删除生图器">×</button></div></header>
      <div class="request-body">
        ${inputRows ? `<ol class="request-inputs">${inputRows}</ol>` : '<p class="no-inputs">无参考图，可直接文生图</p>'}
        <label class="prompt-label">提示词<textarea data-field="prompt" maxlength="12000" required placeholder="描述要生成或修改的画面">${escapeHtml(node.prompt)}</textarea></label>
        <label>平台 · 模型<select data-field="profileId">${modelOptions}</select></label>
        <div class="request-settings"><label>比例 · 分辨率<select data-field="combo">${comboOptions}</select></label><label>数量<select data-field="count">${[1,2,3,4].map(value => `<option value="${value}" ${value === Number(node.count) ? 'selected' : ''}>${value} 张</option>`).join('')}</select></label></div>
        ${quality}${unavailable}
        <button class="generate-button" type="button" data-generate ${availability.enabled ? '' : 'disabled'}>生成图片</button>
      </div>
    </article>`;
  }

  function sentimentMarkup(node) {
    if (node.status !== 'succeeded') return '';
    return `<div class="sentiment-actions" aria-label="结果评价">${Object.entries(sentimentNames).map(([key, label]) => `<button type="button" data-sentiment="${key}" class="${node.sentiment === key ? 'selected' : ''}" aria-label="${label}" aria-pressed="${node.sentiment === key}" title="${label}"><svg viewBox="0 0 24 24" aria-hidden="true">${key === 'adopted' ? '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z"/>' : key === 'satisfied' ? '<path d="M7 10v10H4V10h3Zm3 10V9l3-6 2 1v5h4a2 2 0 0 1 2 2l-2 9h-9Z"/>' : '<path d="M7 14V4H4v10h3Zm3-10v11l3 6 2-1v-5h4a2 2 0 0 0 2-2l-2-9h-9Z"/>'}</svg><span>${label}</span></button>`).join('')}</div>`;
  }

  function mediaMarkup(node) {
    if (node.type === 'image') {
      if (node.needsReselect || (node.localOnly && !localFiles.has(node.id))) {
        return '<div class="result-state upload-missing"><strong>需要重新选择图片</strong><small>浏览器刷新后无法恢复本地文件内容</small><button type="button" data-reselect-image>重新选择</button></div>';
      }
      return `<img src="${escapeHtml(node.src || '')}" alt="${escapeHtml(node.name || '参考图片')}">`;
    }
    if (node.status === 'succeeded' && node.artifactUrl) return `<img src="${escapeHtml(node.artifactUrl)}" alt="生成结果">`;
    return `<div class="result-state ${escapeHtml(node.status)}"><span class="status-spinner"></span><strong>${escapeHtml(statusNames[node.status] || node.status)}</strong>${node.error ? `<small>${escapeHtml(node.error)}</small>` : ''}</div>`;
  }

  function imageMarkup(node) {
    const result = node.type === 'generation_result';
    const actions = result ? `<footer class="result-footer"><span>${escapeHtml((providerNames[node.provider] || node.provider || '') + (node.modelLabel ? ` · ${node.modelLabel}` : ''))}</span><div>${node.artifactUrl ? `<a href="${escapeHtml(node.artifactUrl)}" target="_blank" rel="noopener">打开原图</a><a href="${escapeHtml(node.artifactUrl)}?download=true" download>下载</a>` : ''}${node.canRetry ? '<button type="button" data-retry>安全重试</button>' : ''}</div></footer>${sentimentMarkup(node)}` : '';
    const canConnect = node.type === 'image' || node.status === 'succeeded';
    return `<article class="canvas-node image-node ${result ? 'result-node' : ''} ${state.selectedId === node.id ? 'selected' : ''}" data-node-id="${node.id}" data-node-type="${node.type}" tabindex="-1" style="left:${node.x}px;top:${node.y}px;width:${node.width}px">
      <header class="image-node-bar drag-handle"><span>${result ? '生成结果' : escapeHtml(node.name || '参考图片')}</span><button type="button" data-delete-node aria-label="从画布移除">×</button></header>
      <div class="image-frame" style="aspect-ratio:${node.aspect || '4/3'}">${mediaMarkup(node)}</div>${actions}
      ${canConnect ? '<button class="output-port" type="button" aria-label="从这张图片创建连接" title="拖动连接到生图器"></button>' : ''}
    </article>`;
  }

  function nodeCenter(node, side) {
    const el = $(`[data-node-id="${node.id}"]`); const height = el?.offsetHeight || (node.type === 'generation_request' ? 430 : 260);
    return {x: node.x + (side === 'right' ? node.width : 0), y: node.y + Math.min(height / 2, 150)};
  }
  function curvePath(a, b) { const bend = Math.max(70, Math.abs(b.x - a.x) * .45); return `M ${a.x} ${a.y} C ${a.x + bend} ${a.y}, ${b.x - bend} ${b.y}, ${b.x} ${b.y}`; }
  function renderLinks() {
    const lines = [];
    requestNodes().forEach(request => (request.orderedInputIds || []).forEach((sourceId, index) => {
      const source = sourceNode(sourceId); if (!source) return;
      lines.push(`<path class="input-link" data-order="${index + 1}" d="${curvePath(nodeCenter(source, 'right'), nodeCenter(request, 'left'))}"/><text x="${nodeCenter(request, 'left').x - 18}" y="${nodeCenter(request, 'left').y - 9 - index * 13}">${index + 1}</text>`);
    }));
    state.nodes.filter(node => node.type === 'generation_result' && node.requestId && nodeById(node.requestId)).forEach(result => {
      lines.push(`<path class="derived-link" d="${curvePath(nodeCenter(nodeById(result.requestId), 'right'), nodeCenter(result, 'left'))}"/>`);
    });
    if (state.connecting) lines.push(`<path class="temporary-link" d="${curvePath(state.connecting.start, state.connecting.current)}"/>`);
    $('#canvas-links').innerHTML = lines.join('');
  }
  function applyViewport() {
    $('#canvas-world').style.transform = `translate(${state.viewport.x}px,${state.viewport.y}px) scale(${state.viewport.zoom})`;
    $('#zoom-reset').textContent = `${Math.round(state.viewport.zoom * 100)}%`;
  }
  function render() {
    $('#canvas-nodes').innerHTML = state.nodes.map(node => node.type === 'generation_request' ? requestMarkup(node) : imageMarkup(node)).join('');
    $('#canvas-empty').hidden = state.nodes.length > 0; applyViewport(); requestAnimationFrame(renderLinks);
  }

  async function imageSize(src) {
    return new Promise(resolve => { const image = new Image(); image.onload = () => resolve({w:image.naturalWidth,h:image.naturalHeight}); image.onerror = () => resolve({w:4,h:3}); image.src = src; });
  }

  async function addFiles(files, point) {
    const valid = [...files].filter(file => /^image\/(png|jpeg|webp)$/.test(file.type));
    for (let index = 0; index < valid.length; index += 1) {
      const file = valid[index]; const id = uid('image'); const src = URL.createObjectURL(file);
      const size = await imageSize(src);
      const width = 280; state.nodes.push({id, type:'image', x:point.x + index * 32, y:point.y + index * 32, width, aspect:`${size.w}/${size.h}`, src, name:file.name, localOnly:true, needsReselect:false});
      localFiles.set(id, file); objectUrls.set(id, src);
    }
    render(); scheduleSave();
  }

  function reselectImage(node) {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/png,image/jpeg,image/webp';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file || !/^image\/(png|jpeg|webp)$/.test(file.type)) return;
      if (objectUrls.has(node.id)) URL.revokeObjectURL(objectUrls.get(node.id));
      const src = URL.createObjectURL(file); const size = await imageSize(src);
      localFiles.set(node.id, file); objectUrls.set(node.id, src);
      node.src = src; node.name = file.name; node.aspect = `${size.w}/${size.h}`;
      node.localOnly = true; node.needsReselect = false;
      render(); scheduleSave();
    }, {once:true});
    input.click();
  }

  function cancelConnection() { if (!state.connecting) return; state.connecting = null; renderLinks(); }
  function beginConnection(event, node) {
    event.preventDefault(); event.stopPropagation();
    const start = nodeCenter(node, 'right'); state.connecting = {sourceId: node.id, pointerId: event.pointerId, start, current:start};
    event.currentTarget.setPointerCapture?.(event.pointerId); renderLinks();
  }
  function finishConnection(event) {
    if (!state.connecting || event.pointerId !== state.connecting.pointerId) return;
    const connection = state.connecting; state.connecting = null;
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('.request-node');
    if (target) addInput(target.dataset.nodeId, connection.sourceId);
    else {
      const overInvalid = document.elementFromPoint(event.clientX, event.clientY)?.closest('.canvas-node,.canvas-toolbar,.workspace-bar');
      const viewport = document.elementFromPoint(event.clientX, event.clientY)?.closest('#canvas-viewport');
      if (viewport && !overInvalid) { const point = worldPoint(event.clientX, event.clientY); const source = sourceNode(connection.sourceId); addRequest(point.x, point.y, {inputId:source.id, parentGenerationId:source.generationId || '', profileId:source.profileId, ratio:source.parameters?.ratio, resolution:source.parameters?.resolution}); }
      else renderLinks();
    }
  }

  function startNodeDrag(event, node) {
    if (event.button !== 0 || event.target.closest('button,input,textarea,select,a,summary,.output-port,.input-port')) return;
    event.preventDefault(); event.stopPropagation();
    drag = {id:node.id, pointerId:event.pointerId, startX:event.clientX, startY:event.clientY, x:node.x, y:node.y};
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }
  function movePointer(event) {
    if (state.connecting && event.pointerId === state.connecting.pointerId) { state.connecting.current = worldPoint(event.clientX, event.clientY); renderLinks(); return; }
    if (drag && event.pointerId === drag.pointerId) { const node=nodeById(drag.id); node.x=drag.x+(event.clientX-drag.startX)/state.viewport.zoom; node.y=drag.y+(event.clientY-drag.startY)/state.viewport.zoom; const el=$(`[data-node-id="${node.id}"]`); if(el){el.style.left=`${node.x}px`;el.style.top=`${node.y}px`;} renderLinks(); return; }
    if (pan && event.pointerId === pan.pointerId) { state.viewport.x=pan.x+event.clientX-pan.startX; state.viewport.y=pan.y+event.clientY-pan.startY; applyViewport(); }
  }
  function endPointer(event) { if (state.connecting) finishConnection(event); if (drag && event.pointerId===drag.pointerId){drag=null;scheduleSave();} if(pan&&event.pointerId===pan.pointerId){pan=null;scheduleSave();} }

  function reorderInput(requestId, sourceId, beforeId) {
    const request=nodeById(requestId); if(!request) return;
    const list=request.orderedInputIds.filter(id=>id!==sourceId); const target=list.indexOf(beforeId); list.splice(target<0?list.length:target,0,sourceId); request.orderedInputIds=list; render(); scheduleSave();
  }

  async function sourceFile(node) {
    if (localFiles.has(node.id)) return localFiles.get(node.id);
    if (node?.type === 'image' && node.localOnly) throw new Error('本地参考图需要重新选择后才能生成');
    if (!node?.artifactUrl) throw new Error('参考图刷新后不可用，请重新选择');
    const response = await fetch(node.artifactUrl); if (!response.ok) throw new Error('无法读取历史结果原图');
    const blob = await response.blob(); return new File([blob], `generation-${node.generationId || node.id}.${blob.type.includes('png')?'png':blob.type.includes('webp')?'webp':'jpg'}`, {type:blob.type});
  }

  async function submitOne(request, resultNode) {
    const data = new FormData();
    data.append('prompt', request.prompt.trim()); data.append('profile_id', request.profileId); data.append('ratio', request.ratio); data.append('resolution', request.resolution); data.append('quality', request.quality || 'standard');
    data.append('parent_generation_id', request.parentGenerationId || ''); data.append('idempotency_key', uid('generation').replace(/-/g,'').slice(0,64));
    for (const id of request.orderedInputIds || []) data.append('references', await sourceFile(sourceNode(id)));
    const payload = await responseJson(await fetch(`/api/projects/${projectId}/generations`, {method:'POST',headers:csrfHeaders,body:data}));
    resultNode.generationId=payload.id; resultNode.status=payload.status; scheduleSave(); return payload;
  }

  async function generate(request) {
    if (!request.prompt.trim()) { toast('请先输入提示词', true); $(`[data-node-id="${request.id}"] textarea`)?.focus(); return; }
    const profile=profileById(request.profileId); if(!profile?.enabled){toast('当前模型不可用，请选择已启用模型',true);return;}
    const missingInput = core.firstMissingLocalInput(
      state.nodes, request, id => localFiles.has(id)
    );
    if (missingInput) { state.selectedId = missingInput.id; render(); toast('本地参考图需要重新选择后才能生成', true); $(`[data-node-id="${missingInput.id}"] [data-reselect-image]`)?.focus(); return; }
    const count=Math.max(1,Math.min(4,Number(request.count)||1));
    const baseX=request.x+request.width+140; const resultWidth=260;
    const results=Array.from({length:count},(_,index)=>({id:uid('result'),type:'generation_result',requestId:request.id,x:baseX+(index%2)*(resultWidth+36),y:request.y+Math.floor(index/2)*390,width:resultWidth,aspect:request.ratio.replace(':','/'),status:'queued',prompt:request.prompt,profileId:request.profileId,provider:profile.provider,modelLabel:profile.label,parameters:{ratio:request.ratio,resolution:request.resolution,quality:request.quality},sentiment:''}));
    state.nodes.push(...results); render(); scheduleSave();
    await Promise.all(results.map(async result=>{try{await submitOne(request,result);}catch(error){result.status='failed';result.error=error.message;render();scheduleSave();}}));
    render(); startPolling();
  }

  function updateResults(items) {
    let changed=false; const byId=new Map(items.map(item=>[item.id,item]));
    state.nodes.filter(node=>node.type==='generation_result'&&node.generationId).forEach(node=>{
      const item=byId.get(node.generationId); if(!item)return;
      const before=`${node.status}|${node.artifactUrl}|${node.sentiment}`; node.status=item.status;node.artifactUrl=item.artifact_url;node.error=item.error;node.canRetry=item.can_retry;node.sentiment=item.sentiment||'';node.provider=item.provider;node.modelLabel=item.model_label;node.prompt=item.prompt;node.parameters=item.parameters;node.profileId=item.profile_id||`${item.provider}:${item.model_id}`;node.profileUnavailable=item.profile_available===false;node.parentGenerationId=item.parent_generation_id;
      if(before!==`${node.status}|${node.artifactUrl}|${node.sentiment}`){changed=true;emitResult(node);}
    });
    if(changed){render();scheduleSave();}
    return state.nodes.some(node=>node.type==='generation_result'&&['queued','running'].includes(node.status));
  }
  async function poll() {
    clearTimeout(pollTimer);
    try { const data=await responseJson(await fetch(`/api/projects/${projectId}/generations?limit=100`)); if(updateResults(data.items))pollTimer=setTimeout(poll,2500); }
    catch(error){console.warn('任务状态刷新失败',error);pollTimer=setTimeout(poll,5000);}
  }
  function startPolling(){poll();}

  async function setSentiment(node,value,button){
    if(!node.generationId)return; button.disabled=true;
    try{await responseJson(await fetch(`/api/projects/${projectId}/generations/${node.generationId}/sentiment`,{method:'POST',headers:{'Content-Type':'application/json',...csrfHeaders},body:JSON.stringify({sentiment:value})}));node.sentiment=value;render();scheduleSave();emitResult(node,'sentiment');toast(`已标记为${sentimentNames[value]}`);}catch(error){toast(error.message,true);button.disabled=false;}
  }
  async function retry(node){try{const data=await responseJson(await fetch(`/api/projects/${projectId}/generations/${node.generationId}/retry`,{method:'POST',headers:csrfHeaders}));node.status=data.status;node.error='';node.canRetry=false;render();scheduleSave();startPolling();}catch(error){toast(error.message,true);}}

  function importLegacy(payload) {
    const loaded=Array.isArray(payload.nodes)?payload.nodes:[];
    state.viewport={x:Number(payload.viewport?.x)||0,y:Number(payload.viewport?.y)||0,zoom:Number(payload.viewport?.zoom)||1};
    state.nodes=core.restoreCanvasNodes(loaded.filter(node=>['image','generation_request','generation_result'].includes(node.type)));
    if(!state.nodes.length&&payload.draft){const draft=payload.draft;state.nodes.push(defaultRequest(220,160,{profileId:draft.profile,ratio:draft.ratio,resolution:draft.resolution,prompt:draft.prompt}));}
  }

  function focusAndCenterNode(node) {
    const viewport = $('#canvas-viewport'); const rect = viewport.getBoundingClientRect();
    const height = $(`[data-node-id="${node.id}"]`)?.offsetHeight || 300;
    state.selectedId = node.id;
    state.viewport.x = rect.width / 2 - (node.x + node.width / 2) * state.viewport.zoom;
    state.viewport.y = rect.height / 2 - (node.y + height / 2) * state.viewport.zoom;
    render(); scheduleSave();
    requestAnimationFrame(() => $(`[data-node-id="${node.id}"]`)?.focus());
  }

  async function applyHistoryQuery() {
    const query = new URLSearchParams(location.search); const action = query.get('action');
    const generationId = query.get('generation');
    if (!generationId || !['locate', 'continue'].includes(action)) return;
    try {
      const item = await responseJson(await fetch(`/api/projects/${projectId}/generations/${generationId}`));
      const outcome = core.historyAction(state.nodes, item, action, uid);
      render();
      if (action === 'continue') {
        addRequest(outcome.result.x + outcome.result.width + 120, outcome.result.y, outcome.request);
      } else {
        focusAndCenterNode(outcome.result);
      }
      if (outcome.createdResult) scheduleSave();
    } catch (error) { toast(error.message, true); }
  }

  function fitView(){if(!state.nodes.length){state.viewport={x:0,y:0,zoom:1};applyViewport();return;}const minX=Math.min(...state.nodes.map(n=>n.x)),minY=Math.min(...state.nodes.map(n=>n.y)),maxX=Math.max(...state.nodes.map(n=>n.x+n.width)),maxY=Math.max(...state.nodes.map(n=>n.y+420));const rect=$('#canvas-viewport').getBoundingClientRect();const zoom=Math.max(.35,Math.min(1,(rect.width-100)/(maxX-minX),(rect.height-100)/(maxY-minY)));state.viewport={x:50-minX*zoom,y:50-minY*zoom,zoom};applyViewport();scheduleSave();}
  function zoomAt(next,cx,cy){const rect=$('#canvas-viewport').getBoundingClientRect();const old=state.viewport.zoom;const zoom=Math.max(.35,Math.min(1.8,next));const px=cx-rect.left,py=cy-rect.top;const wx=(px-state.viewport.x)/old,wy=(py-state.viewport.y)/old;state.viewport.x=px-wx*zoom;state.viewport.y=py-wy*zoom;state.viewport.zoom=zoom;applyViewport();renderLinks();scheduleSave();}

  document.addEventListener('DOMContentLoaded', async () => {
    try{const payload=await responseJson(await fetch(`/api/projects/${projectId}/canvas`));importLegacy(payload.state||{});}catch(error){toast(error.message,true);}render();await applyHistoryQuery();startPolling();
    const viewport=$('#canvas-viewport');
    $('#canvas-upload').addEventListener('change',event=>{const rect=viewport.getBoundingClientRect();addFiles(event.target.files,worldPoint(rect.left+180,rect.top+150));event.target.value='';});
    $('#add-request').addEventListener('click',()=>{const rect=viewport.getBoundingClientRect();const p=worldPoint(rect.left+rect.width/2-175,rect.top+140);addRequest(p.x,p.y);});
    $('[data-empty-action="request"]').addEventListener('click',()=>$('#add-request').click());
    $('#fit-view').addEventListener('click',fitView);$('#zoom-in').addEventListener('click',()=>zoomAt(state.viewport.zoom+.1,innerWidth/2,innerHeight/2));$('#zoom-out').addEventListener('click',()=>zoomAt(state.viewport.zoom-.1,innerWidth/2,innerHeight/2));$('#zoom-reset').addEventListener('click',()=>zoomAt(1,innerWidth/2,innerHeight/2));
    viewport.addEventListener('dragover',event=>{event.preventDefault();viewport.classList.add('file-over');});viewport.addEventListener('dragleave',()=>viewport.classList.remove('file-over'));viewport.addEventListener('drop',event=>{event.preventDefault();viewport.classList.remove('file-over');if(event.dataTransfer.files.length)addFiles(event.dataTransfer.files,worldPoint(event.clientX,event.clientY));});
    viewport.addEventListener('wheel',event=>{event.preventDefault();zoomAt(state.viewport.zoom*(event.deltaY<0?1.08:.92),event.clientX,event.clientY);},{passive:false});
    viewport.addEventListener('dblclick',event=>{if(event.target.closest('.canvas-node,.canvas-toolbar'))return;const p=worldPoint(event.clientX,event.clientY);addRequest(p.x,p.y);});
    viewport.addEventListener('pointerdown',event=>{const nodeEl=event.target.closest('.canvas-node');const node=nodeEl&&nodeById(nodeEl.dataset.nodeId);if(event.target.closest('.output-port')&&node)return beginConnection(event,node);if(node&&event.target.closest('.drag-handle'))return startNodeDrag(event,node);if(event.target===viewport||event.target.closest('.canvas-world')&&!node){pan={pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,x:state.viewport.x,y:state.viewport.y};viewport.setPointerCapture?.(event.pointerId);}});
    viewport.addEventListener('pointermove',movePointer);viewport.addEventListener('pointerup',endPointer);viewport.addEventListener('pointercancel',event=>{cancelConnection();if(drag&&drag.pointerId===event.pointerId)drag=null;if(pan&&pan.pointerId===event.pointerId)pan=null;});
    document.addEventListener('keydown',event=>{if(event.key==='Escape')cancelConnection();});
    $('#canvas-nodes').addEventListener('input',event=>{const el=event.target.closest('.canvas-node');const node=el&&nodeById(el.dataset.nodeId);if(!node)return;if(event.target.dataset.field==='prompt')node.prompt=event.target.value;scheduleSave();});
    $('#canvas-nodes').addEventListener('change',event=>{const el=event.target.closest('.canvas-node');const node=el&&nodeById(el.dataset.nodeId);if(!node)return;const field=event.target.dataset.field;if(field==='profileId'){const old=comboValue(node.ratio,node.resolution);node.profileId=event.target.value;const profile=profileById(node.profileId);const valid=combos(profile);const chosen=valid.find(item=>item.value===old)||valid[0];node.ratio=chosen?.ratio||'1:1';node.resolution=chosen?.resolution||'2K';node.quality=profile?.qualities?.includes(node.quality)?node.quality:(profile?.qualities?.[0]||'standard');render();if(!valid.some(item=>item.value===old))toast('已切换为该模型支持的默认尺寸');}else if(field==='combo'){[node.ratio,node.resolution]=event.target.value.split('|');}else if(field==='count')node.count=Number(event.target.value);else if(field==='quality')node.quality=event.target.value;scheduleSave();});
    $('#canvas-nodes').addEventListener('click',event=>{const el=event.target.closest('.canvas-node');const node=el&&nodeById(el.dataset.nodeId);if(!node)return;if(event.target.closest('[data-delete-node]'))removeNode(node.id);else if(event.target.closest('[data-toggle-request]')){node.expanded=!node.expanded;render();scheduleSave();}else if(event.target.closest('[data-remove-input]')){node.orderedInputIds=node.orderedInputIds.filter(id=>id!==event.target.closest('[data-remove-input]').dataset.removeInput);render();scheduleSave();}else if(event.target.closest('[data-reselect-image]'))reselectImage(node);else if(event.target.closest('[data-generate]'))generate(node);else if(event.target.closest('[data-sentiment]'))setSentiment(node,event.target.closest('[data-sentiment]').dataset.sentiment,event.target.closest('[data-sentiment]'));else if(event.target.closest('[data-retry]'))retry(node);});
    let draggedInput=null;$('#canvas-nodes').addEventListener('dragstart',event=>{const row=event.target.closest('[data-input-id]');if(row){draggedInput={requestId:row.dataset.requestId,sourceId:row.dataset.inputId};event.dataTransfer.effectAllowed='move';}});$('#canvas-nodes').addEventListener('dragover',event=>{if(draggedInput&&event.target.closest('[data-input-id]'))event.preventDefault();});$('#canvas-nodes').addEventListener('drop',event=>{const row=event.target.closest('[data-input-id]');if(row&&draggedInput){event.preventDefault();reorderInput(draggedInput.requestId,draggedInput.sourceId,row.dataset.inputId);draggedInput=null;}});$('#canvas-nodes').addEventListener('dragend',()=>{draggedInput=null;});
  });
})();
