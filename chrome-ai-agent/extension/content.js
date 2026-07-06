const MAX_TEXT_CHARS = 24000;
const MAX_CHUNKS = 28;
const MAX_CHUNK_CHARS = 1800;
const MAX_ELEMENTS = 220;
const MAX_FORM_VALUES = 160;
const MAX_SHADOW_DEPTH = 5;

const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "textarea",
  "select",
  "summary",
  "[role='button']",
  "[role='link']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='switch']",
  "[role='tab']",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

const FORM_SELECTOR = "input, textarea, select, [contenteditable='true']";

const SENSITIVE_WORDS = [
  "password",
  "passcode",
  "otp",
  "one-time",
  "one time",
  "credit",
  "card",
  "cvv",
  "cvc",
  "ssn",
  "social security",
  "secret",
  "token",
  "pin"
];

const DESTRUCTIVE_WORDS = [
  "delete",
  "remove",
  "destroy",
  "erase",
  "cancel account",
  "close account",
  "deactivate account"
];

const PAYMENT_WORDS = [
  "pay",
  "payment",
  "purchase",
  "buy now",
  "place order",
  "checkout",
  "transfer",
  "send money",
  "crypto",
  "wallet"
];

const WRITE_ACTION_WORDS = [
  "save",
  "update",
  "delete",
  "remove",
  "submit",
  "send",
  "post",
  "confirm",
  "approve"
];

function cleanText(value, max = 180) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function isVisible(el) {
  if (!el || !(el instanceof Element)) return false;

  const style = window.getComputedStyle(el);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.opacity === "0" ||
    el.hidden
  ) {
    return false;
  }

  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function rootDocument(root) {
  if (root instanceof Document) return root;
  return root.ownerDocument || document;
}

function cssAttrValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function queryAllInRoot(root, selector) {
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch (error) {
    return [];
  }
}

function buildSelectorInRoot(el, root = document) {
  if (el.id) {
    const selector = `#${CSS.escape(el.id)}`;

    try {
      if (root.querySelectorAll(selector).length === 1) return selector;
    } catch (error) {
      // Fall back to a path selector.
    }
  }

  const stableAttributes = ["data-testid", "data-test", "data-qa", "name", "aria-label"];

  for (const attr of stableAttributes) {
    const value = el.getAttribute(attr);
    if (value) {
      const selector = `${el.tagName.toLowerCase()}[${attr}="${cssAttrValue(value)}"]`;

      try {
        if (root.querySelectorAll(selector).length === 1) return selector;
      } catch (error) {
        // Fall back to a path selector.
      }
    }
  }

  const parts = [];
  let current = el;

  while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 7) {
    let part = current.tagName.toLowerCase();
    const parent = current.parentElement;

    if (!parent || parent === root) {
      parts.unshift(part);
      break;
    }

    const siblings = Array.from(parent.children).filter(child => child.tagName === current.tagName);

    if (siblings.length > 1) {
      part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
    }

    parts.unshift(part);
    current = parent;

    const selector = parts.join(" > ");
    try {
      if (root.querySelectorAll(selector).length === 1) return selector;
    } catch (error) {
      break;
    }
  }

  return parts.join(" > ");
}

function getAssociatedLabel(el, root = document) {
  if (el.labels && el.labels.length) {
    return cleanText(Array.from(el.labels).map(label => label.innerText).join(" "));
  }

  if (el.id) {
    const label = root.querySelector?.(`label[for="${cssAttrValue(el.id)}"]`) ||
      rootDocument(root).querySelector(`label[for="${cssAttrValue(el.id)}"]`);
    if (label) return cleanText(label.innerText);
  }

  const wrappingLabel = el.closest("label");
  if (wrappingLabel) return cleanText(wrappingLabel.innerText);

  return "";
}

function getElementText(el, root = document) {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return cleanText(el.placeholder || el.getAttribute("aria-label") || getAssociatedLabel(el, root));
  }

  return cleanText(el.innerText || el.textContent || el.getAttribute("aria-label") || el.getAttribute("title"));
}

