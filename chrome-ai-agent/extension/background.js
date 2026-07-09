const SCREENSHOT_MAX_WIDTH = 1200;
const SCREENSHOT_MAX_HEIGHT = 1200;
const SCREENSHOT_QUALITY = 0.72;
const SCREENSHOT_MAX_BYTES = 900000;
const CONTEXT_TARGET_TTL_MS = 30 * 60 * 1000;
const MAX_CONTEXT_TARGETS = 80;

// These limits are enforced in the service worker, so a content-script change
// cannot accidentally cause an unbounded model payload.
const CONTEXT_LIMITS = Object.freeze({
  light: Object.freeze({
    maxFrames: 2,
    maxElements: 60,
    maxFormValues: 35,
    maxChunks: 8,
    maxTextChars: 7000,
    maxChunkChars: 900,
    maxAccessibilityFrames: 0,
    maxAccessibilityNodes: 0,
    accessibilityDepth: 0,
    maxCollectionMs: 4500
  }),
  deep: Object.freeze({
    maxFrames: 6,
    maxElements: 180,
    maxFormValues: 120,
    maxChunks: 20,
    maxTextChars: 16000,
    maxChunkChars: 1400,
    maxAccessibilityFrames: 6,
    maxAccessibilityNodes: 140,
    accessibilityDepth: 5,
    maxCollectionMs: 12000
  })
});

// Contexts are scoped to a task, rather than whatever tab happens to be
// active when a model response arrives.
const observedTargets = new Map();
const lastObservedTargetByTask = new Map();
const committedDocuments = new Map();

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

function rememberCommittedDocument(details) {
  if (!Number.isInteger(details?.tabId) || !Number.isInteger(details?.frameId)) return;
  const previous = committedDocuments.get(documentMapKey(details.tabId, details.frameId));

  committedDocuments.set(documentMapKey(details.tabId, details.frameId), {
    documentId: String(details.documentId || previous?.documentId || ""),
    url: details.url || "",
    committedAt: nowIso()
  });
}

chrome.webNavigation.onCommitted.addListener(rememberCommittedDocument);
chrome.webNavigation.onHistoryStateUpdated.addListener(rememberCommittedDocument);
chrome.webNavigation.onReferenceFragmentUpdated.addListener(rememberCommittedDocument);

chrome.tabs.onRemoved.addListener(tabId => {
  for (const key of committedDocuments.keys()) {
    if (key.startsWith(`${tabId}:`)) committedDocuments.delete(key);
  }

  for (const [contextId, target] of observedTargets) {
    if (target.tabId === tabId) observedTargets.delete(contextId);
  }

  trimTargets();
});

function runtimeError() {
  return chrome.runtime.lastError ? new Error(chrome.runtime.lastError.message) : null;
}

function tabsQuery(queryInfo) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query(queryInfo, tabs => {
      const error = runtimeError();
      if (error) reject(error);
      else resolve(tabs || []);
    });
  });
}

function tabsGet(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, tab => {
      const error = runtimeError();
      if (error) reject(error);
      else resolve(tab);
    });
  });
}

function tabsSendMessage(tabId, message, options = {}) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, options, response => {
      const error = runtimeError();
      if (error) reject(error);
      else resolve(response);
    });
  });
}

function captureVisibleTab(windowId, options) {
  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(windowId, options, dataUrl => {
      const error = runtimeError();
      if (error) reject(error);
      else resolve(dataUrl);
    });
  });
}

function getAllFrames(tabId) {
  return new Promise((resolve, reject) => {
    chrome.webNavigation.getAllFrames({ tabId }, frames => {
      const error = runtimeError();
      if (error) reject(error);
      else resolve(frames || []);
    });
  });
}

function debuggerAttach(target, protocolVersion) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, protocolVersion, () => {
      const error = runtimeError();
      if (error) reject(error);
      else resolve();
    });
  });
}

function debuggerDetach(target) {
  return new Promise(resolve => {
    chrome.debugger.detach(target, () => resolve());
  });
}

