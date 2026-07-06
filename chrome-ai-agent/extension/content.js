const MAX_TEXT_CHARS = 12000;
const MAX_ELEMENTS = 160;
const MAX_FORM_VALUES = 120;

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

function getVisibleText() {
  if (!document.body) return "";

  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const text = node.textContent.trim();
        if (!text) return NodeFilter.FILTER_REJECT;

        const parent = node.parentElement;
        if (!parent || !isVisible(parent)) return NodeFilter.FILTER_REJECT;

        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  const chunks = [];
  let length = 0;

  while (walker.nextNode()) {
    const text = cleanText(walker.currentNode.textContent, 1000);
    if (!text) continue;

    chunks.push(text);
    length += text.length + 1;

    if (length > MAX_TEXT_CHARS) break;
  }

  return chunks.join("\n").slice(0, MAX_TEXT_CHARS);
}

function cssAttrValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildSelector(el) {
  if (el.id) {
    return `#${CSS.escape(el.id)}`;
  }

  const stableAttributes = ["data-testid", "data-test", "data-qa", "name", "aria-label"];

  for (const attr of stableAttributes) {
    const value = el.getAttribute(attr);
    if (value) {
      const selector = `${el.tagName.toLowerCase()}[${attr}="${cssAttrValue(value)}"]`;

      try {
        if (document.querySelectorAll(selector).length === 1) return selector;
      } catch (error) {
        // Fall back to the path selector below.
      }
    }
  }

  const parts = [];
  let current = el;

  while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 5) {
    let part = current.tagName.toLowerCase();
    const parent = current.parentElement;

    if (!parent) {
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
      if (document.querySelectorAll(selector).length === 1) return selector;
    } catch (error) {
      break;
    }
  }

  return parts.join(" > ");
}

function getAssociatedLabel(el) {
  if (el.labels && el.labels.length) {
    return cleanText(Array.from(el.labels).map(label => label.innerText).join(" "));
  }

  if (el.id) {
    const label = document.querySelector(`label[for="${cssAttrValue(el.id)}"]`);
    if (label) return cleanText(label.innerText);
  }

  const wrappingLabel = el.closest("label");
  if (wrappingLabel) return cleanText(wrappingLabel.innerText);

  return "";
}

function getElementText(el) {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return cleanText(el.placeholder || el.getAttribute("aria-label") || getAssociatedLabel(el));
  }

  return cleanText(el.innerText || el.textContent || el.getAttribute("aria-label") || el.getAttribute("title"));
}

function isSensitiveElement(el) {
  const inputType = (el.getAttribute("type") || "").toLowerCase();

  if (inputType === "password") return true;

  const haystack = [
    inputType,
    el.getAttribute("autocomplete"),
    el.getAttribute("name"),
    el.getAttribute("id"),
    el.getAttribute("placeholder"),
    el.getAttribute("aria-label"),
    getAssociatedLabel(el)
  ].join(" ").toLowerCase();

  return SENSITIVE_WORDS.some(word => haystack.includes(word));
}

function collectInteractiveElements() {
  const elements = [];
  const seen = new Set();

  for (const el of document.querySelectorAll(INTERACTIVE_SELECTOR)) {
    if (elements.length >= MAX_ELEMENTS) break;
    if (seen.has(el) || !isVisible(el)) continue;

    seen.add(el);

    const selector = buildSelector(el);
    if (!selector) continue;

    const type = (el.getAttribute("type") || "").toLowerCase();
    const summary = {
      selector,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || "",
      type,
      text: getElementText(el),
      label: getAssociatedLabel(el),
      placeholder: cleanText(el.getAttribute("placeholder")),
      name: cleanText(el.getAttribute("name")),
      ariaLabel: cleanText(el.getAttribute("aria-label")),
      disabled: Boolean(el.disabled || el.getAttribute("aria-disabled") === "true"),
      sensitive: isSensitiveElement(el)
    };

    elements.push(summary);
  }

  return elements;
}

