const providerSelect = document.getElementById("provider");
const modelInput = document.getElementById("model");
const baseUrlField = document.getElementById("baseUrlField");
const baseUrlInput = document.getElementById("baseUrl");
const apiKeyInput = document.getElementById("apiKey");
const saveSettingsBtn = document.getElementById("saveSettingsBtn");
const settingsStatus = document.getElementById("settingsStatus");
const backendStatus = document.getElementById("backendStatus");
const codexSigninPanel = document.getElementById("codexSigninPanel");
const codexLoginBtn = document.getElementById("codexLoginBtn");
const codexCheckBtn = document.getElementById("codexCheckBtn");
const codexSigninStatus = document.getElementById("codexSigninStatus");
const providerDisclosure = document.getElementById("providerDisclosure");
const settingsToggleBtn = document.getElementById("settingsToggleBtn");
const apiKeyToggleBtn = document.getElementById("apiKeyToggleBtn");
const agentStateTitle = document.getElementById("agentStateTitle");
const activityTimeline = document.getElementById("activityTimeline");
const actionHistoryList = document.getElementById("actionHistory");
const clearHistoryBtn = document.getElementById("clearHistoryBtn");
const exportHistoryMdBtn = document.getElementById("exportHistoryMdBtn");
const exportHistoryJsonBtn = document.getElementById("exportHistoryJsonBtn");
const pauseCautionPreviewInput = document.getElementById("pauseCautionPreview");
const permissionInfoBtn = document.getElementById("permissionInfoBtn");

const taskInput = document.getElementById("task");
const askBtn = document.getElementById("askBtn");
const refreshBtn = document.getElementById("refreshBtn");
const runBatchBtn = document.getElementById("runBatchBtn");
const stopBtn = document.getElementById("stopBtn");
const clearBtn = document.getElementById("clearBtn");
const attachFileBtn = document.getElementById("attachFileBtn");
const fileInput = document.getElementById("fileInput");
const includeScreenshotInput = document.getElementById("includeScreenshot");
const screenshotToggle = includeScreenshotInput?.closest(".icon-toggle");
const actionPausePanel = document.getElementById("actionPausePanel");
const actionPauseText = document.getElementById("actionPauseText");
const previewContinueBtn = document.getElementById("previewContinueBtn");
const previewStopBtn = document.getElementById("previewStopBtn");
const attachmentTray = document.getElementById("attachmentTray");
const composerState = document.getElementById("composerState");
const responseBox = document.getElementById("response");
const actionsBox = document.getElementById("actions");
const collectionTaskInput = document.getElementById("collectionTask");
const collectionFieldsInput = document.getElementById("collectionFields");
const collectionPlaybookInput = document.getElementById("collectionPlaybook");
const collectionPlaybookBtn = document.getElementById("collectionPlaybookBtn");
const collectionPlaybookFile = document.getElementById("collectionPlaybookFile");
const limitStepsInput = document.getElementById("limitSteps");
const limitRowsInput = document.getElementById("limitRows");
const limitUrlsInput = document.getElementById("limitUrls");
const limitNoProgressInput = document.getElementById("limitNoProgress");
const limitRuntimeInput = document.getElementById("limitRuntime");
const reviewFirstRecordInput = document.getElementById("reviewFirstRecord");
const collectionStartBtn = document.getElementById("collectionStartBtn");
const collectionStopBtn = document.getElementById("collectionStopBtn");
const collectionApproveBtn = document.getElementById("collectionApproveBtn");
const collectionDownloadBtn = document.getElementById("collectionDownloadBtn");
const collectionClearBtn = document.getElementById("collectionClearBtn");
const collectionStatus = document.getElementById("collectionStatus");
const collectionRowsPreview = document.getElementById("collectionRowsPreview");
const collectionLog = document.getElementById("collectionLog");
const metricSteps = document.getElementById("metricSteps");
const metricRows = document.getElementById("metricRows");
const metricUrls = document.getElementById("metricUrls");
const metricElapsed = document.getElementById("metricElapsed");
const metricCurrentUrl = document.getElementById("metricCurrentUrl");
const metricLastAction = document.getElementById("metricLastAction");
const permissionOnboarding = document.getElementById("permissionOnboarding");
const permissionOnboardingCloseBtn = document.getElementById("permissionOnboardingCloseBtn");
const permissionOnboardingAckBtn = document.getElementById("permissionOnboardingAckBtn");

const API_BASE = "http://localhost:3000";
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 512 * 1024;
const MAX_ATTACHMENT_CHARS = 12000;
const MAX_TOTAL_ATTACHMENT_CHARS = 30000;
const ACTIVITY_LIMIT = 8;
const ACTION_HISTORY_LIMIT = 60;
const ACTION_HISTORY_STORAGE_KEY = "chromeAiAgentActionHistory";
const TASK_DRAFT_STORAGE_KEY = "chromeAiAgentTaskDraft";
const PAUSE_CAUTION_PREVIEW_STORAGE_KEY = "chromeAiAgentPauseCautionPreview";
const ONBOARDING_ACK_STORAGE_KEY = "chromeAiAgentPermissionOnboardingAck";
const ACTION_RETRY_DELAYS_MS = [300, 700, 1500];

let pendingActions = [];
let executedActions = [];
let latestPageData = null;
let taskPermissionGranted = false;
let codexSigninPollTimer = null;
let attachedFiles = [];
let nextAttachmentId = 1;
let collectionPlaybookName = "";
let collectionRun = createEmptyCollectionRun();
let activeAbortController = null;
let batchRunning = false;
let actionHistory = [];
let runningActionHistoryId = "";
let lastTaskDraftSaveTimer = null;
let pauseCautionPreview = true;
let pendingPreviewPause = null;

function setBusy(isBusy) {
  document.body.classList.toggle("is-busy", isBusy);
  document.body.setAttribute("aria-busy", String(isBusy));
  askBtn.disabled = isBusy;
  refreshBtn.disabled = isBusy;
  runBatchBtn.disabled = isBusy || !executableActions(pendingActions).length;
  saveSettingsBtn.disabled = isBusy;
  codexLoginBtn.disabled = isBusy;
  codexCheckBtn.disabled = isBusy;
  attachFileBtn.disabled = isBusy;
  if (baseUrlInput) baseUrlInput.disabled = isBusy;
  if (settingsToggleBtn) settingsToggleBtn.disabled = isBusy;
  if (apiKeyToggleBtn) apiKeyToggleBtn.disabled = isBusy;
  stopBtn.disabled = !isBusy && !collectionRun.running && !batchRunning;
}

function storageLocal() {
  return chrome?.storage?.local || null;
}

function storageGet(key) {
  const storage = storageLocal();
  if (!storage) return Promise.resolve({});

  return new Promise(resolve => {
    storage.get(key, value => resolve(value || {}));
  });
}

function storageSet(value) {
  const storage = storageLocal();
  if (!storage) return Promise.resolve();

  return new Promise(resolve => {
    storage.set(value, () => resolve());
  });
}

