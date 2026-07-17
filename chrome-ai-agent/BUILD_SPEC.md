# Chrome AI Agent Build Spec for Codex

> **Current architecture override:** The implemented agent is screenshot-only and has no task approval gate. It captures the visible tab with the Chrome debugger protocol, sends the PNG to a vision-capable provider, and executes validated coordinate actions automatically. The older permission-gate, content-script, DOM snapshot, selector, and multi-action examples below are historical and must not be used as the implementation source of truth.

This Markdown file is a full build brief for **Codex**. Save it as `BUILD_SPEC.md` inside a new project folder and ask Codex to create the project.

The goal is to build a local Chrome browser AI agent similar in concept to a side-panel browser assistant: it can read the current page, reason about the page, and perform page actions such as clicking, typing, extracting, and submitting forms.

This updated version includes these user requirements:

1. Ask permission **once per task/action batch**, not before every individual action.
2. Allow automatic submit only when the user has clearly instructed the agent to submit/send/post/search/confirm that form.
3. Do **not** add a domain allowlist. The extension should be usable on all normal websites through Chrome `<all_urls>` permissions.
4. Runtime AI provider options:
   - Claude API key
   - OpenAI API key
   - OpenAI sign-in through the local Codex CLI, as an experimental local-only mode

Important: **Codex is used to build the project. Codex is not required as the runtime model unless the user chooses the experimental “OpenAI sign-in / Codex CLI” provider.**

---

## 1. Product goal

Build a Chrome Manifest V3 extension called **Chrome AI Agent**.

The agent should:

1. Open as a Chrome side panel.
2. Let the user choose a runtime provider:
   - `openai_api_key`
   - `claude_api_key`
   - `openai_signin_codex`
3. Let the user type tasks such as:
   - `Summarize this page.`
   - `Find the login button.`
   - `Click the search box and type wireless headphones.`
   - `Fill this contact form with my message and submit it.`
4. Read visible page text and interactive DOM elements.
5. Send the task + page context to a local backend.
6. Use the selected runtime provider from the backend.
7. Return:
   - a user-facing reply
   - optional browser actions
8. Show the action batch to the user.
9. Ask for permission once for the whole task/action batch.
10. Run all approved, validated, non-blocked actions in sequence.
11. Auto-submit ordinary forms if the user explicitly instructed the agent to submit.

---

## 2. High-level architecture

```text
Chrome Side Panel UI
  ↓ user enters task + provider settings
Extension sidepanel.js
  ↓ asks content.js for current page context
Content Script
  ↓ returns visible text + interactive elements
Local Backend Server
  ↓ calls selected runtime provider
AI Provider
  ↓ returns JSON reply + proposed browser actions
Backend Validator
  ↓ validates selectors, action types, submit permission, and risk rules
Side Panel UI
  ↓ user grants permission once for this task batch
Content Script
  ↓ clicks/types/submits/extracts on the current page
```

Why this architecture:

- The Chrome extension should not contain hardcoded API keys.
- The backend keeps provider credentials in `.env` or a local gitignored secrets file.
- The content script handles DOM access.
- The side panel gives the user a persistent control UI.
- The user gives one permission per task/action batch instead of approving every action one by one.

---

## 3. Provider modes

### 3.1 `openai_api_key`

Uses the official OpenAI JavaScript SDK from the local backend.

The key can come from either:

- `server/.env`, or
- the side-panel settings form, which sends the key to the local backend and then clears the key field.

### 3.2 `claude_api_key`

Uses the official Anthropic SDK from the local backend.

The key can come from either:

- `server/.env`, or
- the side-panel settings form, which sends the key to the local backend and then clears the key field.

### 3.3 `openai_signin_codex`

Experimental local-only mode.

This mode does **not** use an OpenAI API key directly. Instead, it calls the local `codex` CLI from the backend. The user must have Codex installed and signed in with ChatGPT.

This is useful for local prototyping when the user wants an OpenAI sign-in flow instead of manually entering an API key.

Limitations:

- This mode depends on the local Codex CLI being installed.
- This mode is slower than direct API calls.
- This mode is not recommended for production browser-agent deployment.
- Do not scrape ChatGPT browser cookies or automate the ChatGPT website. Only use the official local Codex CLI sign-in flow.

---

## 4. Main safety rules

Use these rules from the first version:

1. Never hardcode API keys in extension files.
2. Never commit `.env` or local secrets files.
3. Ask permission once per task/action batch before executing actions.
4. Do not repeatedly ask permission before every click/type/submit action in the same batch.
5. Allow `submit` actions only when the user explicitly asked to submit/send/post/search/confirm the current form or action.
6. Do not add a domain allowlist. Use `<all_urls>` so the extension can run on all normal websites.
7. Still acknowledge Chrome limitations: extensions cannot run on some internal pages such as `chrome://` pages.
8. Never type into password fields.
9. Block obvious high-risk irreversible actions even if the model proposes them, including:
   - payment submission
   - purchase confirmation
   - financial transfer
   - crypto transfer
   - account deletion
   - destructive delete/remove actions
10. For risky requests, explain the issue and return no executable actions.
11. Limit action batches to 1-5 actions for the MVP.
12. Log proposed actions, blocked actions, and executed actions in the side panel.

Important clarification about submit:

- Allowed example: `Fill this contact form with “I am interested” and submit it.`
- Allowed example: `Search for wireless headphones and submit the search.`
- Blocked example: `Submit the payment.`
- Blocked example: `Confirm the purchase.`
- Blocked example: `Delete my account.`

---

## 5. Tech stack

Use:

- Chrome Manifest V3 extension
- Chrome Side Panel API
- HTML/CSS/JavaScript for the side panel
- Content script for DOM reading and browser actions
- Node.js backend
- Express server
- OpenAI JavaScript SDK
- Anthropic JavaScript SDK
- Optional Codex CLI adapter for OpenAI sign-in mode
- `.env` and `.runtime-secrets.json` for local credentials

Recommended local tools:

- Node.js LTS or newer
- Chrome or Chromium-based browser
- npm
- Codex CLI, Codex app, or Codex IDE extension to build the project

---

## 6. Project structure

Create this structure:

```text
chrome-ai-agent/
  README.md
  BUILD_SPEC.md
  AGENTS.md
  .gitignore

  extension/
    manifest.json
    background.js
    sidepanel.html
    sidepanel.js
    content.js

  server/
    package.json
    index.js
    .env.example
```

