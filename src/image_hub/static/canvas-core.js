(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ImageHubCanvasCore = Object.freeze(api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function profileById(models, id) {
    return models.find(item => item.id === id) || null;
  }

  function chooseRequestProfile(models, inheritedProfileId) {
    if (inheritedProfileId) return profileById(models, inheritedProfileId);
    return models.find(item => item.enabled) || null;
  }

  function requestAvailability(profile) {
    if (profile?.enabled) return {enabled: true, message: ''};
    return {enabled: false, message: '当前模型不可用。请联系管理员配置或选择其他已启用模型。'};
  }

  function historicalResult(item, uid) {
    const parameters = item.parameters || {};
    return {
      id: uid('result'), type: 'generation_result', generationId: item.id,
      x: 180, y: 150, width: 280,
      aspect: (parameters.ratio || '4:3').replace(':', '/'),
      status: item.status, artifactUrl: item.artifact_url, prompt: item.prompt,
      provider: item.provider, modelLabel: item.model_label,
      profileId: item.profile_id || '', profileUnavailable: item.profile_available === false,
      parameters, sentiment: item.sentiment || '',
      canRetry: item.can_retry, parentGenerationId: item.parent_generation_id || '',
      createdAt: item.created_at || '', inputCount: item.input_count || 0,
    };
  }

  function historyAction(nodes, item, action, uid) {
    if (action !== 'locate' && action !== 'continue') throw new Error(`Unsupported history action: ${action}`);
    let result = nodes.find(node => node.type === 'generation_result' && node.generationId === item.id);
    let createdResult = false;
    if (!result) { result = historicalResult(item, uid); nodes.push(result); createdResult = true; }
    if (action === 'locate') return {result, request: null, focusId: result.id, createdResult};
    const parameters = item.parameters || {};
    return {
      result,
      request: {
        prompt: item.prompt, profileId: item.profile_id || '', ratio: parameters.ratio,
        resolution: parameters.resolution, quality: parameters.quality, inputId: result.id,
        parentGenerationId: item.id,
      },
      focusId: '', createdResult,
    };
  }

  function firstMissingLocalInput(nodes, request, hasLocalFile) {
    const byId = new Map(nodes.map(node => [node.id, node]));
    for (const id of request.orderedInputIds || []) {
      const node = byId.get(id);
      if (node?.type === 'image' && node.localOnly && !hasLocalFile(id)) return node;
    }
    return null;
  }

  function restoreCanvasNodes(nodes) {
    return nodes.map(node => {
      const restored = {...node};
      if (restored.type === 'generation_request') restored.orderedInputIds = [...(restored.orderedInputIds || restored.referenceOrder || [])];
      if (restored.type === 'image' && restored.localOnly) { restored.src = ''; restored.needsReselect = true; }
      return restored;
    });
  }

  function isPresentationNode(node) {
    return Boolean(node && ['image', 'generation_request', 'generation_result'].includes(node.type));
  }

  function clonePresentationNodes(nodes, selectedIds, uid, offset = {x: 36, y: 36}) {
    const selected = new Set(selectedIds);
    const sourceById = new Map(nodes.map(node => [node.id, node]));
    const copied = nodes.filter(node => selected.has(node.id) && isPresentationNode(node));
    const idMap = new Map(copied.map(node => [node.id, uid(node.type === 'generation_request' ? 'request' : node.type === 'image' ? 'image' : 'result')]));
    const clones = copied.map(node => {
      const clone = {...node, id: idMap.get(node.id), x: Number(node.x || 0) + offset.x, y: Number(node.y || 0) + offset.y};
      delete clone.generationId;
      delete clone.canRetry;
      delete clone.sentiment;
      delete clone.uploading;
      if (clone.type === 'generation_result') {
        clone.presentationProxy = true;
        const oldRequest = node.requestId;
        clone.requestId = idMap.get(oldRequest) || (sourceById.get(oldRequest)?.type === 'generation_request' ? oldRequest : '');
      }
      if (clone.type === 'generation_request') {
        clone.submitting = false;
        clone.orderedInputIds = (node.orderedInputIds || []).flatMap(id => {
          const source = sourceById.get(id);
          if (!source || !['image', 'generation_result'].includes(source.type)) return [];
          return [idMap.get(id) || id];
        });
      }
      return clone;
    });
    return {clones, idMap: Object.fromEntries(idMap)};
  }

  function removePresentationNodes(nodes, selectedIds) {
    const removed = new Set(selectedIds);
    const kept = nodes.filter(node => !removed.has(node.id));
    kept.forEach(node => {
      if (node.type === 'generation_request') node.orderedInputIds = (node.orderedInputIds || []).filter(id => !removed.has(id));
      if (node.type === 'generation_result' && removed.has(node.requestId)) node.requestId = '';
    });
    return kept;
  }

  function rectCenterToWorld(elementRect, viewportRect, viewport) {
    return {
      x: (elementRect.left + elementRect.width / 2 - viewportRect.left - viewport.x) / viewport.zoom,
      y: (elementRect.top + elementRect.height / 2 - viewportRect.top - viewport.y) / viewport.zoom,
    };
  }

  function visibleWorld(viewportRect, viewport) {
    return {x: -viewport.x / viewport.zoom, y: -viewport.y / viewport.zoom, width: viewportRect.width / viewport.zoom, height: viewportRect.height / viewport.zoom};
  }

  function minimapGeometry(rects, visible, size = {width: 176, height: 112}, padding = 8) {
    const all = [...rects, visible];
    const margin = 80;
    const minX = Math.min(...all.map(rect => rect.x)) - margin;
    const minY = Math.min(...all.map(rect => rect.y)) - margin;
    const maxX = Math.max(...all.map(rect => rect.x + rect.width)) + margin;
    const maxY = Math.max(...all.map(rect => rect.y + rect.height)) + margin;
    const worldWidth = Math.max(1, maxX - minX);
    const worldHeight = Math.max(1, maxY - minY);
    const scale = Math.min((size.width - padding * 2) / worldWidth, (size.height - padding * 2) / worldHeight);
    const ox = (size.width - worldWidth * scale) / 2 - minX * scale;
    const oy = (size.height - worldHeight * scale) / 2 - minY * scale;
    const mapRect = rect => ({x: rect.x * scale + ox, y: rect.y * scale + oy, width: Math.max(2, rect.width * scale), height: Math.max(2, rect.height * scale)});
    return {bounds: {x: minX, y: minY, width: worldWidth, height: worldHeight}, scale, ox, oy, nodes: rects.map(mapRect), viewport: mapRect(visible)};
  }

  function minimapPointToWorld(point, geometry) {
    return {x: (point.x - geometry.ox) / geometry.scale, y: (point.y - geometry.oy) / geometry.scale};
  }

  function isEditableTarget(target) {
    if (!target) return false;
    const tag = String(target.tagName || '').toLowerCase();
    return ['input', 'textarea', 'select'].includes(tag) || Boolean(target.isContentEditable || target.closest?.('[contenteditable="true"]'));
  }

  return {
    profileById, chooseRequestProfile, requestAvailability, historyAction,
    restoreCanvasNodes, firstMissingLocalInput, isPresentationNode,
    clonePresentationNodes, removePresentationNodes, rectCenterToWorld,
    visibleWorld, minimapGeometry, minimapPointToWorld, isEditableTarget,
  };
});
