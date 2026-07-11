import crypto from "node:crypto";

export const PROVIDER_IDS = Object.freeze([
  "openai_api_key",
  "claude_api_key",
  "openai_signin_codex",
  "deepseek_r1_ollama",
  "gpt_oss_20b_ollama"
]);

export const PROVIDER_ID_SET = new Set(PROVIDER_IDS);

export class ProviderDriverError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "ProviderDriverError";
    this.code = code;
    this.provider = options.provider || null;
    this.requestId = options.requestId || null;
  }
}

export function normalizeUsage(usage = {}) {
  const inputTokens = firstNumber(
    usage.inputTokens,
    usage.input_tokens,
    usage.promptTokens,
    usage.prompt_tokens,
    usage.prompt_eval_count
  );
  const outputTokens = firstNumber(
    usage.outputTokens,
    usage.output_tokens,
    usage.completionTokens,
    usage.completion_tokens,
    usage.eval_count
  );
  const reportedTotal = firstNumber(usage.totalTokens, usage.total_tokens);

  return {
    inputTokens,
    outputTokens,
    totalTokens: reportedTotal ?? sumKnown(inputTokens, outputTokens)
  };
}

export function createDriverRuntime(options = {}) {
  return {
    now: options.now || (() => Date.now()),
    requestId: options.requestId || (() => crypto.randomUUID())
  };
}

export function assertProviderRequest(request = {}) {
  if (request.signal?.aborted) {
    throw new ProviderDriverError("request_aborted", "Provider request was aborted before it started.");
  }
  if (typeof request.instructions !== "string") {
    throw new ProviderDriverError("invalid_request", "Provider instructions must be a string.");
  }
  if (typeof request.input !== "string") {
    throw new ProviderDriverError("invalid_request", "Provider input must be a string.");
  }
}

export function parseJsonOutput(raw) {
  if (raw && typeof raw === "object") return raw;
  const text = String(raw || "").trim();
  if (!text) {
    throw new ProviderDriverError("empty_output", "Provider returned an empty structured response.");
  }

  const unfenced = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  try {
    return JSON.parse(unfenced);
  } catch (error) {
    throw new ProviderDriverError("invalid_json", "Provider returned invalid JSON.", { cause: error });
  }
}

export function createNormalizedResult({
  output,
  raw,
  provider,
  model,
  requestId,
  startedAt,
  finishedAt,
  usage,
  warnings = []
}) {
  return {
    output,
    raw: typeof raw === "string" ? raw : JSON.stringify(raw ?? ""),
    provider,
    model,
    requestId,
    latencyMs: Math.max(0, Number(finishedAt) - Number(startedAt)),
    usage: normalizeUsage(usage),
    warnings: Array.isArray(warnings) ? warnings.filter(Boolean) : []
  };
}

export function publicDriverConfig({ id, label, model, capabilities, configured, baseUrl = "" }) {
  return Object.freeze({
    id,
    label,
    model: model || "",
    baseUrl: safePublicBaseUrl(baseUrl),
    configured: Boolean(configured),
    capabilities: Object.freeze({ ...capabilities })
  });
}

export async function runMeasured({ driver, request, invoke, structured = false }) {
  assertProviderRequest(request);
  const startedAt = driver.runtime.now();
  const requestId = driver.runtime.requestId();

  try {
    const response = await invoke(requestId);
    if (request.signal?.aborted) {
      throw new ProviderDriverError("request_aborted", "Provider request was aborted.");
    }
    const raw = response?.raw ?? response?.text ?? response?.output ?? "";
    const output = structured ? parseJsonOutput(response?.output ?? raw) : String(response?.output ?? raw ?? "");

    return createNormalizedResult({
      output,
      raw,
      provider: driver.id,
      model: response?.model || driver.model,
      requestId: response?.requestId || requestId,
      startedAt,
      finishedAt: driver.runtime.now(),
      usage: response?.usage,
      warnings: response?.warnings
    });
  } catch (error) {
    if (error instanceof ProviderDriverError) {
      error.provider ||= driver.id;
      error.requestId ||= requestId;
      throw error;
    }
    if (request.signal?.aborted || error?.name === "AbortError") {
      throw new ProviderDriverError("request_aborted", "Provider request was aborted.", {
        cause: error,
        provider: driver.id,
        requestId
      });
    }
    throw new ProviderDriverError("provider_request_failed", error?.message || "Provider request failed.", {
      cause: error,
      provider: driver.id,
      requestId
    });
  }
}

function safePublicBaseUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function firstNumber(...values) {
  for (const value of values) {
    if (Number.isFinite(Number(value)) && Number(value) >= 0) return Number(value);
  }
  return null;
}

function sumKnown(left, right) {
  if (left === null && right === null) return null;
  return (left || 0) + (right || 0);
}