function storageRemove(key) {
  const storage = storageLocal();
  if (!storage) return Promise.resolve();

  return new Promise(resolve => {
    storage.remove(key, () => resolve());
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function compactText(value, max = 120) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function normalizeComparableText(value) {
  return compactText(value, 300).toLowerCase();
}

function actionId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `action-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function currentPageReference() {
  const page = latestPageData?.pageData || {};
  const tab = latestPageData?.tab || {};

  return {
    url: tab.url || page.url || "",
    title: tab.title || page.title || ""
  };
}

function actionSummary(action) {
  const type = String(action?.type || "action").toLowerCase();
  const target = compactText(
    action?.description ||
    action?.label ||
    action?.ariaLabel ||
    action?.placeholder ||
    action?.name ||
    action?.elementText ||
    action?.selector,
    80
  );

  if (type === "type") {
    return `Type "${compactText(action?.text, 40)}"${target ? ` into ${target}` : ""}`;
  }

  if (type === "submit") return `Submit${target ? ` ${target}` : ""}`;
  if (type === "click") return `Click${target ? ` ${target}` : ""}`;
  if (type === "extract") return `Extract${target ? ` from ${target}` : ""}`;
  return `${type}${target ? ` ${target}` : ""}`;
}

function actionMeta(action) {
  const parts = [];
  const selector = compactText(action?.selector, 140);
  const frameId = Number.isFinite(action?.frameId) ? action.frameId : 0;

  if (selector) parts.push(`Selector: ${selector}`);
  parts.push(`Frame: ${frameId}`);

  if (Array.isArray(action?.shadowPath) && action.shadowPath.length) {
    parts.push(`Shadow path: ${action.shadowPath.join(" > ")}`);
  }

  return parts;
}

function renderActionHistory() {
  if (exportHistoryMdBtn) exportHistoryMdBtn.disabled = !actionHistory.length;
  if (exportHistoryJsonBtn) exportHistoryJsonBtn.disabled = !actionHistory.length;
  if (!actionHistoryList) return;

  actionHistoryList.textContent = "";

  if (!actionHistory.length) {
    const empty = document.createElement("li");
    empty.className = "history-empty";
    empty.textContent = "No actions yet.";
    actionHistoryList.appendChild(empty);
    return;
  }

  for (const item of actionHistory.slice().reverse()) {
    const entry = document.createElement("li");
    entry.className = `history-entry history-${item.status || "proposed"}`;

    const main = document.createElement("div");
    main.className = "history-main";

    const time = document.createElement("span");
    time.className = "history-time";
    time.textContent = item.timestamp
      ? new Date(item.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : "";

    const summary = document.createElement("span");
    summary.className = "history-summary";
    summary.textContent = item.summary || "Action";
    summary.title = item.summary || "";

    const status = document.createElement("span");
    status.className = `history-status ${item.status || "proposed"}`;
    status.textContent = item.status || "proposed";

    main.appendChild(time);
    main.appendChild(summary);
    main.appendChild(status);
    entry.appendChild(main);

    const meta = document.createElement("div");
    meta.className = "history-meta";

    for (const line of [
      item.result ? `Result: ${compactText(item.result, 160)}` : "",
      item.error ? `Error: ${compactText(item.error, 180)}` : "",
      item.rematchNote ? compactText(item.rematchNote, 180) : "",
      item.riskReasons?.length ? `Risk: ${item.riskReasons.join(" ")}` : "",
      ...(Array.isArray(item.meta) ? item.meta : [])
    ].filter(Boolean).slice(0, 5)) {
      const span = document.createElement("span");
      span.textContent = line;
      span.title = line;
      meta.appendChild(span);
    }

    if (meta.children.length) entry.appendChild(meta);
    actionHistoryList.appendChild(entry);
  }
}

async function persistActionHistory() {
  actionHistory = actionHistory.slice(-ACTION_HISTORY_LIMIT);
  await storageSet({ [ACTION_HISTORY_STORAGE_KEY]: actionHistory });
}

async function loadActionHistory() {
  const data = await storageGet(ACTION_HISTORY_STORAGE_KEY);
  const stored = data[ACTION_HISTORY_STORAGE_KEY];
  actionHistory = Array.isArray(stored) ? stored.slice(-ACTION_HISTORY_LIMIT) : [];
  renderActionHistory();
}

function addActionHistoryEntry(action, status, patch = {}) {
  const { url, title } = currentPageReference();
  const entry = {
    id: actionId(),
    status,
    timestamp: new Date().toISOString(),
    task: compactText(patch.task || taskInput.value, 400),
    url,
    title,
    summary: actionSummary(action),
    action: {
      type: action?.type || "",
      selector: action?.selector || "",
      text: action?.text || "",
      frameId: Number.isFinite(action?.frameId) ? action.frameId : 0,
      shadowPath: Array.isArray(action?.shadowPath) ? action.shadowPath : []
    },
    riskLabel: action?.riskLabel || "",
    riskReasons: Array.isArray(action?.riskReasons) ? action.riskReasons : [],
    meta: actionMeta(action),
    attempts: 0,
    result: "",
    error: "",
    rematchNote: "",
    ...patch
  };

  actionHistory.push(entry);
  renderActionHistory();
  persistActionHistory();
  return entry.id;
}

function updateActionHistoryEntry(id, patch) {
  if (!id) return;

  const index = actionHistory.findIndex(item => item.id === id);
  if (index === -1) return;

  actionHistory[index] = {
    ...actionHistory[index],
    ...patch,
    timestamp: patch.timestamp || actionHistory[index].timestamp
  };
  renderActionHistory();
  persistActionHistory();
}

function clearActionHistory() {
  actionHistory = [];
  renderActionHistory();
  storageSet({ [ACTION_HISTORY_STORAGE_KEY]: actionHistory });
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function downloadTextFile(filename, content, type = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function actionHistoryStatusSummary() {
  const summary = actionHistory.reduce((counts, item) => {
    const status = item.status || "proposed";
    counts[status] = (counts[status] || 0) + 1;
    return counts;
  }, {});

  return ["proposed", "blocked", "retrying", "executed", "failed", "stopped"]
    .filter(status => summary[status])
    .map(status => `- ${status}: ${summary[status]}`)
    .join("\n") || "- None";
}

function actionHistoryMarkdown() {
  const rows = actionHistory.map(item => {
    const result = item.error
      ? `Error: ${item.error}`
      : item.result || "";
    return `| ${markdownEscape(item.timestamp)} | ${markdownEscape(item.status || "proposed")} | ${markdownEscape(item.scope || "task")} | ${markdownEscape(item.summary)} | ${markdownEscape(item.attempts || 0)} | ${markdownEscape(result)} | ${markdownEscape(item.url)} |`;
  });
  const details = actionHistory.map((item, index) => [
    `### ${index + 1}. ${item.summary || "Action"}`,
    "",
    `- Status: ${item.status || "proposed"}`,
    `- Scope: ${item.scope || "task"}`,
    `- Task: ${item.task || "N/A"}`,
    `- Page: ${item.title || "N/A"} (${item.url || "N/A"})`,
    `- Attempts: ${item.attempts || 0}`,
    `- Risk: ${item.riskLabel || "safe"}${item.riskReasons?.length ? ` - ${item.riskReasons.join(" ")}` : ""}`,
    `- Selector: ${item.action?.selector || "N/A"}`,
    `- Frame: ${Number.isFinite(item.action?.frameId) ? item.action.frameId : 0}`,
    item.rematchNote ? `- Rematch: ${item.rematchNote}` : "",
    item.result ? `- Result: ${item.result}` : "",
    item.error ? `- Error: ${item.error}` : ""
  ].filter(Boolean).join("\n"));

  return [
    "# Chrome AI Agent Action History",
    "",
    `- Generated: ${new Date().toISOString()}`,
    `- Retained entries: ${actionHistory.length}`,
    `- Retention limit: ${ACTION_HISTORY_LIMIT}`,
    "",
    "## Status Summary",
    "",
    actionHistoryStatusSummary(),
    "",
    "## Timeline",
    "",
    "| Time | Status | Scope | Action | Attempts | Result | URL |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...(rows.length ? rows : ["| N/A | N/A | N/A | No actions retained | 0 | N/A | N/A |"]),
    "",
    "## Details",
    "",
    details.join("\n\n") || "No actions retained."
  ].join("\n");
}

function downloadActionHistoryMarkdown() {
  downloadTextFile(
    `chrome-ai-agent-action-history-${timestampSlug()}.md`,
    actionHistoryMarkdown(),
    "text/markdown;charset=utf-8"
  );
}

function downloadActionHistoryJson() {
  downloadTextFile(
    `chrome-ai-agent-action-history-${timestampSlug()}.json`,
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      entryCount: actionHistory.length,
      historyLimit: ACTION_HISTORY_LIMIT,
      entries: actionHistory
    }, null, 2),
    "application/json;charset=utf-8"
  );
}

async function loadUserPreferences() {
  const data = await storageGet(PAUSE_CAUTION_PREVIEW_STORAGE_KEY);
  pauseCautionPreview = data[PAUSE_CAUTION_PREVIEW_STORAGE_KEY] !== false;

  if (pauseCautionPreviewInput) {
    pauseCautionPreviewInput.checked = pauseCautionPreview;
  }
}

function setPauseCautionPreview(value) {
  pauseCautionPreview = Boolean(value);
  if (pauseCautionPreviewInput) pauseCautionPreviewInput.checked = pauseCautionPreview;
  storageSet({ [PAUSE_CAUTION_PREVIEW_STORAGE_KEY]: pauseCautionPreview });
}

function showPermissionOnboarding() {
  if (!permissionOnboarding) return;
  permissionOnboarding.hidden = false;
  permissionOnboardingAckBtn?.focus();
}

function hidePermissionOnboarding({ acknowledge = false } = {}) {
  if (!permissionOnboarding) return;
  permissionOnboarding.hidden = true;

  if (acknowledge) {
    storageSet({ [ONBOARDING_ACK_STORAGE_KEY]: true });
  }
}

async function loadPermissionOnboarding() {
  const data = await storageGet(ONBOARDING_ACK_STORAGE_KEY);
  if (!data[ONBOARDING_ACK_STORAGE_KEY]) {
    showPermissionOnboarding();
  }
}

function appendResponse(text) {
  responseBox.textContent += `\n\n${text}`;
  updateAgentStateFromMessage(text);

  const clean = String(text || "").trim();
  if (clean) {
    recordActivity(clean);
  }
}

function setStatusLine(element, text, tone = "") {
  element.textContent = text;
  element.classList.remove("success", "danger");

  if (tone) {
    element.classList.add(tone);
  }

  if (element === settingsStatus || element === codexSigninStatus || element === collectionStatus) {
    updateAgentStateFromMessage(text);
  }
}

function setBackendStatus(isConnected, text) {
  backendStatus.textContent = text;
  backendStatus.classList.toggle("connected", isConnected);
  backendStatus.classList.toggle("offline", !isConnected);
  backendStatus.title = isConnected ? "Local backend is reachable." : "Local backend is not reachable.";
  recordActivity(isConnected ? "Backend connected" : "Backend offline", isConnected ? "success" : "danger");
}

function setAgentState(label, tone = "") {
  if (!agentStateTitle) return;

  agentStateTitle.textContent = label;
  agentStateTitle.classList.remove("is-error", "is-success");

  if (tone === "danger") {
    agentStateTitle.classList.add("is-error");
  } else if (tone === "success") {
    agentStateTitle.classList.add("is-success");
  }
}

function activityTimestamp() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function activityToneFromMessage(message, fallback = "") {
  const text = String(message || "").toLowerCase();

  if (fallback) return fallback;
  if (text.includes("error") || text.includes("failed") || text.includes("could not") || text.includes("stopped")) return "danger";
  if (text.includes("complete") || text.includes("success") || text.includes("saved")) return "success";
  if (text.includes("reading") || text.includes("thinking") || text.includes("planning") || text.includes("running")) return "active";
  return "";
}

function recordActivity(message, tone = "") {
  if (!activityTimeline) return;

  const clean = String(message || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);

  if (!clean) return;

  const lastEntry = activityTimeline.lastElementChild?.querySelector(".activity-message")?.textContent || "";
  if (lastEntry === clean) return;

  const entry = document.createElement("li");
  entry.className = `activity-entry ${activityToneFromMessage(clean, tone)}`.trim();

  const node = document.createElement("span");
  node.className = "activity-node";
  node.setAttribute("aria-hidden", "true");

  const time = document.createElement("span");
  time.className = "activity-time";
  time.textContent = activityTimestamp();

  const copy = document.createElement("span");
  copy.className = "activity-message";
  copy.textContent = clean;

  entry.appendChild(node);
  entry.appendChild(time);
  entry.appendChild(copy);
  activityTimeline.appendChild(entry);

  while (activityTimeline.children.length > ACTIVITY_LIMIT) {
    activityTimeline.firstElementChild?.remove();
  }

  activityTimeline.scrollTop = activityTimeline.scrollHeight;
}