---

## 7. Codex workflow

### Option A: Codex CLI

From an empty folder:

```bash
mkdir chrome-ai-agent
cd chrome-ai-agent
git init
```

Save this file as:

```text
BUILD_SPEC.md
```

Then run:

```bash
codex
```

Paste this task into Codex:

```text
Read BUILD_SPEC.md and build the full Chrome AI Agent MVP exactly as specified. Create all files in the project tree. Do not hardcode API keys in the extension. Use a local Node/Express backend. Support three runtime provider modes: OpenAI API key, Claude API key, and experimental OpenAI sign-in through the local Codex CLI. Implement one-time permission per task/action batch. Allow submit actions only when the user explicitly instructed submit/send/post/search/confirm. Do not add a domain allowlist; use <all_urls>. Keep high-risk destructive/payment/password actions blocked. Run syntax checks and tell me how to start the backend and load the unpacked extension in Chrome.
```

### Option B: Codex app or IDE extension

1. Create the `chrome-ai-agent` folder.
2. Add this file as `BUILD_SPEC.md`.
3. Open the folder in Codex.
4. Ask Codex to implement the build spec.
5. Review every diff before accepting it.
6. Commit after each working milestone.

Recommended checkpoint commands:

```bash
git add .
git commit -m "Initial Chrome AI Agent MVP"
```

---

# 8. Full extension code

## `extension/manifest.json`

```json
{
  "manifest_version": 3,
  "name": "Chrome AI Agent",
  "version": "0.2.0",
  "description": "A browser AI agent that can read the current page and run approved task batches.",
  "minimum_chrome_version": "116",
  "permissions": [
    "activeTab",
    "scripting",
    "sidePanel",
    "tabs"
  ],
  "host_permissions": [
    "<all_urls>",
    "http://localhost:3000/*"
  ],
  "background": {
    "service_worker": "background.js"
  },
  "side_panel": {
    "default_path": "sidepanel.html"
  },
  "action": {
    "default_title": "Open AI Agent"
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content.js"],
      "run_at": "document_idle"
    }
  ]
}
```

Notes:

- `<all_urls>` is intentional because the user wants the extension usable on all websites.
- Chrome will still block extensions on some internal browser pages such as `chrome://`.
- Chrome may show permission warnings because the extension can read page content.

---

## `extension/background.js`

```js
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});
```

---

## `extension/sidepanel.html`

```html
<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <title>Chrome AI Agent</title>
    <style>
      :root {
        color-scheme: light dark;
      }

      body {
        font-family: Arial, sans-serif;
        margin: 12px;
        font-size: 14px;
      }

      h2, h3 {
        margin-bottom: 6px;
      }

      label {
        display: block;
        margin-top: 8px;
        font-size: 12px;
        opacity: 0.85;
      }

      select,
      input,
      textarea {
        width: 100%;
        box-sizing: border-box;
        padding: 8px;
        margin-top: 4px;
      }

      textarea {
        min-height: 90px;
        resize: vertical;
      }

      button {
        margin-top: 8px;
        padding: 8px 12px;
        cursor: pointer;
      }

      button:disabled {
        cursor: not-allowed;
        opacity: 0.6;
      }

      .box {
        margin-top: 12px;
        padding: 10px;
        border: 1px solid #ddd;
        border-radius: 8px;
        white-space: pre-wrap;
        overflow-wrap: break-word;
      }

      .muted {
        opacity: 0.75;
        font-size: 12px;
      }

      .danger {
        color: #9b1c1c;
      }

      .action-card {
        border: 1px solid #ccc;
        border-radius: 8px;
        padding: 8px;
        margin-top: 8px;
      }
    </style>
  </head>

  <body>
    <h2>AI Agent</h2>
    <p class="muted">The agent can read the current page and run a task batch after one permission click.</p>

    <h3>Provider</h3>

    <label for="provider">Runtime provider</label>
    <select id="provider">
      <option value="openai_api_key">OpenAI API key</option>
      <option value="claude_api_key">Claude API key</option>
      <option value="openai_signin_codex">OpenAI sign-in through Codex CLI</option>
    </select>

    <label for="model">Model</label>
    <input id="model" placeholder="Example: gpt-5.5 or claude-sonnet-4-5" />

    <label for="apiKey">API key, only needed for API key modes</label>
    <input id="apiKey" type="password" placeholder="Paste key here, then Save Provider. The field clears after saving." />

    <button id="saveSettingsBtn">Save Provider</button>
    <div id="settingsStatus" class="muted">Provider not saved yet.</div>

    <h3>Task</h3>
    <textarea id="task" placeholder="Example: summarize this page, fill this contact form and submit it..."></textarea>

    <button id="askBtn">Ask Agent</button>
    <button id="refreshBtn">Read Page Again</button>

    <div id="response" class="box">Ready.</div>
    <div id="actions" class="box" style="display:none;"></div>

    <button id="runBatchBtn" style="display:none;">Grant Permission and Run Batch</button>
    <button id="clearBtn">Clear</button>

    <script src="sidepanel.js"></script>
  </body>
</html>
```

---

## `extension/sidepanel.js`

