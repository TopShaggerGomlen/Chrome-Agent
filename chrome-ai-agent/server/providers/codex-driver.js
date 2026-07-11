import { createDriverRuntime, ProviderDriverError, publicDriverConfig, runMeasured } from "./contracts.js";

const CAPABILITIES = Object.freeze({
  structuredGeneration: true,
  nativeJsonSchema: false,
  images: false,
  usage: false,
  cancellation: true,
  healthChecks: true,
  modelMetadata: true,
  remoteData: true
});

export function createCodexDriver({ settings = {}, executor, ...runtimeOptions } = {}) {
  const driver = {
    id: "openai_signin_codex",
    label: "OpenAI sign-in via Codex CLI",
    model: settings.codexModel || settings.model || "",
    capabilities: CAPABILITIES,
    runtime: createDriverRuntime(runtimeOptions),
    publicConfig() {
      return publicDriverConfig({
        id: this.id,
        label: this.label,
        model: this.model,
        capabilities: this.capabilities,
        configured: Boolean(executor || settings.codexCommand)
      });
    },
    async healthCheck({ signal, probe = false } = {}) {
      if (signal?.aborted) return health(this, false, "request_aborted");
      if (!executor && !settings.codexCommand) return health(this, false, "missing_command");
      if (!probe) return health(this, true, "configured");
      if (typeof executor?.healthCheck === "function") {
        const checked = await executor.healthCheck({ settings, signal });
        return typeof checked === "boolean" ? health(this, checked, checked ? "reachable" : "unreachable") : checked;
      }
      return health(this, true, "probe_unavailable");
    },
    generateText(request) {
      assertNoImage(request);
      return runMeasured({ driver: this, request, invoke: requestId => invokeCodex(executor, settings, this.model, request, requestId) });
    },
    generateJson(request) {
      assertNoImage(request);
      const schemaPrompt = request.schema ? `\nJSON Schema:\n${JSON.stringify(request.schema)}` : "";
      return runMeasured({
        driver: this,
        request,
        structured: true,
        invoke: requestId => invokeCodex(executor, settings, this.model, {
          ...request,
          instructions: `${request.instructions}\nReturn only valid JSON. No markdown.${schemaPrompt}`
        }, requestId, ["Codex CLI uses constrained JSON prompting; native schema enforcement is unavailable."])
      });
    }
  };
  return driver;
}

function assertNoImage(request) {
  if (request?.screenshot) throw new ProviderDriverError("unsupported_capability", "Codex CLI provider does not accept image input.");
}

async function invokeCodex(executor, settings, model, request, requestId, warnings = []) {
  if (typeof executor !== "function" && typeof executor?.execute !== "function") {
    throw new Error("Codex executor is not configured.");
  }
  const execute = typeof executor === "function" ? executor : executor.execute.bind(executor);
  const response = await execute({
    settings,
    model,
    prompt: `${request.instructions}\n\n${request.input}`.slice(0, request.maxInputCharacters || 30000),
    signal: request.signal,
    requestId
  });
  if (typeof response === "string") return { raw: response, warnings };
  return { raw: response?.raw ?? response?.stdout ?? response?.text ?? "", ...response, warnings: [...warnings, ...(response?.warnings || [])] };
}

function health(driver, ok, status) {
  return { ok, status, provider: driver.id, model: driver.model };
}