function updateAgentStateFromMessage(message) {
  const text = String(message || "").toLowerCase();

  if (!text) return;

  if (text.includes("waiting for permission") || text.includes("permission granted")) {
    setAgentState("Waiting for permission", "active");
  } else if (text.includes("running action") || text.includes("running actions") || text.includes("action result")) {
    setAgentState("Running browser action", "active");
  } else if (text.includes("reading page") || text.includes("page read")) {
    setAgentState("Reading page", "active");
  } else if (text.includes("thinking") || text.includes("streaming") || text.includes("planning")) {
    setAgentState("Thinking", "active");
  } else if (text.includes("error") || text.includes("failed") || text.includes("could not")) {
    setAgentState("Error", "danger");
  } else if (text.includes("complete") || text.includes("success") || text.includes("saved")) {
    setAgentState("Completed", "success");
  } else if (text.includes("ready")) {
    setAgentState("Ready");
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function totalAttachmentChars() {
  return attachedFiles.reduce((sum, file) => sum + file.content.length, 0);
}

function isLikelyText(value) {
  if (!value) return true;

  const sample = value.slice(0, 2048);
  if (sample.includes("\u0000")) return false;

  const controlChars = sample.match(/[\u0001-\u0008\u000b\u000c\u000e-\u001f]/g) || [];
  return controlChars.length / sample.length < 0.04;
}

function renderAttachments() {
  attachmentTray.textContent = "";
  attachmentTray.classList.toggle("has-files", attachedFiles.length > 0);

  for (const file of attachedFiles) {
    const chip = document.createElement("div");
    chip.className = "file-chip";

    const name = document.createElement("span");
    name.className = "file-chip-name";
    name.textContent = file.name;

    const meta = document.createElement("span");
    meta.className = "file-chip-meta";
    meta.textContent = file.truncated ? `${formatBytes(file.size)} truncated` : formatBytes(file.size);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.textContent = "x";
    removeBtn.title = `Remove ${file.name}`;
    removeBtn.setAttribute("aria-label", `Remove ${file.name}`);
    removeBtn.addEventListener("click", () => {
      attachedFiles = attachedFiles.filter(item => item.id !== file.id);
      renderAttachments();
    });

    chip.appendChild(name);
    chip.appendChild(meta);
    chip.appendChild(removeBtn);
    attachmentTray.appendChild(chip);
  }

  updateComposerState();
}

function updateComposerState() {
  const fileText = attachedFiles.length === 1
    ? "1 file attached"
    : attachedFiles.length
      ? `${attachedFiles.length} files attached`
      : "No files";
  const screenshotOn = Boolean(includeScreenshotInput?.checked);
  const screenshotText = screenshotOn ? "Screenshot on" : "Screenshot off";

  if (composerState) {
    composerState.textContent = `${fileText} · ${screenshotText}`;
  }

  if (screenshotToggle) {
    screenshotToggle.classList.toggle("is-active", screenshotOn);
    screenshotToggle.title = screenshotOn ? "Screenshot context is on" : "Screenshot context is off";
    screenshotToggle.setAttribute("aria-label", screenshotToggle.title);
  }
}

function resizeTaskInput() {
  if (!taskInput) return;

  taskInput.style.height = "auto";
  const nextHeight = Math.min(Math.max(taskInput.scrollHeight, 88), 180);
  taskInput.style.height = `${nextHeight}px`;
  taskInput.style.overflowY = taskInput.scrollHeight > 180 ? "auto" : "hidden";
}

function saveTaskDraftSoon() {
  if (lastTaskDraftSaveTimer) {
    clearTimeout(lastTaskDraftSaveTimer);
  }

  lastTaskDraftSaveTimer = setTimeout(() => {
    storageSet({ [TASK_DRAFT_STORAGE_KEY]: taskInput.value });
  }, 160);
}

async function loadTaskDraft() {
  const data = await storageGet(TASK_DRAFT_STORAGE_KEY);
  const draft = data[TASK_DRAFT_STORAGE_KEY];

  if (typeof draft === "string" && !taskInput.value) {
    taskInput.value = draft;
    resizeTaskInput();
  }
}

async function readAttachment(file) {
  const availableChars = MAX_TOTAL_ATTACHMENT_CHARS - totalAttachmentChars();

  if (availableChars <= 0) {
    return { error: "Attachment text limit reached." };
  }

  const sliced = file.slice(0, MAX_ATTACHMENT_BYTES);
  const rawText = await sliced.text();
  const normalizedText = rawText.replace(/\r\n/g, "\n");

  if (!isLikelyText(normalizedText)) {
    return { error: `${file.name} does not look like a text file.` };
  }

  const charLimit = Math.min(MAX_ATTACHMENT_CHARS, availableChars);
  const content = normalizedText.slice(0, charLimit);

  return {
    id: nextAttachmentId++,
    name: file.name,
    type: file.type || "text/plain",
    size: file.size,
    content,
    truncated: file.size > MAX_ATTACHMENT_BYTES || normalizedText.length > content.length
  };
}

async function addAttachments(fileList) {
  const files = Array.from(fileList || []);
  const skipped = [];

  for (const file of files) {
    if (attachedFiles.length >= MAX_ATTACHMENTS) {
      skipped.push(`Only ${MAX_ATTACHMENTS} files can be attached.`);
      break;
    }

    try {
      const attachment = await readAttachment(file);

      if (attachment.error) {
        skipped.push(attachment.error);
      } else {
        attachedFiles.push(attachment);
      }
    } catch (error) {
      skipped.push(`Could not read ${file.name}: ${error.message}`);
    }
  }

  renderAttachments();

  if (skipped.length) {
    appendResponse(`Attachment notice:\n${skipped.join("\n")}`);
  }
}

function agentAttachments() {
  return attachedFiles.map(file => ({
    name: file.name,
    type: file.type,
    size: file.size,
    content: file.content,
    truncated: file.truncated
  }));
}

function actionRiskLabel(action) {
  return String(action?.riskLabel || action?.risk || "safe").toLowerCase();
}

function actionRiskReasons(action) {
  if (Array.isArray(action?.riskReasons)) return action.riskReasons.filter(Boolean);
  if (action?.reason) return [action.reason];
  if (action?.riskReason) return [action.riskReason];
  return [];
}

function normalizeActionForDisplay(item) {
  const action = item?.action && typeof item.action === "object" ? item.action : item;
  const riskLabel = actionRiskLabel(item?.riskLabel ? item : action);
  const reasons = [
    ...actionRiskReasons(action),
    ...actionRiskReasons(item)
  ];

  return {
    ...action,
    riskLabel: riskLabel === "blocked" || riskLabel === "caution" ? riskLabel : "safe",
    riskReasons: Array.from(new Set(reasons.map(reason => String(reason || "").trim()).filter(Boolean)))
  };
}

function executableActions(actions) {
  return (actions || [])
    .map(normalizeActionForDisplay)
    .filter(action => action.riskLabel !== "blocked");
}

function normalizeShadowPath(value) {
  return Array.isArray(value)
    ? value.map(item => String(item || "").trim()).filter(Boolean)
    : [];
}

function targetKey(action) {
  return JSON.stringify({
    frameId: Number.isFinite(action?.frameId) ? action.frameId : 0,
    selector: String(action?.selector || ""),
    shadowPath: normalizeShadowPath(action?.shadowPath)
  });
}

function pageElements(pageData = latestPageData?.pageData) {
  return Array.isArray(pageData?.elements) ? pageData.elements : [];
}

function elementForAction(action, pageData = latestPageData?.pageData) {
  const key = targetKey(action);
  return pageElements(pageData).find(element => targetKey(element) === key) || null;
}

function enrichActionForDisplay(action, pageData = latestPageData?.pageData) {
  const element = elementForAction(action, pageData);
  if (!element) return action;

  return {
    ...action,
    tag: element.tag || action.tag,
    role: element.role || action.role,
    elementType: element.type || action.elementType,
    label: element.label || action.label,
    placeholder: element.placeholder || action.placeholder,
    name: element.name || action.name,
    ariaLabel: element.ariaLabel || action.ariaLabel,
    elementText: element.text || action.elementText
  };
}

function retryableSelectorError(error) {
  const text = String(error || "").toLowerCase();
  if (!text) return false;
  if (text.includes("blocked") || text.includes("password") || text.includes("otp") || text.includes("card") || text.includes("secret")) return false;
  if (text.includes("high-risk") || text.includes("disabled") || text.includes("read-only")) return false;

  return [
    "element not found",
    "invalid selector",
    "missing selector",
    "shadow host not found",
    "closed or inaccessible",
    "target element is not visible",
    "could not run action in frame"
  ].some(fragment => text.includes(fragment));
}

function comparableFields(element) {
  return ["label", "text", "ariaLabel", "placeholder", "name"]
    .map(key => normalizeComparableText(element?.[key]))
    .filter(Boolean);
}

function elementMatchScore(original, candidate, action) {
  if (!original || !candidate?.selector || candidate.disabled) return 0;
  if ((action.type === "type" || action.type === "extract") && candidate.sensitive) return 0;

  let score = 0;
  const sameFrame = Number(original.frameId || 0) === Number(candidate.frameId || 0);
  const originalShadow = JSON.stringify(normalizeShadowPath(original.shadowPath));
  const candidateShadow = JSON.stringify(normalizeShadowPath(candidate.shadowPath));

  if (sameFrame) score += 2;
  if (originalShadow === candidateShadow) score += 2;
  if (original.tag && original.tag === candidate.tag) score += 2;
  if (original.role && original.role === candidate.role) score += 2;
  if (original.type && original.type === candidate.type) score += 1;

  const originalFields = comparableFields(original);
  const candidateFields = comparableFields(candidate);

  for (const originalText of originalFields) {
    for (const candidateText of candidateFields) {
      if (originalText === candidateText) {
        score += 4;
      } else if (
        originalText.length >= 4 &&
        candidateText.length >= 4 &&
        (originalText.includes(candidateText) || candidateText.includes(originalText))
      ) {
        score += 2;
      }
    }
  }

  return score;
}

function rematchAction(action, oldPageData, newPageData) {
  const original = elementForAction(action, oldPageData);
  if (!original) return null;

  const scored = pageElements(newPageData)
    .map(candidate => ({
      candidate,
      score: elementMatchScore(original, candidate, action)
    }))
    .filter(item => item.score >= 8)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return null;
  if (scored[1] && scored[0].score - scored[1].score < 3) return null;

  const candidate = scored[0].candidate;
  return {
    action: {
      ...action,
      selector: candidate.selector,
      frameId: Number.isFinite(candidate.frameId) ? candidate.frameId : 0,
      shadowPath: normalizeShadowPath(candidate.shadowPath)
    },
    candidate,
    score: scored[0].score
  };
}

function createEmptyCollectionRun() {
  return {
    running: false,
    pausedForReview: false,
    stopRequested: false,
    firstRecordReviewed: false,
    startedAt: 0,
    completedAt: 0,
    task: "",
    playbook: "",
    playbookName: "",
    fields: [],
    rows: [],
    rowKeys: new Set(),
    warnings: [],
    log: [],
    steps: 0,
    noProgressSteps: 0,
    visitedUrls: new Set(),
    currentUrl: "",
    currentTitle: "",
    lastAction: "-",
    stopReason: ""
  };
}

function collectionLimits() {
  return {
    maxSteps: Math.max(Number(limitStepsInput.value) || 250, 1),
    maxRows: Math.max(Number(limitRowsInput.value) || 500, 1),
    maxVisitedUrls: Math.max(Number(limitUrlsInput.value) || 100, 1),
    maxNoProgressSteps: Math.max(Number(limitNoProgressInput.value) || 10, 1),
    maxRuntimeMinutes: Math.max(Number(limitRuntimeInput.value) || 30, 1)
  };
}

function collectionFieldList() {
  return collectionFieldsInput.value
    .split(",")
    .map(field => field.trim())
    .filter(Boolean);
}

function collectionElapsedMs() {
  if (!collectionRun.startedAt) return 0;
  const end = collectionRun.completedAt || Date.now();
  return Math.max(end - collectionRun.startedAt, 0);
}

function formatElapsed(ms) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${rest}s`;
}

function addCollectionLog(message) {
  const stamp = new Date().toLocaleTimeString();
  collectionRun.log.unshift(`[${stamp}] ${message}`);
  collectionRun.log = collectionRun.log.slice(0, 80);
}

function setCollectionStatus(text, tone = "") {
  setStatusLine(collectionStatus, text, tone);
  recordActivity(text, tone || (String(text).toLowerCase().includes("running") ? "active" : ""));
}

function setCollectionControls() {
  collectionStartBtn.disabled = collectionRun.running || collectionRun.pausedForReview;
  collectionStopBtn.disabled = !collectionRun.running;
  collectionApproveBtn.style.display = collectionRun.pausedForReview ? "inline-block" : "none";
  collectionDownloadBtn.disabled = collectionRun.rows.length === 0;
  collectionPlaybookBtn.disabled = collectionRun.running;
  collectionClearBtn.disabled = collectionRun.running;
  stopBtn.disabled = !collectionRun.running && !activeAbortController && !batchRunning;
}

function rowKey(row) {
  const entries = Object.entries(row || {})
    .filter(([key]) => !["capturedAt", "confidence", "notes", "unresolvedFields"].includes(key))
    .map(([key, value]) => [key, String(value || "").trim().toLowerCase()])
    .sort(([a], [b]) => a.localeCompare(b));

  return JSON.stringify(entries);
}

function mergeCollectionFields(fields) {
  const current = new Set(collectionRun.fields);

  for (const field of fields || []) {
    const clean = String(field || "").trim();
    if (clean) current.add(clean);
  }

  for (const row of collectionRun.rows) {
    for (const key of Object.keys(row)) {
      current.add(key);
    }
  }

  collectionRun.fields = Array.from(current);
}

function mergeCollectionRows(rows) {
  let added = 0;

  for (const row of rows || []) {
    if (!row || typeof row !== "object") continue;

    const key = rowKey(row);
    if (collectionRun.rowKeys.has(key)) continue;

    collectionRun.rowKeys.add(key);
    collectionRun.rows.push(row);
    added += 1;
  }

  mergeCollectionFields([]);
  return added;
}

function visibleCollectionFields() {
  const preferred = collectionRun.fields.length
    ? collectionRun.fields
    : Array.from(new Set(collectionRun.rows.flatMap(row => Object.keys(row))));
  const metadata = ["sourceUrl", "sourceTitle", "capturedAt", "confidence", "notes", "unresolvedFields"];
  const ordered = [
    ...preferred.filter(field => !metadata.includes(field)),
    ...metadata.filter(field => preferred.includes(field) || collectionRun.rows.some(row => row[field]))
  ];

  return ordered.slice(0, 18);
}

function renderRowsPreview() {
  if (!collectionRun.rows.length) {
    collectionRowsPreview.style.display = "none";
    collectionRowsPreview.textContent = "";
    return;
  }

  const fields = visibleCollectionFields();
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const tbody = document.createElement("tbody");
  const headRow = document.createElement("tr");

  for (const field of fields) {
    const th = document.createElement("th");
    th.textContent = field;
    headRow.appendChild(th);
  }

  thead.appendChild(headRow);

  for (const row of collectionRun.rows.slice(-30)) {
    const tr = document.createElement("tr");

    for (const field of fields) {
      const td = document.createElement("td");
      td.textContent = row[field] ?? "";
      tr.appendChild(td);
    }

    tbody.appendChild(tr);
  }

  table.appendChild(thead);
  table.appendChild(tbody);
  collectionRowsPreview.textContent = "";
  collectionRowsPreview.appendChild(table);
  collectionRowsPreview.style.display = "block";
}

function renderCollectionRun() {
  metricSteps.textContent = String(collectionRun.steps);
  metricRows.textContent = String(collectionRun.rows.length);
  metricUrls.textContent = String(collectionRun.visitedUrls.size);
  metricElapsed.textContent = formatElapsed(collectionElapsedMs());
  metricCurrentUrl.textContent = collectionRun.currentUrl || "-";
  metricCurrentUrl.title = collectionRun.currentUrl || "";
  metricLastAction.textContent = collectionRun.lastAction || "-";
  collectionLog.textContent = collectionRun.log.length ? collectionRun.log.join("\n") : "No collection run yet.";
  renderRowsPreview();
  setCollectionControls();
}

async function readCollectionSnapshot() {
  const result = await sendToBackground({
    type: "GET_DEEP_PAGE_CONTEXT",
    includeScreenshot: includeScreenshotInput.checked,
    includeAccessibility: true
  });

  if (result.error) return result;

  latestPageData = {
    tab: result.tab,
    pageData: result.page
  };

  return {
    tab: result.tab,
    snapshot: {
      ...result.page,
      tab: result.tab
    }
  };
}

function collectionRunState() {
  return {
    steps: collectionRun.steps,
    rows: collectionRun.rows.length,
    visitedUrls: Array.from(collectionRun.visitedUrls).slice(-100),
    noProgressSteps: collectionRun.noProgressSteps,
    elapsedMs: collectionElapsedMs(),
    currentUrl: collectionRun.currentUrl,
    currentTitle: collectionRun.currentTitle,
    firstRecordReviewed: collectionRun.firstRecordReviewed,
    warnings: collectionRun.warnings.slice(-30),
    lastAction: collectionRun.lastAction,
    stopReason: collectionRun.stopReason
  };
}

function limitStopReason(limits) {
  if (collectionRun.steps >= limits.maxSteps) return "step_limit";
  if (collectionRun.rows.length >= limits.maxRows) return "row_limit";
  if (collectionRun.visitedUrls.size >= limits.maxVisitedUrls) return "url_limit";
  if (collectionRun.noProgressSteps >= limits.maxNoProgressSteps) return "no_progress_limit";
  if (collectionElapsedMs() >= limits.maxRuntimeMinutes * 60 * 1000) return "runtime_limit";
  return "";
}

function collectionActionUsesPreviewRetry(action) {
  return ["click", "type"].includes(String(action?.type || "").toLowerCase());
}

function collectionActionForDisplay(action, snapshot) {
  const normalized = normalizeActionForDisplay(action);
  const type = String(normalized.type || "").toLowerCase();
  const riskLabel = normalized.riskLabel === "safe" && type === "type"
    ? "caution"
    : normalized.riskLabel;

  return enrichActionForDisplay({
    ...normalized,
    riskLabel
  }, snapshot);
}

async function executeCollectionActions(tabId, actions, snapshot) {
  for (const action of actions || []) {
    if (collectionRun.stopRequested) return false;

    const collectionAction = collectionActionForDisplay(action, snapshot);
    const historyId = addActionHistoryEntry(collectionAction, collectionAction.riskLabel === "blocked" ? "blocked" : "proposed", {
      scope: "collection",
      task: collectionRun.task,
      result: "Queued by Collection Mode."
    });
    const actionWithHistory = {
      ...collectionAction,
      historyId
    };

    collectionRun.lastAction = actionWithHistory.type;
    addCollectionLog(`Action: ${JSON.stringify(actionWithHistory)}`);
    renderCollectionRun();

    if (actionWithHistory.riskLabel === "blocked") {
      const reason = actionWithHistory.riskReasons?.join(" ") || "Collection action was blocked.";
      collectionRun.warnings.push(reason);
      addCollectionLog(`Action blocked: ${reason}`);
      renderCollectionRun();
      return false;
    }

    if (collectionActionUsesPreviewRetry(actionWithHistory)) {
      updateActionHistoryEntry(historyId, {
        attempts: 1,
        result: "Previewing collection target before running."
      });

      const execution = await executeActionWithPreviewAndRetry(actionWithHistory, {
        collection: true,
        originalPageData: snapshot,
        shouldStop: () => collectionRun.stopRequested,
        onStop: () => {
          collectionRun.stopRequested = true;
          setCollectionStatus("Stopping collection after preview...", "danger");
        }
      });
      const result = execution.result;
      const finalAction = execution.action || actionWithHistory;

      if (execution.stopped || result?.stopped) {
        updateActionHistoryEntry(historyId, {
          status: "stopped",
          attempts: execution.attempts || 1,
          result: result?.result || "Stopped after preview.",
          error: "",
          rematchNote: execution.rematchNote || ""
        });
        addCollectionLog(result?.result || "Stopped after preview.");
        renderCollectionRun();
        return false;
      }

      if (result?.error) {
        updateActionHistoryEntry(historyId, {
          status: "failed",
          attempts: execution.attempts || 1,
          error: result.error,
          result: "",
          rematchNote: execution.rematchNote || ""
        });
        collectionRun.warnings.push(result.error);
        addCollectionLog(`Action blocked/failed: ${result.error}`);
        renderCollectionRun();
        return false;
      }

      updateActionHistoryEntry(historyId, {
        status: "executed",
        attempts: execution.attempts || 1,
        result: result?.result || "Action completed.",
        error: "",
        rematchNote: execution.rematchNote || "",
        action: {
          type: finalAction.type,
          selector: finalAction.selector || "",
          text: finalAction.text || "",
          frameId: Number.isFinite(finalAction.frameId) ? finalAction.frameId : 0,
          shadowPath: normalizeShadowPath(finalAction.shadowPath)
        },
        meta: actionMeta(finalAction)
      });

      if (execution.retried) {
        addCollectionLog(`Action rematched and retried: ${actionSummary(finalAction)}`);
      }

      await sleep(700);
      continue;
    }

    updateActionHistoryEntry(historyId, {
      attempts: 1,
      result: "Running collection action."
    });

    const result = await sendToBackground({
      type: "RUN_PAGE_ACTION",
      action: actionWithHistory,
      collection: true
    });

    if (result?.error) {
      updateActionHistoryEntry(historyId, {
        status: "failed",
        attempts: 1,
        error: result.error,
        result: ""
      });
      collectionRun.warnings.push(result.error);
      addCollectionLog(`Action blocked/failed: ${result.error}`);
      renderCollectionRun();
      return false;
    }

    updateActionHistoryEntry(historyId, {
      status: "executed",
      attempts: 1,
      result: result?.result || "Action completed.",
      error: ""
    });

    await sleep(actionWithHistory.type === "wait" ? 100 : 700);
  }

  return true;
}

async function runCollectionLoop() {
  const limits = collectionLimits();
  collectionRun.running = true;
  collectionRun.pausedForReview = false;
  setCollectionStatus("Collection running...");
  renderCollectionRun();

  while (collectionRun.running && !collectionRun.stopRequested) {
    const limitReason = limitStopReason(limits);
    if (limitReason) {
      collectionRun.stopReason = limitReason;
      break;
    }

    const observed = await readCollectionSnapshot();

    if (observed.error) {
      collectionRun.warnings.push(observed.error);
      collectionRun.stopReason = "snapshot_failed";
      break;
    }

    const { tab, snapshot } = observed;
    collectionRun.currentUrl = snapshot.url || tab.url || "";
    collectionRun.currentTitle = snapshot.title || tab.title || "";
    if (collectionRun.currentUrl) collectionRun.visitedUrls.add(collectionRun.currentUrl);
    addCollectionLog(`Observed ${collectionRun.currentTitle || collectionRun.currentUrl || "page"}`);
    renderCollectionRun();

    let data;

    try {
      data = await postJson(`${API_BASE}/collection/step`, {
        task: collectionRun.task,
        fields: collectionRun.fields,
        playbook: collectionRun.playbook,
        limits,
        runState: collectionRunState(),
        page: snapshot,
        provider: providerSelect.value,
        files: agentAttachments()
      });
    } catch (error) {
      collectionRun.warnings.push(error.message);
      collectionRun.stopReason = "backend_error";
      break;
    }

    collectionRun.steps += 1;
    const addedRows = mergeCollectionRows(data.rows);
    mergeCollectionFields(data.fields);

    for (const warning of data.warnings || []) {
      collectionRun.warnings.push(warning);
    }

    if (data.reply) addCollectionLog(data.reply);
    if (data.nextRecordHint) addCollectionLog(`Next: ${data.nextRecordHint}`);

    const actions = Array.isArray(data.actions) ? data.actions : [];
    const madeProgress = addedRows > 0 || actions.length > 0 || data.done;
    collectionRun.noProgressSteps = madeProgress ? 0 : collectionRun.noProgressSteps + 1;

    if (addedRows > 0) {
      addCollectionLog(`Captured ${addedRows} row(s).`);
    }

    renderCollectionRun();

    if (
      reviewFirstRecordInput.checked &&
      !collectionRun.firstRecordReviewed &&
      collectionRun.rows.length > 0
    ) {
      collectionRun.running = false;
      collectionRun.pausedForReview = true;
      collectionRun.stopReason = "first_record_review";
      setCollectionStatus("Paused for first-record review.", "success");
      renderCollectionRun();
      return;
    }

    if (data.done) {
      collectionRun.stopReason = data.stopReason || "done";
      break;
    }

    if (!actions.length) {
      await new Promise(resolve => setTimeout(resolve, 600));
      continue;
    }

    const actionOk = await executeCollectionActions(tab.id, actions, snapshot);
    if (!actionOk && collectionRun.warnings.length) {
      collectionRun.noProgressSteps += 1;
    }
  }

  collectionRun.running = false;
  collectionRun.completedAt = Date.now();

  if (collectionRun.stopRequested) {
    collectionRun.stopReason = "stopped_by_user";
    setCollectionStatus("Collection stopped.", "danger");
  } else if (collectionRun.stopReason === "done") {
    setCollectionStatus("Collection complete.", "success");
  } else {
    setCollectionStatus(`Collection stopped: ${collectionRun.stopReason || "finished"}.`);
  }

  renderCollectionRun();
}

function markdownEscape(value) {
  return String(value ?? "")
    .replace(/\r?\n/g, "<br>")
    .replace(/\|/g, "\\|");
}

function collectionMarkdown() {
  const fields = visibleCollectionFields();
  const warnings = collectionRun.warnings.length
    ? collectionRun.warnings.map(warning => `- ${warning}`).join("\n")
    : "- None";
  const sources = Array.from(collectionRun.visitedUrls)
    .map(url => `- ${url}`)
    .join("\n") || "- None";
  const header = `| ${fields.map(markdownEscape).join(" | ")} |`;
  const separator = `| ${fields.map(() => "---").join(" | ")} |`;
  const rows = collectionRun.rows.map(row => `| ${fields.map(field => markdownEscape(row[field])).join(" | ")} |`);

  return [
    `# Chrome AI Agent Collection Export`,
    "",
    `- Task: ${collectionRun.task || "N/A"}`,
    `- Playbook: ${collectionRun.playbookName || "N/A"}`,
    `- Generated: ${new Date().toISOString()}`,
    `- Steps: ${collectionRun.steps}`,
    `- Rows: ${collectionRun.rows.length}`,
    `- Visited URLs: ${collectionRun.visitedUrls.size}`,
    `- Stop reason: ${collectionRun.stopReason || "N/A"}`,
    "",
    "## Warnings",
    "",
    warnings,
    "",
    "## Extracted Rows",
    "",
    fields.length ? [header, separator, ...rows].join("\n") : "No rows captured.",
    "",
    "## Sources",
    "",
    sources,
    ""
  ].join("\n");
}

