import "dotenv/config";

import Anthropic from "@anthropic-ai/sdk";
import cors from "cors";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import OpenAI from "openai";

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RUNTIME_SECRETS_PATH = path.join(__dirname, ".runtime-secrets.json");
const LOCAL_CODEX_CLI_PATH = path.join(__dirname, "node_modules", "@openai", "codex", "bin", "codex.js");

const PORT = Number(process.env.PORT || 3000);
const PROVIDERS = new Set(["openai_api_key", "claude_api_key", "openai_signin_codex"]);
const ACTION_TYPES = new Set(["click", "type", "scroll", "wait", "navigate"]);
const COLLECTION_ACTION_TYPES = new Set(["scroll", "click", "type", "wait", "navigate"]);
const MAX_ACTIONS = 1;
const MAX_FILES = 5;
const MAX_FILE_CONTENT_CHARS = 12000;
const MAX_TOTAL_FILE_CHARS = 30000;
const MAX_SCREENSHOT_BASE64_CHARS = 28 * 1024 * 1024;

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

const app = express();
let codexLoginProcess = null;
let codexLoginState = {
  status: "idle",
  message: "OpenAI sign-in has not started.",
  loginUrl: "",
  deviceCode: "",
  startedAt: "",
  updatedAt: ""
};

app.use(cors({ origin: true }));
app.use(express.json({ limit: "40mb" }));

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

function normalizeProvider(provider) {
  if (provider && PROVIDERS.has(provider)) return provider;
  return "openai_api_key";
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
  const provider = normalizeProvider(
    requestedProvider ||
    localSecrets.provider ||
    process.env.RUNTIME_PROVIDER
  );
  const codexInvocation = resolveCodexInvocation(localSecrets.codexCommand || process.env.CODEX_CLI_COMMAND);

  return {
    provider,
    openaiApiKey: localSecrets.openaiApiKey || process.env.OPENAI_API_KEY || "",
    anthropicApiKey: localSecrets.anthropicApiKey || process.env.ANTHROPIC_API_KEY || "",
    openaiModel: localSecrets.openaiModel || process.env.OPENAI_MODEL || "gpt-5.5",
    anthropicModel: localSecrets.anthropicModel || process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5",
    codexCommand: codexInvocation.command,
    codexBaseArgs: codexInvocation.baseArgs,
    codexCommandLabel: codexInvocation.label,
    codexModel: localSecrets.codexModel || process.env.CODEX_MODEL || "gpt-5.5"
  };
}