function collectFormValues() {
  const values = [];

  for (const el of document.querySelectorAll("input, textarea, select, [contenteditable='true']")) {
    if (values.length >= MAX_FORM_VALUES) break;
    if (!isVisible(el) || isSensitiveElement(el)) continue;

    const selector = buildSelector(el);
    if (!selector) continue;

    const value = el instanceof HTMLSelectElement
      ? cleanText(el.selectedOptions?.[0]?.text || el.value, 500)
      : el.isContentEditable
        ? cleanText(el.innerText || el.textContent, 1000)
        : cleanText(el.value, 1000);

    values.push({
      selector,
      tag: el.tagName.toLowerCase(),
      type: (el.getAttribute("type") || "").toLowerCase(),
      label: getAssociatedLabel(el),
      name: cleanText(el.getAttribute("name")),
      placeholder: cleanText(el.getAttribute("placeholder")),
      value
    });
  }

  return values;
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

function getCollectionSnapshot() {
  return {
    url: location.href,
    title: document.title,
    timestamp: new Date().toISOString(),
    text: getVisibleText(),
    elements: collectInteractiveElements(),
    formValues: collectFormValues(),
    scroll: getScrollState()
  };
}

function containsAnyWord(value, words) {
  const text = String(value || "").toLowerCase();
  return words.some(word => text.includes(word));
}

function actionLooksHighRisk(action, el) {
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
    getAssociatedLabel(el)
  ].join(" ");

  return containsAnyWord(text, PAYMENT_WORDS) || containsAnyWord(text, DESTRUCTIVE_WORDS);
}

function actionLooksLikeBlockedWrite(action, el) {
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
    getAssociatedLabel(el)
  ].join(" ");

  return containsAnyWord(text, WRITE_ACTION_WORDS);
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

function runType(el, text) {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable)) {
    return { error: "Target is not a text input, textarea, or contenteditable element." };
  }

  if (isSensitiveElement(el)) {
    return { error: "Blocked typing into a password, OTP, card, or secret field." };
  }

  if (el.disabled || el.readOnly) {
    return { error: "Target is disabled or read-only." };
  }

  el.scrollIntoView({ block: "center", inline: "center" });
  setElementValue(el, text);

  return { ok: true, result: "typed" };
}

function runSubmit(el) {
  if (actionLooksHighRisk({ type: "submit" }, el)) {
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

function runExtract(el) {
  if (isSensitiveElement(el)) {
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

  const { type, selector, text } = action;

  if (!["click", "type", "submit", "extract"].includes(type)) {
    return { error: `Unsupported action type: ${type}` };
  }

  if (!selector || typeof selector !== "string") {
    return { error: "Action is missing a selector." };
  }

  let el;

  try {
    el = document.querySelector(selector);
  } catch (error) {
    return { error: `Invalid selector: ${selector}` };
  }

  if (!el) {
    return { error: `Element not found: ${selector}` };
  }

  if (!isVisible(el)) {
    return { error: "Target element is not visible." };
  }

  if (actionLooksHighRisk(action, el)) {
    return { error: "Blocked high-risk payment, purchase, transfer, or destructive action." };
  }

  if (type === "click") return runClick(el);
  if (type === "type") return runType(el, text || "");
  if (type === "submit") return runSubmit(el);
  if (type === "extract") return runExtract(el);

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
    return { ok: true, result: "snapshot extracted", snapshot: getCollectionSnapshot() };
  }

  if (type === "injectScriptOnce") return runInjectScriptOnce(action);
  if (type === "navigateCurrentUrl") return runNavigateCurrentUrl(action);

  if (type === "click" || type === "type") {
    if (!action.selector || typeof action.selector !== "string") {
      return { error: "Action is missing a selector." };
    }

    let el;

    try {
      el = document.querySelector(action.selector);
    } catch (error) {
      return { error: `Invalid selector: ${action.selector}` };
    }

    if (!el) return { error: `Element not found: ${action.selector}` };
    if (!isVisible(el)) return { error: "Target element is not visible." };
    if (actionLooksHighRisk(action, el) || actionLooksLikeBlockedWrite(action, el)) {
      return { error: "Blocked high-risk or write-like page action." };
    }

    if (type === "click") return runClick(el);
    return runType(el, action.text || "");
  }

  return { error: `Unsupported collection action type: ${type}` };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "GET_PAGE_CONTEXT") {
    sendResponse({
      url: location.href,
      title: document.title,
      text: getVisibleText(),
      elements: collectInteractiveElements()
    });
    return false;
  }

  if (message?.type === "RUN_ACTION") {
    runAction(message.action)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message || "Action failed." }));
    return true;
  }

  if (message?.type === "GET_COLLECTION_SNAPSHOT") {
    sendResponse(getCollectionSnapshot());
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