function downloadCollectionMarkdown() {
  const blob = new Blob([collectionMarkdown()], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  a.href = url;
  a.download = `chrome-ai-agent-collection-${timestamp}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function resetCollectionRun() {
  collectionRun = createEmptyCollectionRun();
  setCollectionStatus("Idle.");
  renderCollectionRun();
}

function stopCurrentWork() {
  if (activeAbortController) {
    activeAbortController.abort();
    activeAbortController = null;
  }

  if (pendingPreviewPause) {
    resolvePreviewPause(false);
  }

  if (collectionRun.running) {
    collectionRun.stopRequested = true;
    setCollectionStatus("Stopping after the current step...");
  }

  if (batchRunning || taskPermissionGranted) {
    taskPermissionGranted = false;
    batchRunning = false;
    stopPendingActionHistory();
    appendResponse("Stopping current action batch...");
  }

  setBusy(false);
  renderCollectionRun();
  renderActions();
}

function renderActions() {
  if (!pendingActions.length) {
    actionsBox.style.display = "none";
    actionsBox.textContent = "";
    runBatchBtn.style.display = "none";
    return;
  }

  const displayActions = pendingActions.map(normalizeActionForDisplay);
  const runnableCount = executableActions(displayActions).length;

  actionsBox.style.display = "block";
  actionsBox.innerHTML = "";

  const header = document.createElement("div");
  header.className = "actions-header";

  const label = document.createElement("span");
  label.textContent = "Action Queue";

  const count = document.createElement("span");
  count.className = "action-count";
  count.textContent = `${runnableCount}/${displayActions.length} runnable`;

  header.appendChild(label);
  header.appendChild(count);
  actionsBox.appendChild(header);

  displayActions.forEach((action, index) => {
    const div = document.createElement("div");
    div.className = "action-card";

    const title = document.createElement("div");
    title.className = "action-title";

    const step = document.createElement("span");
    step.textContent = `Step ${index + 1}: ${actionSummary(action)}`;

    const type = document.createElement("span");
    type.className = "action-type";
    type.textContent = action.type;

    const risk = document.createElement("span");
    risk.className = `risk-badge risk-${action.riskLabel}`;
    risk.textContent = action.riskLabel;

    title.appendChild(step);
    title.appendChild(type);
    title.appendChild(risk);
    div.appendChild(title);

    const metaLines = [
      ...(action.riskReasons || []),
      ...actionMeta(action)
    ];

    if (metaLines.length) {
      const meta = document.createElement("div");
      meta.className = "action-meta";
      meta.textContent = metaLines.join(" ");
      div.appendChild(meta);
    }

    actionsBox.appendChild(div);
  });

  runBatchBtn.style.display = "inline-block";
  runBatchBtn.disabled = !runnableCount || batchRunning;
  runBatchBtn.textContent = runnableCount
    ? `Grant Permission and Run Batch (${runnableCount})`
    : "No Runnable Actions";
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

async function sendToBackground(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    return {
      error: error.message || "Could not communicate with the extension background worker."
    };
  }
}

async function readCurrentPage() {
  const result = await sendToBackground({
    type: "GET_DEEP_PAGE_CONTEXT",
    includeScreenshot: includeScreenshotInput.checked,
    includeAccessibility: true
  });

  if (result.error) {
    return result;
  }

  latestPageData = {
    tab: result.tab,
    pageData: result.page
  };

  return latestPageData;
}

function actionNeedsPreview(action) {
  return ["click", "type", "submit"].includes(String(action?.type || ""));
}

async function previewPageAction(action) {
  if (!actionNeedsPreview(action)) {
    return { ok: true, result: "preview skipped" };
  }

  return sendToBackground({
    type: "PREVIEW_PAGE_ACTION",
    action
  });
}

async function runPageAction(action, options = {}) {
  return sendToBackground({
    type: "RUN_PAGE_ACTION",
    action,
    collection: Boolean(options.collection)
  });
}

function resultError(result) {
  return result?.error ? String(result.error) : "";
}

function actionRequiresPreviewPause(action) {
  const type = String(action?.type || "").toLowerCase();
  return pauseCautionPreview &&
    actionNeedsPreview(action) &&
    (actionRiskLabel(action) === "caution" || type === "type" || type === "submit");
}

function setActionPausePanelVisible(isVisible) {
  if (!actionPausePanel) return;
  actionPausePanel.style.display = isVisible ? "grid" : "none";
}

function resolvePreviewPause(shouldContinue) {
  if (!pendingPreviewPause) return;

  const pending = pendingPreviewPause;
  pendingPreviewPause = null;
  setActionPausePanelVisible(false);

  if (!shouldContinue) {
    pending.onStop?.();
  }

  pending.resolve(Boolean(shouldContinue));
}

function waitForPreviewApproval(action, options = {}) {
  if (!actionRequiresPreviewPause(action)) {
    return Promise.resolve(true);
  }

  if (!actionPausePanel || !previewContinueBtn || !previewStopBtn) {
    return Promise.resolve(true);
  }

  if (pendingPreviewPause) {
    resolvePreviewPause(false);
  }

  if (actionPauseText) {
    actionPauseText.textContent = `Review the highlighted target for "${actionSummary(action)}" before continuing.`;
  }

  setActionPausePanelVisible(true);
  previewContinueBtn.disabled = false;
  previewStopBtn.disabled = false;
  setAgentState("Waiting for preview approval", "active");
  recordActivity("Paused after preview for approval", "active");
  previewContinueBtn.focus();

  return new Promise(resolve => {
    pendingPreviewPause = {
      resolve,
      onStop: options.onStop
    };
  });
}

async function retryActionAfterRefresh(action, historyId, originalError, originalPageData, options = {}) {
  if (!retryableSelectorError(originalError)) {
    return {
      action,
      result: { error: originalError },
      attempts: 1,
      retried: false
    };
  }

  recordActivity("Retrying action after selector changed", "active");

  if (!originalPageData) {
    return {
      action,
      result: { error: `${originalError} Retry unavailable because the original page context is missing.` },
      attempts: 1,
      retried: false
    };
  }

  const readPageForRetry = options.readPageForRetry || readCurrentPage;
  let lastRetryError = "";

  for (const delayMs of ACTION_RETRY_DELAYS_MS) {
    if (options.shouldStop?.()) {
      return {
        action,
        result: { stopped: true, result: "Stopped before retry." },
        attempts: 1,
        retried: false,
        stopped: true
      };
    }

    updateActionHistoryEntry(historyId, {
      status: "retrying",
      attempts: 1,
      error: originalError,
      result: `Waiting ${delayMs}ms for page changes before re-reading.`
    });

    await sleep(delayMs);

    if (options.shouldStop?.()) {
      return {
        action,
        result: { stopped: true, result: "Stopped before retry." },
        attempts: 1,
        retried: false,
        stopped: true
      };
    }

    const reread = await readPageForRetry();
    const nextPageData = reread?.pageData || reread?.snapshot || reread?.page;

    if (reread?.error || !nextPageData) {
      lastRetryError = reread?.error || "Page reread did not return page data.";
      continue;
    }

    const rematched = rematchAction(action, originalPageData, nextPageData);

    if (!rematched) {
      lastRetryError = "No confident rematch found.";
      continue;
    }

    const retryAction = enrichActionForDisplay({
      ...rematched.action,
      historyId
    }, nextPageData);
    const rematchNote = `Retried after ${delayMs}ms with selector ${compactText(retryAction.selector, 120)}.`;

    updateActionHistoryEntry(historyId, {
      status: "retrying",
      attempts: 2,
      error: "",
      result: "Target rematched; trying once more.",
      rematchNote,
      action: {
        type: retryAction.type,
        selector: retryAction.selector,
        text: retryAction.text || "",
        frameId: Number.isFinite(retryAction.frameId) ? retryAction.frameId : 0,
        shadowPath: normalizeShadowPath(retryAction.shadowPath)
      },
      meta: actionMeta(retryAction)
    });

    const preview = await previewPageAction(retryAction);
    const previewError = resultError(preview);

    if (previewError) {
      if (!retryableSelectorError(previewError)) {
        return {
          action: retryAction,
          result: { error: `${originalError} Retry preview failed: ${previewError}` },
          attempts: 2,
          retried: true,
          rematchNote
        };
      }

      lastRetryError = `Retry preview failed: ${previewError}`;
      continue;
    }

    const approved = await waitForPreviewApproval(retryAction, options);

    if (!approved) {
      return {
        action: retryAction,
        result: { stopped: true, result: "Stopped after preview." },
        attempts: 2,
        retried: true,
        stopped: true,
        rematchNote
      };
    }

    const result = await runPageAction(retryAction, options);

    return {
      action: retryAction,
      result,
      attempts: 2,
      retried: true,
      rematchNote
    };
  }

  return {
    action,
    result: { error: `${originalError} Could not confidently rematch the target after retry backoff.${lastRetryError ? ` Last retry: ${lastRetryError}` : ""}` },
    attempts: 1,
    retried: false
  };
}

async function executeActionWithPreviewAndRetry(action, options = {}) {
  const historyId = action.historyId || "";
  const originalPageData = options.originalPageData || latestPageData?.pageData;

  if (options.shouldStop?.()) {
    return {
      action,
      result: { stopped: true, result: "Stopped before action." },
      attempts: 0,
      retried: false,
      stopped: true
    };
  }

  const preview = await previewPageAction(action);
  const previewError = resultError(preview);

  if (previewError) {
    return retryActionAfterRefresh(action, historyId, previewError, originalPageData, options);
  }

  const approved = await waitForPreviewApproval(action, options);

  if (!approved) {
    return {
      action,
      result: { stopped: true, result: "Stopped after preview." },
      attempts: 1,
      retried: false,
      stopped: true
    };
  }

  if (options.shouldStop?.()) {
    return {
      action,
      result: { stopped: true, result: "Stopped before action." },
      attempts: 1,
      retried: false,
      stopped: true
    };
  }

  const result = await runPageAction(action, options);
  const actionError = resultError(result);

  if (actionError) {
    return retryActionAfterRefresh(action, historyId, actionError, originalPageData, options);
  }

  return {
    action,
    result,
    attempts: 1,
    retried: false
  };
}

function stopPendingActionHistory(reason = "Stopped before this action ran.") {
  for (const action of executableActions(pendingActions)) {
    updateActionHistoryEntry(action.historyId, {
      status: "stopped",
      result: reason,
      error: ""
    });
  }
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
    throw new Error(data.error || data.message || `Request failed: ${res.status}`);
  }

  return data;
}

function applyAgentFinal(data) {
  const executable = Array.isArray(data.actions) ? data.actions : [];
  const blocked = Array.isArray(data.blockedActions)
    ? data.blockedActions.map(item => normalizeActionForDisplay({
      ...(item.action || item),
      riskLabel: "blocked",
      riskReasons: [
        ...(Array.isArray(item.riskReasons) ? item.riskReasons : []),
        item.reason || item.riskReason || ""
      ].filter(Boolean)
    }))
    : [];

  pendingActions = [
    ...executable.map(normalizeActionForDisplay),
    ...blocked
  ].map(action => {
    const enriched = enrichActionForDisplay(action);
    const status = enriched.riskLabel === "blocked" ? "blocked" : "proposed";
    const historyId = addActionHistoryEntry(enriched, status);
    return { ...enriched, historyId };
  });

  const currentText = responseBox.textContent.trim();
  const statusOnly = [
    "Reading page context...",
    "Streaming reply...",
    "Planning actions...",
    "Codex CLI mode does not stream tokens here. Planning actions..."
  ].includes(currentText);

  if (data.reply && (!currentText || statusOnly)) {
    responseBox.textContent = data.reply;
  }

  if (Array.isArray(data.warnings) && data.warnings.length) {
    appendResponse(`Warnings:\n${data.warnings.join("\n")}`);
  }

  renderActions();
}

function parseSseBlock(block) {
  let event = "message";
  const dataLines = [];

  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim() || "message";
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  const dataText = dataLines.join("\n");
  let data = {};

  if (dataText) {
    try {
      data = JSON.parse(dataText);
    } catch (error) {
      data = { text: dataText };
    }
  }

  return { event, data };
}

async function streamAgentRequest(payload) {
  activeAbortController = new AbortController();
  stopBtn.disabled = false;

  const res = await fetch(`${API_BASE}/agent/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload),
    signal: activeAbortController.signal
  });

  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed: ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawFinal = false;
  let sawDelta = false;

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

    const blocks = buffer.split(/\n\n/);
    buffer = blocks.pop() || "";

    for (const block of blocks) {
      if (!block.trim()) continue;

      const { event, data } = parseSseBlock(block);

      if (event === "status") {
        if (data.message && !sawDelta) {
          responseBox.textContent = data.message;
          updateAgentStateFromMessage(data.message);
          recordActivity(data.message, "active");
        }
      } else if (event === "delta") {
        if (!sawDelta) {
          responseBox.textContent = "";
          sawDelta = true;
        }
        responseBox.textContent += data.text || "";
      } else if (event === "final") {
        sawFinal = true;
        applyAgentFinal(data);
        setAgentState("Completed", "success");
        recordActivity("Response completed", "success");
      } else if (event === "error") {
        setAgentState("Error", "danger");
        recordActivity(data.error || data.message || "Streaming request failed", "danger");
        throw new Error(data.error || data.message || "Streaming request failed.");
      }
    }

    if (done) break;
  }

  if (!sawFinal) {
    throw new Error("Streaming ended before final actions were returned.");
  }
}

