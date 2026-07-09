const MAX_TEXT_CHARS = 24000;
const MAX_CHUNKS = 28;
const MAX_CHUNK_CHARS = 1800;
const MAX_ELEMENTS = 220;
const MAX_FORM_VALUES = 160;
const MAX_SHADOW_DEPTH = 5;
const MAX_SNAPSHOT_ROOTS = 24;
const MAX_SHADOW_HOSTS_PER_ROOT = 80;
const MAX_ACTION_AGE_MS = 2 * 60 * 1000;

// These are hard ceilings, even when a caller asks for a larger snapshot. Keep
// the default page context compatible with the existing planner while giving
// workflow callers a cheaper, targeted alternative.
const SNAPSHOT_LIMITS = Object.freeze({
  full: Object.freeze({
    textChars: MAX_TEXT_CHARS,
    chunks: MAX_CHUNKS,
    chunkChars: MAX_CHUNK_CHARS,
    elements: MAX_ELEMENTS,
    formValues: MAX_FORM_VALUES
  }),
  light: Object.freeze({
    textChars: 8000,
    chunks: 10,
    chunkChars: 900,
    elements: 80,
    formValues: 40
  }),
  targeted: Object.freeze({
    textChars: 6000,
    chunks: 8,
    chunkChars: 700,
    elements: 50,
    formValues: 25
  })
});