function isSensitiveElement(el, root = document) {
  const inputType = (el.getAttribute("type") || "").toLowerCase();

  if (inputType === "password") return true;

  const haystack = [
    inputType,
    el.getAttribute("autocomplete"),
    el.getAttribute("name"),
    el.getAttribute("id"),
    el.getAttribute("placeholder"),
    el.getAttribute("aria-label"),
    getAssociatedLabel(el, root)
  ].join(" ").toLowerCase();

  return SENSITIVE_WORDS.some(word => haystack.includes(word));
}

function containsAnyWord(value, words) {
  const text = String(value || "").toLowerCase();
  return words.some(word => text.includes(word));
}

function actionLooksHighRisk(action, el, root = document) {
  const text = [
    action?.type,
    action?.selector,
    action?.text,
    el?.innerText,
    el?.textContent,
    el?.getAttribute?.("aria-label"),
    el?.getAttribute?.("title"),
    el?.getAttribute?.("name"),
    el?.getAttribute?.("placeholder"),
    getAssociatedLabel(el, root)
  ].join(" ");

  return containsAnyWord(text, PAYMENT_WORDS) || containsAnyWord(text, DESTRUCTIVE_WORDS);
}

function actionLooksLikeBlockedWrite(action, el, root = document) {
  const text = [
    action?.type,
    action?.selector,
    action?.text,
    action?.description,
    el?.innerText,
    el?.textContent,
    el?.getAttribute?.("aria-label"),
    el?.getAttribute?.("title"),
    el?.getAttribute?.("name"),
    el?.getAttribute?.("placeholder"),
    getAssociatedLabel(el, root)
  ].join(" ");

  return containsAnyWord(text, WRITE_ACTION_WORDS);
}

function shadowHostsInRoot(root) {
  return queryAllInRoot(root, "*").filter(el => el.shadowRoot);
}

function walkRoots(callback, root = document, shadowPath = [], depth = 0) {
  callback(root, shadowPath);

  if (depth >= MAX_SHADOW_DEPTH) return;

  for (const host of shadowHostsInRoot(root)) {
    const hostSelector = buildSelectorInRoot(host, root);
    if (!hostSelector) continue;

    walkRoots(callback, host.shadowRoot, [...shadowPath, hostSelector], depth + 1);
  }
}

function resolveActionRoot(action) {
  let root = document;

  for (const hostSelector of action.shadowPath || []) {
    let host;

    try {
      host = root.querySelector(hostSelector);
    } catch (error) {
      return { error: `Invalid shadow host selector: ${hostSelector}` };
    }

    if (!host) return { error: `Shadow host not found: ${hostSelector}` };
    if (!host.shadowRoot) return { error: `Shadow host is closed or inaccessible: ${hostSelector}` };
    root = host.shadowRoot;
  }

  return { root };
}

function resolveActionElement(action) {
  const resolved = resolveActionRoot(action);
  if (resolved.error) return resolved;

  if (!action.selector || typeof action.selector !== "string") {
    return { error: "Action is missing a selector." };
  }

  try {
    const el = resolved.root.querySelector(action.selector);
    if (!el) return { error: `Element not found: ${action.selector}` };
    return { el, root: resolved.root };
  } catch (error) {
    return { error: `Invalid selector: ${action.selector}` };
  }
}

function collectInteractiveElements() {
  const elements = [];
  const seen = new Set();

  walkRoots((root, shadowPath) => {
    if (elements.length >= MAX_ELEMENTS) return;

    for (const el of queryAllInRoot(root, INTERACTIVE_SELECTOR)) {
      if (elements.length >= MAX_ELEMENTS) break;
      if (seen.has(el) || !isVisible(el)) continue;

      seen.add(el);

      const selector = buildSelectorInRoot(el, root);
      if (!selector) continue;

      const type = (el.getAttribute("type") || "").toLowerCase();

      elements.push({
        selector,
        shadowPath,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role") || "",
        type,
        text: getElementText(el, root),
        label: getAssociatedLabel(el, root),
        placeholder: cleanText(el.getAttribute("placeholder")),
        name: cleanText(el.getAttribute("name")),
        ariaLabel: cleanText(el.getAttribute("aria-label")),
        disabled: Boolean(el.disabled || el.getAttribute("aria-disabled") === "true"),
        sensitive: isSensitiveElement(el, root)
      });
    }
  });

  return elements;
}