async function getJson(url) {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data.error || `Request failed: ${res.status}`);
  }

  return data;
}

function isOllamaProvider(provider) {
  return provider === "deepseek_r1_ollama" || provider === "gpt_oss_20b_ollama";
}

function defaultBaseUrlForProvider(provider) {
  return isOllamaProvider(provider) ? "http://localhost:11434/v1" : "";
}

function defaultModelForProvider(provider) {
  if (provider === "claude_api_key") return "claude-sonnet-4-5";
  if (provider === "deepseek_r1_ollama") return "deepseek-r1";
  if (provider === "gpt_oss_20b_ollama") return "gpt-oss:20b";
  return "gpt-5.5";
}

function updateProviderTools() {
  const isCodexSignin = providerSelect.value === "openai_signin_codex";
  const isOllama = isOllamaProvider(providerSelect.value);
  codexSigninPanel.style.display = isCodexSignin ? "block" : "none";
  if (baseUrlField) baseUrlField.style.display = isOllama ? "grid" : "none";
  if (isOllama && baseUrlInput && !baseUrlInput.value.trim()) {
    baseUrlInput.value = defaultBaseUrlForProvider(providerSelect.value);
  }
  apiKeyInput.placeholder = isCodexSignin
    ? "Not required for OpenAI sign-in"
    : isOllama
      ? "Optional Ollama API key"
      : "Paste key";

  if (!isCodexSignin && codexSigninPollTimer) {
    clearInterval(codexSigninPollTimer);
    codexSigninPollTimer = null;
  }
}

