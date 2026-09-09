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
    // An inherited profile is an explicit historical choice. Never replace an
    // unavailable historical provider with an unrelated enabled provider.
    if (inheritedProfileId) return profileById(models, inheritedProfileId);
    return models.find(item => item.enabled) || null;
  }

  function requestAvailability(profile) {
    if (profile?.enabled) return {enabled: true, message: ''};
    return {
      enabled: false,
      message: '当前模型不可用。请联系管理员配置或选择其他已启用模型。',
    };
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
    };
  }

  function historyAction(nodes, item, action, uid) {
    if (action !== 'locate' && action !== 'continue') {
      throw new Error(`Unsupported history action: ${action}`);
    }
    let result = nodes.find(node =>
      node.type === 'generation_result' && node.generationId === item.id
    );
    let createdResult = false;
    if (!result) {
      result = historicalResult(item, uid);
      nodes.push(result);
      createdResult = true;
    }
    if (action === 'locate') {
      return {result, request: null, focusId: result.id, createdResult};
    }
    const parameters = item.parameters || {};
    const request = {
      prompt: item.prompt,
      profileId: item.profile_id || '',
      ratio: parameters.ratio,
      resolution: parameters.resolution,
      quality: parameters.quality,
      inputId: result.id,
      parentGenerationId: item.id,
    };
    return {result, request, focusId: '', createdResult};
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
      if (restored.type === 'generation_request') {
        restored.orderedInputIds = [...(restored.orderedInputIds || restored.referenceOrder || [])];
      }
      if (restored.type === 'image' && restored.localOnly) {
        restored.src = '';
        restored.needsReselect = true;
      }
      return restored;
    });
  }

  return {
    profileById, chooseRequestProfile, requestAvailability, historyAction,
    restoreCanvasNodes, firstMissingLocalInput,
  };
});