const DOCUMENT_INSTANCE_ID = typeof globalThis.crypto?.randomUUID === "function"
  ? globalThis.crypto.randomUUID()
  : `doc-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
const DOCUMENT_CREATED_AT = new Date().toISOString();

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

function clampSnapshotLimit(value, fallback, hardMaximum) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(Math.floor(value), hardMaximum));
}

function normalizeSnapshotOptions(options = {}) {
  const requestedMode = String(options.snapshotMode || options.mode || "full").toLowerCase();
  const snapshotMode = Object.prototype.hasOwnProperty.call(SNAPSHOT_LIMITS, requestedMode)
    ? requestedMode
    : "full";
  const defaults = SNAPSHOT_LIMITS[snapshotMode];
  const full = SNAPSHOT_LIMITS.full;
  const requestedSelectors = Array.isArray(options.targetSelectors)
    ? options.targetSelectors
    : Array.isArray(options.selectors)
      ? options.selectors
      : [];

  return {
    snapshotMode,
    textChars: clampSnapshotLimit(options.textChars, defaults.textChars, full.textChars),
    chunks: clampSnapshotLimit(options.chunks, defaults.chunks, full.chunks),
    chunkChars: clampSnapshotLimit(options.chunkChars, defaults.chunkChars, full.chunkChars),
    elements: clampSnapshotLimit(options.elements, defaults.elements, full.elements),
    formValues: clampSnapshotLimit(options.formValues, defaults.formValues, full.formValues),
    targetSelectors: requestedSelectors.slice(0, 12)
  };
}

function normalizedDocumentUrl(value = location.href) {
  try {
    const url = new URL(value, location.href);
    // Fragments commonly change as a user scrolls or opens an in-page panel;
    // they do not indicate a different browser document.
    url.hash = "";
    return url.href;
  } catch (error) {
    return String(value || "");
  }
}

function getDocumentIdentity() {
  return {
    id: DOCUMENT_INSTANCE_ID,
    href: normalizedDocumentUrl(),
    origin: location.origin,
    createdAt: DOCUMENT_CREATED_AT
  };
}

function targetFingerprintPayload(el, root = document, selector = "", shadowPath = []) {
  return [
    "v1",
    selector,
    ...(shadowPath || []),
    el?.tagName?.toLowerCase() || "",
    el?.getAttribute?.("type") || "",
    el?.getAttribute?.("role") || "",
    el?.getAttribute?.("name") || "",
    el?.getAttribute?.("aria-label") || "",
    getAssociatedLabel(el, root),
    getElementText(el, root)
  ].map(value => cleanText(value, 180).toLowerCase()).join("\u001f");
}

function hashFingerprint(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `v1-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function getTargetFingerprint(el, root = document, selector = "", shadowPath = []) {
  return hashFingerprint(targetFingerprintPayload(el, root, selector, shadowPath));
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

function walkRoots(
  callback,
  root = document,
  shadowPath = [],
  depth = 0,
  state = { visitedRoots: 0, maxRoots: MAX_SNAPSHOT_ROOTS }
) {
  if (state.visitedRoots >= state.maxRoots) return;
  state.visitedRoots += 1;
  callback(root, shadowPath);

  if (depth >= MAX_SHADOW_DEPTH) return;

  for (const host of shadowHostsInRoot(root).slice(0, MAX_SHADOW_HOSTS_PER_ROOT)) {
    if (state.visitedRoots >= state.maxRoots) break;
    const hostSelector = buildSelectorInRoot(host, root);
    if (!hostSelector) continue;

    walkRoots(callback, host.shadowRoot, [...shadowPath, hostSelector], depth + 1, state);
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

function resolveSnapshotTargets(options) {
  const targets = [];
  const seen = new Set();

  for (const requestedTarget of options.targetSelectors || []) {
    const action = typeof requestedTarget === "string"
      ? { selector: requestedTarget }
      : requestedTarget;
    const resolved = resolveActionElement(action || {});

    if (!resolved.error && resolved.el && !seen.has(resolved.el)) {
      seen.add(resolved.el);
      targets.push(resolved.el);
    }
  }

  return targets;
}

function isTargetRelevant(el, targetElements) {
  return !targetElements.length || targetElements.some(target =>
    target === el || target.contains(el) || el.contains(target)
  );
}

function expectedDocumentIdentity(action) {
  return action?.expectedDocumentIdentity || action?.documentIdentity || action?.context?.documentIdentity;
}

function documentIdentityMatches(expected) {
  if (!expected) return true;

  const actual = getDocumentIdentity();
  if (typeof expected === "string") return expected === actual.id;
  if (typeof expected !== "object") return false;

  const expectedId = expected.id || expected.documentId || expected.instanceId;
  const expectedHref = expected.href || expected.url || expected.documentUrl;

  if (expectedId && expectedId !== actual.id) return false;
  if (expectedHref && normalizedDocumentUrl(expectedHref) !== actual.href) return false;

  return Boolean(expectedId || expectedHref);
}

function actionTimestamp(action) {
  const candidate = action?.expiresAt || action?.plannedAt || action?.createdAt || action?.context?.timestamp;
  if (!candidate) return null;
  const timestamp = Date.parse(candidate);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function verifyActionFreshness(action) {
  const expectedIdentity = expectedDocumentIdentity(action);
  if (expectedIdentity && !documentIdentityMatches(expectedIdentity)) {
    return { error: "Action is stale: the page document changed after planning. Re-observe and re-plan." };
  }

  if (action?.expectedUrl && normalizedDocumentUrl(action.expectedUrl) !== normalizedDocumentUrl()) {
    return { error: "Action is stale: the page URL changed after planning. Re-observe and re-plan." };
  }

  const timestamp = actionTimestamp(action);
  if (timestamp) {
    const expiry = action?.expiresAt ? timestamp : timestamp + MAX_ACTION_AGE_MS;
    if (Date.now() > expiry) {
      return { error: "Action is stale: its planning context expired. Re-observe and re-plan." };
    }
  }

  return null;
}

function matchesTargetMetadata(expected, el, root) {
  if (!expected || typeof expected !== "object") return true;

  const actual = {
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute("role") || "",
    type: el.getAttribute("type") || "",
    name: el.getAttribute("name") || "",
    ariaLabel: el.getAttribute("aria-label") || "",
    label: getAssociatedLabel(el, root),
    text: getElementText(el, root)
  };

  return ["tag", "role", "type", "name", "ariaLabel", "label", "text"].every(key => {
    if (expected[key] === undefined || expected[key] === null || expected[key] === "") return true;
    return cleanText(actual[key], 180).toLowerCase() === cleanText(expected[key], 180).toLowerCase();
  });
}

function verifyActionTargetFreshness(action, el, root) {
  const expectedFingerprint = action?.targetFingerprint || action?.expectedTargetFingerprint ||
    action?.target?.fingerprint || action?.expectedTarget?.fingerprint;

  if (expectedFingerprint) {
    const actualFingerprint = getTargetFingerprint(el, root, action.selector, action.shadowPath || []);
    if (expectedFingerprint !== actualFingerprint) {
      return { error: "Action target changed after planning. Re-observe and re-plan before acting." };
    }
  }

  const expectedTarget = action?.expectedTarget || action?.targetMetadata ||
    (action?.target && typeof action.target === "object" ? action.target : null);
  if (!matchesTargetMetadata(expectedTarget, el, root)) {
    return { error: "Action target no longer matches the planned control. Re-observe and re-plan before acting." };
  }

  return null;
}

function collectInteractiveElements(options = normalizeSnapshotOptions()) {
  const elements = [];
  const seen = new Set();
  const targetElements = resolveSnapshotTargets(options);

  walkRoots((root, shadowPath) => {
    if (elements.length >= options.elements) return;

    for (const el of queryAllInRoot(root, INTERACTIVE_SELECTOR)) {
      if (elements.length >= options.elements) break;
      if (seen.has(el) || !isVisible(el) || !isTargetRelevant(el, targetElements)) continue;

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
        sensitive: isSensitiveElement(el, root),
        targetFingerprint: getTargetFingerprint(el, root, selector, shadowPath)
      });
    }
  });

  return elements;
}

function collectFormValues(options = normalizeSnapshotOptions()) {
  const values = [];
  const targetElements = resolveSnapshotTargets(options);

  walkRoots((root, shadowPath) => {
    if (values.length >= options.formValues) return;

    for (const el of queryAllInRoot(root, FORM_SELECTOR)) {
      if (values.length >= options.formValues) break;
      if (!isVisible(el) || isSensitiveElement(el, root) || !isTargetRelevant(el, targetElements)) continue;

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
        value,
        targetFingerprint: getTargetFingerprint(el, root, selector, shadowPath)
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

function appendTextChunk(chunks, state, text, meta, options = normalizeSnapshotOptions()) {
  if (!text) return;

  if (state.current && state.current.text.length + text.length + 1 > options.chunkChars) {
    chunks.push(state.current);
    state.totalChars += state.current.text.length;
    state.current = null;
  }

  if (chunks.length >= options.chunks || state.totalChars >= options.textChars) return;

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

  const separator = state.current.text ? "\n" : "";
  const remainingChars = options.textChars - state.totalChars - state.current.text.length - separator.length;
  if (remainingChars <= 0) return;

  state.current.text = `${state.current.text}${separator}${text.slice(0, remainingChars)}`.slice(0, options.chunkChars);
}

function collectTargetedTextChunks(targetElements, options) {
  const chunks = [];
  let totalChars = 0;

  for (const target of targetElements) {
    if (chunks.length >= options.chunks || totalChars >= options.textChars || !isVisible(target)) break;

    const text = cleanText(target.innerText || target.textContent, Math.min(options.chunkChars, options.textChars - totalChars));
    if (!text) continue;

    chunks.push({
      chunkId: `chunk-${chunks.length + 1}`,
      heading: nearestHeadingText(target),
      source: target.getRootNode() instanceof ShadowRoot ? "open-shadow" : "dom",
      shadowPath: [],
      visibility: "visible",
      text
    });
    totalChars += text.length;
  }

  return chunks;
}

function collectTextChunks(options = normalizeSnapshotOptions()) {
  const targetElements = resolveSnapshotTargets(options);
  if (options.snapshotMode === "targeted" && targetElements.length) {
    return collectTargetedTextChunks(targetElements, options);
  }

  const chunks = [];
  const state = {
    current: null,
    totalChars: 0
  };

  walkRoots((root, shadowPath) => {
    if (chunks.length >= options.chunks || state.totalChars >= options.textChars) return;

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

    while (walker.nextNode() && chunks.length < options.chunks && state.totalChars < options.textChars) {
      const node = walker.currentNode;
      const text = cleanText(node.textContent, Math.min(900, options.chunkChars));
      appendTextChunk(chunks, state, text, {
        heading: nearestHeadingText(node),
        source: shadowPath.length ? "open-shadow" : "dom",
        shadowPath
      }, options);
    }
  });

  if (state.current && chunks.length < options.chunks) {
    chunks.push(state.current);
  }

  return chunks.map((chunk, index) => ({ ...chunk, chunkId: `chunk-${index + 1}` }));
}

function getVisibleText(options = normalizeSnapshotOptions()) {
  return collectTextChunks(options).map(chunk => chunk.text).join("\n").slice(0, options.textChars);
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

function getFrameContext(options = {}) {
  const snapshotOptions = normalizeSnapshotOptions(options);
  const chunks = collectTextChunks(snapshotOptions);

  return {
    url: location.href,
    title: document.title,
    timestamp: new Date().toISOString(),
    documentIdentity: getDocumentIdentity(),
    snapshotMode: snapshotOptions.snapshotMode,
    snapshotLimits: {
      textChars: snapshotOptions.textChars,
      chunks: snapshotOptions.chunks,
      chunkChars: snapshotOptions.chunkChars,
      elements: snapshotOptions.elements,
      formValues: snapshotOptions.formValues
    },
    text: chunks.map(chunk => chunk.text).join("\n").slice(0, snapshotOptions.textChars),
    chunks,
    elements: collectInteractiveElements(snapshotOptions),
    formValues: collectFormValues(snapshotOptions),
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

function removePreviewOverlay() {
  document.getElementById("chrome-ai-agent-preview-overlay")?.remove();
}

function previewElement(el) {
  if (!isVisible(el)) {
    return { error: "Target element is not visible." };
  }

  el.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
  el.focus?.({ preventScroll: true });

  const rect = el.getBoundingClientRect();
  removePreviewOverlay();

  const overlay = document.createElement("div");
  overlay.id = "chrome-ai-agent-preview-overlay";
  overlay.setAttribute("aria-hidden", "true");
  overlay.style.position = "fixed";
  overlay.style.left = `${Math.max(rect.left - 6, 0)}px`;
  overlay.style.top = `${Math.max(rect.top - 6, 0)}px`;
  overlay.style.width = `${Math.max(rect.width + 12, 16)}px`;
  overlay.style.height = `${Math.max(rect.height + 12, 16)}px`;
  overlay.style.border = "3px solid #39b8ff";
  overlay.style.borderRadius = "10px";
  overlay.style.boxShadow = "0 0 0 4px rgba(57, 184, 255, 0.24), 0 12px 34px rgba(0, 0, 0, 0.28)";
  overlay.style.pointerEvents = "none";
  overlay.style.zIndex = "2147483647";
  overlay.style.transition = "opacity 180ms ease";

  document.documentElement.appendChild(overlay);

  setTimeout(() => {
    overlay.style.opacity = "0";
    setTimeout(removePreviewOverlay, 220);
  }, 700);

  return { ok: true, result: "previewed target" };
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

  const freshnessError = verifyActionFreshness(action);
  if (freshnessError) return freshnessError;

  const type = String(action.type || "");

  if (!["click", "type", "submit", "extract"].includes(type)) {
    return { error: `Unsupported action type: ${type}` };
  }

  const resolved = resolveActionElement(action);
  if (resolved.error) return { error: resolved.error };

  const { el, root } = resolved;

  const targetFreshnessError = verifyActionTargetFreshness(action, el, root);
  if (targetFreshnessError) return targetFreshnessError;

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

async function previewAction(action) {
  if (!action || typeof action !== "object") {
    return { error: "Invalid action." };
  }

  const freshnessError = verifyActionFreshness(action);
  if (freshnessError) return freshnessError;

  const type = String(action.type || "");

  if (!["click", "type", "submit"].includes(type)) {
    return { ok: true, result: "preview skipped" };
  }

  const resolved = resolveActionElement(action);
  if (resolved.error) return { error: resolved.error };

  const { el, root } = resolved;

  const targetFreshnessError = verifyActionTargetFreshness(action, el, root);
  if (targetFreshnessError) return targetFreshnessError;

  if (actionLooksHighRisk(action, el, root)) {
    return { error: "Blocked high-risk payment, purchase, transfer, or destructive action." };
  }

  return previewElement(el);
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
    return { error: "No content-script recovery injection is supported." };
  }

  // Overriding window.confirm() can silently authorize destructive site actions.
  // Native dialogs must instead be handled by the background debugger, where it
  // can dismiss alerts only and pause for confirmations/prompts.
  return {
    error: "Automatic dialog overrides are disabled. Dismiss alert dialogs through the browser debugger or resolve this dialog manually."
  };
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

  const freshnessError = verifyActionFreshness(action);
  if (freshnessError) return freshnessError;

  const type = String(action.type || "");

  if (type === "scroll") return runScroll(action);

  if (type === "wait") {
    const ms = Math.min(Math.max(Number(action.ms) || 1000, 250), 10000);
    await sleep(ms);
    return { ok: true, result: "waited", ms };
  }

  if (type === "readFormValues") {
    return {
      ok: true,
      result: "form values read",
      formValues: collectFormValues(action.snapshotOptions || action)
    };
  }

  if (type === "extract") {
    return {
      ok: true,
      result: "snapshot extracted",
      snapshot: getFrameContext(action.snapshotOptions || action)
    };
  }

  if (type === "injectScriptOnce") return runInjectScriptOnce(action);
  if (type === "navigateCurrentUrl") return runNavigateCurrentUrl(action);

  if (type === "click" || type === "type") {
    const resolved = resolveActionElement(action);
    if (resolved.error) return { error: resolved.error };

    const { el, root } = resolved;

    const targetFreshnessError = verifyActionTargetFreshness(action, el, root);
    if (targetFreshnessError) return targetFreshnessError;

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
    sendResponse(getFrameContext(message.snapshotOptions || message.options || {}));
    return false;
  }

  if (message?.type === "RUN_ACTION") {
    runAction(message.action)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message || "Action failed." }));
    return true;
  }

  if (message?.type === "PREVIEW_ACTION") {
    previewAction(message.action)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message || "Action preview failed." }));
    return true;
  }

  if (message?.type === "GET_COLLECTION_SNAPSHOT") {
    sendResponse(getFrameContext(message.snapshotOptions || message.options || { snapshotMode: "light" }));
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
