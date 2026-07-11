import "dotenv/config";

import express from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  WorkflowRunStore,
  assertValidPatientQueue,
  createWorkflowRecord,
  createFieldValue,
  setRecordField,
  applyUrolithiasisRules,
  exportRunToCsv,
  exportRunToMarkdown,
  UROLITHIASIS_FIELD_SCHEMA,
  UROLITHIASIS_PROFILE_ID,
  validateUrolithiasisRecord,
  assessUrolithiasisReview
} from "./workflows/index.js";
import { WorkflowContextCache, workflowContextKey } from "./workflows/context-cache.js";
import { assertPhaseFieldAllowed, assertSingleWorkflowAction } from "./workflows/workflow-protocol.js";
import { assertPromptByteBudget, collectionPlaybookForPrompt } from "./workflows/prompt-policy.js";
import { applyFirstRecordCheckpoint } from "./workflows/checkpoint.js";
import { publicWorkflowPolicy, workflowAdapterFor } from "./workflows/workflow-adapters.js";
import { DiagnosticsRegistry, correlationId } from "./observability.js";
import { createRuntimeProviderDriver, runtimeProviderMetadata, runtimeProviderStatus } from "./providers/runtime.js";
import { WorkbookService } from "./workbooks/service.js";
import { createWorkbookRouter } from "./routes/workbook.js";
import { AuditStore } from "./workbooks/audit-store.js";

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RUNTIME_SECRETS_PATH = process.env.RUNTIME_SECRETS_PATH
  ? path.resolve(process.env.RUNTIME_SECRETS_PATH)
  : path.join(__dirname, ".runtime-secrets.json");
const LOCAL_CODEX_CLI_PATH = path.join(__dirname, "node_modules", "@openai", "codex", "bin", "codex.js");
const workflowStore = new WorkflowRunStore({ rootDir: process.env.WORKFLOW_RUNS_DIR ? path.resolve(process.env.WORKFLOW_RUNS_DIR) : path.join(__dirname, ".workflow-runs") });
const workbookAudit = new AuditStore({ directory: process.env.WORKBOOK_AUDIT_DIR ? path.resolve(process.env.WORKBOOK_AUDIT_DIR) : path.join(__dirname, ".workbook-audit") });
let configuredWorkbookAliases = {};
try { configuredWorkbookAliases = process.env.WORKBOOK_PATH_ALIASES ? JSON.parse(process.env.WORKBOOK_PATH_ALIASES) : {}; } catch { configuredWorkbookAliases = {}; }
if (process.env.WORKBOOK_PATH && !configuredWorkbookAliases.main) configuredWorkbookAliases.main = process.env.WORKBOOK_PATH;
const workbookService = new WorkbookService({
  runStore: workflowStore,
  pathAliases: configuredWorkbookAliases,
  allowedRoots: process.env.WORKBOOK_ALLOWED_ROOTS ? process.env.WORKBOOK_ALLOWED_ROOTS.split(path.delimiter).filter(Boolean) : [],
  audit: workbookAudit,
  aliasConfig: undefined
});
const workflowContextCache = new WorkflowContextCache();
const workflowDiagnostics = new DiagnosticsRegistry();
const workflowPlanControllers = new Map();

function registerWorkflowPlanController(runId, controller) {
  const controllers = workflowPlanControllers.get(runId) || new Set();
  controllers.add(controller);
  workflowPlanControllers.set(runId, controllers);
  return () => {
    controllers.delete(controller);
    if (!controllers.size) workflowPlanControllers.delete(runId);
  };
}

function abortWorkflowPlans(runId) {
  for (const controller of workflowPlanControllers.get(runId) || []) controller.abort();
}

const PORT = Number(process.env.PORT || 3000);
const OLLAMA_PROVIDERS = new Set(["deepseek_r1_ollama", "gpt_oss_20b_ollama"]);
const PROVIDER_ALIASES = new Map([["local_model", "deepseek_r1_ollama"]]);
const PROVIDERS = new Set(["openai_api_key", "claude_api_key", "openai_signin_codex", ...OLLAMA_PROVIDERS]);
const ACTION_TYPES = new Set(["click", "type", "submit", "extract"]);
const COLLECTION_ACTION_TYPES = new Set([
  "scroll",
  "click",
  "type",
  "wait",
  "extract",
  "readFormValues",
  "dismissAlert",
  "navigateCurrentUrl"
]);
const MAX_ACTIONS = 5;
const MAX_FILES = 5;
const MAX_FILE_CONTENT_CHARS = 12000;
const MAX_TOTAL_FILE_CHARS = 30000;
const MAX_PAGE_ELEMENTS = 360;
const MAX_PAGE_CHUNKS = 60;
const MAX_AX_FRAMES = 8;
const MAX_AX_NODES = 120;

const SUBMIT_WORDS = ["submit", "send", "post", "search", "confirm"];
const HIGH_RISK_WORDS = [
  "payment",
  "pay",
  "purchase",
  "buy now",
  "place order",
  "checkout",
  "financial transfer",
  "wire transfer",
  "transfer",
  "send money",
  "crypto",
  "wallet",
  "delete account",
  "remove account",
  "close account",
  "deactivate account",
  "delete my account",
  "destroy",
  "erase"
];
const SENSITIVE_WORDS = [
  "password",
  "passcode",
  "otp",
  "one-time",
  "one time",
  "credit card",
  "card number",
  "cvv",
  "cvc",
  "secret",
  "token",
  "pin"
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
const JSON_STRING = { type: "string" };
const JSON_NUMBER = { type: "number" };
const JSON_STRING_ARRAY = {
  type: "array",
  items: JSON_STRING
};
const AGENT_ACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["type", "selector", "text", "frameId", "shadowPath"],
  properties: {
    type: { type: "string", enum: ["click", "type", "submit", "extract"] },
    selector: JSON_STRING,
    text: JSON_STRING,
    frameId: JSON_NUMBER,
    shadowPath: JSON_STRING_ARRAY
  }
};
const COLLECTION_ACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "type",
    "selector",
    "text",
    "direction",
    "pixels",
    "ms",
    "name",
    "url",
    "description",
    "frameId",
    "shadowPath"
  ],
  properties: {
    type: { type: "string", enum: Array.from(COLLECTION_ACTION_TYPES) },
    selector: JSON_STRING,
    text: JSON_STRING,
    direction: { type: "string", enum: ["down", "up", "top", "bottom", ""] },
    pixels: JSON_NUMBER,
    ms: JSON_NUMBER,
    name: JSON_STRING,
    url: JSON_STRING,
    description: JSON_STRING,
    frameId: JSON_NUMBER,
    shadowPath: JSON_STRING_ARRAY
  }
};
const AGENT_RESPONSE_FORMAT = {
  type: "json_schema",
  name: "agent_action_plan",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["reply", "actions"],
    properties: {
      reply: JSON_STRING,
      actions: {
        type: "array",
        items: AGENT_ACTION_SCHEMA
      }
    }
  }
};
const COLLECTION_RESPONSE_FORMAT = {
  type: "json_schema",
  name: "collection_step_plan",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["reply", "done", "actions", "rows", "fields", "warnings", "nextRecordHint", "stopReason"],
    properties: {
      reply: JSON_STRING,
      done: { type: "boolean" },
      actions: {
        type: "array",
        items: COLLECTION_ACTION_SCHEMA
      },
      rows: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["cells"],
          properties: {
            cells: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["field", "value"],
                properties: {
                  field: JSON_STRING,
                  value: JSON_STRING
                }
              }
            }
          }
        }
      },
      fields: JSON_STRING_ARRAY,
      warnings: JSON_STRING_ARRAY,
      nextRecordHint: JSON_STRING,
      stopReason: JSON_STRING
    }
  }
};
const WORKFLOW_FIELD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["fieldId", "status", "value", "source", "sourceDate", "url", "snippet", "note"],
  properties: {
    fieldId: JSON_STRING,
    status: { type: "string", enum: ["found", "not_applicable", "unresolved"] },
    value: JSON_STRING,
    source: JSON_STRING,
    sourceDate: JSON_STRING,
    url: JSON_STRING,
    snippet: JSON_STRING,
    note: JSON_STRING
  }
};
const WORKFLOW_RESPONSE_FORMAT = {
  type: "json_schema",
  name: "workflow_patient_step",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["reply", "done", "phase", "action", "fields", "warnings"],
    properties: {
      reply: JSON_STRING,
      done: { type: "boolean" },
      phase: JSON_STRING,
      action: { anyOf: [COLLECTION_ACTION_SCHEMA, { type: "null" }] },
      fields: { type: "array", items: WORKFLOW_FIELD_SCHEMA },
      warnings: JSON_STRING_ARRAY
    }
  }
};

const app = express();
let codexLoginProcess = null;
const codexLoginTickets = new Map();
let codexLoginState = {
  status: "idle",
  message: "OpenAI sign-in has not started.",
  loginUrl: "",
  deviceCode: "",
  startedAt: "",
  updatedAt: ""
};

app.use(express.json({ limit: "12mb" }));

function safeText(value, max = 4000) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function safeAttachmentText(value, max = MAX_FILE_CONTENT_CHARS) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .trim()
    .slice(0, max);
}

function normalizeAttachments(files) {
  if (!Array.isArray(files)) return [];

  const normalized = [];
  let remainingChars = MAX_TOTAL_FILE_CHARS;

  for (const file of files.slice(0, MAX_FILES)) {
    if (!file || typeof file !== "object" || remainingChars <= 0) break;

    const content = safeAttachmentText(file.content, Math.min(MAX_FILE_CONTENT_CHARS, remainingChars));
    const originalLength = String(file.content || "").length;

    normalized.push({
      name: safeText(file.name || "attached-file", 180),
      type: safeText(file.type || "text/plain", 80),
      size: Number.isFinite(file.size) ? file.size : 0,
      truncated: Boolean(file.truncated || originalLength > content.length),
      content
    });

    remainingChars -= content.length;
  }

  return normalized;
}

function normalizeShadowPath(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => safeText(item, 500)).filter(Boolean).slice(0, 6);
}

function targetKey(value) {
  const action = value?.action && typeof value.action === "object" ? value.action : value || {};
  return JSON.stringify({
    frameId: Number.isFinite(action.frameId) ? action.frameId : 0,
    selector: String(action.selector || ""),
    shadowPath: normalizeShadowPath(action.shadowPath)
  });
}

function normalizePageElement(element) {
  const source = element && typeof element === "object" ? element : {};

  return {
    frameId: Number.isFinite(source.frameId) ? source.frameId : 0,
    selector: safeText(source.selector, 500),
    shadowPath: normalizeShadowPath(source.shadowPath),
    tag: safeText(source.tag, 40),
    role: safeText(source.role, 80),
    type: safeText(source.type, 80),
    text: safeText(source.text, 300),
    label: safeText(source.label, 300),
    placeholder: safeText(source.placeholder, 300),
    name: safeText(source.name, 180),
    ariaLabel: safeText(source.ariaLabel, 300),
    disabled: Boolean(source.disabled),
    sensitive: Boolean(source.sensitive)
  };
}

