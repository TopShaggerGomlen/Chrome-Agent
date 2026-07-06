const SCREENSHOT_MAX_WIDTH = 1200;
const SCREENSHOT_MAX_HEIGHT = 1200;
const SCREENSHOT_QUALITY = 0.72;
const AX_MAX_FRAMES = 12;
const AX_MAX_NODES_PER_FRAME = 220;
const AX_DEPTH = 7;

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
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
  return compressScreenshot(dataUrl);
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

async function getAccessibilityTree(tabId) {
  const target = { tabId };
  const warnings = [];
  const frames = [];

  try {
    await debuggerAttach(target, "1.3");
    await debuggerSendCommand(target, "Accessibility.enable");

    const frameTree = await debuggerSendCommand(target, "Page.getFrameTree");
    const cdpFrames = flattenFrameTree(frameTree.frameTree).slice(0, AX_MAX_FRAMES);

    for (const frame of cdpFrames) {
      try {
        const result = await debuggerSendCommand(target, "Accessibility.getFullAXTree", {
          depth: AX_DEPTH,
          frameId: frame.frameId
        });

        frames.push({
          frameId: frame.frameId,
          url: frame.url,
          nodes: (result.nodes || []).slice(0, AX_MAX_NODES_PER_FRAME).map(normalizeAxNode),
          truncated: (result.nodes || []).length > AX_MAX_NODES_PER_FRAME
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
    capturedAt: new Date().toISOString(),
    frames,
    warnings
  };
}

function normalizeFrameInfo(frame) {
  return {
    frameId: frame.frameId,
    parentFrameId: frame.parentFrameId ?? -1,
    url: frame.url || "",
    errorOccurred: Boolean(frame.errorOccurred)
  };
}

function annotateFrameSnapshot(snapshot, frame) {
  const frameId = frame.frameId;
  const frameUrl = frame.url || snapshot?.url || "";

  return {
    ...snapshot,
    frameId,
    parentFrameId: frame.parentFrameId ?? -1,
    url: snapshot?.url || frameUrl,
    elements: (snapshot?.elements || []).map(element => ({ ...element, frameId })),
    formValues: (snapshot?.formValues || []).map(value => ({ ...value, frameId })),
    chunks: (snapshot?.chunks || []).map(chunk => ({ ...chunk, frameId }))
  };
}

function aggregateFrameSnapshots(tab, frames, snapshots, warnings) {
  const accessibleFrames = snapshots.map(item => item.snapshot);
  const elements = accessibleFrames.flatMap(frame => frame.elements || []);
  const formValues = accessibleFrames.flatMap(frame => frame.formValues || []);
  const chunks = accessibleFrames.flatMap(frame => frame.chunks || []);
  const text = chunks.map(chunk => chunk.text).join("\n\n").slice(0, 24000);

  return {
    url: tab.url || accessibleFrames[0]?.url || "",
    title: tab.title || accessibleFrames[0]?.title || "",
    timestamp: new Date().toISOString(),
    text,
    frames: frames.map(normalizeFrameInfo),
    accessibleFrames,
    elements,
    formValues,
    chunks,
    scroll: accessibleFrames.find(frame => frame.frameId === 0)?.scroll || accessibleFrames[0]?.scroll || {},
    warnings
  };
}

async function collectDeepPageContext(options = {}) {
  const tab = await getActiveTab();

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

  const snapshots = [];

  for (const frame of frames) {
    try {
      const snapshot = await tabsSendMessage(
        tab.id,
        { type: "GET_FRAME_CONTEXT" },
        { frameId: frame.frameId }
      );

      if (snapshot?.error) {
        warnings.push(`Frame ${frame.url || frame.frameId}: ${snapshot.error}`);
        continue;
      }

      snapshots.push({
        frame,
        snapshot: annotateFrameSnapshot(snapshot || {}, frame)
      });
    } catch (error) {
      warnings.push(`Frame ${frame.url || frame.frameId} inaccessible: ${error.message}`);
    }
  }

  const page = aggregateFrameSnapshots(tab, frames, snapshots, warnings);

  if (options.includeScreenshot) {
    try {
      page.screenshot = await captureScreenshotForTab(tab);

      if (page.screenshot.warning) {
        page.warnings.push(page.screenshot.warning);
      }
    } catch (error) {
      page.warnings.push(`Screenshot capture failed: ${error.message}`);
    }
  }

  if (options.includeAccessibility) {
    page.accessibility = await getAccessibilityTree(tab.id);
    page.warnings.push(...(page.accessibility.warnings || []));
  }

  return { tab, page };
}

async function runActionInFrame(message) {
  const tab = await getActiveTab();
  const action = message.action || {};
  const frameId = Number.isFinite(action.frameId) ? action.frameId : 0;

  if (!tab?.id) {
    return { error: "No active tab found." };
  }

  try {
    return await tabsSendMessage(
      tab.id,
      {
        type: message.collection ? "RUN_COLLECTION_ACTION" : "RUN_ACTION",
        action
      },
      { frameId }
    );
  } catch (error) {
    return { error: `Could not run action in frame ${frameId}: ${error.message}` };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "GET_DEEP_PAGE_CONTEXT") {
    collectDeepPageContext({
      includeScreenshot: Boolean(message.includeScreenshot),
      includeAccessibility: message.includeAccessibility !== false
    })
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message || "Could not collect page context." }));
    return true;
  }

  if (message?.type === "RUN_PAGE_ACTION") {
    runActionInFrame({ action: message.action, collection: Boolean(message.collection) })
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message || "Could not run page action." }));
    return true;
  }

  return false;
});