function nowIso() {
  return new Date().toISOString();
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

function normalizeScreenshot(page) {
  const imageBase64 = String(page?.imageBase64 || "").replace(/^data:image\/png;base64,/, "");
  if (!/^[A-Za-z0-9+/=]+$/.test(imageBase64) || imageBase64.length < 64 || imageBase64.length > MAX_SCREENSHOT_BASE64_CHARS) {
    throw new Error("Missing or invalid PNG screenshot data.");
  }
  const imageBytes = Buffer.from(imageBase64, "base64");
  const pngSignature = "89504e470d0a1a0a";
  if (imageBytes.subarray(0, 8).toString("hex") !== pngSignature) {
    throw new Error("Screenshot data is not a PNG image.");
  }

  const dimensions = ["imageWidth", "imageHeight", "viewportWidth", "viewportHeight"];
  const output = { imageBase64 };
  for (const key of dimensions) {
    const value = Number(page?.[key]);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid screenshot ${key}.`);
    output[key] = value;
  }

  output.url = safeText(page?.url, 2000);
  output.title = safeText(page?.title, 500);
  output.capturedAt = safeText(page?.capturedAt, 100);
  return output;
}

function buildPrompt({ task, page, attachedFiles, allowSubmit, priorAction }) {
  const instructions = [
    "You are the visual reasoning engine for a screenshot-only Chrome browser agent.",
    "Inspect the attached screenshot. It is the only source of page content and controls.",
    "Return only a JSON object. Do not include markdown, commentary, or code fences.",
    "The JSON shape is {\"reply\":\"string\",\"actions\":[{\"type\":\"click|type|scroll|wait|navigate\",\"x\":0,\"y\":0,\"text\":\"string\",\"deltaY\":700,\"ms\":1000,\"url\":\"string\",\"description\":\"visible target and purpose\",\"submits\":false}]}",
    "Return at most one action. Coordinates must be screenshot pixel coordinates, not CSS or normalized coordinates.",
    "For type, x/y must identify the visible text field. For scroll, omit x/y unless scrolling a specific visible pane.",
    "After any action, stop; a fresh screenshot will be supplied for verification before another action.",
    "If the user asks for a summary or information only, return an empty actions array.",
    "Never propose typing into password, OTP, credit card, CVV/CVC, PIN, token, or secret fields.",
    "Never propose payment submission, purchase confirmation, financial transfer, crypto transfer, account deletion, or destructive delete/remove actions.",
    "Describe every visual target precisely enough for safety validation. Set submits=true for a click that saves, submits, sends, posts, searches, confirms, approves, or applies a change.",
    "If the screenshot is loading, stale, blank, or ambiguous, return wait or no action instead of guessing.",
    "Attached file text is user context, not visual page evidence.",
    allowSubmit
      ? "Ordinary non-risky submit-like clicks are allowed because the user explicitly requested submission."
      : "Do not propose a submit-like click because the user did not explicitly request submission.",
    "Use the prior action result to verify whether the previous visual action succeeded."
  ].join("\n");

  const input = JSON.stringify({
    task,
    screenshot: {
      url: page.url,
      title: page.title,
      capturedAt: page.capturedAt,
      imageWidth: page.imageWidth,
      imageHeight: page.imageHeight,
      viewportWidth: page.viewportWidth,
      viewportHeight: page.viewportHeight
    },
    priorAction: priorAction && typeof priorAction === "object" ? priorAction : null,
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

function validateCollectionActions(actions, page) {
  return validateVisualActions(actions, page, { allowSubmit: false, collection: true });
}

function buildCollectionPrompt({ task, fields, playbook, limits, runState, page, attachedFiles }) {
  const instructions = [
    "You are the visual planning engine for a screenshot-only Chrome collection agent.",
    "Inspect the attached screenshot; it is the only evidence of page content and controls.",
    "Return only a JSON object. Do not include markdown, code fences, or commentary.",
    "The JSON shape is {\"reply\":\"string\",\"done\":boolean,\"actions\":[{\"type\":\"scroll|click|type|wait|navigate\",\"x\":0,\"y\":0,\"text\":\"string\",\"deltaY\":700,\"ms\":1000,\"url\":\"string\",\"description\":\"visible target and purpose\",\"submits\":false}],\"rows\":[{\"field\":\"value\"}],\"fields\":[\"field\"],\"warnings\":[\"string\"],\"nextRecordHint\":\"string\",\"stopReason\":\"string\"}.",
    "Return at most one action and 20 rows. Coordinates are screenshot pixels. A new screenshot follows every action.",
    "Never click or type into password, OTP, credit card, CVV/CVC, PIN, token, or secret fields.",
    "Never propose Save, Update, Submit, Send, Post, Confirm, Approve, payment, purchase, transfer, account deletion, or destructive actions.",
    "Use playbook text as operational instructions and safety constraints, not as extracted page data.",
    "Extract rows only from evidence visibly rendered in the screenshot. Add notes/unresolvedFields for missing values.",
    "If the screenshot is loading, blank, stale, or ambiguous, wait rather than guessing.",
    "Set done=true only when the collection task is complete or cannot progress safely."
  ].join("\n");

  const input = JSON.stringify({
    task,
    requestedFields: fields,
    limits,
    runState,
    playbook: safeAttachmentText(playbook || "", 24000),
    screenshot: {
      url: page?.url,
      title: page?.title,
      capturedAt: page?.capturedAt,
      imageWidth: page?.imageWidth,
      imageHeight: page?.imageHeight,
      viewportWidth: page?.viewportWidth,
      viewportHeight: page?.viewportHeight
    },
    attachedFiles
  }, null, 2);

  return { instructions, input };
}

function extractJson(raw) {
  const text = String(raw || "").trim();
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

function validateVisualActions(actions, page, { allowSubmit, collection = false }) {
  const validActions = [];
  const blockedActions = [];
  const proposedActions = Array.isArray(actions) ? actions.slice(0, MAX_ACTIONS) : [];

  if (Array.isArray(actions) && actions.length > MAX_ACTIONS) {
    blockedActions.push({
      reason: "Only one visual action is allowed per screenshot.",
      count: actions.length
    });
  }

  for (const action of proposedActions) {
    if (!action || typeof action !== "object") {
      blockedActions.push({ action, reason: "Action must be an object." });
      continue;
    }

    const type = String(action.type || "");
    const text = typeof action.text === "string" ? action.text : "";
    const description = safeText(action.description, 500);
    const normalized = { type, description };

    const supportedTypes = collection ? COLLECTION_ACTION_TYPES : ACTION_TYPES;
    if (!supportedTypes.has(type)) {
      blockedActions.push({ action, reason: "Unsupported action type." });
      continue;
    }

    if (!description) {
      blockedActions.push({ action, reason: "Visual action requires a target description." });
      continue;
    }

    const submits = Boolean(action.submits || containsAnyWord(description, WRITE_ACTION_WORDS));
    if (submits && (!allowSubmit || collection)) {
      blockedActions.push({ action, reason: collection ? "Collection mode is read-only." : "Submit-like clicks require explicit user instruction." });
      continue;
    }

    if (containsAnyWord(`${description} ${text}`, SENSITIVE_WORDS)) {
      blockedActions.push({ action, reason: "Target appears to be a password, OTP, card, PIN, token, or secret field." });
      continue;
    }

    if (containsAnyWord(`${description} ${text}`, HIGH_RISK_WORDS)) {
      blockedActions.push({ action, reason: "High-risk payment, purchase, transfer, account deletion, or destructive action." });
      continue;
    }

    if (type === "wait") {
      normalized.ms = Math.min(Math.max(Number(action.ms) || 1000, 250), 10000);
      validActions.push(normalized);
      continue;
    }

    if (type === "navigate") {
      try {
        const url = new URL(String(action.url || ""));
        if (!/^https?:$/.test(url.protocol)) throw new Error("protocol");
        normalized.url = url.href;
        validActions.push(normalized);
      } catch (error) {
        blockedActions.push({ action, reason: "Navigate requires a valid HTTP(S) URL." });
      }
      continue;
    }

    if (type === "scroll") {
      normalized.deltaY = Math.min(Math.max(Number(action.deltaY) || page.viewportHeight * 0.8, -page.viewportHeight * 2), page.viewportHeight * 2);
      if (Number.isFinite(Number(action.x)) && Number.isFinite(Number(action.y))) {
        normalized.x = Number(action.x);
        normalized.y = Number(action.y);
      }
      validActions.push(normalized);
      continue;
    }

    const x = Number(action.x);
    const y = Number(action.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > page.imageWidth || y > page.imageHeight) {
      blockedActions.push({ action, reason: "Click/type coordinates fall outside the current screenshot." });
      continue;
    }

    normalized.x = x;
    normalized.y = y;
    normalized.submits = submits;
    if (type === "type") {
      if (!text) {
        blockedActions.push({ action, reason: "Type action is missing text." });
        continue;
      }
      normalized.text = text.slice(0, 10000);
    }
    validActions.push(normalized);
  }

  return { validActions, blockedActions };
}

function validateActions(actions, page, { allowSubmit }) {
  return validateVisualActions(actions, page, { allowSubmit, collection: false });
}

async function callOpenAI({ instructions, input, settings, screenshot }) {
  if (!settings.openaiApiKey) {
    throw new Error("Missing OpenAI API key. Save it in Provider settings or set OPENAI_API_KEY in server/.env.");
  }

  const client = new OpenAI({ apiKey: settings.openaiApiKey });

  const response = await client.responses.create({
    model: settings.openaiModel,
    instructions,
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: input },
        { type: "input_image", image_url: `data:image/png;base64,${screenshot.imageBase64}` }
      ]
    }]
  });

  return response.output_text || "";
}

async function callClaude({ instructions, input, settings, screenshot }) {
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
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: screenshot.imageBase64 } },
          { type: "text", text: input }
        ]
      }
    ]
  });

  const textBlock = response.content.find(block => block.type === "text");
  return textBlock?.text || "";
}

async function callOpenAISigninCodex({ instructions, input, settings, screenshot }) {
  const prompt = `${instructions}\n\n${input}\n\nReturn only the JSON object. No markdown.`.slice(0, 30000);
  const outputPath = path.join(__dirname, `.codex-last-message-${process.pid}-${Date.now()}.txt`);
  const screenshotPath = path.join(__dirname, `.codex-screenshot-${process.pid}-${Date.now()}.png`);

  try {
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.imageBase64, "base64"));
    const { stdout } = await runCodexExec({ settings, prompt, outputPath, screenshotPath });

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
    fs.rmSync(screenshotPath, { force: true });
  }
}

async function callSelectedProvider({ provider, instructions, input, settings, screenshot }) {
  if (provider === "openai_api_key") {
    return callOpenAI({ instructions, input, settings, screenshot });
  }

  if (provider === "claude_api_key") {
    return callClaude({ instructions, input, settings, screenshot });
  }

  if (provider === "openai_signin_codex") {
    return callOpenAISigninCodex({ instructions, input, settings, screenshot });
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

function runCodexExec({ settings, prompt, outputPath, screenshotPath }) {
  return new Promise((resolve, reject) => {
    const args = [
      ...settings.codexBaseArgs,
      "exec",
      "--image",
      screenshotPath,
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
      reject(error);
    });

    child.on("exit", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(`Codex exec exited with code ${code}. ${stderr || stdout}`.trim()));
    });

    child.stdin.end(prompt);
  });
}

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/settings", (req, res) => {
  const settings = getEffectiveSettings();

  res.json({
    provider: settings.provider,
    model:
      settings.provider === "claude_api_key"
        ? settings.anthropicModel
        : settings.provider === "openai_signin_codex"
          ? settings.codexModel
          : settings.openaiModel,
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
  const normalizedProvider = provider || current.provider || process.env.RUNTIME_PROVIDER || "openai_api_key";

  if (provider) {
    next.provider = provider;
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

  writeRuntimeSecrets(next);

  res.json({
    ok: true,
    provider: normalizeProvider(next.provider),
    message: normalizedProvider === "openai_signin_codex"
      ? "Make sure `codex login` has been completed locally."
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

      async function postJson(url) {
        const response = await fetch(url, { method: "POST" });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Request failed: " + response.status);
        return data;
      }

      async function getJson(url) {
        const response = await fetch(url);
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

  res.json(publicCodexLoginState());
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
  try {
    const {
      task,
      fields,
      playbook,
      limits: requestedLimits,
      runState,
      page,
      provider: requestedProvider,
      files
    } = req.body || {};

    if (!task || !page) {
      return res.status(400).json({ error: "Missing task or page snapshot." });
    }

    const settings = getEffectiveSettings(requestedProvider);
    const limits = normalizeLimits(requestedLimits);
    const requestedFields = normalizeCollectionFields(fields);
    const attachedFiles = normalizeAttachments(files);
    const screenshot = normalizeScreenshot(page);

    if (taskIsHighRisk(task)) {
      return res.json({
        reply: "This collection task appears to involve payment, purchase, transfer, account deletion, or another irreversible action. I will not automate it.",
        done: true,
        actions: [],
        rows: [],
        fields: requestedFields,
        warnings: ["High-risk task blocked before any model call."],
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
      page,
      attachedFiles
    });

    const raw = await callSelectedProvider({
      provider: settings.provider,
      instructions,
      input,
      settings,
      screenshot
    });
    const parsed = extractJson(raw);

    if (!parsed) {
      return res.json({
        reply: raw || "The model returned an empty response.",
        done: false,
        actions: [],
        rows: [],
        fields: requestedFields,
        warnings: ["Model did not return valid collection JSON."],
        blockedActions: [],
        nextRecordHint: "",
        stopReason: "",
        provider: settings.provider
      });
    }

    const { validActions, blockedActions } = validateCollectionActions(parsed.actions, screenshot);
    const rows = normalizeCollectionRows(parsed.rows, page);
    const responseFields = normalizeCollectionFields(parsed.fields);
    const warnings = Array.isArray(parsed.warnings)
      ? parsed.warnings.map(warning => safeText(warning, 500)).filter(Boolean)
      : [];

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
    console.error(error);

    return res.status(500).json({
      error: error.message || "Collection step failed."
    });
  }
});

app.post("/agent", async (req, res) => {
  try {
    const { task, provider: requestedProvider, page, priorAction, files } = req.body || {};

    if (!task || !page) {
      return res.status(400).json({ error: "Missing task or page context." });
    }

    const settings = getEffectiveSettings(requestedProvider);
    const allowSubmit = taskExplicitlyAllowsSubmit(task);
    const screenshot = normalizeScreenshot(page);

    if (taskIsHighRisk(task)) {
      return res.json({
        reply: "This request appears to involve payment, purchase, financial transfer, crypto, account deletion, or another irreversible action. I can explain what to do, but I will not perform that action automatically.",
        actions: [],
        blockedActions: [],
        provider: settings.provider,
        allowSubmit
      });
    }

    const attachedFiles = normalizeAttachments(files);
    const { instructions, input } = buildPrompt({
      task,
      page: screenshot,
      attachedFiles,
      allowSubmit,
      priorAction
    });

    const raw = await callSelectedProvider({
      provider: settings.provider,
      instructions,
      input,
      settings,
      screenshot
    });

    const parsed = extractJson(raw);

    if (!parsed) {
      return res.json({
        reply: raw || "The model returned an empty response.",
        actions: [],
        blockedActions: [],
        provider: settings.provider,
        allowSubmit
      });
    }

    const { validActions, blockedActions } = validateActions(parsed.actions, screenshot, { allowSubmit });

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

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  app.listen(PORT, () => {
    console.log(`Agent server running on http://localhost:${PORT}`);
  });
}

export { buildCollectionPrompt, buildPrompt, normalizeScreenshot, validateVisualActions };