function normalizePageChunk(chunk) {
  const source = chunk && typeof chunk === "object" ? chunk : {};

  return {
    chunkId: safeText(source.chunkId, 80),
    frameId: Number.isFinite(source.frameId) ? source.frameId : 0,
    heading: safeText(source.heading, 180),
    source: safeText(source.source, 80),
    visibility: safeText(source.visibility, 80),
    shadowPath: normalizeShadowPath(source.shadowPath),
    text: safeAttachmentText(source.text, 2200)
  };
}

function normalizePage(page) {
  const source = page && typeof page === "object" ? page : {};
  const elements = Array.isArray(source.elements)
    ? source.elements.map(normalizePageElement).filter(element => element.selector).slice(0, MAX_PAGE_ELEMENTS)
    : [];
  const chunks = Array.isArray(source.chunks)
    ? source.chunks.map(normalizePageChunk).filter(chunk => chunk.text).slice(0, MAX_PAGE_CHUNKS)
    : [];
  const screenshot = source.screenshot && typeof source.screenshot === "object"
    ? {
      dataUrl: String(source.screenshot.dataUrl || "").slice(0, 8 * 1024 * 1024),
      mediaType: safeText(source.screenshot.mediaType || "image/jpeg", 80),
      width: Number(source.screenshot.width) || 0,
      height: Number(source.screenshot.height) || 0,
      bytes: Number(source.screenshot.bytes) || 0,
      capturedAt: safeText(source.screenshot.capturedAt, 80)
    }
    : null;
  const accessibility = source.accessibility && typeof source.accessibility === "object"
    ? {
      capturedAt: safeText(source.accessibility.capturedAt, 80),
      frames: Array.isArray(source.accessibility.frames)
        ? source.accessibility.frames.slice(0, MAX_AX_FRAMES).map(frame => ({
          frameId: safeText(frame.frameId, 120),
          url: safeText(frame.url, 1000),
          truncated: Boolean(frame.truncated),
          nodes: Array.isArray(frame.nodes)
            ? frame.nodes.slice(0, MAX_AX_NODES).map(node => ({
              role: safeText(node.role, 120),
              name: safeText(node.name, 300),
              value: safeText(node.value, 300),
              description: safeText(node.description, 300),
              ignored: Boolean(node.ignored)
            }))
            : []
        }))
        : []
    }
    : null;

  return {
    url: safeText(source.url, 1000),
    title: safeText(source.title, 300),
    timestamp: safeText(source.timestamp, 80),
    text: safeAttachmentText(source.text, 24000),
    frames: Array.isArray(source.frames) ? source.frames.slice(0, 80) : [],
    elements,
    formValues: Array.isArray(source.formValues) ? source.formValues.slice(0, 200) : [],
    chunks,
    scroll: source.scroll && typeof source.scroll === "object" ? source.scroll : {},
    warnings: Array.isArray(source.warnings) ? source.warnings.map(warning => safeText(warning, 500)).filter(Boolean).slice(0, 60) : [],
    screenshot,
    accessibility
  };
}

function containsAnyWord(value, words) {
  const text = String(value || "").toLowerCase();
  return words.some(word => text.includes(word));
}

function readRuntimeSecrets() {
  try {
    if (!fs.existsSync(RUNTIME_SECRETS_PATH)) return {};
    return JSON.parse(fs.readFileSync(RUNTIME_SECRETS_PATH, "utf8"));
  } catch (error) {
    console.warn("Could not read runtime secrets:", error.message);
    return {};
  }
}

function writeRuntimeSecrets(secrets) {
  fs.writeFileSync(RUNTIME_SECRETS_PATH, `${JSON.stringify(secrets, null, 2)}\n`, "utf8");
}

function isExtensionId(value) {
  return /^[a-p]{32}$/.test(String(value || ""));
}

function extensionOrigin(extensionId) {
  return `chrome-extension://${extensionId}`;
}

function secureEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function ensurePairingCode() {
  const current = readRuntimeSecrets();

  if (current.pairingCode) return current.pairingCode;

  const pairingCode = crypto.randomBytes(18).toString("base64url");
  writeRuntimeSecrets({ ...current, pairingCode });
  return pairingCode;
}

function requestToken(req) {
  const authorization = String(req.get("authorization") || "");
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  return bearer || String(req.query?.token || "");
}

function createCodexLoginTicket() {
  const ticket = crypto.randomBytes(24).toString("base64url");
  codexLoginTickets.set(ticket, Date.now() + 10 * 60 * 1000);
  return ticket;
}

function isValidCodexLoginTicket(req) {
  if (!req.path.startsWith("/codex-login")) return false;
  const ticket = String(req.query?.ticket || "");
  const expiresAt = codexLoginTickets.get(ticket);
  if (!expiresAt || expiresAt < Date.now()) {
    if (ticket) codexLoginTickets.delete(ticket);
    return false;
  }
  return true;
}

function isPairingRoute(req) {
  return req.path === "/pair" || req.path === "/pair/status";
}

function isPublicRoute(req) {
  return req.path === "/health" || isPairingRoute(req);
}

function localApiGuard(req, res, next) {
  const origin = String(req.get("origin") || "");
  const secrets = readRuntimeSecrets();
  const pairedOrigin = isExtensionId(secrets.pairedExtensionId)
    ? extensionOrigin(secrets.pairedExtensionId)
    : "";
  const canPair = isPairingRoute(req) && /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
  const originAllowed = !origin || origin === pairedOrigin || canPair;

  if (!originAllowed) {
    return res.status(403).json({ error: "This backend only accepts its paired extension." });
  }

  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  }

  if (req.method === "OPTIONS") return res.sendStatus(204);
  if (isPublicRoute(req)) return next();

  if (!secrets.backendToken || (!secureEqual(requestToken(req), secrets.backendToken) && !isValidCodexLoginTicket(req))) {
    return res.status(401).json({ error: "Pair this extension with the local backend first." });
  }

  return next();
}

app.use(localApiGuard);
app.use("/workbook", createWorkbookRouter({ workbookService }));

function normalizeProvider(provider) {
  if (provider && PROVIDER_ALIASES.has(provider)) return PROVIDER_ALIASES.get(provider);
  if (provider && PROVIDERS.has(provider)) return provider;
  return "openai_api_key";
}

function isRecognizedProvider(provider) {
  return Boolean(provider && (PROVIDERS.has(provider) || PROVIDER_ALIASES.has(provider)));
}

function isOllamaProvider(provider) {
  return OLLAMA_PROVIDERS.has(provider);
}

function providerSupportsScreenshot(provider) {
  return Boolean(runtimeProviderMetadata(provider).capabilities.images);
}

function screenshotOmittedWarning(provider) {
  if (provider === "openai_signin_codex") {
    return "Screenshot context is omitted for OpenAI sign-in through Codex CLI mode.";
  }

  if (isOllamaProvider(provider)) {
    return "Screenshot context is omitted for Ollama self-hosted model modes.";
  }

  return "";
}

function modelForSettings(settings) {
  return runtimeProviderMetadata(settings.provider, settings).model;
}

function resolveCodexInvocation(commandOverride) {
  const command = String(commandOverride || "").trim();
  const hasLocalCodex = fs.existsSync(LOCAL_CODEX_CLI_PATH);

  if ((!command || command === "codex") && hasLocalCodex) {
    return {
      command: process.execPath,
      baseArgs: [LOCAL_CODEX_CLI_PATH],
      label: "local @openai/codex"
    };
  }

  return {
    command: command || "codex",
    baseArgs: [],
    label: command || "codex"
  };
}

function getEffectiveSettings(requestedProvider) {
  const localSecrets = readRuntimeSecrets();
  const requested = requestedProvider ||
    localSecrets.provider ||
    process.env.RUNTIME_PROVIDER;
  const provider = normalizeProvider(
    requested
  );
  const codexInvocation = resolveCodexInvocation(localSecrets.codexCommand || process.env.CODEX_CLI_COMMAND);
  const legacyLocalModel = normalizeProvider(localSecrets.provider || process.env.RUNTIME_PROVIDER) === provider
    ? localSecrets.localModel || process.env.LOCAL_MODEL || ""
    : "";
  const deepseekR1Model = localSecrets.deepseekR1Model ||
    process.env.DEEPSEEK_R1_MODEL ||
    (provider === "deepseek_r1_ollama" ? legacyLocalModel : "") ||
    "deepseek-r1";
  const gptOss20bModel = localSecrets.gptOss20bModel ||
    process.env.GPT_OSS_20B_MODEL ||
    (provider === "gpt_oss_20b_ollama" ? legacyLocalModel : "") ||
    "gpt-oss:20b";

  return {
    provider,
    openaiApiKey: localSecrets.openaiApiKey || process.env.OPENAI_API_KEY || "",
    anthropicApiKey: localSecrets.anthropicApiKey || process.env.ANTHROPIC_API_KEY || "",
    ollamaApiKey: localSecrets.ollamaApiKey || localSecrets.localModelApiKey || process.env.OLLAMA_API_KEY || process.env.LOCAL_MODEL_API_KEY || "ollama",
    ollamaBaseUrl: localSecrets.ollamaBaseUrl || localSecrets.localModelBaseUrl || process.env.OLLAMA_BASE_URL || process.env.LOCAL_MODEL_BASE_URL || "http://localhost:11434/v1",
    openaiModel: localSecrets.openaiModel || process.env.OPENAI_MODEL || "gpt-5.5",
    anthropicModel: localSecrets.anthropicModel || process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5",
    deepseekR1Model,
    gptOss20bModel,
    ollamaModel: provider === "gpt_oss_20b_ollama" ? gptOss20bModel : deepseekR1Model,
    codexCommand: codexInvocation.command,
    codexBaseArgs: codexInvocation.baseArgs,
    codexCommandLabel: codexInvocation.label,
    codexModel: localSecrets.codexModel || process.env.CODEX_MODEL || "gpt-5.5"
  };
}

function nowIso() {
  return new Date().toISOString();
}

function workflowProfile(profileId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(String(profileId || ""))) throw new Error("Unknown workflow profile.");
  const file = path.join(__dirname, "workflows", "profiles", `${profileId}.json`);
  if (!fs.existsSync(file)) throw new Error("Unknown workflow profile.");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function providerNeedsWorkflowConsent(provider) {
  return Boolean(runtimeProviderMetadata(provider).capabilities.remoteData);
}

function workflowConsentKey(profile, settings) {
  return [profile.id, profile.version, settings.provider, modelForSettings(settings)].join("::");
}

function requireWorkflowConsent(profile, settings, saveConsent) {
  if (!providerNeedsWorkflowConsent(settings.provider)) return { key: "", saved: false };

  const key = workflowConsentKey(profile, settings);
  const secrets = readRuntimeSecrets();
  const consents = secrets.workflowConsents && typeof secrets.workflowConsents === "object"
    ? secrets.workflowConsents
    : {};

  if (consents[key]) return { key, saved: true };
  if (!saveConsent) {
    const error = new Error("Saved consent is required before this sensitive workflow can send data to a cloud provider.");
    error.statusCode = 409;
    throw error;
  }

  writeRuntimeSecrets({
    ...secrets,
    workflowConsents: {
      ...consents,
      [key]: { savedAt: nowIso(), profileId: profile.id, profileVersion: profile.version, provider: settings.provider, model: modelForSettings(settings) }
    }
  });

  return { key, saved: true };
}