```js
const providerSelect = document.getElementById("provider");
const modelInput = document.getElementById("model");
const apiKeyInput = document.getElementById("apiKey");
const saveSettingsBtn = document.getElementById("saveSettingsBtn");
const settingsStatus = document.getElementById("settingsStatus");

const taskInput = document.getElementById("task");
const askBtn = document.getElementById("askBtn");
const refreshBtn = document.getElementById("refreshBtn");
const runBatchBtn = document.getElementById("runBatchBtn");
const clearBtn = document.getElementById("clearBtn");
const responseBox = document.getElementById("response");
const actionsBox = document.getElementById("actions");

let pendingActions = [];
let executedActions = [];
let latestPageData = null;
let taskPermissionGranted = false;

function setBusy(isBusy) {
  askBtn.disabled = isBusy;
  refreshBtn.disabled = isBusy;
  runBatchBtn.disabled = isBusy;
  saveSettingsBtn.disabled = isBusy;
}

function renderActions() {
  if (!pendingActions.length) {
    actionsBox.style.display = "none";
    actionsBox.textContent = "";
    runBatchBtn.style.display = "none";
    return;
  }

  actionsBox.style.display = "block";
  actionsBox.innerHTML = "<strong>Pending action batch:</strong>";

  pendingActions.forEach((action, index) => {
    const div = document.createElement("div");
    div.className = "action-card";
    div.textContent = `${index + 1}. ${JSON.stringify(action, null, 2)}`;
    actionsBox.appendChild(div);
  });

  runBatchBtn.style.display = "inline-block";
  runBatchBtn.textContent = `Grant Permission and Run Batch (${pendingActions.length})`;
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  return tabs[0];
}

async function sendToContentScript(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    return {
      error: "Could not talk to the current page. Refresh the page, then try again. Some Chrome pages cannot be accessed by extensions."
    };
  }
}

async function readCurrentPage() {
  const tab = await getActiveTab();

  if (!tab || !tab.id) {
    return { error: "No active tab found." };
  }

  const pageData = await sendToContentScript(tab.id, {
    type: "GET_PAGE_CONTEXT"
  });

  if (pageData.error) {
    return pageData;
  }

  latestPageData = {
    tab,
    pageData
  };

  return latestPageData;
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data.error || `Request failed: ${res.status}`);
  }

  return data;
}

saveSettingsBtn.addEventListener("click", async () => {
  setBusy(true);
  settingsStatus.textContent = "Saving provider...";

  try {
    const provider = providerSelect.value;
    const model = modelInput.value.trim();
    const apiKey = apiKeyInput.value.trim();

    const data = await postJson("http://localhost:3000/settings", {
      provider,
      model,
      apiKey
    });

    apiKeyInput.value = "";
    settingsStatus.textContent = `Saved provider: ${data.provider}. ${data.message || ""}`;
  } catch (error) {
    settingsStatus.textContent = error.message;
  }

  setBusy(false);
});

refreshBtn.addEventListener("click", async () => {
  setBusy(true);
  responseBox.textContent = "Reading page...";

  const result = await readCurrentPage();

  if (result.error) {
    responseBox.textContent = result.error;
  } else {
    const count = result.pageData.elements?.length || 0;
    responseBox.textContent = `Page read successfully. Found ${count} interactive elements.`;
  }

  setBusy(false);
});

askBtn.addEventListener("click", async () => {
  const task = taskInput.value.trim();

  if (!task) {
    responseBox.textContent = "Write a task first.";
    return;
  }

  setBusy(true);
  responseBox.textContent = "Reading page...";
  actionsBox.style.display = "none";
  pendingActions = [];
  executedActions = [];
  taskPermissionGranted = false;
  renderActions();

  const result = await readCurrentPage();

  if (result.error) {
    responseBox.textContent = result.error;
    setBusy(false);
    return;
  }

  const { tab, pageData } = result;
  responseBox.textContent = "Thinking...";

  try {
    const data = await postJson("http://localhost:3000/agent", {
      task,
      provider: providerSelect.value,
      url: tab.url,
      title: tab.title,
      page: pageData
    });

    responseBox.textContent = data.reply || "No reply.";
    pendingActions = Array.isArray(data.actions) ? data.actions : [];

    if (Array.isArray(data.blockedActions) && data.blockedActions.length) {
      responseBox.textContent += `\n\nBlocked actions:\n${JSON.stringify(data.blockedActions, null, 2)}`;
    }

    renderActions();
  } catch (error) {
    responseBox.textContent = `Could not complete request: ${error.message}. Make sure the backend is running on http://localhost:3000.`;
  }

  setBusy(false);
});

runBatchBtn.addEventListener("click", async () => {
  if (!pendingActions.length) {
    renderActions();
    return;
  }

  taskPermissionGranted = true;
  setBusy(true);
  responseBox.textContent += "\n\nPermission granted once for this task batch. Running actions...";

  const tab = await getActiveTab();

  while (pendingActions.length > 0 && taskPermissionGranted) {
    const action = pendingActions.shift();

    const result = await sendToContentScript(tab.id, {
      type: "RUN_ACTION",
      action
    });

    executedActions.push({ action, result });
    responseBox.textContent += `\n\nAction result:\n${JSON.stringify({ action, result }, null, 2)}`;

    if (result && result.error) {
      responseBox.textContent += "\nStopped because an action failed.";
      break;
    }
  }

  renderActions();
  setBusy(false);
});

clearBtn.addEventListener("click", () => {
  pendingActions = [];
  executedActions = [];
  latestPageData = null;
  taskPermissionGranted = false;
  responseBox.textContent = "Ready.";
  actionsBox.textContent = "";
  actionsBox.style.display = "none";
  taskInput.value = "";
  renderActions();
});
```

---

## `extension/content.js`

```js
const MAX_TEXT_CHARS = 12000;
const MAX_ELEMENTS = 160;

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
        if (!parent) return NodeFilter.FILTER_REJECT;

        const style = window.getComputedStyle(parent);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.opacity === "0"
        ) {
          return NodeFilter.FILTER_REJECT;
        }

        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  const chunks = [];

  while (walker.nextNode()) {
    chunks.push(walker.currentNode.textContent.trim());
    if (chunks.join("\n").length > MAX_TEXT_CHARS) break;
  }

  return chunks.join("\n").slice(0, MAX_TEXT_CHARS);
}

function buildSelector(el) {
  if (el.id) {
    return `#${CSS.escape(el.id)}`;
  }

  const parts = [];
  let current = el;

  while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 5) {
    let part = current.tagName.toLowerCase();

    if (current.getAttribute("name")) {
      part += `[name="${CSS.escape(current.getAttribute("name"))}"]`;
      parts.unshift(part);
      break;
    }

    if (current.className && typeof current.className === "string") {
      const className = current.className.trim().split(/\s+/)[0];
      if (className) {
        part += `.${CSS.escape(className)}`;
      }
    }

    const parent = current.parentElement;

    if (parent) {
      const siblings = [...parent.children].filter(
        child => child.tagName === current.tagName
      );

      if (siblings.length > 1) {
        part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
    }

    parts.unshift(part);
    current = current.parentElement;
  }

  return parts.join(" > ");
}