function collectFormValues() {
  const values = [];

  walkRoots((root, shadowPath) => {
    if (values.length >= MAX_FORM_VALUES) return;

    for (const el of queryAllInRoot(root, FORM_SELECTOR)) {
      if (values.length >= MAX_FORM_VALUES) break;
      if (!isVisible(el) || isSensitiveElement(el, root)) continue;

      const selector = buildSelectorInRoot(el, root);
      if (!selector) continue;

      const value = el instanceof HTMLSelectElement
        ? cleanText(el.selectedOptions?.[0]?.text || el.value, 500)
        : el.isContentEditable
          ? cleanText(el.innerText || el.textContent, 1000)
          : cleanText(el.value, 1000);

      values.push({
        selector,
        shadowPath,
        tag: el.tagName.toLowerCase(),
        type: (el.getAttribute("type") || "").toLowerCase(),
        label: getAssociatedLabel(el, root),
        name: cleanText(el.getAttribute("name")),
        placeholder: cleanText(el.getAttribute("placeholder")),
        value
      });
    }
  });

  return values;
}

function nearestHeadingText(node) {
  let el = node instanceof Element ? node : node.parentElement;

  while (el && el !== document.body) {
    const heading = el.matches?.("h1,h2,h3,h4,h5,h6,[role='heading']")
      ? el
      : el.querySelector?.("h1,h2,h3,h4,h5,h6,[role='heading']");

    if (heading && isVisible(heading)) return cleanText(heading.innerText || heading.textContent, 120);
    el = el.parentElement;
  }

  return cleanText(document.title || location.hostname, 120);
}

function appendTextChunk(chunks, state, text, meta) {
  if (!text) return;

  if (state.current && state.current.text.length + text.length + 1 > MAX_CHUNK_CHARS) {
    chunks.push(state.current);
    state.totalChars += state.current.text.length;
    state.current = null;
  }

  if (!state.current) {
    state.current = {
      chunkId: `chunk-${chunks.length + 1}`,
      heading: meta.heading || cleanText(document.title || location.hostname, 120),
      source: meta.source,
      shadowPath: meta.shadowPath || [],
      visibility: "visible",
      text: ""
    };
  }

  state.current.text = `${state.current.text}${state.current.text ? "\n" : ""}${text}`.slice(0, MAX_CHUNK_CHARS);
}

function collectTextChunks() {
  const chunks = [];
  const state = {
    current: null,
    totalChars: 0
  };

  walkRoots((root, shadowPath) => {
    if (chunks.length >= MAX_CHUNKS || state.totalChars >= MAX_TEXT_CHARS) return;

    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const text = node.textContent.trim();
          if (!text) return NodeFilter.FILTER_REJECT;

          const parent = node.parentElement;
          if (!parent || !isVisible(parent)) return NodeFilter.FILTER_REJECT;

          if (["SCRIPT", "STYLE", "NOSCRIPT"].includes(parent.tagName)) {
            return NodeFilter.FILTER_REJECT;
          }

          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    while (walker.nextNode() && chunks.length < MAX_CHUNKS && state.totalChars < MAX_TEXT_CHARS) {
      const node = walker.currentNode;
      const text = cleanText(node.textContent, 900);
      appendTextChunk(chunks, state, text, {
        heading: nearestHeadingText(node),
        source: shadowPath.length ? "open-shadow" : "dom",
        shadowPath
      });
    }
  });

  if (state.current && chunks.length < MAX_CHUNKS) {
    chunks.push(state.current);
  }

  return chunks.map((chunk, index) => ({ ...chunk, chunkId: `chunk-${index + 1}` }));
}

function getVisibleText() {
  return collectTextChunks().map(chunk => chunk.text).join("\n").slice(0, MAX_TEXT_CHARS);
}

