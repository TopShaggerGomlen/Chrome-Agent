chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

const attachedTabs = new Set();

async function attach(tabId) {
  if (attachedTabs.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, "1.3");
  attachedTabs.add(tabId);
}

async function detach(tabId) {
  if (!attachedTabs.has(tabId)) return;
  try {
    await chrome.debugger.detach({ tabId });
  } finally {
    attachedTabs.delete(tabId);
  }
}

async function command(tabId, method, params = {}) {
  await attach(tabId);
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

async function capture(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const metrics = await command(tabId, "Page.getLayoutMetrics");
    const viewport = metrics.visualViewport || metrics.layoutViewport;
    const shot = await command(tabId, "Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false
    });

    return {
      imageBase64: shot.data,
      viewportWidth: viewport.clientWidth,
      viewportHeight: viewport.clientHeight,
      pageX: viewport.pageX || 0,
      pageY: viewport.pageY || 0,
      url: tab.url || "",
      title: tab.title || "",
      capturedAt: new Date().toISOString()
    };
  } finally {
    await detach(tabId);
  }
}

function viewportPoint(action, context) {
  const imageWidth = Number(context?.imageWidth);
  const imageHeight = Number(context?.imageHeight);
  const viewportWidth = Number(context?.viewportWidth);
  const viewportHeight = Number(context?.viewportHeight);
  const x = Number(action.x);
  const y = Number(action.y);

  if (![imageWidth, imageHeight, viewportWidth, viewportHeight, x, y].every(Number.isFinite)) {
    throw new Error("Visual action is missing valid coordinate metadata.");
  }
  if (imageWidth <= 0 || imageHeight <= 0 || x < 0 || y < 0 || x > imageWidth || y > imageHeight) {
    throw new Error("Visual action coordinates are outside the captured screenshot.");
  }

  return {
    x: x * viewportWidth / imageWidth,
    y: y * viewportHeight / imageHeight
  };
}

async function clickAt(tabId, point) {
  await command(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
  await command(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
}

async function selectAll(tabId) {
  await command(tabId, "Input.dispatchKeyEvent", {
    type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2
  });
  await command(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2
  });
}

async function runVisualAction(tabId, action, context) {
  const type = String(action?.type || "");

  if (type === "wait") {
    const ms = Math.min(Math.max(Number(action.ms) || 1000, 250), 10000);
    await new Promise(resolve => setTimeout(resolve, ms));
    return { ok: true, result: "waited", ms };
  }

  if (type === "navigate") {
    const url = new URL(String(action.url || ""));
    if (!/^https?:$/.test(url.protocol)) throw new Error("Only HTTP(S) navigation is allowed.");
    await command(tabId, "Page.navigate", { url: url.href });
    return { ok: true, result: "navigating", url: url.href };
  }

  if (type === "scroll") {
    const viewportWidth = Number(context?.viewportWidth);
    const viewportHeight = Number(context?.viewportHeight);
    const x = Number.isFinite(Number(action.x))
      ? viewportPoint(action, context).x
      : viewportWidth / 2;
    const y = Number.isFinite(Number(action.y))
      ? viewportPoint(action, context).y
      : viewportHeight / 2;
    const deltaY = Math.max(Math.min(Number(action.deltaY) || viewportHeight * 0.8, viewportHeight * 2), -viewportHeight * 2);
    await command(tabId, "Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY });
    return { ok: true, result: "scrolled", deltaY };
  }

  if (type !== "click" && type !== "type") throw new Error(`Unsupported visual action: ${type}`);
  const point = viewportPoint(action, context);
  await clickAt(tabId, point);

  if (type === "type") {
    const text = String(action.text || "");
    if (!text) throw new Error("Type action is missing text.");
    await selectAll(tabId);
    await command(tabId, "Input.insertText", { text });
  }

  return { ok: true, result: type === "click" ? "clicked" : "typed", point };
}

chrome.debugger.onDetach.addListener(source => {
  if (source.tabId) attachedTabs.delete(source.tabId);
});

chrome.tabs.onRemoved.addListener(tabId => attachedTabs.delete(tabId));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = Number(message?.tabId);
  let operation;

  if (message?.type === "CAPTURE_VISUAL_PAGE") operation = capture(tabId);
  if (message?.type === "RUN_VISUAL_ACTION") operation = runVisualAction(tabId, message.action, message.context);
  if (message?.type === "DETACH_VISUAL_PAGE") operation = detach(tabId).then(() => ({ ok: true }));
  if (!operation) return false;

  operation.then(sendResponse).catch(error => sendResponse({ error: error.message || "Visual browser operation failed." }));
  return true;
});