function getElementLabel(el) {
  const aria = el.getAttribute("aria-label") || "";
  const placeholder = el.getAttribute("placeholder") || "";
  const title = el.getAttribute("title") || "";
  const value = el.value || "";
  const text = el.innerText || el.textContent || "";
  return [aria, placeholder, title, value, text].filter(Boolean).join(" ").trim();
}

function getInteractiveElements() {
  const elements = [...document.querySelectorAll(
    "a, button, input, textarea, select, option, form, [role='button'], [role='link'], [onclick], [contenteditable='true']"
  )];

  return elements.slice(0, MAX_ELEMENTS).map((el, index) => {
    const rect = el.getBoundingClientRect();
    const tag = el.tagName.toLowerCase();

    return {
      index,
      tag,
      text: getElementLabel(el).slice(0, 500),
      type: el.getAttribute("type") || "",
      name: el.getAttribute("name") || "",
      id: el.id || "",
      role: el.getAttribute("role") || "",
      autocomplete: el.getAttribute("autocomplete") || "",
      href: el.getAttribute("href") || "",
      selector: buildSelector(el),
      visible: rect.width > 0 && rect.height > 0
    };
  });
}

function normalize(value) {
  return String(value || "").toLowerCase();
}

function elementTextBundle(el) {
  return normalize([
    el.innerText,
    el.textContent,
    el.value,
    el.id,
    el.name,
    el.getAttribute("aria-label"),
    el.getAttribute("placeholder"),
    el.getAttribute("title"),
    el.getAttribute("type"),
    el.getAttribute("autocomplete")
  ].filter(Boolean).join(" "));
}

function isPasswordOrSecretField(el) {
  const bundle = elementTextBundle(el);
  const type = normalize(el.getAttribute("type"));
  const autocomplete = normalize(el.getAttribute("autocomplete"));

  return (
    type === "password" ||
    bundle.includes("password") ||
    bundle.includes("passcode") ||
    bundle.includes("one-time-code") ||
    autocomplete.includes("cc-") ||
    bundle.includes("cvv") ||
    bundle.includes("cvc") ||
    bundle.includes("credit card") ||
    bundle.includes("card number")
  );
}

function isHighRiskElement(el) {
  const bundle = elementTextBundle(el);

  return DESTRUCTIVE_WORDS.some(word => bundle.includes(word)) ||
    PAYMENT_WORDS.some(word => bundle.includes(word));
}

function setNativeValue(el, value) {
  const prototype = Object.getPrototypeOf(el);
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");

  if (descriptor && descriptor.set) {
    descriptor.set.call(el, value);
  } else {
    el.value = value;
  }
}

async function runAction(action) {
  const { type, selector, text } = action || {};

  if (!type) {
    return { ok: false, error: "Missing action type." };
  }

  if (type === "extract") {
    return {
      ok: true,
      action: "extract",
      text: getVisibleText()
    };
  }

  if (!selector) {
    return { ok: false, error: "Missing selector." };
  }

  const el = document.querySelector(selector);

  if (!el) {
    return { ok: false, error: `Element not found: ${selector}` };
  }

  if (isHighRiskElement(el)) {
    return {
      ok: false,
      error: "Blocked high-risk element such as payment, purchase, transfer, delete, or account removal."
    };
  }

  if (type === "click") {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.click();

    return { ok: true, action: "click", selector };
  }

  if (type === "type") {
    if (isPasswordOrSecretField(el)) {
      return {
        ok: false,
        error: "Blocked typing into password, one-time-code, or payment-card fields."
      };
    }

    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.focus();

    if (el.isContentEditable) {
      el.textContent = text || "";
    } else {
      setNativeValue(el, text || "");
    }

    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));

    return {
      ok: true,
      action: "type",
      selector,
      text
    };
  }

  if (type === "submit") {
    el.scrollIntoView({ behavior: "smooth", block: "center" });

    const form = el.tagName.toLowerCase() === "form" ? el : el.closest("form");

    if (form) {
      if (typeof form.requestSubmit === "function") {
        form.requestSubmit(el.tagName.toLowerCase() === "button" ? el : undefined);
      } else {
        form.submit();
      }

      return { ok: true, action: "submit", selector };
    }

    el.click();
    return { ok: true, action: "submit-click", selector };
  }

  return {
    ok: false,
    error: `Unknown action type: ${type}`
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_PAGE_CONTEXT") {
    sendResponse({
      url: location.href,
      title: document.title,
      text: getVisibleText(),
      elements: getInteractiveElements()
    });

    return true;
  }

  if (message.type === "RUN_ACTION") {
    runAction(message.action).then(sendResponse);
    return true;
  }
});
```

---

# 9. Full backend code

## `server/package.json`

```json
{
  "name": "chrome-ai-agent-server",
  "version": "0.2.0",
  "type": "module",
  "scripts": {
    "dev": "node index.js",
    "check": "node --check index.js"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.66.0",
    "cors": "^2.8.5",
    "dotenv": "^17.2.0",
    "express": "^5.1.0",
    "openai": "^6.0.0"
  }
}
```

If the SDKs have newer versions, Codex can update them with:

```bash
npm install openai@latest @anthropic-ai/sdk@latest
```

---

## `server/.env.example`

```env
PORT=3000

# Default provider: openai_api_key, claude_api_key, or openai_signin_codex
RUNTIME_PROVIDER=openai_api_key

# OpenAI API key mode
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.5

# Claude API key mode
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-sonnet-4-5

# OpenAI sign-in through local Codex CLI mode
CODEX_CLI_COMMAND=codex
CODEX_MODEL=gpt-5.5
```

After creating `.env.example`, create a real `.env` file locally:

```env
PORT=3000
RUNTIME_PROVIDER=openai_api_key
OPENAI_API_KEY=sk-your-real-key
OPENAI_MODEL=gpt-5.5
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-sonnet-4-5
CODEX_CLI_COMMAND=codex
CODEX_MODEL=gpt-5.5
```

Never commit `.env`.

---

## `server/index.js`

```js
import "dotenv/config";
import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

const execFileAsync = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 3000;
const SECRETS_PATH = path.join(process.cwd(), ".runtime-secrets.json");

const PROVIDERS = new Set([
  "openai_api_key",
  "claude_api_key",
  "openai_signin_codex"
]);

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "2mb" }));