function getScrollState() {
  const scrollingElement = document.scrollingElement || document.documentElement;
  const scrollTop = scrollingElement.scrollTop;
  const scrollLeft = scrollingElement.scrollLeft;
  const documentHeight = scrollingElement.scrollHeight;
  const documentWidth = scrollingElement.scrollWidth;
  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;

  return {
    scrollTop,
    scrollLeft,
    documentHeight,
    documentWidth,
    viewportHeight,
    viewportWidth,
    atTop: scrollTop <= 8,
    atBottom: scrollTop + viewportHeight >= documentHeight - 8
  };
}

function collectShadowWarnings() {
  const warnings = [];
  const customElements = queryAllInRoot(document, "*").filter(el => el.localName.includes("-"));
  const closedOrUnknown = customElements.filter(el => !el.shadowRoot).slice(0, 12);

  if (closedOrUnknown.length) {
    warnings.push("Some custom elements may use closed or inaccessible shadow roots.");
  }

  return warnings;
}

function getFrameContext() {
  const chunks = collectTextChunks();

  return {
    url: location.href,
    title: document.title,
    timestamp: new Date().toISOString(),
    text: chunks.map(chunk => chunk.text).join("\n").slice(0, MAX_TEXT_CHARS),
    chunks,
    elements: collectInteractiveElements(),
    formValues: collectFormValues(),
    scroll: getScrollState(),
    warnings: collectShadowWarnings()
  };
}

function setElementValue(el, value) {
  const text = String(value || "");

  if (el.isContentEditable) {
    el.focus();
    el.textContent = text;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    return;
  }

  const proto = Object.getPrototypeOf(el);
  const descriptor = Object.getOwnPropertyDescriptor(proto, "value");

  if (descriptor && descriptor.set) {
    descriptor.set.call(el, text);
  } else {
    el.value = text;
  }

  el.focus();
  el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function runClick(el) {
  el.scrollIntoView({ block: "center", inline: "center" });
  el.focus?.();
  el.click();

  return { ok: true, result: "clicked" };
}

function isSubmitControl(el) {
  if (el instanceof HTMLButtonElement) {
    const type = (el.getAttribute("type") || "submit").toLowerCase();
    return type === "submit" || type === "image";
  }

  if (el instanceof HTMLInputElement) {
    const type = (el.getAttribute("type") || "").toLowerCase();
    return type === "submit" || type === "image";
  }

  return false;
}

function runType(el, root, text) {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable)) {
    return { error: "Target is not a text input, textarea, or contenteditable element." };
  }

  if (isSensitiveElement(el, root)) {
    return { error: "Blocked typing into a password, OTP, card, or secret field." };
  }

  if (el.disabled || el.readOnly) {
    return { error: "Target is disabled or read-only." };
  }

  el.scrollIntoView({ block: "center", inline: "center" });
  setElementValue(el, text);

  return { ok: true, result: "typed" };
}

function runSubmit(el, root) {
  if (actionLooksHighRisk({ type: "submit" }, el, root)) {
    return { error: "Blocked high-risk submit action." };
  }

  const form = el.closest("form");

  if (form) {
    form.scrollIntoView({ block: "center", inline: "center" });

    if (typeof form.requestSubmit === "function") {
      form.requestSubmit(isSubmitControl(el) ? el : undefined);
    } else {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    }

    return { ok: true, result: "submitted form" };
  }

  if (
    el instanceof HTMLButtonElement ||
    el instanceof HTMLInputElement ||
    el instanceof HTMLAnchorElement ||
    el.getAttribute("role") === "button"
  ) {
    return runClick(el);
  }

  return { error: "No form or submit-like element found for submit action." };
}

function runExtract(el, root) {
  if (isSensitiveElement(el, root)) {
    return { error: "Blocked extracting from a sensitive field." };
  }

  const text = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
    ? el.value
    : el.innerText || el.textContent || "";

  return { ok: true, result: cleanText(text, 2000) };
}