function renderCodexSigninStatus(data) {
  if (!data) {
    setStatusLine(codexSigninStatus, "Not checked yet.");
    return;
  }

  const codeText = data.deviceCode ? ` Code: ${data.deviceCode}.` : "";

  if (data.status === "complete") {
    setStatusLine(
      codexSigninStatus,
      "OpenAI sign-in confirmed. You can now use OpenAI sign-in through Codex CLI.",
      "success"
    );
    return;
  }

  if (data.status === "failed") {
    setStatusLine(codexSigninStatus, `Sign-in failed: ${data.message || "Unknown error."}`, "danger");
    return;
  }

  if (data.status === "waiting" || data.status === "starting") {
    setStatusLine(codexSigninStatus, `${data.message || "Waiting for sign-in to finish."}${codeText}`);
    return;
  }

  setStatusLine(codexSigninStatus, data.message || "Codex sign-in has not started.");
}

async function getCodexSigninStatus() {
  return getJson(`${API_BASE}/codex-login/status`);
}

function startCodexSigninPolling() {
  if (codexSigninPollTimer) {
    clearInterval(codexSigninPollTimer);
  }

  codexSigninPollTimer = setInterval(async () => {
    if (providerSelect.value !== "openai_signin_codex") return;

    try {
      const data = await getCodexSigninStatus();
      renderCodexSigninStatus(data);

      if (data.status === "complete" || data.status === "failed") {
        clearInterval(codexSigninPollTimer);
        codexSigninPollTimer = null;
      }
    } catch (error) {
      setStatusLine(codexSigninStatus, `Could not check sign-in: ${error.message}`, "danger");
    }
  }, 3000);
}