function readRuntimeSecrets() {
  try {
    if (!fs.existsSync(SECRETS_PATH)) return {};
    return JSON.parse(fs.readFileSync(SECRETS_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeRuntimeSecrets(next) {
  fs.writeFileSync(SECRETS_PATH, JSON.stringify(next, null, 2));
}

function safeText(value, max = 12000) {
  if (typeof value !== "string") return "";
  return value.slice(0, max);
}

function extractJson(text) {
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");

    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      const maybeJson = text.slice(firstBrace, lastBrace + 1);
      try {
        return JSON.parse(maybeJson);
      } catch {
        return null;
      }
    }
  }

  return null;
}

function normalize(value) {
  return String(value || "").toLowerCase();
}

function taskExplicitlyAllowsSubmit(task) {
  const t = normalize(task);

  return [
    "submit",
    "send the form",
    "send this form",
    "post this",
    "publish this",
    "confirm this form",
    "search for",
    "run the search",
    "press enter",
    "complete and send"
  ].some(phrase => t.includes(phrase));
}

function taskIsHighRisk(task) {
  const t = normalize(task);

  return [
    "submit payment",
    "pay ",
    "pay now",
    "purchase",
    "buy now",
    "place order",
    "checkout",
    "transfer money",
    "send money",
    "crypto",
    "delete my account",
    "close my account",
    "remove my account",
    "deactivate my account"
  ].some(phrase => t.includes(phrase));
}

function elementIsSensitive(el) {
  const bundle = normalize([
    el.text,
    el.type,
    el.name,
    el.id,
    el.role,
    el.autocomplete,
    el.href
  ].join(" "));

  return (
    bundle.includes("password") ||
    bundle.includes("one-time-code") ||
    bundle.includes("otp") ||
    bundle.includes("cvv") ||
    bundle.includes("cvc") ||
    bundle.includes("credit card") ||
    bundle.includes("card number") ||
    bundle.includes("cc-number")
  );
}

function elementIsHighRisk(el) {
  const bundle = normalize([
    el.text,
    el.type,
    el.name,
    el.id,
    el.role,
    el.href
  ].join(" "));

  return [
    "submit payment",
    "pay",
    "purchase",
    "buy now",
    "place order",
    "checkout",
    "transfer",
    "send money",
    "delete",
    "remove account",
    "close account",
    "deactivate"
  ].some(word => bundle.includes(word));
}

function buildPrompt({ task, url, title, pageText, pageElements, allowSubmit }) {
  const schema = `
Return ONLY valid JSON with this exact shape:
{
  "reply": "User-facing explanation",
  "actions": [
    {
      "type": "click" | "type" | "submit" | "extract",
      "selector": "CSS selector for click/type/submit actions, empty for extract",
      "text": "text to type, only for type actions"
    }
  ]
}
`;

  const instructions = `
You are a browser AI agent running inside a Chrome extension.

Capabilities:
- summarize the current page
- answer questions about visible page content
- suggest browser actions using provided selectors
- click, type, submit, or extract visible page text

Rules:
- ${schema}
- Use only selectors from the provided interactive elements.
- For summarization or Q&A, return no actions.
- Return at most 5 actions.
- Do not create a submit action unless allowSubmit is true.
- allowSubmit is ${allowSubmit ? "true" : "false"} for this task.
- If the user asks to fill and submit an ordinary form, and allowSubmit is true, you may include a submit action.
- Never propose actions for payment submission, purchases, financial transfer, crypto transfer, account deletion, or destructive deletion.
- Never type passwords, one-time codes, card numbers, CVV/CVC, or secrets.
- If the task is risky, explain why and return an empty actions array.
`;

  const input = `
User task:
${safeText(task, 2000)}

Current page:
URL: ${safeText(url || "", 1000)}
Title: ${safeText(title || "", 500)}

Visible text:
${pageText}

Interactive elements:
${JSON.stringify(pageElements, null, 2)}
`;

  return { instructions, input };
}

function validateActions(actions, pageElements = [], { allowSubmit }) {
  const blockedActions = [];

  if (!Array.isArray(actions)) {
    return { validActions: [], blockedActions };
  }

  const allowedTypes = new Set(["click", "type", "submit", "extract"]);
  const selectorToElement = new Map(
    pageElements
      .filter(el => el && el.selector)
      .map(el => [el.selector, el])
  );

  const validActions = [];

  for (const rawAction of actions.slice(0, 5)) {
    const action = {
      type: typeof rawAction?.type === "string" ? rawAction.type : "",
      selector: typeof rawAction?.selector === "string" ? rawAction.selector : "",
      text: typeof rawAction?.text === "string" ? rawAction.text.slice(0, 1000) : ""
    };

    if (!allowedTypes.has(action.type)) {
      blockedActions.push({ action, reason: "Unknown action type." });
      continue;
    }

    if (action.type === "extract") {
      validActions.push(action);
      continue;
    }

    const el = selectorToElement.get(action.selector);

    if (!el) {
      blockedActions.push({ action, reason: "Selector was not found in the observed interactive elements." });
      continue;
    }

    if (action.type === "submit" && !allowSubmit) {
      blockedActions.push({ action, reason: "Submit was blocked because the user did not explicitly ask to submit." });
      continue;
    }

    if (action.type === "type" && elementIsSensitive(el)) {
      blockedActions.push({ action, reason: "Typing into password, OTP, card, or other secret fields is blocked." });
      continue;
    }

    if (elementIsHighRisk(el)) {
      blockedActions.push({ action, reason: "High-risk payment, purchase, transfer, delete, or account action is blocked." });
      continue;
    }

    validActions.push(action);
  }

  return { validActions, blockedActions };
}

function getEffectiveSettings(requestProvider) {
  const localSecrets = readRuntimeSecrets();
  const provider = requestProvider || localSecrets.provider || process.env.RUNTIME_PROVIDER || "openai_api_key";

  return {
    provider: PROVIDERS.has(provider) ? provider : "openai_api_key",
    openaiApiKey: localSecrets.openaiApiKey || process.env.OPENAI_API_KEY || "",
    anthropicApiKey: localSecrets.anthropicApiKey || process.env.ANTHROPIC_API_KEY || "",
    openaiModel: localSecrets.openaiModel || process.env.OPENAI_MODEL || "gpt-5.5",
    anthropicModel: localSecrets.anthropicModel || process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5",
    codexCommand: process.env.CODEX_CLI_COMMAND || "codex",
    codexModel: localSecrets.codexModel || process.env.CODEX_MODEL || "gpt-5.5"
  };
}

async function callOpenAI({ instructions, input, settings }) {
  if (!settings.openaiApiKey) {
    throw new Error("Missing OpenAI API key. Save it in Provider settings or set OPENAI_API_KEY in server/.env.");
  }

  const client = new OpenAI({ apiKey: settings.openaiApiKey });

  const response = await client.responses.create({
    model: settings.openaiModel,
    instructions,
    input
  });

  return response.output_text || "";
}

async function callClaude({ instructions, input, settings }) {
  if (!settings.anthropicApiKey) {
    throw new Error("Missing Claude API key. Save it in Provider settings or set ANTHROPIC_API_KEY in server/.env.");
  }

  const anthropic = new Anthropic({ apiKey: settings.anthropicApiKey });

  const response = await anthropic.messages.create({
    model: settings.anthropicModel,
    max_tokens: 1200,
    system: instructions,
    messages: [
      {
        role: "user",
        content: input
      }
    ]
  });

  const textBlock = response.content.find(block => block.type === "text");
  return textBlock?.text || "";
}

async function callOpenAISigninCodex({ instructions, input, settings }) {
  const prompt = `${instructions}\n\n${input}\n\nReturn only the JSON object. No markdown.`.slice(0, 30000);

  try {
    const { stdout } = await execFileAsync(
      settings.codexCommand,
      [
        "exec",
        "--ask-for-approval",
        "never",
        "--sandbox",
        "read-only",
        "--model",
        settings.codexModel,
        prompt
      ],
      {
        timeout: 120000,
        maxBuffer: 1024 * 1024 * 4
      }
    );

    return stdout || "";
  } catch (error) {
    throw new Error(
      `OpenAI sign-in mode failed. Make sure Codex CLI is installed and signed in with ChatGPT. Details: ${error.message}`
    );
  }
}

async function callSelectedProvider({ provider, instructions, input, settings }) {
  if (provider === "openai_api_key") {
    return callOpenAI({ instructions, input, settings });
  }

  if (provider === "claude_api_key") {
    return callClaude({ instructions, input, settings });
  }

  if (provider === "openai_signin_codex") {
    return callOpenAISigninCodex({ instructions, input, settings });
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/settings", (req, res) => {
  const settings = getEffectiveSettings();
  res.json({
    provider: settings.provider,
    openaiModel: settings.openaiModel,
    anthropicModel: settings.anthropicModel,
    codexModel: settings.codexModel,
    hasOpenAIKey: Boolean(settings.openaiApiKey),
    hasClaudeKey: Boolean(settings.anthropicApiKey)
  });
});

app.post("/settings", (req, res) => {
  const { provider, model, apiKey } = req.body || {};

  if (provider && !PROVIDERS.has(provider)) {
    return res.status(400).json({ error: "Invalid provider." });
  }

  const current = readRuntimeSecrets();
  const next = { ...current };

  if (provider) {
    next.provider = provider;
  }

  if (provider === "openai_api_key") {
    if (apiKey) next.openaiApiKey = apiKey;
    if (model) next.openaiModel = model;
  }

  if (provider === "claude_api_key") {
    if (apiKey) next.anthropicApiKey = apiKey;
    if (model) next.anthropicModel = model;
  }

  if (provider === "openai_signin_codex") {
    if (model) next.codexModel = model;
  }

  writeRuntimeSecrets(next);

  res.json({
    ok: true,
    provider: next.provider,
    message: provider === "openai_signin_codex"
      ? "Make sure `codex login` has been completed locally."
      : "API key mode saved locally on the backend."
  });
});

app.post("/agent", async (req, res) => {
  try {
    const { task, provider: requestedProvider, url, title, page } = req.body || {};

    if (!task || !page) {
      return res.status(400).json({ error: "Missing task or page context." });
    }

    const settings = getEffectiveSettings(requestedProvider);
    const allowSubmit = taskExplicitlyAllowsSubmit(task);

    if (taskIsHighRisk(task)) {
      return res.json({
        reply: "This request appears to involve payment, purchase, financial transfer, crypto, account deletion, or another irreversible action. I can explain what to do, but I will not perform that action automatically.",
        actions: [],
        blockedActions: []
      });
    }

    const pageText = safeText(page.text || "", 12000);
    const pageElements = Array.isArray(page.elements) ? page.elements.slice(0, 160) : [];
    const { instructions, input } = buildPrompt({
      task,
      url,
      title,
      pageText,
      pageElements,
      allowSubmit
    });

    const raw = await callSelectedProvider({
      provider: settings.provider,
      instructions,
      input,
      settings
    });

    const parsed = extractJson(raw);

    if (!parsed) {
      return res.json({
        reply: raw || "The model returned an empty response.",
        actions: [],
        blockedActions: []
      });
    }

    const { validActions, blockedActions } = validateActions(parsed.actions, pageElements, { allowSubmit });

    return res.json({
      reply: typeof parsed.reply === "string" ? parsed.reply : "",
      actions: validActions,
      blockedActions,
      provider: settings.provider,
      allowSubmit
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: error.message || "Agent server failed."
    });
  }
});

app.listen(PORT, () => {
  console.log(`Agent server running on http://localhost:${PORT}`);
});
```

---

# 10. Root files

## `.gitignore`

```gitignore
node_modules/
.env
server/.env
server/.runtime-secrets.json
.runtime-secrets.json
.DS_Store
dist/
build/
*.log
```

---

## `AGENTS.md`

```md
# AGENTS.md

## Project rules

This project is a Chrome Manifest V3 browser AI agent.

Follow these rules:

1. Do not hardcode API keys in extension files.
2. Keep secrets only in `server/.env` or `server/.runtime-secrets.json`.
3. Support runtime provider modes:
   - `openai_api_key`
   - `claude_api_key`
   - `openai_signin_codex`
4. Do not add a domain allowlist. The extension should use `<all_urls>`.
5. Ask permission once per task/action batch, not before every action.
6. Allow submit actions only when the user explicitly asks to submit/send/post/search/confirm.
7. Do not type into password, OTP, credit card, CVV/CVC, or secret fields.
8. Block high-risk irreversible actions such as payment, purchase, financial transfer, crypto transfer, account deletion, or destructive delete/remove actions.
9. Keep extension code plain JavaScript unless the user asks to add a framework.
10. Prefer minimal, readable code.
11. Test syntax before finishing:
    - `node --check server/index.js`
12. If changing Chrome permissions, explain why.
13. Preserve the MVP architecture: extension side panel + content script + local backend.
```

---

## `README.md`

```md
# Chrome AI Agent

A local MVP Chrome extension that opens in the Chrome side panel, reads the current page, sends context to a local AI backend, and runs approved task batches.

## Features

- Chrome side panel UI
- Reads visible page text
- Lists visible interactive elements
- Sends page context to a local Node backend
- Supports OpenAI API key mode
- Supports Claude API key mode
- Supports experimental OpenAI sign-in mode through local Codex CLI
- Proposes click/type/submit/extract actions
- Asks permission once per task/action batch
- Allows ordinary form submit when the user explicitly asks for submit
- Blocks password, OTP, card, payment, purchase, transfer, crypto, account deletion, and destructive actions
- No domain allowlist; uses `<all_urls>` for all normal websites

## Requirements

- Chrome or Chromium browser
- Node.js LTS or newer
- npm
- One of:
  - OpenAI API key
  - Claude API key
  - Codex CLI installed and signed in with ChatGPT

## Setup

### 1. Install backend dependencies

```bash
cd server
npm install
```

### 2. Create environment file

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Edit `.env` depending on your provider.

For OpenAI API key mode:

```env
RUNTIME_PROVIDER=openai_api_key
OPENAI_API_KEY=your_openai_key_here
OPENAI_MODEL=gpt-5.5
```

For Claude API key mode:

```env
RUNTIME_PROVIDER=claude_api_key
ANTHROPIC_API_KEY=your_claude_key_here
ANTHROPIC_MODEL=claude-sonnet-4-5
```

For OpenAI sign-in through Codex CLI mode:

```bash
codex login
```

Then use:

```env
RUNTIME_PROVIDER=openai_signin_codex
CODEX_CLI_COMMAND=codex
CODEX_MODEL=gpt-5.5
```

### 3. Start backend

```bash
npm run dev
```

Check health:

```bash
curl http://localhost:3000/health
```

Expected:

```json
{"ok":true}
```

### 4. Load Chrome extension

1. Open Chrome.
2. Go to `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the `extension` folder.
6. Open any normal website.
7. Click the extension icon.
8. The side panel should open.

## Test prompts

Try:

```text
Summarize this page in 5 bullet points.
```

```text
Find the main search box on this page.
```

```text
Click the search box and type wireless headphones.
```

```text
Fill the contact form with “Hello, I am interested in your service” and submit it.
```

## Permission behavior

The extension shows the proposed action batch. The user clicks **Grant Permission and Run Batch** once. After that, the extension runs the validated batch without asking again for every individual click/type/submit action.

The permission resets when the user starts a new task.

## Submit behavior

The agent may submit ordinary forms when the user explicitly asks it to submit/send/post/search/confirm.

The agent should not submit payments, purchases, transfers, crypto actions, account deletion, or destructive actions.

## Provider behavior

### OpenAI API key

Uses `OPENAI_API_KEY` from `.env` or a key saved from the side panel to the local backend.

### Claude API key

Uses `ANTHROPIC_API_KEY` from `.env` or a key saved from the side panel to the local backend.

### OpenAI sign-in through Codex CLI

Uses the local `codex` CLI. The user must run `codex login` first. This mode is experimental and local-only.

## Known limitations

- Chrome internal pages such as `chrome://extensions` are not accessible to content scripts.
- Some websites block automation or use complex shadow DOM/iframes.
- Codex CLI sign-in mode may be slower than direct API key modes.
- This is a local MVP, not a production SaaS.
```

---

# 11. Run commands

From the project root:

```bash
cd server
npm install
cp .env.example .env
# edit .env
npm run dev
```

Then load the `extension/` folder in Chrome.

---

# 12. Testing checklist

## Backend checks

```bash
cd server
npm install
npm run check
npm run dev
```

Then open:

```text
http://localhost:3000/health
```

Expected:

```json
{"ok":true}
```

## Extension checks

1. Go to `chrome://extensions`.
2. Load `extension/` as unpacked.
3. Open a normal website, not a Chrome internal page.
4. Click the extension icon.
5. Side panel opens.

## Provider checks

### OpenAI API key

1. Select OpenAI API key.
2. Save model/key in the side panel or use `.env`.
3. Ask: `Summarize this page.`
4. Expect a response.

### Claude API key

1. Select Claude API key.
2. Save model/key in the side panel or use `.env`.
3. Ask: `Summarize this page.`
4. Expect a response.

### OpenAI sign-in through Codex CLI

1. Install Codex CLI.
2. Run `codex login`.
3. Select OpenAI sign-in through Codex CLI.
4. Ask: `Summarize this page.`
5. Expect a response, but slower than direct API mode.

## Permission batch checks

1. Ask: `Click the search box and type wireless headphones.`
2. Agent should propose actions.
3. Side panel should show one button: `Grant Permission and Run Batch`.
4. Click it once.
5. It should execute the batch without asking again.

## Submit checks

Allowed:

```text
Fill the search box with wireless headphones and submit the search.
```

Expected: submit action can be proposed and run after one permission click.

Blocked:

```text
Submit the payment.
```

Expected: no executable action.

Blocked:

```text
Delete my account.
```

Expected: no executable action.

---

# 13. Troubleshooting

## Side panel says it cannot talk to the current page

Try:

1. Refresh the tab.
2. Use a normal website, not `chrome://`, `edge://`, or the Chrome Web Store.
3. Reload the extension from `chrome://extensions`.

## Backend cannot be reached

Make sure the server is running:

```bash
cd server
npm run dev
```

Then check:

```bash
curl http://localhost:3000/health
```

## Missing API key

Use either `.env` or the side panel Provider section.

OpenAI:

```env
RUNTIME_PROVIDER=openai_api_key
OPENAI_API_KEY=your_key
```

Claude:

```env
RUNTIME_PROVIDER=claude_api_key
ANTHROPIC_API_KEY=your_key
```

## OpenAI sign-in mode fails

Run:

```bash
codex login
codex doctor
```

Then restart the backend.

## Model returned invalid JSON

The server tries to recover JSON from the model output. If it happens often, ask Codex to implement structured outputs for OpenAI mode and stricter JSON repair for Claude/Codex modes.

---

# 14. Future upgrades

## Phase 1: Reliability

- Add structured outputs with JSON schema for OpenAI mode.
- Add better JSON repair for Claude/Codex modes.
- Add unit tests for action validation.
- Add better selector generation.
- Add retry logic.
- Add streaming replies.

## Phase 2: Agent control

- Add a visible action history.
- Add risk labels: safe, caution, blocked.
- Add a stop button that cancels the current batch.
- Add optional manual confirmation for especially sensitive but non-blocked actions.

## Phase 3: Better page understanding

- Add screenshot capture after user permission.
- Add accessibility tree extraction.
- Add iframe support.
- Add shadow DOM support.
- Add page chunking for long pages.

## Phase 4: Real agent loop

- Add observe → plan → one-time permission → act batch → observe again.
- Let the user stop at any time.
- Keep a short memory of the current task.
- Add action rollback when possible.

## Phase 5: Deployment

- Deploy backend to a secure server only if credentials and authentication are handled properly.
- Restrict CORS to the extension ID for production.
- Add authentication.
- Add usage limits.
- Add privacy policy.
- Prepare Chrome Web Store listing.

Do not add a domain allowlist unless the user changes the requirement later.

---

# 15. Important implementation notes for Codex

Codex should preserve these decisions unless asked otherwise:

1. Keep extension UI simple and framework-free.
2. Keep backend separate from extension.
3. Support all three providers:
   - OpenAI API key
   - Claude API key
   - OpenAI sign-in through local Codex CLI
4. Keep action output JSON-based.
5. Do not add background autonomous browsing.
6. Do not ask approval for every individual action.
7. Ask permission once per task/action batch.
8. Allow ordinary submit actions if and only if the user explicitly asked to submit/send/post/search/confirm.
9. Do not add a domain allowlist.
10. Use `localhost:3000` for MVP.
11. Avoid overengineering until the MVP works.

---

# 16. Optional: stronger structured output schema

Once the plain JSON MVP works, ask Codex to replace plain JSON prompting with structured outputs for OpenAI API key mode.

Desired schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "reply": {
      "type": "string"
    },
    "actions": {
      "type": "array",
      "maxItems": 5,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "type": {
            "type": "string",
            "enum": ["click", "type", "submit", "extract"]
          },
          "selector": {
            "type": "string"
          },
          "text": {
            "type": "string"
          }
        },
        "required": ["type", "selector", "text"]
      }
    }
  },
  "required": ["reply", "actions"]
}
```

Codex task for this upgrade:

```text
Update the backend to use OpenAI structured outputs with the agent response JSON schema from BUILD_SPEC.md for OpenAI API key mode. Keep action validation after model output. Do not remove provider support, one-time task permission, submit-if-explicit behavior, or high-risk blocking.
```

---

# 17. Official references

Use these docs if Codex needs to verify current APIs:

- Codex quickstart: https://developers.openai.com/codex/quickstart
- Codex CLI: https://developers.openai.com/codex/cli
- Codex authentication: https://developers.openai.com/codex/auth
- Codex CLI reference: https://developers.openai.com/codex/cli/reference
- OpenAI API keys: https://help.openai.com/en/articles/4936850-where-do-i-find-my-openai-api-key
- OpenAI API developer quickstart: https://developers.openai.com/api/docs/quickstart
- OpenAI JavaScript SDK: https://developers.openai.com/api/reference/typescript/
- OpenAI Responses API: https://developers.openai.com/api/reference/resources/responses/methods/create/
- OpenAI structured outputs: https://developers.openai.com/api/docs/guides/structured-outputs
- Anthropic Claude get started: https://docs.anthropic.com/en/docs/get-started
- Anthropic client SDKs: https://docs.anthropic.com/en/api/client-sdks
- Chrome extension manifest: https://developer.chrome.com/docs/extensions/reference/manifest
- Chrome side panel API: https://developer.chrome.com/docs/extensions/reference/api/sidePanel
- Chrome content scripts: https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts
- Chrome scripting API: https://developer.chrome.com/docs/extensions/reference/api/scripting
- Chrome tabs and activeTab: https://developer.chrome.com/docs/extensions/reference/api/tabs

---

# 18. Final Codex prompt

Paste this into Codex after saving this file:

```text
Build the Chrome AI Agent MVP from BUILD_SPEC.md.