function debuggerSendCommand(target, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params || {}, result => {
      const error = runtimeError();
      if (error) reject(error);
      else resolve(result || {});
    });
  });
}

async function getActiveTab() {
  const tabs = await tabsQuery({ active: true, currentWindow: true });
  return tabs[0] || null;
}

function documentMapKey(tabId, frameId) {
  return `${tabId}:${frameId}`;
}

function cleanTaskId(value) {
  const taskId = String(value || "default").trim();
  return taskId.slice(0, 160) || "default";
}

function contextMode(value) {
  return String(value || "deep").toLowerCase() === "light" ? "light" : "deep";
}

function getContextLimits(mode) {
  return CONTEXT_LIMITS[contextMode(mode)];
}

function nowIso() {
  return new Date().toISOString();
}

function newContextId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `context-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function currentDocumentId(tabId, frameId, frame = {}) {
  return String(
    frame.documentId ||
    committedDocuments.get(documentMapKey(tabId, frameId))?.documentId ||
    ""
  );
}

function trimTargets() {
  const cutoff = Date.now() - CONTEXT_TARGET_TTL_MS;

  for (const [contextId, target] of observedTargets) {
    if (Date.parse(target.observedAt || "") < cutoff) observedTargets.delete(contextId);
  }

  while (observedTargets.size > MAX_CONTEXT_TARGETS) {
    observedTargets.delete(observedTargets.keys().next().value);
  }

  for (const [taskId, target] of lastObservedTargetByTask) {
    if (!target?.contextId || !observedTargets.has(target.contextId)) {
      lastObservedTargetByTask.delete(taskId);
    }
  }
}

function rememberObservedTarget(taskId, target) {
  trimTargets();
  observedTargets.set(target.contextId, target);
  lastObservedTargetByTask.set(taskId, target);
}

function normalizeTargetRef(value = {}) {
  if (!value || typeof value !== "object") return {};

  return {
    contextId: value.contextId ? String(value.contextId) : "",
    tabId: Number.isInteger(value.tabId) ? value.tabId : undefined,
    frameId: Number.isInteger(value.frameId) ? value.frameId : undefined,
    url: typeof value.url === "string" ? value.url : "",
    documentId: value.documentId ? String(value.documentId) : ""
  };
}

function targetForFrame(contextTarget, frame) {
  const frameId = Number.isInteger(frame.frameId) ? frame.frameId : 0;
  return {
    contextId: contextTarget.contextId,
    taskId: contextTarget.taskId,
    tabId: contextTarget.tabId,
    frameId,
    url: frame.url || "",
    documentId: currentDocumentId(contextTarget.tabId, frameId, frame),
    observedAt: contextTarget.observedAt
  };
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";

  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }

  return btoa(binary);
}

async function compressScreenshot(dataUrl) {
  try {
    const sourceBlob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(sourceBlob);
    const scale = Math.min(
      1,
      SCREENSHOT_MAX_WIDTH / bitmap.width,
      SCREENSHOT_MAX_HEIGHT / bitmap.height
    );
    const width = Math.max(Math.round(bitmap.width * scale), 1);
    const height = Math.max(Math.round(bitmap.height * scale), 1);
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");

    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();

    const outputBlob = await canvas.convertToBlob({
      type: "image/jpeg",
      quality: SCREENSHOT_QUALITY
    });
    const base64 = arrayBufferToBase64(await outputBlob.arrayBuffer());

    return {
      dataUrl: `data:image/jpeg;base64,${base64}`,
      mediaType: "image/jpeg",
      width,
      height,
      bytes: outputBlob.size,
      capturedAt: new Date().toISOString()
    };
  } catch (error) {
    return {
      dataUrl,
      mediaType: dataUrl.slice(5, dataUrl.indexOf(";")) || "image/png",
      width: 0,
      height: 0,
      bytes: Math.round(dataUrl.length * 0.75),
      capturedAt: new Date().toISOString(),
      warning: `Screenshot captured but could not be compressed: ${error.message}`
    };
  }
}

async function captureScreenshotForTab(tab) {
  const dataUrl = await captureVisibleTab(tab.windowId, { format: "png" });
  const screenshot = await compressScreenshot(dataUrl);

  if (screenshot.bytes > SCREENSHOT_MAX_BYTES) {
    return {
      omitted: true,
      bytes: screenshot.bytes,
      capturedAt: screenshot.capturedAt,
      warning: `Screenshot omitted because it exceeds the ${SCREENSHOT_MAX_BYTES}-byte context limit.`
    };
  }

  return screenshot;
}

function flattenFrameTree(node, output = []) {
  if (!node?.frame) return output;

  output.push({
    frameId: node.frame.id,
    parentFrameId: node.frame.parentId || "",
    url: node.frame.url || "",
    name: node.frame.name || "",
    securityOrigin: node.frame.securityOrigin || ""
  });

  for (const child of node.childFrames || []) {
    flattenFrameTree(child, output);
  }

  return output;
}

function axValue(value) {
  if (!value || typeof value !== "object") return "";
  const raw = value.value;
  if (raw === undefined || raw === null) return "";
  if (typeof raw === "object") return JSON.stringify(raw).slice(0, 300);
  return String(raw).slice(0, 300);
}

function normalizeAxNode(node) {
  const properties = {};

  for (const prop of node.properties || []) {
    if (prop?.name) properties[prop.name] = axValue(prop.value);
  }

  return {
    nodeId: String(node.nodeId || ""),
    parentId: String(node.parentId || ""),
    childIds: Array.isArray(node.childIds) ? node.childIds.slice(0, 40).map(String) : [],
    frameId: String(node.frameId || ""),
    role: axValue(node.role),
    name: axValue(node.name),
    value: axValue(node.value),
    description: axValue(node.description),
    ignored: Boolean(node.ignored),
    properties
  };
}

async function getAccessibilityTree(tabId, limits) {
  const target = { tabId };
  const warnings = [];
  const frames = [];
  const deadline = Date.now() + Math.min(limits.maxCollectionMs, 8000);

  if (!limits.maxAccessibilityFrames || !limits.maxAccessibilityNodes) {
    return {
      capturedAt: nowIso(),
      frames,
      warnings: ["Accessibility extraction is disabled for lightweight context."]
    };
  }

  try {
    await debuggerAttach(target, "1.3");
    await debuggerSendCommand(target, "Accessibility.enable");

    const frameTree = await debuggerSendCommand(target, "Page.getFrameTree");
    const cdpFrames = flattenFrameTree(frameTree.frameTree).slice(0, limits.maxAccessibilityFrames);

    for (const frame of cdpFrames) {
      if (Date.now() >= deadline) {
        warnings.push("Accessibility extraction stopped at its context time limit.");
        break;
      }

      try {
        const result = await debuggerSendCommand(target, "Accessibility.getFullAXTree", {
          depth: limits.accessibilityDepth,
          frameId: frame.frameId
        });

        frames.push({
          frameId: frame.frameId,
          url: frame.url,
          nodes: (result.nodes || []).slice(0, limits.maxAccessibilityNodes).map(normalizeAxNode),
          truncated: (result.nodes || []).length > limits.maxAccessibilityNodes
        });
      } catch (error) {
        warnings.push(`Accessibility tree unavailable for frame ${frame.url || frame.frameId}: ${error.message}`);
      }
    }
  } catch (error) {
    warnings.push(`Accessibility extraction unavailable: ${error.message}`);
  } finally {
    await debuggerDetach(target);
  }

  return {
    capturedAt: nowIso(),
    frames,
    warnings
  };
}

function normalizeFrameInfo(frame, tabId) {
  return {
    frameId: frame.frameId,
    parentFrameId: frame.parentFrameId ?? -1,
    url: frame.url || "",
    documentId: currentDocumentId(tabId, frame.frameId, frame),
    errorOccurred: Boolean(frame.errorOccurred)
  };
}

function truncateText(value, maxLength) {
  return String(value || "").slice(0, Math.max(0, maxLength));
}

function limitFrameSnapshot(snapshot, frame, limits) {
  const perFrameTextChars = Math.max(800, Math.floor(limits.maxTextChars / limits.maxFrames));
  const perFrameChunks = Math.max(1, Math.ceil(limits.maxChunks / limits.maxFrames));
  const perFrameElements = Math.max(1, Math.ceil(limits.maxElements / limits.maxFrames));
  const perFrameFormValues = Math.max(1, Math.ceil(limits.maxFormValues / limits.maxFrames));
  let remainingText = perFrameTextChars;
  const chunks = [];

  for (const chunk of snapshot?.chunks || []) {
    if (!remainingText || chunks.length >= perFrameChunks) break;

    const text = truncateText(chunk?.text, Math.min(limits.maxChunkChars, remainingText));
    if (!text) continue;

    chunks.push({ ...chunk, text });
    remainingText -= text.length;
  }

  return {
    ...snapshot,
    frameId: frame.frameId,
    parentFrameId: frame.parentFrameId ?? -1,
    url: snapshot?.url || frame.url || "",
    text: truncateText(chunks.map(chunk => chunk.text).join("\n"), perFrameTextChars),
    elements: (snapshot?.elements || []).slice(0, perFrameElements),
    formValues: (snapshot?.formValues || []).slice(0, perFrameFormValues),
    chunks,
    truncated: {
      text: String(snapshot?.text || "").length > perFrameTextChars,
      elements: (snapshot?.elements || []).length > perFrameElements,
      formValues: (snapshot?.formValues || []).length > perFrameFormValues,
      chunks: (snapshot?.chunks || []).length > perFrameChunks
    }
  };
}

function annotateFrameSnapshot(snapshot, frame, limits) {
  const frameId = frame.frameId;
  const frameUrl = frame.url || snapshot?.url || "";
  const limited = limitFrameSnapshot(snapshot, frame, limits);

  return {
    ...limited,
    frameId,
    parentFrameId: frame.parentFrameId ?? -1,
    url: limited.url || frameUrl,
    elements: (limited.elements || []).map(element => ({ ...element, frameId })),
    formValues: (limited.formValues || []).map(value => ({ ...value, frameId })),
    chunks: (limited.chunks || []).map(chunk => ({ ...chunk, frameId }))
  };
}

function aggregateFrameSnapshots(tab, frames, snapshots, warnings, limits, contextTarget) {
  const accessibleFrames = snapshots.map(item => item.snapshot);
  const elements = accessibleFrames.flatMap(frame => frame.elements || []).slice(0, limits.maxElements);
  const formValues = accessibleFrames.flatMap(frame => frame.formValues || []).slice(0, limits.maxFormValues);
  const chunks = accessibleFrames.flatMap(frame => frame.chunks || []).slice(0, limits.maxChunks);
  const text = chunks.map(chunk => chunk.text).join("\n\n").slice(0, limits.maxTextChars);
  const mainFrame = frames.find(frame => frame.frameId === 0) || frames[0] || {};

  return {
    url: tab.url || accessibleFrames[0]?.url || "",
    title: tab.title || accessibleFrames[0]?.title || "",
    timestamp: nowIso(),
    contextMode: contextTarget.contextMode,
    context: {
      contextId: contextTarget.contextId,
      taskId: contextTarget.taskId,
      tabId: contextTarget.tabId,
      frameId: mainFrame.frameId ?? 0,
      url: mainFrame.url || tab.url || "",
      documentId: currentDocumentId(contextTarget.tabId, mainFrame.frameId ?? 0, mainFrame),
      observedAt: contextTarget.observedAt
    },
    // `target` is retained as a convenient action-routing alias for clients
    // that do not yet consume the fuller `context` property.
    target: targetForFrame(contextTarget, mainFrame),
    text,
    frames: frames.map(frame => ({ ...normalizeFrameInfo(frame, tab.id), target: targetForFrame(contextTarget, frame) })),
    accessibleFrames,
    elements,
    formValues,
    chunks,
    scroll: accessibleFrames.find(frame => frame.frameId === 0)?.scroll || accessibleFrames[0]?.scroll || {},
    warnings,
    truncated: {
      frames: Boolean(contextTarget.discoveredFrameCount > frames.length),
      elements: accessibleFrames.flatMap(frame => frame.elements || []).length > elements.length,
      formValues: accessibleFrames.flatMap(frame => frame.formValues || []).length > formValues.length,
      chunks: accessibleFrames.flatMap(frame => frame.chunks || []).length > chunks.length,
      text: chunks.map(chunk => chunk.text).join("\n\n").length > text.length
    }
  };
}

function prioritizeFrames(frames, requestedFrameId) {
  const uniqueFrames = [...new Map(frames.map(frame => [frame.frameId, frame])).values()];

  return uniqueFrames.sort((left, right) => {
    const leftRank = left.frameId === requestedFrameId ? 0 : left.frameId === 0 ? 1 : 2;
    const rightRank = right.frameId === requestedFrameId ? 0 : right.frameId === 0 ? 1 : 2;
    return leftRank - rightRank || left.frameId - right.frameId;
  });
}

async function resolveObservationTab(options, taskId) {
  const requested = normalizeTargetRef(options.target || options.context || {});
  const cached = requested.contextId ? observedTargets.get(requested.contextId) : lastObservedTargetByTask.get(taskId);
  const tabId = requested.tabId ?? cached?.tabId;

  if (Number.isInteger(tabId)) return tabsGet(tabId);
  return getActiveTab();
}

async function collectDeepPageContext(options = {}) {
  const taskId = cleanTaskId(options.taskId || options.target?.taskId || options.context?.taskId);
  const mode = contextMode(options.contextMode);
  const limits = getContextLimits(mode);
  const tab = await resolveObservationTab(options, taskId);

  if (!tab?.id) {
    return { error: "No active tab found." };
  }

  const warnings = [];
  let frames = [];

  try {
    frames = await getAllFrames(tab.id);
  } catch (error) {
    warnings.push(`Could not enumerate frames: ${error.message}`);
  }

  if (!frames.length) {
    frames = [{ frameId: 0, parentFrameId: -1, url: tab.url || "" }];
  }

  const requested = normalizeTargetRef(options.target || options.context || {});
  const discoveredFrameCount = frames.length;
  frames = prioritizeFrames(frames, requested.frameId ?? 0).slice(0, limits.maxFrames);

  if (discoveredFrameCount > frames.length) {
    warnings.push(`Context limited to ${frames.length} of ${discoveredFrameCount} frames (${mode} mode).`);
  }

  const observedAt = nowIso();
  const mainFrame = frames.find(frame => frame.frameId === 0) || frames[0];
  const contextTarget = {
    contextId: newContextId(),
    taskId,
    tabId: tab.id,
    frameId: mainFrame?.frameId ?? 0,
    url: mainFrame?.url || tab.url || "",
    documentId: currentDocumentId(tab.id, mainFrame?.frameId ?? 0, mainFrame),
    observedAt,
    contextMode: mode,
    discoveredFrameCount,
    frames: new Map()
  };

  for (const frame of frames) {
    contextTarget.frames.set(frame.frameId, targetForFrame(contextTarget, frame));
  }

  const snapshots = [];
  const deadline = Date.now() + limits.maxCollectionMs;

  for (const frame of frames) {
    if (Date.now() >= deadline) {
      warnings.push(`Context collection stopped after ${limits.maxCollectionMs}ms (${mode} mode).`);
      break;
    }

    try {
      const snapshot = await tabsSendMessage(
        tab.id,
        {
          type: "GET_FRAME_CONTEXT",
          snapshotOptions: {
            snapshotMode: mode,
            textChars: Math.max(800, Math.floor(limits.maxTextChars / limits.maxFrames)),
            chunks: Math.max(1, Math.ceil(limits.maxChunks / limits.maxFrames)),
            chunkChars: limits.maxChunkChars,
            elements: Math.max(1, Math.ceil(limits.maxElements / limits.maxFrames)),
            formValues: Math.max(1, Math.ceil(limits.maxFormValues / limits.maxFrames))
          }
        },
        { frameId: frame.frameId }
      );

      if (snapshot?.error) {
        warnings.push(`Frame ${frame.url || frame.frameId}: ${snapshot.error}`);
        continue;
      }

      snapshots.push({
        frame,
        snapshot: annotateFrameSnapshot(snapshot || {}, frame, limits)
      });
    } catch (error) {
      warnings.push(`Frame ${frame.url || frame.frameId} inaccessible: ${error.message}`);
    }
  }

  const page = aggregateFrameSnapshots(tab, frames, snapshots, warnings, limits, contextTarget);
  rememberObservedTarget(taskId, contextTarget);

  if (options.includeScreenshot && mode === "deep") {
    try {
      const activeTab = await getActiveTab();

      if (activeTab?.id !== tab.id) {
        page.warnings.push("Screenshot omitted because the observed tab is no longer the visible tab.");
      } else {
        page.screenshot = await captureScreenshotForTab(tab);
      }

      if (page.screenshot?.warning) {
        page.warnings.push(page.screenshot.warning);
      }
    } catch (error) {
      page.warnings.push(`Screenshot capture failed: ${error.message}`);
    }
  } else if (options.includeScreenshot) {
    page.warnings.push("Screenshot omitted in lightweight context mode.");
  }

  if (options.includeAccessibility && mode === "deep") {
    page.accessibility = await getAccessibilityTree(tab.id, limits);
    page.warnings.push(...(page.accessibility.warnings || []));
  } else if (options.includeAccessibility) {
    page.warnings.push("Accessibility tree omitted in lightweight context mode.");
  }

  return { tab, page };
}

function resolveActionTarget(message, action) {
  const taskId = cleanTaskId(
    message.taskId || action.taskId || message.target?.taskId || action.target?.taskId || action.context?.taskId
  );
  const reference = normalizeTargetRef(
    message.target || message.context || action.target || action.targetContext || action.context || {
      contextId: message.contextId || action.contextId
    }
  );
  const stored = reference.contextId
    ? observedTargets.get(reference.contextId)
    : lastObservedTargetByTask.get(taskId);

  if (reference.contextId && !stored && !Number.isInteger(reference.tabId)) {
    return { error: "The action context has expired. Collect fresh page context and re-plan." };
  }

  const frameId = Number.isInteger(action.frameId)
    ? action.frameId
    : Number.isInteger(reference.frameId)
      ? reference.frameId
      : stored?.frameId ?? 0;
  const storedFrameTarget = stored?.frames?.get(frameId);
  const target = {
    contextId: reference.contextId || stored?.contextId || "",
    taskId,
    tabId: reference.tabId ?? storedFrameTarget?.tabId ?? stored?.tabId,
    frameId,
    url: reference.url || storedFrameTarget?.url || "",
    documentId: reference.documentId || storedFrameTarget?.documentId || ""
  };

  if (!Number.isInteger(target.tabId)) {
    return { error: "Action is missing a target context. Collect page context and re-plan before executing." };
  }

  return { target };
}

async function validateActionTarget(target) {
  let tab;

  try {
    tab = await tabsGet(target.tabId);
  } catch (error) {
    return { error: `Target tab is unavailable: ${error.message}` };
  }

  let frames;
  try {
    frames = await getAllFrames(target.tabId);
  } catch (error) {
    return { error: `Could not verify target document: ${error.message}` };
  }

  const frame = frames.find(candidate => candidate.frameId === target.frameId) ||
    (target.frameId === 0 ? { frameId: 0, url: tab.url || "" } : null);

  if (!frame) return { error: `Target frame ${target.frameId} no longer exists. Collect fresh page context and re-plan.` };

  const currentUrl = frame.url || (target.frameId === 0 ? tab.url || "" : "");
  const documentId = currentDocumentId(target.tabId, target.frameId, frame);

  if (target.documentId && documentId && target.documentId !== documentId) {
    return { error: "Target document changed since planning. Collect fresh page context and re-plan." };
  }

  if (target.url && currentUrl && target.url !== currentUrl) {
    return { error: "Target URL changed since planning. Collect fresh page context and re-plan." };
  }

  return { tab, frame, documentId };
}

async function runActionInFrame(message) {
  const action = message.action || {};
  if (message.collection && action.type === "dismissAlert") {
    return dismissAlertInTarget(message);
  }
  const resolvedTarget = resolveActionTarget(message, action);
  if (resolvedTarget.error) return resolvedTarget;

  const { target } = resolvedTarget;
  const verified = await validateActionTarget(target);
  if (verified.error) return verified;

  const messageType = message.preview
    ? "PREVIEW_ACTION"
    : message.collection
      ? "RUN_COLLECTION_ACTION"
      : "RUN_ACTION";

  try {
    const result = await tabsSendMessage(
      target.tabId,
      {
        type: messageType,
        action
      },
      { frameId: target.frameId }
    );
    return { ...result, target: { ...target, documentId: verified.documentId || target.documentId } };
  } catch (error) {
    return { error: `Could not run action in target tab/frame ${target.tabId}/${target.frameId}: ${error.message}` };
  }
}

async function dismissAlertInTarget(message) {
  const resolvedTarget = resolveActionTarget(message, message.action || {});
  if (resolvedTarget.error) return resolvedTarget;
  const { target } = resolvedTarget;
  const verified = await validateActionTarget(target);
  if (verified.error) return verified;

  const debuggerTarget = { tabId: target.tabId };
  try {
    await debuggerAttach(debuggerTarget, "1.3");
    await debuggerSendCommand(debuggerTarget, "Page.enable");
    await debuggerSendCommand(debuggerTarget, "Page.handleJavaScriptDialog", { accept: true });
    return { ok: true, result: "dismissed alert dialog", target };
  } catch (error) {
    return { error: `No dismissible alert was available: ${error.message}` };
  } finally {
    await debuggerDetach(debuggerTarget);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "GET_DEEP_PAGE_CONTEXT") {
    collectDeepPageContext({
      taskId: message.taskId,
      target: message.target || message.context,
      contextMode: message.contextMode || "deep",
      includeScreenshot: Boolean(message.includeScreenshot),
      includeAccessibility: message.includeAccessibility !== false
    })
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message || "Could not collect page context." }));
    return true;
  }

  if (message?.type === "GET_LIGHT_PAGE_CONTEXT") {
    collectDeepPageContext({
      taskId: message.taskId,
      target: message.target || message.context,
      contextMode: "light",
      includeScreenshot: false,
      includeAccessibility: false
    })
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message || "Could not collect page context." }));
    return true;
  }

  if (message?.type === "RUN_PAGE_ACTION") {
    runActionInFrame({
      action: message.action,
      taskId: message.taskId,
      target: message.target || message.context,
      contextId: message.contextId,
      collection: Boolean(message.collection)
    })
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message || "Could not run page action." }));
    return true;
  }

  if (message?.type === "PREVIEW_PAGE_ACTION") {
    runActionInFrame({
      action: message.action,
      taskId: message.taskId,
      target: message.target || message.context,
      contextId: message.contextId,
      preview: true
    })
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message || "Could not preview page action." }));
    return true;
  }

  if (message?.type === "DISMISS_JAVASCRIPT_ALERT") {
    dismissAlertInTarget(message)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message || "Could not dismiss alert dialog." }));
    return true;
  }

  return false;
});
