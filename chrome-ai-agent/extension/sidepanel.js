const providerSelect = document.getElementById("provider");
const modelInput = document.getElementById("model");
const apiKeyInput = document.getElementById("apiKey");
const saveSettingsBtn = document.getElementById("saveSettingsBtn");
const settingsStatus = document.getElementById("settingsStatus");
const backendStatus = document.getElementById("backendStatus");
const codexSigninPanel = document.getElementById("codexSigninPanel");
const codexLoginBtn = document.getElementById("codexLoginBtn");
const codexCheckBtn = document.getElementById("codexCheckBtn");
const codexSigninStatus = document.getElementById("codexSigninStatus");
const providerDisclosure = document.getElementById("providerDisclosure");

const taskInput = document.getElementById("task");
const askBtn = document.getElementById("askBtn");
const refreshBtn = document.getElementById("refreshBtn");
const runBatchBtn = document.getElementById("runBatchBtn");
const stopBtn = document.getElementById("stopBtn");
const clearBtn = document.getElementById("clearBtn");
const attachFileBtn = document.getElementById("attachFileBtn");
const fileInput = document.getElementById("fileInput");
const includeScreenshotInput = document.getElementById("includeScreenshot");
const attachmentTray = document.getElementById("attachmentTray");
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

const API_BASE = "http://localhost:3000";
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 512 * 1024;
const MAX_ATTACHMENT_CHARS = 12000;
const MAX_TOTAL_ATTACHMENT_CHARS = 30000;

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
  stopBtn.disabled = !isBusy && !collectionRun.running && !batchRunning;
}

function appendResponse(text) {
  responseBox.textContent += `\n\n${text}`;
}

function setStatusLine(element, text, tone = "") {
  element.textContent = text;
  element.classList.remove("success", "danger");

  if (tone) {
    element.classList.add(tone);
  }
}

function setBackendStatus(isConnected, text) {
  backendStatus.textContent = text;
  backendStatus.classList.toggle("connected", isConnected);
  backendStatus.classList.toggle("offline", !isConnected);
  backendStatus.title = isConnected ? "Local backend is reachable." : "Local backend is not reachable.";
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

async function executeCollectionActions(tabId, actions) {
  for (const action of actions || []) {
    if (collectionRun.stopRequested) return false;

    collectionRun.lastAction = action.type;
    addCollectionLog(`Action: ${JSON.stringify(action)}`);
    renderCollectionRun();

    const result = await sendToBackground({
      type: "RUN_PAGE_ACTION",
      action,
      collection: true
    });

    if (result?.error) {
      collectionRun.warnings.push(result.error);
      addCollectionLog(`Action blocked/failed: ${result.error}`);
      renderCollectionRun();
      return false;
    }

    await new Promise(resolve => setTimeout(resolve, action.type === "wait" ? 100 : 700));
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

    const actionOk = await executeCollectionActions(tab.id, actions);
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

  if (collectionRun.running) {
    collectionRun.stopRequested = true;
    setCollectionStatus("Stopping after the current step...");
  }

  if (batchRunning || taskPermissionGranted) {
    taskPermissionGranted = false;
    batchRunning = false;
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
    step.textContent = `Step ${index + 1}`;

    const type = document.createElement("span");
    type.className = "action-type";
    type.textContent = action.type;

    const risk = document.createElement("span");
    risk.className = `risk-badge risk-${action.riskLabel}`;
    risk.textContent = action.riskLabel;

    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(action, null, 2);

    title.appendChild(step);
    title.appendChild(type);
    title.appendChild(risk);
    div.appendChild(title);

    if (action.riskReasons.length) {
      const meta = document.createElement("div");
      meta.className = "action-meta";
      meta.textContent = action.riskReasons.join(" ");
      div.appendChild(meta);
    }

    div.appendChild(pre);
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
  ];

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
        if (data.message && !sawDelta) responseBox.textContent = data.message;
      } else if (event === "delta") {
        if (!sawDelta) {
          responseBox.textContent = "";
          sawDelta = true;
        }
        responseBox.textContent += data.text || "";
      } else if (event === "final") {
        sawFinal = true;
        applyAgentFinal(data);
      } else if (event === "error") {
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

function defaultModelForProvider(provider) {
  if (provider === "claude_api_key") return "claude-sonnet-4-5";
  return "gpt-5.5";
}

function updateProviderTools() {
  const isCodexSignin = providerSelect.value === "openai_signin_codex";
  codexSigninPanel.style.display = isCodexSignin ? "block" : "none";

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
    setBackendStatus(true, "Connected");
    setStatusLine(settingsStatus, `Provider: ${providerSelect.value}.`, "success");
    updateProviderTools();
  } catch (error) {
    modelInput.value = defaultModelForProvider(providerSelect.value);
    setBackendStatus(false, "Offline");
    setStatusLine(settingsStatus, "Backend not connected yet.", "danger");
    providerDisclosure.open = true;
    updateProviderTools();
  }
}

providerSelect.addEventListener("change", () => {
  if (!modelInput.value.trim()) {
    modelInput.value = defaultModelForProvider(providerSelect.value);
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

    const data = await postJson(`${API_BASE}/settings`, {
      provider,
      model,
      apiKey
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

  const result = await readCurrentPage();

  if (result.error) {
    responseBox.textContent = result.error;
  } else {
    const count = result.pageData.elements?.length || 0;
    const frameCount = result.pageData.frames?.length || 1;
    const chunkCount = result.pageData.chunks?.length || 0;
    const warningText = result.pageData.warnings?.length
      ? `\nWarnings:\n${result.pageData.warnings.join("\n")}`
      : "";
    responseBox.textContent = `Page read successfully. Found ${count} interactive elements across ${frameCount} frame(s) and ${chunkCount} text chunk(s).${warningText}`;
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

  if (Array.isArray(pageData.warnings) && pageData.warnings.length) {
    responseBox.textContent = `Context warnings:\n${pageData.warnings.join("\n")}\n\nThinking...`;
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
    } else {
      responseBox.textContent = `Could not complete request: ${error.message}. Make sure the backend is running on ${API_BASE}.`;
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
  appendResponse("Permission granted once for this task batch. Running actions...");

  while (taskPermissionGranted) {
    const nextIndex = pendingActions.findIndex(action => normalizeActionForDisplay(action).riskLabel !== "blocked");
    if (nextIndex === -1) break;

    const action = normalizeActionForDisplay(pendingActions.splice(nextIndex, 1)[0]);

    const result = await sendToBackground({
      type: "RUN_PAGE_ACTION",
      action
    });

    executedActions.push({ action, result });
    appendResponse(`Action result:\n${JSON.stringify({ action, result }, null, 2)}`);

    if (result && result.error) {
      appendResponse("Stopped because an action failed.");
      break;
    }
  }

  batchRunning = false;
  renderActions();
  setBusy(false);
});

clearBtn.addEventListener("click", () => {
  stopCurrentWork();
  pendingActions = [];
  executedActions = [];
  latestPageData = null;
  taskPermissionGranted = false;
  responseBox.textContent = "Ready.";
  actionsBox.textContent = "";
  actionsBox.style.display = "none";
  taskInput.value = "";
  attachedFiles = [];
  renderAttachments();
  renderActions();
});

renderAttachments();
renderCollectionRun();
loadSettings();