async function runAction(action) {
  if (!action || typeof action !== "object") {
    return { error: "Invalid action." };
  }

  const type = String(action.type || "");

  if (!["click", "type", "submit", "extract"].includes(type)) {
    return { error: `Unsupported action type: ${type}` };
  }

  const resolved = resolveActionElement(action);
  if (resolved.error) return { error: resolved.error };

  const { el, root } = resolved;

  if (!isVisible(el)) {
    return { error: "Target element is not visible." };
  }

  if (actionLooksHighRisk(action, el, root)) {
    return { error: "Blocked high-risk payment, purchase, transfer, or destructive action." };
  }

  if (type === "click") return runClick(el);
  if (type === "type") return runType(el, root, action.text || "");
  if (type === "submit") return runSubmit(el, root);
  if (type === "extract") return runExtract(el, root);

  return { error: "Action did not run." };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function runScroll(action) {
  const direction = String(action.direction || "down").toLowerCase();
  const pixels = Number.isFinite(action.pixels) ? action.pixels : Math.round(window.innerHeight * 0.8);

  if (direction === "top") {
    window.scrollTo({ top: 0, behavior: "smooth" });
  } else if (direction === "bottom") {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
  } else {
    window.scrollBy({
      top: direction === "up" ? -Math.abs(pixels) : Math.abs(pixels),
      left: 0,
      behavior: "smooth"
    });
  }

  return { ok: true, result: "scrolled", scroll: getScrollState() };
}

function runInjectScriptOnce(action) {
  const name = String(action.name || "");

  if (name !== "autoDismissDialogs") {
    return { error: "Only the autoDismissDialogs recovery script is supported." };
  }

  if (document.documentElement.dataset.chromeAiAgentAutoDismissDialogs === "true") {
    return { ok: true, result: "autoDismissDialogs already installed" };
  }

  const script = document.createElement("script");
  script.textContent = `
    (() => {
      window.alert = function noopAlert() {};
      window.confirm = function confirmOk() { return true; };
      window.print = function noopPrint() {};
      document.documentElement.dataset.chromeAiAgentAutoDismissDialogs = "true";
    })();
  `;
  (document.documentElement || document.head || document.body).appendChild(script);
  script.remove();

  return { ok: true, result: "autoDismissDialogs installed" };
}

function runNavigateCurrentUrl(action) {
  const url = String(action.url || location.href);

  try {
    const nextUrl = new URL(url, location.href);

    if (nextUrl.origin !== location.origin) {
      return { error: "Blocked navigation outside the current origin." };
    }

    location.href = nextUrl.href;
    return { ok: true, result: "navigating", url: nextUrl.href };
  } catch (error) {
    return { error: "Invalid navigation URL." };
  }
}

async function runCollectionAction(action) {
  if (!action || typeof action !== "object") {
    return { error: "Invalid collection action." };
  }

  const type = String(action.type || "");

  if (type === "scroll") return runScroll(action);

  if (type === "wait") {
    const ms = Math.min(Math.max(Number(action.ms) || 1000, 250), 10000);
    await sleep(ms);
    return { ok: true, result: "waited", ms };
  }

  if (type === "readFormValues") {
    return { ok: true, result: "form values read", formValues: collectFormValues() };
  }

  if (type === "extract") {
    return { ok: true, result: "snapshot extracted", snapshot: getFrameContext() };
  }

  if (type === "injectScriptOnce") return runInjectScriptOnce(action);
  if (type === "navigateCurrentUrl") return runNavigateCurrentUrl(action);

  if (type === "click" || type === "type") {
    const resolved = resolveActionElement(action);
    if (resolved.error) return { error: resolved.error };

    const { el, root } = resolved;

    if (!isVisible(el)) return { error: "Target element is not visible." };
    if (actionLooksHighRisk(action, el, root) || actionLooksLikeBlockedWrite(action, el, root)) {
      return { error: "Blocked high-risk or write-like page action." };
    }

    if (type === "click") return runClick(el);
    return runType(el, root, action.text || "");
  }

  return { error: `Unsupported collection action type: ${type}` };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "GET_FRAME_CONTEXT" || message?.type === "GET_PAGE_CONTEXT") {
    sendResponse(getFrameContext());
    return false;
  }

  if (message?.type === "RUN_ACTION") {
    runAction(message.action)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message || "Action failed." }));
    return true;
  }

  if (message?.type === "GET_COLLECTION_SNAPSHOT") {
    sendResponse(getFrameContext());
    return false;
  }

  if (message?.type === "RUN_COLLECTION_ACTION") {
    runCollectionAction(message.action)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message || "Collection action failed." }));
    return true;
  }

  return false;
});