function workflowRunResponse(run) {
  return {
    ...run,
    records: (run.records || []).map((record) => ({
      ...record,
      validation: validateUrolithiasisRecord(record)
    }))
  };
}

function workflowRecord(run, recordId) {
  const record = (run.records || []).find((candidate) => candidate.id === recordId);
  if (!record) {
    const error = new Error("Workflow record was not found.");
    error.statusCode = 404;
    throw error;
  }
  return record;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function publicCodexLoginState() {
  return {
    status: codexLoginState.status,
    message: codexLoginState.message,
    loginUrl: codexLoginState.loginUrl,
    deviceCode: codexLoginState.deviceCode,
    startedAt: codexLoginState.startedAt,
    updatedAt: codexLoginState.updatedAt
  };
}

function setCodexLoginState(patch) {
  codexLoginState = {
    ...codexLoginState,
    ...patch,
    updatedAt: nowIso()
  };
}

function stripAnsi(value) {
  return String(value || "").replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function extractFirstUrl(value) {
  const text = stripAnsi(value);
  const match = text.match(/https?:\/\/[^\s"'<>]+/i);

  if (!match) return "";

  return match[0].replace(/[),.;]+$/, "");
}

function extractDeviceCode(value) {
  const text = stripAnsi(value);
  const oneTimeCode = text.match(/one-time code[\s\S]*?\b([A-Z0-9]{4,}-[A-Z0-9]{4,})\b/i);
  if (oneTimeCode) return oneTimeCode[1].toUpperCase();

  const standalone = text.match(/\b([A-Z0-9]{4,}-[A-Z0-9]{4,})\b/);
  return standalone ? standalone[1].toUpperCase() : "";
}

function updateCodexLoginFromOutput(chunk) {
  const output = String(chunk || "");
  const loginUrl = extractFirstUrl(output);
  const deviceCode = extractDeviceCode(output);

  if (loginUrl || deviceCode) {
    setCodexLoginState({
      status: "waiting",
      loginUrl: loginUrl || codexLoginState.loginUrl,
      deviceCode: deviceCode || codexLoginState.deviceCode,
      message: "Open the OpenAI sign-in tab, complete login, then return here."
    });
    return;
  }

  if (codexLoginState.status === "starting") {
    setCodexLoginState({
      status: "waiting",
      message: "Codex login is running. Complete the browser sign-in when it opens."
    });
  }
}

function startCodexLogin(settings) {
  if (codexLoginProcess && !codexLoginProcess.killed && codexLoginState.status !== "complete") {
    return publicCodexLoginState();
  }

  const startedAt = nowIso();
  setCodexLoginState({
    status: "starting",
    message: "Starting Codex OpenAI sign-in...",
    loginUrl: "",
    deviceCode: "",
    startedAt
  });

  const child = spawn(settings.codexCommand, [...settings.codexBaseArgs, "login", "--device-auth"], {
    cwd: __dirname,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

  codexLoginProcess = child;

  child.stdout.on("data", chunk => updateCodexLoginFromOutput(chunk));
  child.stderr.on("data", chunk => updateCodexLoginFromOutput(chunk));

  child.on("error", error => {
    setCodexLoginState({
      status: "failed",
      message: `Could not start Codex CLI login. ${error.message}`
    });
    codexLoginProcess = null;
  });

  child.on("exit", (code, signal) => {
    if (code === 0) {
      setCodexLoginState({
        status: "complete",
        message: "OpenAI sign-in completed through Codex CLI."
      });
    } else {
      setCodexLoginState({
        status: "failed",
        message: `Codex login exited before confirmation. Exit code: ${code ?? "none"}, signal: ${signal ?? "none"}.`
      });
    }

    codexLoginProcess = null;
  });

  return publicCodexLoginState();
}

async function verifyCodexSignin(settings) {
  try {
    await execFileAsync(
      settings.codexCommand,
      [
        ...settings.codexBaseArgs,
        "login",
        "status"
      ],
      {
        timeout: 30000,
        maxBuffer: 1024 * 1024
      }
    );

    setCodexLoginState({
      status: "complete",
      message: "OpenAI sign-in confirmed. Codex CLI can run with the current account."
    });

    return publicCodexLoginState();
  } catch (error) {
    throw new Error(
      `OpenAI sign-in is not confirmed yet. Complete the browser flow or run codex login locally. Details: ${error.message}`
    );
  }
}

function taskExplicitlyAllowsSubmit(task) {
  return containsAnyWord(task, SUBMIT_WORDS);
}

function taskIsHighRisk(task) {
  return containsAnyWord(task, HIGH_RISK_WORDS);
}

function elementLooksSensitive(element) {
  if (!element || typeof element !== "object") return false;
  if (element.sensitive) return true;

  const text = [
    element.selector,
    element.tag,
    element.role,
    element.type,
    element.text,
    element.label,
    element.placeholder,
    element.name,
    element.ariaLabel
  ].join(" ");

  return containsAnyWord(text, SENSITIVE_WORDS);
}

function actionLooksHighRisk(action, element) {
  const text = [
    action?.type,
    action?.selector,
    action?.text,
    element?.text,
    element?.label,
    element?.placeholder,
    element?.name,
    element?.ariaLabel
  ].join(" ");

  return containsAnyWord(text, HIGH_RISK_WORDS);
}

function actionLooksWriteLike(action, element) {
  const text = [
    action?.type,
    action?.selector,
    action?.text,
    action?.description,
    element?.text,
    element?.label,
    element?.placeholder,
    element?.name,
    element?.ariaLabel
  ].join(" ");

  return containsAnyWord(text, WRITE_ACTION_WORDS);
}

function classifyActionRisk(action, element, { allowSubmit = false, collection = false } = {}) {
  const reasons = [];

  if (!ACTION_TYPES.has(String(action?.type || "")) && !COLLECTION_ACTION_TYPES.has(String(action?.type || ""))) {
    return { riskLabel: "blocked", riskReasons: ["Unsupported action type."] };
  }

  if (element?.disabled) {
    reasons.push("Target element is disabled.");
  }

  if ((action?.type === "type" || action?.type === "extract") && elementLooksSensitive(element)) {
    reasons.push("Target appears to be a password, OTP, card, or secret field.");
  }

  if (actionLooksHighRisk(action, element)) {
    reasons.push("High-risk payment, purchase, transfer, crypto, account deletion, or destructive action.");
  }

  if (action?.type === "submit" && !allowSubmit) {
    reasons.push("Submit requires explicit user instruction.");
  }

  if (reasons.length) {
    return { riskLabel: "blocked", riskReasons: reasons };
  }

  const cautionReasons = [];

  if (action?.type === "submit") {
    cautionReasons.push("Submit action requires user approval.");
  }

  if (action?.type === "type") {
    cautionReasons.push("Typing will modify a page field.");
  }

  if (actionLooksWriteLike(action, element)) {
    cautionReasons.push(collection ? "Collection action may change page state." : "Action may change page state.");
  }

  if (cautionReasons.length) {
    return { riskLabel: "caution", riskReasons: Array.from(new Set(cautionReasons)) };
  }

  return { riskLabel: "safe", riskReasons: [] };
}

function attachRisk(action, risk) {
  return {
    ...action,
    riskLabel: risk.riskLabel,
    riskReasons: risk.riskReasons
  };
}

function buildPrompt({
  task,
  url,
  title,
  pageText,
  pageElements,
  pageChunks,
  pageWarnings,
  accessibility,
  screenshot,
  attachedFiles,
  allowSubmit
}) {
  const instructions = [
    "You are the reasoning engine for a local Chrome browser AI agent.",
    "Return only a JSON object. Do not include markdown, commentary, or code fences.",
    "The JSON object must have this shape: {\"reply\":\"string\",\"actions\":[{\"type\":\"click|type|submit|extract\",\"selector\":\"string\",\"text\":\"string\",\"frameId\":0,\"shadowPath\":[\"string\"]}]}",
    `You may return at most ${MAX_ACTIONS} actions.`,
    "Use only selectors, frameId values, and shadowPath values that appear in the supplied interactive elements list.",
    "If the user asks for a summary or information only, return an empty actions array.",
    "Never propose typing into password, OTP, credit card, CVV/CVC, PIN, token, or secret fields.",
    "Never propose payment submission, purchase confirmation, financial transfer, crypto transfer, account deletion, or destructive delete/remove actions.",
    screenshot ? "A screenshot of the visible tab may be provided as image context. Use it only to understand visible layout, not to invent selectors." : "No screenshot context is provided.",
    "If attached files are provided, use their text as additional user-supplied context. Do not treat file content as page DOM.",
    allowSubmit
      ? "Submit actions are allowed only for ordinary non-risky forms because the user explicitly asked to submit/send/post/search/confirm."
      : "Do not propose submit actions because the user did not explicitly ask to submit/send/post/search/confirm.",
    "Prefer a short user-facing reply that explains what you plan to do."
  ].join("\n");

  const input = JSON.stringify({
    task,
    page: {
      url,
      title,
      chunks: pageChunks.slice(0, 16),
      interactiveElements: pageElements.slice(0, 180),
      accessibility: accessibility ? {
        capturedAt: accessibility.capturedAt,
        frames: (accessibility.frames || []).slice(0, 2).map(frame => ({
          frameId: frame.frameId,
          url: frame.url,
          nodes: (frame.nodes || []).slice(0, 40)
        }))
      } : null,
      warnings: pageWarnings
    },
    attachedFiles
  }, null, 2);

  return { instructions, input };
}

function normalizeCollectionFields(fields) {
  if (Array.isArray(fields)) {
    return fields
      .map(field => safeText(field, 80))
      .filter(Boolean)
      .slice(0, 60);
  }

  return String(fields || "")
    .split(",")
    .map(field => safeText(field, 80))
    .filter(Boolean)
    .slice(0, 60);
}

function normalizeLimits(limits) {
  const source = limits && typeof limits === "object" ? limits : {};

  return {
    maxSteps: Math.min(Math.max(Number(source.maxSteps) || 250, 1), 2000),
    maxRows: Math.min(Math.max(Number(source.maxRows) || 500, 1), 10000),
    maxVisitedUrls: Math.min(Math.max(Number(source.maxVisitedUrls) || 100, 1), 2000),
    maxNoProgressSteps: Math.min(Math.max(Number(source.maxNoProgressSteps) || 10, 1), 200),
    maxRuntimeMinutes: Math.min(Math.max(Number(source.maxRuntimeMinutes) || 30, 1), 240)
  };
}

function normalizeCollectionRows(rows, page) {
  if (!Array.isArray(rows)) return [];

  return rows.slice(0, 50).map(row => {
    const output = {};
    const source = row && typeof row === "object" ? row : {};

    for (const [key, value] of Object.entries(source)) {
      const cleanKey = safeText(key, 120);
      if (!cleanKey) continue;

      if (Array.isArray(value)) {
        output[cleanKey] = value.map(item => safeText(item, 500)).join("; ");
      } else if (value && typeof value === "object") {
        output[cleanKey] = safeText(JSON.stringify(value), 1000);
      } else {
        output[cleanKey] = value === null || value === undefined ? "" : safeText(value, 1000);
      }
    }

    output.sourceUrl = output.sourceUrl || safeText(page?.url, 1000);
    output.sourceTitle = output.sourceTitle || safeText(page?.title, 300);
    output.capturedAt = output.capturedAt || new Date().toISOString();
    output.confidence = output.confidence || "";
    output.notes = output.notes || "";
    output.unresolvedFields = output.unresolvedFields || "";

    return output;
  });
}

function collectionRowsFromModel(rows) {
  if (!Array.isArray(rows)) return [];

  return rows.map(row => {
    if (Array.isArray(row?.cells)) {
      const output = {};

      for (const cell of row.cells) {
        const field = safeText(cell?.field, 120);
        if (!field) continue;
        output[field] = cell?.value === null || cell?.value === undefined
          ? ""
          : safeText(cell.value, 1000);
      }

      return output;
    }

    return row;
  });
}

function validateCollectionActions(actions, page) {
  const validActions = [];
  const blockedActions = [];
  const pageElements = Array.isArray(page?.elements) ? page.elements : [];
  const elementsBySelector = new Map();

  for (const element of pageElements) {
    if (element?.selector) {
      elementsBySelector.set(targetKey(element), element);
    }
  }

  const proposedActions = Array.isArray(actions) ? actions.slice(0, MAX_ACTIONS) : [];

  if (Array.isArray(actions) && actions.length > MAX_ACTIONS) {
    blockedActions.push({
      reason: `Action batch exceeds the ${MAX_ACTIONS} action limit.`,
      count: actions.length
    });
  }

  for (const action of proposedActions) {
    if (!action || typeof action !== "object") {
      blockedActions.push({ action, reason: "Action must be an object." });
      continue;
    }

    const type = String(action.type || "");

    if (!COLLECTION_ACTION_TYPES.has(type)) {
      blockedActions.push({ action, reason: "Unsupported collection action type." });
      continue;
    }

    if (type === "scroll") {
      validActions.push(attachRisk({
        type,
        direction: ["up", "down", "top", "bottom"].includes(action.direction) ? action.direction : "down",
        pixels: Math.min(Math.max(Number(action.pixels) || 900, 100), 3000)
      }, { riskLabel: "safe", riskReasons: [] }));
      continue;
    }

    if (type === "wait") {
      validActions.push(attachRisk({ type, ms: Math.min(Math.max(Number(action.ms) || 1000, 250), 10000) }, { riskLabel: "safe", riskReasons: [] }));
      continue;
    }

    if (type === "extract" || type === "readFormValues") {
      validActions.push(attachRisk({ type }, { riskLabel: "safe", riskReasons: [] }));
      continue;
    }

    if (type === "dismissAlert") {
      validActions.push(attachRisk({
        type,
        frameId: Number.isFinite(action.frameId) ? action.frameId : 0
      }, { riskLabel: "safe", riskReasons: ["Dismisses a native alert only; confirmation dialogs remain manual."] }));
      continue;
    }

    if (type === "navigateCurrentUrl") {
      const url = typeof action.url === "string" ? safeText(action.url, 1000) : "";
      validActions.push(attachRisk(url ? { type, url } : { type }, { riskLabel: "safe", riskReasons: [] }));
      continue;
    }

    const selector = String(action.selector || "");
    const frameId = Number.isFinite(action.frameId) ? action.frameId : 0;
    const shadowPath = normalizeShadowPath(action.shadowPath);
    const normalizedTarget = {
      type,
      selector,
      frameId,
      shadowPath,
      text: typeof action.text === "string" ? action.text : "",
      description: typeof action.description === "string" ? action.description : ""
    };
    const element = elementsBySelector.get(targetKey(normalizedTarget));

    if (!selector || selector.length > 500) {
      blockedActions.push({ action: attachRisk(normalizedTarget, { riskLabel: "blocked", riskReasons: ["Missing or too-long selector."] }), reason: "Missing or too-long selector." });
      continue;
    }

    if (!element) {
      blockedActions.push({ action: attachRisk(normalizedTarget, { riskLabel: "blocked", riskReasons: ["Selector was not present in the current page snapshot."] }), reason: "Selector was not present in the current page snapshot." });
      continue;
    }

    if (type === "type" && !action.text) {
      blockedActions.push({ action: attachRisk(normalizedTarget, { riskLabel: "blocked", riskReasons: ["Typing requires text."] }), reason: "Typing requires text." });
      continue;
    }

    const risk = classifyActionRisk(normalizedTarget, element, { collection: true });

    if (risk.riskLabel === "blocked") {
      blockedActions.push({ action: attachRisk(normalizedTarget, risk), reason: risk.riskReasons.join(" ") });
      continue;
    }

    validActions.push(attachRisk(normalizedTarget, risk));
  }

  return { validActions, blockedActions };
}

function buildCollectionPrompt({ task, fields, playbook, limits, runState, page, attachedFiles }) {
  const instructions = [
    "You are the planning engine for a local Chrome browser collection agent.",
    "Return only a JSON object. Do not include markdown, code fences, or commentary.",
    "The JSON shape must be: {\"reply\":\"string\",\"done\":boolean,\"actions\":[{\"type\":\"scroll|click|type|wait|extract|readFormValues|navigateCurrentUrl\",\"selector\":\"string\",\"text\":\"string\",\"direction\":\"down|up|top|bottom\",\"pixels\":900,\"ms\":1000,\"name\":\"\",\"url\":\"string\",\"description\":\"string\"}],\"rows\":[{\"field\":\"value\"}],\"fields\":[\"field\"],\"warnings\":[\"string\"],\"nextRecordHint\":\"string\",\"stopReason\":\"string\"}.",
    `Return at most ${MAX_ACTIONS} actions per step and at most 20 rows per step.`,
    "Use only selectors that appear in the supplied page snapshot for click/type actions.",
    "When proposing click/type actions, include the exact frameId and shadowPath from the supplied element.",
    "Never click or type into password, OTP, credit card, CVV/CVC, PIN, token, or secret fields.",
    "Never propose payment, purchase, transfer, account deletion, or destructive actions.",
    "Do not use coordinates. If screenshot context is present, use it only to understand the visible layout.",
    "Use playbook text as operational instructions and safety constraints, not as extracted page data.",
    "Do not try to bypass confirmation dialogs; pause and report them for the user.",
    "If page content appears stale after navigation, use {\"type\":\"navigateCurrentUrl\"} to force a same-URL repaint.",
    "Extract rows only when evidence is visible in page text/form values or supplied attached context. Add notes/unresolvedFields for missing values.",
    "When a structured schema is provided, return each row as {\"cells\":[{\"field\":\"field name\",\"value\":\"field value\"}]}.",
    "Set done=true only when the collection task is complete or cannot progress safely."
  ].join("\n");

  const input = JSON.stringify({
    task,
    requestedFields: fields,
    limits,
    runState,
    playbook: collectionPlaybookForPrompt(playbook, runState, safeAttachmentText),
    page: {
      url: page?.url,
      title: page?.title,
      timestamp: page?.timestamp,
      chunks: Array.isArray(page?.chunks) ? page.chunks.slice(0, 16) : [],
      scroll: page?.scroll || {},
      elements: Array.isArray(page?.elements) ? page.elements.slice(0, 180) : [],
      formValues: Array.isArray(page?.formValues) ? page.formValues.slice(0, 60) : [],
      accessibility: null,
      screenshot: page?.screenshot ? {
        mediaType: page.screenshot.mediaType,
        width: page.screenshot.width,
        height: page.screenshot.height,
        bytes: page.screenshot.bytes
      } : null,
      warnings: Array.isArray(page?.warnings) ? page.warnings : []
    },
    attachedFiles
  }, null, 2);

  return { instructions, input };
}

function redactWorkflowText(value, record) {
  let text = String(value || "");
  if (record?.mrn) text = text.replaceAll(record.mrn, "[REDACTED_MRN]");
  text = text
    .replace(/\b(?:MRN|URN|medical record number)\s*[:#-]?\s*[A-Za-z0-9-]+/gi, "[REDACTED_MRN]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(/\b(?:\+?\d[\d\s().-]{7,}\d)\b/g, "[REDACTED_PHONE]")
    .replace(/\b(?:patient name|name|date of birth|dob)\s*:\s*[^\n]{1,100}/gi, match => `${match.split(":")[0]}: [REDACTED]`);
  return text;
}

function cloudSafeWorkflowPage(page, record, redactIdentifiers) {
  if (!redactIdentifiers) return page;
  return {
    ...page,
    url: redactWorkflowText(page.url, record),
    title: redactWorkflowText(page.title, record),
    chunks: (page.chunks || []).map(chunk => ({ ...chunk, text: redactWorkflowText(chunk.text, record) })),
    formValues: (page.formValues || [])
      .filter(value => !/(?:mrn|urn|patient name|date of birth|dob)/i.test([value.label, value.name, value.placeholder].join(" ")))
      .map(value => ({ ...value, value: redactWorkflowText(value.value, record) })),
    elements: (page.elements || []).map(element => ({
      ...element,
      text: redactWorkflowText(element.text, record),
      label: redactWorkflowText(element.label, record),
      placeholder: redactWorkflowText(element.placeholder, record),
      ariaLabel: redactWorkflowText(element.ariaLabel, record)
    }))
  };
}

function buildWorkflowPrompt({ profile, record, page, redactIdentifiers = false }) {
  const adapter = workflowAdapterFor(profile);
  const phaseFieldIds = adapter.phaseFieldIds(profile, record.phase, Object.keys(UROLITHIASIS_FIELD_SCHEMA));
  const instructions = [
    "You are the planning and evidence-extraction engine for a read-only browser workflow.",
    "Return only the required JSON object.",
    "Use only selectors, frame IDs, and shadow paths from the supplied page controls.",
    "The current workflow is sensitive: do not request screenshots, passwords, secrets, write controls, Save, Update, Submit, or destructive actions.",
    "Only emit a field when direct visible evidence supports it. Include a concise evidence snippet and source name for every found field.",
    "Use ISO dates (YYYY-MM-DD), booleans as 0 or 1, and N/A only when the workflow rule explicitly permits it.",
    "When searching for the patient, use the literal text {{MRN}} rather than requesting or reproducing the patient identifier.",
    "Do not infer missing values. When the patient workflow is done, emit an unresolved entry with a concrete reason for every allowed field still lacking evidence.",
    "Return exactly one browser action in action, or null. After navigation, wait for the next observation instead of batching follow-up clicks.",
    `Adapter guidance for this phase: ${adapter.phaseInstruction(profile, record.phase)}`,
    `Allowed phases: ${profile.phases.join(", ")}.`,
    `Field IDs relevant to this phase: ${phaseFieldIds.join(", ")}.`
  ].join("\n");

  const safePage = cloudSafeWorkflowPage(page, record, redactIdentifiers);
  const knownFields = Object.fromEntries(Object.entries(record.fields || {}).filter(([fieldId]) => phaseFieldIds.includes(fieldId)).map(([fieldId, field]) => [fieldId, {
    status: field?.status || "missing",
    ...(field?.value !== undefined && field?.value !== "" ? { value: field.value } : {})
  }]));
  const input = JSON.stringify({
    profile: { id: profile.id, version: profile.version, phase: record.phase, mode: profile.mode },
    patient: { recordId: record.id, surgeryDate: record.surgeryDate },
    knownFields,
    page: {
      contextMode: safePage.contextMode || "full",
      url: safePage.url,
      title: safePage.title,
      chunks: (safePage.chunks || []).slice(0, 8),
      elements: (safePage.elements || []).slice(0, 80),
      formValues: (safePage.formValues || []).slice(0, 24),
      warnings: safePage.warnings || []
    }
  }, null, 2);

  assertPromptByteBudget(input);

  return { instructions, input };
}

function workflowTypedValue(field, definition) {
  if (field.status === "not_applicable") return "N/A";
  const raw = String(field.value || "").trim();
  if (definition.type === "boolean") {
    if (raw === "0" || raw.toLowerCase() === "no") return 0;
    if (raw === "1" || raw.toLowerCase() === "yes") return 1;
    throw new Error(`${field.fieldId} must be 0 or 1.`);
  }
  if (definition.type === "number") {
    const number = Number(raw);
    if (!Number.isFinite(number)) throw new Error(`${field.fieldId} must be numeric.`);
    return number;
  }
  return raw;
}

function applyWorkflowFieldUpdates(record, fields, allowedFieldIds = Object.keys(UROLITHIASIS_FIELD_SCHEMA)) {
  const updates = [];
  const allowed = new Set(allowedFieldIds);

  for (const field of fields || []) {
    const fieldId = String(field?.fieldId || "");
    const definition = UROLITHIASIS_FIELD_SCHEMA[fieldId];
    if (!definition) throw new Error(`Unknown or disallowed field: ${fieldId || "(empty)"}.`);
    assertPhaseFieldAllowed(fieldId, record.phase, allowed);
    if (field.status === "unresolved") {
      const note = safeText(field.note || "No direct evidence was found.", 500);
      setRecordField(record, fieldId, {
        status: "unresolved",
        type: definition.type,
        evidence: [],
        note
      });
      record.warnings = [...(record.warnings || []), `${fieldId}: ${note}`];
      updates.push(fieldId);
      continue;
    }

    const evidence = field.source && field.snippet
      ? [{
        source: safeText(field.source, 180),
        ...(field.sourceDate ? { sourceDate: safeText(field.sourceDate, 10) } : {}),
        ...(field.url ? { url: safeText(field.url, 1000) } : {}),
        snippet: safeText(field.snippet, 1000)
      }]
      : [];

    if (field.status === "found" && !evidence.length) {
      throw new Error(`${fieldId} needs source evidence before it can be accepted.`);
    }

    setRecordField(record, fieldId, {
      status: field.status,
      value: workflowTypedValue(field, definition),
      type: definition.type,
      evidence,
      note: safeText(field.note, 500)
    });
    updates.push(fieldId);
  }

  return updates;
}

function extractJson(raw) {
  const text = stripReasoningTags(raw);
  if (!text) return null;

  const withoutFence = text
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

  const candidates = [
    withoutFence,
    withoutFence.slice(withoutFence.indexOf("{"), withoutFence.lastIndexOf("}") + 1)
  ].filter(candidate => candidate && candidate.startsWith("{") && candidate.endsWith("}"));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      // Try the next candidate.
    }
  }

  return null;
}

function validateActions(actions, pageElements, { allowSubmit }) {
  const validActions = [];
  const blockedActions = [];
  const elementsBySelector = new Map();

  for (const element of pageElements) {
    if (element?.selector) {
      elementsBySelector.set(targetKey(element), element);
    }
  }

  const proposedActions = Array.isArray(actions) ? actions.slice(0, MAX_ACTIONS) : [];

  if (Array.isArray(actions) && actions.length > MAX_ACTIONS) {
    blockedActions.push({
      reason: `Action batch exceeds the ${MAX_ACTIONS} action MVP limit.`,
      count: actions.length
    });
  }

  for (const action of proposedActions) {
    if (!action || typeof action !== "object") {
      blockedActions.push({ action, reason: "Action must be an object." });
      continue;
    }

    const type = String(action.type || "");
    const selector = String(action.selector || "");
    const text = typeof action.text === "string" ? action.text : "";
    const frameId = Number.isFinite(action.frameId) ? action.frameId : 0;
    const shadowPath = normalizeShadowPath(action.shadowPath);
    const normalized = { type, selector, text, frameId, shadowPath };

    if (!ACTION_TYPES.has(type)) {
      blockedActions.push({ action, reason: "Unsupported action type." });
      continue;
    }

    if (!selector || selector.length > 500) {
      blockedActions.push({ action: attachRisk(normalized, { riskLabel: "blocked", riskReasons: ["Missing or too-long selector."] }), reason: "Missing or too-long selector." });
      continue;
    }

    const element = elementsBySelector.get(targetKey(normalized));

    if (!element) {
      blockedActions.push({ action: attachRisk(normalized, { riskLabel: "blocked", riskReasons: ["Selector was not present in the current page context."] }), reason: "Selector was not present in the current page context." });
      continue;
    }

    if (type === "type" && !text) {
      blockedActions.push({ action: attachRisk(normalized, { riskLabel: "blocked", riskReasons: ["Type action is missing text."] }), reason: "Type action is missing text." });
      continue;
    }

    const risk = classifyActionRisk(normalized, element, { allowSubmit });

    if (risk.riskLabel === "blocked") {
      blockedActions.push({ action: attachRisk(normalized, risk), reason: risk.riskReasons.join(" ") });
      continue;
    }

    validActions.push(attachRisk(normalized, risk));
  }

  return { validActions, blockedActions };
}

function stripReasoningTags(value) {
  return String(value || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<\|begin_of_thought\|>[\s\S]*?<\|end_of_thought\|>/gi, "")
    .trim();
}

async function callOpenAISigninCodex({ instructions, input, settings, signal }) {
  const prompt = `${instructions}\n\n${input}\n\nReturn only the JSON object. No markdown.`.slice(0, 30000);
  const outputPath = path.join(__dirname, `.codex-last-message-${process.pid}-${Date.now()}.txt`);

  try {
    const { stdout } = await runCodexExec({ settings, prompt, outputPath, signal });

    if (fs.existsSync(outputPath)) {
      return fs.readFileSync(outputPath, "utf8");
    }

    return stdout || "";
  } catch (error) {
    throw new Error(
      `OpenAI sign-in mode failed. Make sure Codex CLI is installed and signed in with ChatGPT. Details: ${error.message}`
    );
  } finally {
    fs.rmSync(outputPath, { force: true });
  }
}

async function callSelectedProviderJson({ provider, instructions, input, settings, screenshot, signal, responseFormat }) {
  const driver = createRuntimeProviderDriver(provider, settings, {
    codexExecutor: ({ prompt, signal: executionSignal }) => callOpenAISigninCodex({
      instructions: "",
      input: prompt,
      settings,
      signal: executionSignal
    })
  });
  const result = await driver.generateJson({
    instructions,
    input,
    screenshot,
    signal,
    schema: responseFormat?.schema,
    schemaName: responseFormat?.name
  });
  return { ...result, raw: result.raw || JSON.stringify(result.output), warnings: result.warnings || [] };
}

function sendSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data || {})}\n\n`);
}

function runCodexExec({ settings, prompt, outputPath, signal }) {
  return new Promise((resolve, reject) => {
    const args = [
      ...settings.codexBaseArgs,
      "exec",
      "--sandbox",
      "read-only",
      "--model",
      settings.codexModel,
      "--color",
      "never",
      "--output-last-message",
      outputPath,
      "-"
    ];
    const child = spawn(settings.codexCommand, args, {
      cwd: __dirname,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error("Codex exec timed out after 120 seconds."));
    }, 120000);
    const abortHandler = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      reject(new Error("Request aborted."));
    };

    if (signal?.aborted) {
      abortHandler();
      return;
    }

    signal?.addEventListener?.("abort", abortHandler, { once: true });

    child.stdout.on("data", chunk => {
      stdout += String(chunk);
      if (stdout.length > 1024 * 1024 * 4) {
        stdout = stdout.slice(-1024 * 1024 * 4);
      }
    });

    child.stderr.on("data", chunk => {
      stderr += String(chunk);
      if (stderr.length > 1024 * 1024 * 2) {
        stderr = stderr.slice(-1024 * 1024 * 2);
      }
    });

    child.on("error", error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", abortHandler);
      reject(error);
    });

    child.on("exit", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", abortHandler);

      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(`Codex exec exited with code ${code}. ${stderr || stdout}`.trim()));
    });

    child.stdin.end(prompt);
  });
}

async function buildAgentFinalResponse({ body, signal }) {
  const requestCorrelationId = correlationId();
  const { task, provider: requestedProvider, url, title, page: rawPage, files } = body || {};

  if (!task || !rawPage) {
    const error = new Error("Missing task or page context.");
    error.statusCode = 400;
    throw error;
  }

  const settings = getEffectiveSettings(requestedProvider);
  const allowSubmit = taskExplicitlyAllowsSubmit(task);
  const page = normalizePage(rawPage);
  const attachedFiles = normalizeAttachments(files);
  const warnings = [...page.warnings];
  const modelScreenshot = providerSupportsScreenshot(settings.provider) ? page.screenshot : null;
  const omittedScreenshotWarning = screenshotOmittedWarning(settings.provider);

  if (!modelScreenshot && page.screenshot && omittedScreenshotWarning) {
    warnings.push(omittedScreenshotWarning);
  }

  if (taskIsHighRisk(task)) {
    return {
      reply: "This request appears to involve payment, purchase, financial transfer, crypto, account deletion, or another irreversible action. I can explain what to do, but I will not perform that action automatically.",
      actions: [],
      blockedActions: [],
      warnings,
      provider: settings.provider,
      allowSubmit
    };
  }

  const { instructions, input } = buildPrompt({
    task,
    url: url || page.url,
    title: title || page.title,
    pageText: page.text,
    pageElements: page.elements,
    pageChunks: page.chunks,
    pageWarnings: page.warnings,
    accessibility: page.accessibility,
    screenshot: modelScreenshot,
    attachedFiles,
    allowSubmit
  });

  workflowDiagnostics.record("agent_general", {
    correlationId: requestCorrelationId,
    eventType: "provider_request",
    result: "started",
    provider: settings.provider,
    model: modelForSettings(settings),
    contextBytes: Buffer.byteLength(input, "utf8")
  });

  let providerResult;
  try {
    providerResult = await callSelectedProviderJson({
      provider: settings.provider,
      instructions,
      input,
      settings,
      screenshot: modelScreenshot,
      signal,
      responseFormat: AGENT_RESPONSE_FORMAT
    });
  } catch (error) {
    workflowDiagnostics.record("agent_general", {
      correlationId: requestCorrelationId,
      eventType: "provider_error",
      result: signal?.aborted ? "stopped" : "failed",
      provider: settings.provider,
      model: modelForSettings(settings),
      contextBytes: Buffer.byteLength(input, "utf8")
    });
    throw error;
  }
  const raw = providerResult.raw;
  warnings.push(...providerResult.warnings);
  workflowDiagnostics.record("agent_general", {
    correlationId: requestCorrelationId,
    eventType: "provider_response",
    result: "succeeded",
    provider: settings.provider,
    model: providerResult.model,
    providerRequestId: providerResult.requestId,
    latencyMs: providerResult.latencyMs,
    inputTokens: providerResult.usage?.inputTokens,
    outputTokens: providerResult.usage?.outputTokens,
    contextBytes: Buffer.byteLength(input, "utf8")
  });

  const parsed = providerResult.output && typeof providerResult.output === "object" ? providerResult.output : extractJson(raw);

  if (!parsed) {
    return {
      reply: raw || "The model returned an empty response.",
      actions: [],
      blockedActions: [],
      warnings: [...warnings, "Model did not return valid action JSON."],
      provider: settings.provider,
      allowSubmit
    };
  }

  const { validActions, blockedActions } = validateActions(parsed.actions, page.elements, { allowSubmit });

  return {
    reply: typeof parsed.reply === "string" ? parsed.reply : "",
    actions: validActions,
    blockedActions,
    warnings,
    provider: settings.provider,
    allowSubmit
  };
}

app.get("/pair/status", (req, res) => {
  const secrets = readRuntimeSecrets();
  res.json({ paired: Boolean(secrets.backendToken && secrets.pairedExtensionId) });
});

app.post("/pair", (req, res) => {
  const extensionId = String(req.body?.extensionId || "");
  const pairingCode = String(req.body?.pairingCode || "");
  const origin = String(req.get("origin") || "");
  const secrets = readRuntimeSecrets();

  if (!isExtensionId(extensionId) || origin !== extensionOrigin(extensionId)) {
    return res.status(400).json({ error: "Pairing must come from a Chrome extension." });
  }

  if (secrets.pairedExtensionId && secrets.pairedExtensionId !== extensionId) {
    return res.status(409).json({ error: "This backend is already paired with another extension." });
  }

  if (!secureEqual(pairingCode, ensurePairingCode())) {
    return res.status(401).json({ error: "The pairing code is not valid." });
  }

  const backendToken = secrets.backendToken || crypto.randomBytes(32).toString("base64url");
  writeRuntimeSecrets({
    ...readRuntimeSecrets(),
    pairedExtensionId: extensionId,
    backendToken,
    pairedAt: nowIso()
  });

  return res.json({ ok: true, backendToken });
});

function saveRecordAudit(record, type, detail = {}) {
  record.audit = [...(record.audit || []), { at: nowIso(), type, ...detail }];
  record.updatedAt = nowIso();
}

function workflowRunPayload(run) {
  const profile = workflowProfile(run.profileId);
  return {
    ...run,
    workflowPolicy: publicWorkflowPolicy(profile),
    records: (run.records || []).map(record => ({
      ...record,
      validation: run.profileId === UROLITHIASIS_PROFILE_ID ? assessUrolithiasisReview(record) : { valid: false, reviewReady: false, errors: [] }
    }))
  };
}

app.get("/workflow-profiles", (req, res) => {
  const directory = path.join(__dirname, "workflows", "profiles");
  const profiles = fs.readdirSync(directory)
    .filter(name => name.endsWith(".json"))
    .map(name => workflowProfile(name.slice(0, -5)));
  res.json({ profiles });
});

app.post("/workflow-runs", async (req, res) => {
  try {
    const profile = workflowProfile(String(req.body?.profileId || UROLITHIASIS_PROFILE_ID));
    const settings = getEffectiveSettings(req.body?.provider);
    const consent = requireWorkflowConsent(profile, settings, Boolean(req.body?.saveCloudConsent));
    let queueInput = req.body?.queue;
    let workbookMeta = {};
    if (req.body?.workbookId) {
      const workbookQueue = await workbookService.patients({ workbookId: req.body.workbookId });
      // Convert workbook rows into the strict queue format (MRN/date), then
      // restore workbook identity metadata without passing objects to the
      // string-only queue parser.
      const queueLines = workbookQueue.patients.map(p => `${String(p.mrn).trim()},${String(p.surgeryDate).trim()}`).join("\n");
      const strictQueue = assertValidPatientQueue(queueLines);
      queueInput = strictQueue.map((item, i) => ({ ...item, patientNumber: workbookQueue.patients[i].patientNumber, row: workbookQueue.patients[i].row }));
      workbookMeta = { workbookId: req.body.workbookId, workbookFileHash: workbookQueue.fileHash, workbookBound: true };
    }
    // Workbook-derived queues are already strictly validated and carry row
    // identity metadata; the textual queue parser intentionally accepts only
    // pasted strings, so do not stringify these objects a second time.
    const queue = req.body?.workbookId ? queueInput : assertValidPatientQueue(queueInput);
    const records = queue.map(item => createWorkflowRecord(item));
    const run = await workflowStore.create({
      profileId: profile.id,
      profileVersion: profile.version,
      records,
      metadata: {
        provider: settings.provider,
        model: modelForSettings(settings),
        cloudConsentKey: consent.key,
        cloudConsentSaved: consent.saved,
        dataClassification: profile.dataClassification,
        ...workbookMeta
      }
    });
    res.status(201).json(workflowRunPayload(run));
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message || "Could not create workflow run." });
  }
});

app.get("/workflow-runs", async (req, res) => {
  const runs = await workflowStore.list();
  res.json({
    runs: runs.map(run => ({
      id: run.id,
      profileId: run.profileId,
      status: run.status,
      updatedAt: run.updatedAt,
      recordCount: (run.records || []).length
    }))
  });
});

app.get("/workflow-runs/:runId", async (req, res) => {
  try {
    res.json(workflowRunPayload(await workflowStore.load(req.params.runId)));
  } catch (error) {
    res.status(404).json({ error: "Workflow run was not found." });
  }
});

app.post("/workflow-runs/:runId/stop", async (req, res) => {
  try {
    abortWorkflowPlans(req.params.runId);
    const run = await workflowStore.load(req.params.runId);
    run.status = "stopped";
    run.audit = [...(run.audit || []), { at: nowIso(), type: "run_stopped" }];
    res.json(workflowRunPayload(await workflowStore.save(run)));
  } catch (error) {
    const status = error?.code === "STALE_WORKFLOW_RUN" ? 409 : 404;
    res.status(status).json({ error: error.message || "Workflow run was not found.", code: error?.code || "WORKFLOW_RUN_NOT_FOUND" });
  }
});

app.post("/workflow-runs/:runId/continue", async (req, res) => {
  try {
    const run = await workflowStore.load(req.params.runId);
    const firstRecord = run.records?.[0];
    if (!firstRecord || (!run.metadata?.firstRecordApproved && (!["review", "complete"].includes(firstRecord.phase) || !assessUrolithiasisReview(firstRecord).reviewReady))) {
      return res.status(409).json({ error: "The first patient is not ready for review." });
    }
    if (run.metadata?.workbookBound && !run.metadata?.workbookWriteSynced) {
      return res.status(409).json({ error: "Sync the approved workbook write before continuing.", code: "WORKBOOK_WRITE_REQUIRED" });
    }
    run.status = "active";
    run.metadata = { ...(run.metadata || {}), firstRecordApproved: true };
    run.audit = [...(run.audit || []), { at: nowIso(), type: "first_record_approved" }];
    res.json(workflowRunPayload(await workflowStore.save(run)));
  } catch (error) {
    const status = error?.code === "STALE_WORKFLOW_RUN" ? 409 : 404;
    res.status(status).json({ error: error.message || "Workflow run was not found.", code: error?.code || "WORKFLOW_RUN_NOT_FOUND" });
  }
});

app.post("/workflow-runs/:runId/records/:recordId", async (req, res) => {
  try {
    const run = await workflowStore.load(req.params.runId);
    if (run.status === "stopped") throw new Error("This workflow run has been stopped.");
    if (run.status === "awaiting_first_review" && !run.metadata?.firstRecordApproved) {
      throw new Error("Approve the first completed record before updating the workflow.");
    }
    const record = workflowRecord(run, req.params.recordId);
    const profile = workflowProfile(run.profileId);
    const updates = Array.isArray(req.body?.fields) ? req.body.fields : [];

    for (const update of updates) {
      const fieldId = String(update?.fieldId || "");
      const definition = UROLITHIASIS_FIELD_SCHEMA[fieldId];
      if (!definition) throw new Error(`Unknown or disallowed field: ${fieldId || "(empty)"}.`);
      setRecordField(record, fieldId, {
        status: update.status,
        value: update.value,
        type: definition.type,
        evidence: update.evidence || [],
        note: update.note
      });
    }

    if (req.body?.observations) applyUrolithiasisRules(record, req.body.observations);
    if (req.body?.phase && profile.phases.includes(req.body.phase)) record.phase = req.body.phase;
    saveRecordAudit(record, "record_updated", { fields: updates.map(update => update.fieldId).filter(Boolean) });

    const validation = assessUrolithiasisReview(record);
    if (validation.reviewReady && record.phase === "collecting") record.phase = "review";
    applyFirstRecordCheckpoint(run, record, validation.reviewReady, nowIso());

    const saved = await workflowStore.save(run);
    res.json({ run: workflowRunPayload(saved), validation });
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message || "Could not update workflow record." });
  }
});

app.post("/workflow-runs/:runId/records/:recordId/plan", async (req, res) => {
  const requestCorrelationId = correlationId();
  const startedAt = Date.now();
  const providerAbortController = new AbortController();
  req.once("aborted", () => providerAbortController.abort());
  res.once("close", () => {
    if (!res.writableEnded) providerAbortController.abort();
  });
  const unregisterController = registerWorkflowPlanController(req.params.runId, providerAbortController);
  try {
    const run = await workflowStore.load(req.params.runId);
    if (run.status === "stopped") throw new Error("This workflow run has been stopped.");
    if (run.status === "awaiting_first_review") throw new Error("Approve the first completed record before continuing.");

    const record = workflowRecord(run, req.params.recordId);
    const profile = workflowProfile(run.profileId);
    const adapter = workflowAdapterFor(profile);
    const settings = getEffectiveSettings(req.body?.provider || run.metadata?.provider);
    requireWorkflowConsent(profile, settings, false);
    const contextKey = workflowContextKey(run.id, record.id);
    const contextPayload = req.body?.context || (req.body?.page ? { fullPage: req.body.page } : null);
    if (!contextPayload) throw new Error("A current page snapshot or context delta is required.");
    const resolvedContext = workflowContextCache.resolve(contextKey, contextPayload);
    const page = normalizePage({ ...resolvedContext.page, screenshot: null, accessibility: null });
    const promptPage = normalizePage({ ...resolvedContext.changedPage, screenshot: null, accessibility: null });
    promptPage.contextMode = resolvedContext.changedPage?.contextMode || "full";
    workflowDiagnostics.record(run.id, {
      correlationId: requestCorrelationId,
      eventType: "context_resolved",
      result: resolvedContext.cacheHit ? "cache_hit" : "cache_miss",
      phase: record.phase,
      recordOrdinal: record.queueIndex,
      cacheHit: resolvedContext.cacheHit,
      contextBytes: Buffer.byteLength(JSON.stringify(contextPayload), "utf8")
    });
    const { instructions, input } = buildWorkflowPrompt({
      profile,
      record,
      page: promptPage,
      redactIdentifiers: providerNeedsWorkflowConsent(settings.provider)
    });
    workflowDiagnostics.record(run.id, {
      correlationId: requestCorrelationId,
      eventType: "provider_request",
      result: "started",
      phase: record.phase,
      provider: settings.provider,
      model: modelForSettings(settings),
      recordOrdinal: record.queueIndex,
      contextBytes: Buffer.byteLength(input, "utf8"),
      cacheHit: resolvedContext.cacheHit
    });
    const providerResult = await callSelectedProviderJson({
      provider: settings.provider,
      instructions,
      input,
      settings,
      screenshot: null,
      signal: providerAbortController.signal,
      responseFormat: WORKFLOW_RESPONSE_FORMAT
    });
    const parsed = providerResult.output && typeof providerResult.output === "object" ? providerResult.output : extractJson(providerResult.raw);
    if (!parsed) throw new Error("The model did not return a valid workflow response.");
    const proposedAction = assertSingleWorkflowAction(parsed);

    const phaseFieldIds = adapter.phaseFieldIds(profile, record.phase, Object.keys(UROLITHIASIS_FIELD_SCHEMA));
    const fieldsUpdated = applyWorkflowFieldUpdates(record, parsed.fields, phaseFieldIds);
    const nextPhase = String(parsed.phase || "");
    if (profile.phases.includes(nextPhase) && adapter.transitionAllowed(profile, record.phase, nextPhase)) {
      record.phase = nextPhase;
    } else if (nextPhase && nextPhase !== record.phase) {
      throw new Error(`Invalid workflow phase transition: ${record.phase} -> ${nextPhase}.`);
    }
    saveRecordAudit(record, "model_workflow_step", { fields: fieldsUpdated, phase: record.phase });
    const validation = assessUrolithiasisReview(record);
    applyFirstRecordCheckpoint(run, record, validation.reviewReady, nowIso());
    const actionValidation = validateCollectionActions(proposedAction ? [proposedAction] : [], page);
    const adapterBlockedActions = actionValidation.validActions.filter(action => !adapter.actionAllowed(profile, action));
    const adapterAllowedActions = actionValidation.validActions.filter(action => adapter.actionAllowed(profile, action));
    const saved = await workflowStore.save(run);
    const usage = providerResult.usage || {};
    workflowDiagnostics.record(run.id, {
      correlationId: requestCorrelationId,
      eventType: "provider_response",
      result: "succeeded",
      phase: record.phase,
      provider: settings.provider,
      model: providerResult.model,
      providerRequestId: providerResult.requestId,
      latencyMs: providerResult.latencyMs ?? Date.now() - startedAt,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      contextBytes: Buffer.byteLength(input, "utf8"),
      recordOrdinal: record.queueIndex,
      foundFieldCount: Object.values(record.fields || {}).filter(field => field?.status === "found").length,
      unresolvedFieldCount: Object.values(record.fields || {}).filter(field => field?.status === "unresolved").length,
      evidenceCoveragePercent: validation.evidenceCoveragePercent,
      cacheHit: resolvedContext.cacheHit
    });

    res.json({
      reply: safeText(parsed.reply, 2000),
      done: Boolean(parsed.done),
      phase: record.phase,
      action: adapterAllowedActions[0] || null,
      blockedActions: [
        ...actionValidation.blockedActions,
        ...adapterBlockedActions.map(action => ({ action, reason: `The ${adapter.id} adapter blocked this action.` }))
      ],
      fieldsUpdated,
      warnings: [
        ...(Array.isArray(parsed.warnings) ? parsed.warnings.map(warning => safeText(warning, 500)) : []),
        ...(providerResult.warnings || []),
        ...((actionValidation.blockedActions.length + adapterBlockedActions.length) ? [`${actionValidation.blockedActions.length + adapterBlockedActions.length} action(s) were blocked.`] : [])
      ],
      correlationId: requestCorrelationId,
      contextCursor: resolvedContext.cursor,
      regionHashCount: resolvedContext.regionHashCount,
      cacheHit: resolvedContext.cacheHit,
      validation,
      run: workflowRunPayload(saved)
    });
  } catch (error) {
    workflowDiagnostics.record(req.params.runId, {
      correlationId: requestCorrelationId,
      eventType: "provider_error",
      result: error?.name === "AbortError" ? "stopped" : "failed",
      latencyMs: Date.now() - startedAt
    });
    const status = error.code === "CONTEXT_BUDGET_EXCEEDED"
      ? 413
      : (error.code === "CONTEXT_REFRESH_REQUIRED" || error.code === "STALE_WORKFLOW_RUN" ? 409 : (error.statusCode || 400));
    res.status(status).json({ error: error.message || "Could not plan workflow step.", code: error.code || "WORKFLOW_PLAN_FAILED", correlationId: requestCorrelationId });
  } finally {
    unregisterController();
  }
});

app.get("/workflow-runs/:runId/diagnostics", async (req, res) => {
  try {
    await workflowStore.load(req.params.runId);
    res.json(workflowDiagnostics.summary(req.params.runId));
  } catch {
    res.status(404).json({ error: "Workflow run was not found." });
  }
});

app.post("/workflow-runs/:runId/diagnostics/events", async (req, res) => {
  try {
    await workflowStore.load(req.params.runId);
    res.json({ event: workflowDiagnostics.record(req.params.runId, {
      eventType: "workflow_action",
      result: req.body?.result,
      phase: req.body?.phase,
      actionType: req.body?.actionType,
      recordOrdinal: req.body?.recordOrdinal,
      retryCount: req.body?.retryCount
    }) });
  } catch {
    res.status(404).json({ error: "Workflow run was not found." });
  }
});

app.get("/workflow-runs/:runId/export.csv", async (req, res) => {
  try {
    const run = await workflowStore.load(req.params.runId);
    res.type("text/csv").attachment(`${run.id}.csv`).send(exportRunToCsv(run, { fieldSchema: UROLITHIASIS_FIELD_SCHEMA }));
  } catch (error) {
    res.status(404).json({ error: "Workflow run was not found." });
  }
});

app.get("/workflow-runs/:runId/export.md", async (req, res) => {
  try {
    const run = await workflowStore.load(req.params.runId);
    res.type("text/markdown").attachment(`${run.id}.md`).send(exportRunToMarkdown(run, { fieldSchema: UROLITHIASIS_FIELD_SCHEMA }));
  } catch (error) {
    res.status(404).json({ error: "Workflow run was not found." });
  }
});

app.delete("/workflow-runs/:runId", async (req, res) => {
  try {
    await workflowStore.delete(req.params.runId);
    workflowContextCache.deleteRun(req.params.runId);
    workflowDiagnostics.delete(req.params.runId);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message || "Could not delete workflow run." });
  }
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/providers/status", async (req, res) => {
  const settings = getEffectiveSettings();
  const probe = req.query.probe === "true";
  const codexExecutor = ({ prompt, signal }) => callOpenAISigninCodex({ instructions: "", input: prompt, settings, signal });
  const providers = await Promise.all([...PROVIDERS].map(provider => runtimeProviderStatus(provider, settings, { codexExecutor, probe })));
  res.json({ providers });
});

app.get("/settings", (req, res) => {
  const settings = getEffectiveSettings();

  res.json({
    provider: settings.provider,
    model: modelForSettings(settings),
    openaiModel: settings.openaiModel,
    anthropicModel: settings.anthropicModel,
    deepseekR1Model: settings.deepseekR1Model,
    gptOss20bModel: settings.gptOss20bModel,
    ollamaModel: settings.ollamaModel,
    ollamaBaseUrl: settings.ollamaBaseUrl,
    baseUrl: isOllamaProvider(settings.provider) ? settings.ollamaBaseUrl : "",
    codexModel: settings.codexModel,
    hasOpenAIKey: Boolean(settings.openaiApiKey),
    hasClaudeKey: Boolean(settings.anthropicApiKey),
    hasOllamaKey: Boolean(settings.ollamaApiKey)
  });
});

app.post("/settings", (req, res) => {
  const { provider, model, apiKey, baseUrl } = req.body || {};

  if (provider && !isRecognizedProvider(provider)) {
    return res.status(400).json({ error: "Invalid provider." });
  }

  const current = readRuntimeSecrets();
  const next = { ...current };
  const normalizedProvider = normalizeProvider(provider || current.provider || process.env.RUNTIME_PROVIDER || "openai_api_key");

  if (provider) {
    next.provider = normalizedProvider;
  }

  if (normalizedProvider === "openai_api_key") {
    if (apiKey) next.openaiApiKey = apiKey;
    if (model) next.openaiModel = model;
  }

  if (normalizedProvider === "claude_api_key") {
    if (apiKey) next.anthropicApiKey = apiKey;
    if (model) next.anthropicModel = model;
  }

  if (normalizedProvider === "openai_signin_codex") {
    if (model) next.codexModel = model;
  }

  if (isOllamaProvider(normalizedProvider)) {
    if (apiKey) next.ollamaApiKey = apiKey;
    if (baseUrl) next.ollamaBaseUrl = baseUrl;
    if (model && normalizedProvider === "deepseek_r1_ollama") next.deepseekR1Model = model;
    if (model && normalizedProvider === "gpt_oss_20b_ollama") next.gptOss20bModel = model;
  }

  writeRuntimeSecrets(next);

  res.json({
    ok: true,
    provider: normalizeProvider(next.provider),
    message: normalizedProvider === "openai_signin_codex"
      ? "Make sure `codex login` has been completed locally."
      : isOllamaProvider(normalizedProvider)
        ? "Ollama provider saved. Make sure Ollama is running and the selected model is pulled."
        : "API key mode saved locally on the backend."
  });
});

app.get("/codex-login", (req, res) => {
  const state = publicCodexLoginState();

  res.type("html").send(`<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <title>OpenAI Sign-In for Chrome AI Agent</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        font-family: Arial, sans-serif;
        max-width: 720px;
        margin: 48px auto;
        padding: 0 20px;
        line-height: 1.45;
      }
      button, a.button {
        display: inline-block;
        margin-top: 12px;
        padding: 10px 14px;
        border: 1px solid #888;
        border-radius: 8px;
        background: transparent;
        color: inherit;
        cursor: pointer;
        text-decoration: none;
      }
      .box {
        margin-top: 16px;
        padding: 14px;
        border: 1px solid #ddd;
        border-radius: 8px;
        white-space: pre-wrap;
        overflow-wrap: break-word;
      }
      .muted { opacity: 0.72; }
      .success { color: #137333; }
      .danger { color: #a50e0e; }
    </style>
  </head>
  <body>
    <h1>OpenAI Sign-In</h1>
    <p class="muted">This starts the local Codex CLI sign-in flow for Chrome AI Agent. Complete the OpenAI browser flow, then return to the extension.</p>
    <div id="status" class="box">${escapeHtml(state.message)}</div>
    <div id="actions"></div>

    <script>
      let openedLoginUrl = "";
      const loginTicket = new URLSearchParams(location.search).get("ticket") || "";
      const withTicket = url => loginTicket ? url + (url.includes("?") ? "&" : "?") + "ticket=" + encodeURIComponent(loginTicket) : url;

      async function postJson(url) {
        const response = await fetch(withTicket(url), { method: "POST" });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Request failed: " + response.status);
        return data;
      }

      async function getJson(url) {
        const response = await fetch(withTicket(url));
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Request failed: " + response.status);
        return data;
      }

      function render(data) {
        const status = document.getElementById("status");
        const actions = document.getElementById("actions");
        const codeText = data.deviceCode ? "\\nCode: " + data.deviceCode : "";
        status.className = "box";

        if (data.status === "complete") {
          status.className = "box success";
          status.textContent = "OpenAI sign-in confirmed. You can close this tab and return to Chrome AI Agent.";
          actions.innerHTML = "";
          return;
        }

        if (data.status === "failed") {
          status.className = "box danger";
          status.textContent = data.message || "Sign-in failed.";
          actions.innerHTML = '<button id="retryBtn">Try Again</button>';
          document.getElementById("retryBtn").addEventListener("click", start);
          return;
        }

        status.textContent = (data.message || "Waiting for sign-in...") + codeText;

        if (data.loginUrl) {
          actions.innerHTML = '<a id="loginLink" class="button" rel="noopener" target="_blank">Open OpenAI Sign-In Page</a>';
          document.getElementById("loginLink").href = data.loginUrl;

          if (openedLoginUrl !== data.loginUrl) {
            openedLoginUrl = data.loginUrl;
            window.open(data.loginUrl, "_blank", "noopener");
          }
        } else {
          actions.innerHTML = "";
        }
      }

      async function poll() {
        try {
          const data = await getJson("/codex-login/status");
          render(data);

          if (data.status !== "complete" && data.status !== "failed") {
            setTimeout(poll, 3000);
          }
        } catch (error) {
          document.getElementById("status").textContent = "Could not check sign-in: " + error.message;
          setTimeout(poll, 5000);
        }
      }

      async function start() {
        document.getElementById("status").textContent = "Starting sign-in...";

        try {
          render(await postJson("/codex-login/start"));
          poll();
        } catch (error) {
          document.getElementById("status").className = "box danger";
          document.getElementById("status").textContent = "Could not start sign-in: " + error.message;
        }
      }

      start();
    </script>
  </body>
</html>`);
});

app.post("/codex-login/start", async (req, res) => {
  const settings = getEffectiveSettings("openai_signin_codex");
  startCodexLogin(settings);

  await new Promise(resolve => setTimeout(resolve, 2500));

  res.json({ ...publicCodexLoginState(), loginTicket: createCodexLoginTicket() });
});

app.get("/codex-login/status", (req, res) => {
  res.json(publicCodexLoginState());
});

app.post("/codex-login/check", async (req, res) => {
  try {
    const settings = getEffectiveSettings("openai_signin_codex");
    const state = await verifyCodexSignin(settings);
    res.json(state);
  } catch (error) {
    res.status(409).json({
      ...publicCodexLoginState(),
      error: error.message
    });
  }
});

app.post("/collection/step", async (req, res) => {
  const requestCorrelationId = correlationId();
  const providerAbortController = new AbortController();
  res.once("close", () => {
    if (!res.writableEnded) providerAbortController.abort();
  });
  try {
    const {
      task,
      fields,
      playbook,
      limits: requestedLimits,
      runState,
      page: rawPage,
      provider: requestedProvider,
      files
    } = req.body || {};

    if (!task || !rawPage) {
      return res.status(400).json({ error: "Missing task or page snapshot." });
    }

    const settings = getEffectiveSettings(requestedProvider);
    const limits = normalizeLimits(requestedLimits);
    const requestedFields = normalizeCollectionFields(fields);
    const attachedFiles = normalizeAttachments(files);
    const page = normalizePage(rawPage);
    const modelScreenshot = providerSupportsScreenshot(settings.provider) ? page.screenshot : null;
    const omittedScreenshotWarning = screenshotOmittedWarning(settings.provider);
    const requestWarnings = !modelScreenshot && page.screenshot && omittedScreenshotWarning
      ? [omittedScreenshotWarning]
      : [];
    const promptPage = modelScreenshot === page.screenshot ? page : { ...page, screenshot: null };

    if (taskIsHighRisk(task)) {
      return res.json({
        reply: "This collection task appears to involve payment, purchase, transfer, account deletion, or another irreversible action. I will not automate it.",
        done: true,
        actions: [],
        rows: [],
        fields: requestedFields,
        warnings: [...requestWarnings, "High-risk task blocked before any model call."],
        blockedActions: [],
        nextRecordHint: "",
        stopReason: "high_risk_task",
        provider: settings.provider
      });
    }

    const { instructions, input } = buildCollectionPrompt({
      task,
      fields: requestedFields,
      playbook,
      limits,
      runState: runState && typeof runState === "object" ? runState : {},
      page: promptPage,
      attachedFiles
    });

    workflowDiagnostics.record("collection_general", {
      correlationId: requestCorrelationId,
      eventType: "provider_request",
      result: "started",
      provider: settings.provider,
      model: modelForSettings(settings),
      contextBytes: Buffer.byteLength(input, "utf8")
    });

    const providerResult = await callSelectedProviderJson({
      provider: settings.provider,
      instructions,
      input,
      settings,
      screenshot: modelScreenshot,
      signal: providerAbortController.signal,
      responseFormat: COLLECTION_RESPONSE_FORMAT
    });
    workflowDiagnostics.record("collection_general", {
      correlationId: requestCorrelationId,
      eventType: "provider_response",
      result: "succeeded",
      provider: settings.provider,
      model: providerResult.model,
      providerRequestId: providerResult.requestId,
      latencyMs: providerResult.latencyMs,
      inputTokens: providerResult.usage?.inputTokens,
      outputTokens: providerResult.usage?.outputTokens,
      contextBytes: Buffer.byteLength(input, "utf8")
    });
    const raw = providerResult.raw;
    const parsed = providerResult.output && typeof providerResult.output === "object" ? providerResult.output : extractJson(raw);

    if (!parsed) {
      return res.json({
        reply: raw || "The model returned an empty response.",
        done: false,
        actions: [],
        rows: [],
        fields: requestedFields,
        warnings: [...requestWarnings, ...providerResult.warnings, "Model did not return valid collection JSON."],
        blockedActions: [],
        nextRecordHint: "",
        stopReason: "",
        provider: settings.provider
      });
    }

    const { validActions, blockedActions } = validateCollectionActions(parsed.actions, page);
    const rows = normalizeCollectionRows(collectionRowsFromModel(parsed.rows), page);
    const responseFields = normalizeCollectionFields(parsed.fields);
    const warnings = Array.isArray(parsed.warnings)
      ? parsed.warnings.map(warning => safeText(warning, 500)).filter(Boolean)
      : [];
    warnings.unshift(...requestWarnings, ...providerResult.warnings);

    if (blockedActions.length) {
      warnings.push(`${blockedActions.length} proposed action(s) were blocked by validation.`);
    }

    return res.json({
      reply: typeof parsed.reply === "string" ? parsed.reply : "",
      done: Boolean(parsed.done),
      actions: validActions,
      rows,
      fields: responseFields.length ? responseFields : requestedFields,
      warnings,
      blockedActions,
      nextRecordHint: safeText(parsed.nextRecordHint || "", 500),
      stopReason: safeText(parsed.stopReason || "", 200),
      provider: settings.provider
    });
  } catch (error) {
    workflowDiagnostics.record("collection_general", {
      correlationId: requestCorrelationId,
      eventType: "provider_error",
      result: providerAbortController.signal.aborted ? "stopped" : "failed"
    });

    return res.status(500).json({
      error: error.message || "Collection step failed."
    });
  }
});

app.post("/agent/stream", async (req, res) => {
  const abortController = new AbortController();
  let responseEnded = false;

  res.on("close", () => {
    if (!responseEnded) abortController.abort();
  });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  try {
    const { task, provider: requestedProvider, page: rawPage, files } = req.body || {};

    if (!task || !rawPage) {
      sendSse(res, "error", { error: "Missing task or page context." });
      responseEnded = true;
      res.end();
      return;
    }

    const settings = getEffectiveSettings(requestedProvider);
    const page = normalizePage(rawPage);
    const attachedFiles = normalizeAttachments(files);
    const warnings = [...page.warnings];
    const modelScreenshot = providerSupportsScreenshot(settings.provider) ? page.screenshot : null;
    const omittedScreenshotWarning = screenshotOmittedWarning(settings.provider);

    if (!modelScreenshot && page.screenshot && omittedScreenshotWarning) {
      warnings.push(omittedScreenshotWarning);
    }

    sendSse(res, "status", { message: "Reading page context..." });

    if (taskIsHighRisk(task)) {
      const reply = "This request appears to involve payment, purchase, financial transfer, crypto, account deletion, or another irreversible action. I can explain what to do, but I will not perform that action automatically.";
      sendSse(res, "delta", { text: reply });
      sendSse(res, "final", {
        reply,
        actions: [],
        blockedActions: [],
        warnings,
        provider: settings.provider,
        allowSubmit: taskExplicitlyAllowsSubmit(task)
      });
      sendSse(res, "done", {});
      responseEnded = true;
      res.end();
      return;
    }

    sendSse(res, "status", { message: "Planning actions..." });

    const final = await buildAgentFinalResponse({
      body: req.body || {},
      signal: abortController.signal
    });

    if (final.reply) sendSse(res, "delta", { text: final.reply });

    sendSse(res, "final", {
      ...final,
      warnings: Array.from(new Set([...(final.warnings || []), ...warnings]))
    });
    sendSse(res, "done", {});
    responseEnded = true;
    res.end();
  } catch (error) {
    if (!responseEnded) {
      sendSse(res, "error", { error: error.message || "Streaming agent request failed." });
      responseEnded = true;
      res.end();
    }
  }
});

app.post("/agent", async (req, res) => {
  const abortController = new AbortController();
  res.once("close", () => {
    if (!res.writableEnded) abortController.abort();
  });
  try {
    return res.json(await buildAgentFinalResponse({ body: req.body || {}, signal: abortController.signal }));
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      error: error.message || "Agent server failed."
    });
  }
});

app.listen(PORT, "127.0.0.1", () => {
  const secrets = readRuntimeSecrets();
  console.log(`Agent server running on http://127.0.0.1:${PORT}`);
  if (!secrets.backendToken) {
    console.log(`Pair the extension with this one-time backend code: ${ensurePairingCode()}`);
  }
});

app.get("/diagnostics/summary", (req, res) => {
  res.json({
    agent: workflowDiagnostics.summary("agent_general"),
    collection: workflowDiagnostics.summary("collection_general")
  });
});
