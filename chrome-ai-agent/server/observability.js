import { createHash, randomUUID } from "node:crypto";

const ALLOWED_EVENT_TYPES = new Set([
  "provider_request",
  "provider_response",
  "provider_error",
  "context_resolved",
  "workflow_action",
  "workflow_retry",
  "workflow_stopped",
  "workflow_review_ready"
]);

const ALLOWED_RESULTS = new Set(["started", "succeeded", "failed", "blocked", "stopped", "cache_hit", "cache_miss"]);
const ALLOWED_PHASES = new Set(["queued", "patient_search", "chartbook", "comorbidities", "laboratory", "radiology", "operations", "medications", "validation", "review", "complete"]);
const ALLOWED_PROVIDERS = new Set(["openai_api_key", "claude_api_key", "openai_signin_codex", "deepseek_r1_ollama", "gpt_oss_20b_ollama"]);
const ALLOWED_ACTION_TYPES = new Set(["", "scroll", "click", "type", "wait", "extract", "readFormValues", "dismissAlert", "navigateCurrentUrl"]);

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function safeToken(value, max = 120) {
  return String(value || "").replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, max);
}

function allowedValue(value, allowed) {
  const normalized = String(value || "");
  return allowed.has(normalized) ? normalized : "";
}

function safeTimestamp() {
  return new Date().toISOString();
}

function safeCorrelationId(value) {
  const normalized = String(value || "");
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)
    ? normalized.toLowerCase()
    : randomUUID();
}

function fingerprint(value) {
  if (!value) return "";
  return `sha256:${createHash("sha256").update(String(value)).digest("hex").slice(0, 16)}`;
}

export function correlationId() {
  return randomUUID();
}

export function sanitizeDiagnosticEvent(input = {}) {
  const eventType = ALLOWED_EVENT_TYPES.has(input.eventType) ? input.eventType : "provider_error";
  const result = ALLOWED_RESULTS.has(input.result) ? input.result : "failed";
  return {
    timestamp: safeTimestamp(),
    correlationId: safeCorrelationId(input.correlationId),
    eventType,
    result,
    phase: allowedValue(input.phase, ALLOWED_PHASES),
    provider: allowedValue(input.provider, ALLOWED_PROVIDERS),
    model: fingerprint(input.model),
    providerRequestId: fingerprint(input.providerRequestId),
    actionType: allowedValue(input.actionType, ALLOWED_ACTION_TYPES),
    recordOrdinal: Math.max(0, Math.floor(finiteNumber(input.recordOrdinal))),
    latencyMs: finiteNumber(input.latencyMs),
    inputTokens: finiteNumber(input.inputTokens),
    outputTokens: finiteNumber(input.outputTokens),
    contextBytes: finiteNumber(input.contextBytes),
    retryCount: finiteNumber(input.retryCount),
    foundFieldCount: finiteNumber(input.foundFieldCount),
    unresolvedFieldCount: finiteNumber(input.unresolvedFieldCount),
    evidenceCoveragePercent: Math.min(100, finiteNumber(input.evidenceCoveragePercent)),
    cacheHit: Boolean(input.cacheHit)
  };
}

export class DiagnosticsRegistry {
  constructor({ maxEventsPerRun = 500, maxRuns = 100 } = {}) {
    this.maxEventsPerRun = maxEventsPerRun;
    this.maxRuns = maxRuns;
    this.runs = new Map();
  }

  record(runId, event) {
    const key = safeToken(runId);
    if (!key) return null;
    const events = this.runs.get(key) || [];
    const sanitized = sanitizeDiagnosticEvent(event);
    events.push(sanitized);
    this.runs.set(key, events.slice(-this.maxEventsPerRun));
    while (this.runs.size > this.maxRuns) this.runs.delete(this.runs.keys().next().value);
    return sanitized;
  }

  summary(runId) {
    const events = this.runs.get(safeToken(runId)) || [];
    const sum = (field) => events.reduce((total, event) => total + finiteNumber(event[field]), 0);
    const latest = events.at(-1) || null;
    return {
      runId: fingerprint(runId),
      eventCount: events.length,
      totalLatencyMs: sum("latencyMs"),
      inputTokens: sum("inputTokens"),
      outputTokens: sum("outputTokens"),
      contextBytes: events
        .filter(event => event.eventType === "provider_request")
        .reduce((total, event) => total + finiteNumber(event.contextBytes), 0),
      retries: sum("retryCount"),
      cacheHits: events.filter((event) => event.eventType === "context_resolved" && event.cacheHit).length,
      failures: events.filter((event) => event.result === "failed").length,
      latest: latest ? {
        timestamp: latest.timestamp,
        correlationId: latest.correlationId,
        phase: latest.phase,
        providerRequestId: latest.providerRequestId,
        evidenceCoveragePercent: latest.evidenceCoveragePercent,
        foundFieldCount: latest.foundFieldCount,
        unresolvedFieldCount: latest.unresolvedFieldCount
      } : null
    };
  }

  delete(runId) {
    this.runs.delete(safeToken(runId));
  }
}