async function loadSettings() {
  try {
    const data = await getJson(`${API_BASE}/settings`);
    providerSelect.value = data.provider || "openai_api_key";
    modelInput.value = data.model || data.openaiModel || defaultModelForProvider(providerSelect.value);
    if (baseUrlInput) {
      baseUrlInput.value = data.baseUrl || data.ollamaBaseUrl || defaultBaseUrlForProvider(providerSelect.value);
    }
    setBackendStatus(true, "Connected");
    setStatusLine(settingsStatus, `Provider: ${providerSelect.value}.`, "success");
    updateProviderTools();
  } catch (error) {
    modelInput.value = defaultModelForProvider(providerSelect.value);
    if (baseUrlInput) {
      baseUrlInput.value = defaultBaseUrlForProvider(providerSelect.value);
    }
    setBackendStatus(false, "Offline");
    setStatusLine(settingsStatus, "Backend not connected yet.", "danger");
    providerDisclosure.open = true;
    updateProviderTools();
  }
}

document.querySelectorAll("[data-no-summary-toggle] button").forEach(button => {
  button.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
  });
});

if (settingsToggleBtn) {
  settingsToggleBtn.addEventListener("click", () => {
    providerDisclosure.open = true;
    modelInput.focus({ preventScroll: true });
    recordActivity("Opened provider settings");
  });
}

if (apiKeyToggleBtn) {
  apiKeyToggleBtn.addEventListener("click", () => {
    const shouldShow = apiKeyInput.type === "password";
    apiKeyInput.type = shouldShow ? "text" : "password";
    apiKeyToggleBtn.textContent = shouldShow ? "Hide" : "Show";
    apiKeyToggleBtn.setAttribute("aria-label", shouldShow ? "Hide API key" : "Show API key");
  });
}

providerSelect.addEventListener("change", () => {
  const currentModel = modelInput.value.trim();
  const knownDefaults = ["gpt-5.5", "claude-sonnet-4-5", "deepseek-r1", "gpt-oss:20b"];

  if (!currentModel || knownDefaults.includes(currentModel)) {
    modelInput.value = defaultModelForProvider(providerSelect.value);
  }

  if (baseUrlInput && isOllamaProvider(providerSelect.value) && !baseUrlInput.value.trim()) {
    baseUrlInput.value = defaultBaseUrlForProvider(providerSelect.value);
  }

  updateProviderTools();
});

saveSettingsBtn.addEventListener("click", async () => {
  setBusy(true);
  setStatusLine(settingsStatus, "Saving provider...");

  try {
    const provider = providerSelect.value;
    const model = modelInput.value.trim();
    const apiKey = apiKeyInput.value.trim();
    const baseUrl = baseUrlInput ? baseUrlInput.value.trim() : "";

    const data = await postJson(`${API_BASE}/settings`, {
      provider,
      model,
      apiKey,
      baseUrl
    });

    apiKeyInput.value = "";
    setBackendStatus(true, "Connected");
    setStatusLine(settingsStatus, `Saved provider: ${data.provider}. ${data.message || ""}`, "success");
  } catch (error) {
    setStatusLine(settingsStatus, error.message, "danger");
  }

  setBusy(false);
});

codexLoginBtn.addEventListener("click", async () => {
  setBusy(true);
  setStatusLine(codexSigninStatus, "Starting OpenAI sign-in...");

  try {
    const model = modelInput.value.trim();

    if (model) {
      await postJson(`${API_BASE}/settings`, {
        provider: "openai_signin_codex",
        model
      });
    }

    const data = await postJson(`${API_BASE}/codex-login/start`, {});
    renderCodexSigninStatus(data);

    if (data.loginUrl) {
      await chrome.tabs.create({ url: data.loginUrl });
    } else {
      await chrome.tabs.create({ url: `${API_BASE}/codex-login` });
    }

    startCodexSigninPolling();
  } catch (error) {
    const restartHint = error.message.includes("404")
      ? " Restart the backend so the new sign-in routes are available."
      : "";
    setStatusLine(codexSigninStatus, `Could not start sign-in: ${error.message}.${restartHint}`, "danger");
  }

  setBusy(false);
});

codexCheckBtn.addEventListener("click", async () => {
  setBusy(true);
  setStatusLine(codexSigninStatus, "Checking OpenAI sign-in...");

  try {
    const data = await postJson(`${API_BASE}/codex-login/check`, {});
    renderCodexSigninStatus(data);
  } catch (error) {
    setStatusLine(codexSigninStatus, `OpenAI sign-in is not confirmed yet: ${error.message}`, "danger");
  }

  setBusy(false);
});

attachFileBtn.addEventListener("click", () => {
  fileInput.click();
});

fileInput.addEventListener("change", async () => {
  await addAttachments(fileInput.files);
  fileInput.value = "";
});

includeScreenshotInput.addEventListener("change", updateComposerState);

taskInput.addEventListener("input", () => {
  resizeTaskInput();
  saveTaskDraftSoon();
});

taskInput.addEventListener("keydown", event => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    if (!askBtn.disabled) askBtn.click();
  }
});

if (clearHistoryBtn) {
  clearHistoryBtn.addEventListener("click", clearActionHistory);
}