Requirements:
- Create the full project tree exactly as specified.
- Implement the Chrome Manifest V3 extension with side panel UI.
- Implement content script page reading and browser actions.
- Implement Node/Express backend.
- Support runtime provider modes: OpenAI API key, Claude API key, and experimental OpenAI sign-in through local Codex CLI.
- Keep API keys out of extension files.
- Store local runtime secrets only in server/.env or server/.runtime-secrets.json.
- Include .env.example, .gitignore, README.md, and AGENTS.md.
- Ask permission once per task/action batch, not before every individual action.
- Allow ordinary form submit only when the user explicitly instructs submit/send/post/search/confirm.
- Do not add a domain allowlist; use <all_urls> so the extension works on all normal websites.
- Keep password, OTP, card, payment, purchase, transfer, crypto, account deletion, and destructive actions blocked.
- Run syntax checks.
- Tell me how to start the server and load the unpacked extension.

Do not add unnecessary frameworks. Keep the MVP simple and working first.
```

---

# 19. Definition of done

The MVP is done when:

1. Backend starts with `npm run dev`.
2. `GET /health` returns `{ "ok": true }`.
3. Extension loads unpacked in Chrome.
4. Side panel opens from extension icon.
5. User can select OpenAI API key, Claude API key, or OpenAI sign-in through Codex CLI.
6. User can ask for a page summary.
7. Backend returns an AI reply.
8. Agent can propose safe actions.
9. Actions appear in the UI before execution.
10. User grants permission once for the task batch.
11. Batch actions run without asking again for each individual action.
12. Ordinary submit can happen when explicitly instructed.
13. High-risk payment, purchase, transfer, crypto, account deletion, destructive, password, OTP, and card actions are blocked.
14. No API key exists in extension files.
15. `.env` and `.runtime-secrets.json` are gitignored.