if (exportHistoryMdBtn) {
  exportHistoryMdBtn.addEventListener("click", downloadActionHistoryMarkdown);
}

if (exportHistoryJsonBtn) {
  exportHistoryJsonBtn.addEventListener("click", downloadActionHistoryJson);
}

if (pauseCautionPreviewInput) {
  pauseCautionPreviewInput.addEventListener("change", () => {
    setPauseCautionPreview(pauseCautionPreviewInput.checked);
  });
}

if (permissionInfoBtn) {
  permissionInfoBtn.addEventListener("click", showPermissionOnboarding);
}

if (permissionOnboardingCloseBtn) {
  permissionOnboardingCloseBtn.addEventListener("click", () => hidePermissionOnboarding());
}

if (permissionOnboardingAckBtn) {
  permissionOnboardingAckBtn.addEventListener("click", () => hidePermissionOnboarding({ acknowledge: true }));
}

if (previewContinueBtn) {
  previewContinueBtn.addEventListener("click", () => resolvePreviewPause(true));
}

if (previewStopBtn) {
  previewStopBtn.addEventListener("click", () => resolvePreviewPause(false));
}

collectionPlaybookBtn.addEventListener("click", () => {
  collectionPlaybookFile.click();
});

collectionPlaybookFile.addEventListener("change", async () => {
  const file = collectionPlaybookFile.files?.[0];
  if (!file) return;

  try {
    const text = await file.text();
    collectionPlaybookInput.value = text.slice(0, 60000);
    collectionPlaybookName = file.name;
    addCollectionLog(`Loaded playbook: ${file.name}`);
    renderCollectionRun();
  } catch (error) {
    setCollectionStatus(`Could not read playbook: ${error.message}`, "danger");
  }

  collectionPlaybookFile.value = "";
});

collectionStartBtn.addEventListener("click", async () => {
  const task = collectionTaskInput.value.trim();

  if (!task) {
    setCollectionStatus("Write a collection task first.", "danger");
    return;
  }

  collectionRun = createEmptyCollectionRun();
  collectionRun.task = task;
  collectionRun.fields = collectionFieldList();
  collectionRun.playbook = collectionPlaybookInput.value.trim();
  collectionRun.playbookName = collectionPlaybookName || (collectionRun.playbook ? "Pasted playbook" : "");
  collectionRun.startedAt = Date.now();
  collectionRun.lastAction = "start";
  addCollectionLog("Collection started.");
  runCollectionLoop().catch(error => {
    collectionRun.running = false;
    collectionRun.stopReason = "runner_error";
    collectionRun.warnings.push(error.message);
    setCollectionStatus(`Collection failed: ${error.message}`, "danger");
    renderCollectionRun();
  });
});

collectionStopBtn.addEventListener("click", () => {
  collectionRun.stopRequested = true;
  if (pendingPreviewPause) resolvePreviewPause(false);
  setCollectionStatus("Stopping after the current step...");
  renderCollectionRun();
});

stopBtn.addEventListener("click", stopCurrentWork);

collectionApproveBtn.addEventListener("click", () => {
  collectionRun.firstRecordReviewed = true;
  collectionRun.pausedForReview = false;
  collectionRun.stopReason = "";
  addCollectionLog("First record approved. Continuing.");
  runCollectionLoop().catch(error => {
    collectionRun.running = false;
    collectionRun.stopReason = "runner_error";
    collectionRun.warnings.push(error.message);
    setCollectionStatus(`Collection failed: ${error.message}`, "danger");
    renderCollectionRun();
  });
});

collectionDownloadBtn.addEventListener("click", downloadCollectionMarkdown);
collectionClearBtn.addEventListener("click", resetCollectionRun);

refreshBtn.addEventListener("click", async () => {
  setBusy(true);
  responseBox.textContent = "Reading page...";
  setAgentState("Reading page", "active");
  recordActivity("Read current page", "active");

  const result = await readCurrentPage();

  if (result.error) {
    responseBox.textContent = result.error;
    setAgentState("Error", "danger");
    recordActivity(result.error, "danger");
  } else {
    const count = result.pageData.elements?.length || 0;
    const frameCount = result.pageData.frames?.length || 1;
    const chunkCount = result.pageData.chunks?.length || 0;
    const warningText = result.pageData.warnings?.length
      ? `\nWarnings:\n${result.pageData.warnings.join("\n")}`
      : "";
    responseBox.textContent = `Page read successfully. Found ${count} interactive elements across ${frameCount} frame(s) and ${chunkCount} text chunk(s).${warningText}`;
    setAgentState("Completed", "success");
    recordActivity("Extracted main content", "success");
  }

  setBusy(false);
});

askBtn.addEventListener("click", async () => {
  const task = taskInput.value.trim();

  if (!task) {
    responseBox.textContent = "Write a task first.";
    setAgentState("Ready");
    recordActivity("Waiting for a task");
    return;
  }

  setBusy(true);
  responseBox.textContent = "Reading page...";
  setAgentState("Reading page", "active");
  recordActivity("Read current page", "active");
  actionsBox.style.display = "none";
  pendingActions = [];
  executedActions = [];
  taskPermissionGranted = false;
  renderActions();

  const result = await readCurrentPage();

  if (result.error) {
    responseBox.textContent = result.error;
    setAgentState("Error", "danger");
    recordActivity(result.error, "danger");
    setBusy(false);
    return;
  }

  const { tab, pageData } = result;
  responseBox.textContent = "Thinking...";
  setAgentState("Thinking", "active");
  recordActivity("Thinking through the request", "active");

  if (Array.isArray(pageData.warnings) && pageData.warnings.length) {
    responseBox.textContent = `Context warnings:\n${pageData.warnings.join("\n")}\n\nThinking...`;
    recordActivity("Context warnings found", "active");
  }

  try {
    await streamAgentRequest({
      task,
      provider: providerSelect.value,
      url: tab?.url || pageData.url,
      title: tab?.title || pageData.title,
      page: pageData,
      files: agentAttachments()
    });
  } catch (error) {
    if (error.name === "AbortError") {
      appendResponse("Stopped.");
      setAgentState("Completed", "success");
    } else {
      responseBox.textContent = `Could not complete request: ${error.message}. Make sure the backend is running on ${API_BASE}.`;
      setAgentState("Error", "danger");
      recordActivity(`Could not complete request: ${error.message}`, "danger");
    }
  } finally {
    activeAbortController = null;
    setBusy(false);
  }
});

runBatchBtn.addEventListener("click", async () => {
  if (!executableActions(pendingActions).length) {
    renderActions();
    return;
  }

  taskPermissionGranted = true;
  batchRunning = true;
  setBusy(true);
  setAgentState("Waiting for permission", "active");
  appendResponse("Permission granted once for this task batch. Running actions...");
  setAgentState("Running browser action", "active");

  while (taskPermissionGranted) {
    const nextIndex = pendingActions.findIndex(action => normalizeActionForDisplay(action).riskLabel !== "blocked");
    if (nextIndex === -1) break;

    const action = normalizeActionForDisplay(pendingActions.splice(nextIndex, 1)[0]);
    runningActionHistoryId = action.historyId || "";
    updateActionHistoryEntry(runningActionHistoryId, {
      attempts: 1,
      result: "Previewing target before running."
    });

    const execution = await executeActionWithPreviewAndRetry(action, {
      shouldStop: () => !taskPermissionGranted || !batchRunning,
      onStop: () => {
        taskPermissionGranted = false;
        batchRunning = false;
      }
    });
    const result = execution.result;
    const finalAction = execution.action || action;

    executedActions.push({ action: finalAction, result });

    if (execution.stopped || result?.stopped) {
      updateActionHistoryEntry(runningActionHistoryId, {
        status: "stopped",
        attempts: execution.attempts || 1,
        result: result?.result || "Stopped after preview.",
        error: "",
        rematchNote: execution.rematchNote || ""
      });
      appendResponse(result?.result || "Stopped after preview.");
      setAgentState("Completed", "success");
      taskPermissionGranted = false;
      stopPendingActionHistory("Stopped after preview approval was declined.");
      break;
    }

    if (result && result.error) {
      updateActionHistoryEntry(runningActionHistoryId, {
        status: "failed",
        attempts: execution.attempts || 1,
        error: result.error,
        result: "",
        rematchNote: execution.rematchNote || ""
      });
      appendResponse(`Action failed: ${result.error}`);
      setAgentState("Error", "danger");
      taskPermissionGranted = false;
      stopPendingActionHistory("Stopped because a previous action failed.");
      break;
    }

    updateActionHistoryEntry(runningActionHistoryId, {
      status: "executed",
      attempts: execution.attempts || 1,
      result: result?.result || "Action completed.",
      error: "",
      rematchNote: execution.rematchNote || ""
    });
    appendResponse(`Action completed: ${actionSummary(finalAction)}.`);
  }

  runningActionHistoryId = "";
  batchRunning = false;
  renderActions();
  setBusy(false);
  if (!pendingActions.length) {
    setAgentState("Completed", "success");
    recordActivity("Action batch completed", "success");
  }
});

clearBtn.addEventListener("click", () => {
  stopCurrentWork();
  pendingActions = [];
  executedActions = [];
  latestPageData = null;
  taskPermissionGranted = false;
  responseBox.textContent = "Ready. Ask me to summarize, extract, compare, or take action on this page.";
  actionsBox.textContent = "";
  actionsBox.style.display = "none";
  taskInput.value = "";
  resizeTaskInput();
  storageRemove(TASK_DRAFT_STORAGE_KEY);
  attachedFiles = [];
  renderAttachments();
  renderActions();
  setAgentState("Ready");
  recordActivity("Cleared current task");
});

renderAttachments();
renderCollectionRun();
loadUserPreferences();
loadActionHistory();
loadTaskDraft();
loadPermissionOnboarding();
updateComposerState();
resizeTaskInput();
loadSettings();
