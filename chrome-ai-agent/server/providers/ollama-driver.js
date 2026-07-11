import { createDriverRuntime, ProviderDriverError, publicDriverConfig, runMeasured } from "./contracts.js";
import { ollamaMessages, stripReasoningTags } from "./content.js";

const IDS = new Set(["deepseek_r1_ollama", "gpt_oss_20b_ollama"]);
const CAPABILITIES = Object.freeze({
  structuredGeneration: true,
  nativeJsonSchema: false,
  images: false,
  usage: true,
  cancellation: true,
  healthChecks: true,
  modelMetadata: true,
  remoteData: false
});

export function createOllamaDriver({ provider, settings = {}, client, ...runtimeOptions } = {}) {
  if (!IDS.has(provider)) throw new Error(`Unsupported Ollama provider: ${provider}`);
  const defaultModel = provider === "deepseek_r1_ollama" ? settings.deepseekR1Model : settings.gptOss20bModel;
  const driver = {
    id: provider,
    label: provider === "deepseek_r1_ollama" ? "DeepSeek R1 via Ollama" : "gpt-oss 20B via Ollama",
    model: defaultModel || settings.ollamaModel || settings.model || "",
    baseUrl: settings.ollamaBaseUrl || settings.baseUrl || "",
    capabilities: CAPABILITIES,
    runtime: createDriverRuntime(runtimeOptions),
    publicConfig() {
      return publicDriverConfig({
        id: this.id,
        label: this.label,
        model: this.model,
        baseUrl: this.baseUrl,
        capabilities: this.capabilities,
        configured: Boolean(client || this.baseUrl)
      });
    },
    async healthCheck({ signal, probe = false } = {}) {
      if (signal?.aborted) return health(this, false, "request_aborted");
      if (!client && !this.baseUrl) return health(this, false, "missing_base_url");
      if (!probe) return health(this, true, "configured");
      if (typeof client?.healthCheck === "function") {
        const checked = await client.healthCheck({ signal, model: this.model });
        return typeof checked === "boolean" ? health(this, checked, checked ? "reachable" : "unreachable") : checked;
      }
      if (typeof client?.models?.list === "function") {
        await client.models.list({}, { signal });
        return health(this, true, "reachable");
      }
      return health(this, true, "probe_unavailable");
    },
    generateText(request) {
      assertNoImage(request);
      return runMeasured({ driver: this, request, invoke: () => invokeOllama(client, this, request) });
    },
    generateJson(request) {
      assertNoImage(request);
      const instruction = request.schema
        ? `${request.instructions}\nReturn only JSON matching this JSON Schema:\n${JSON.stringify(request.schema)}`
        : `${request.instructions}\nReturn only valid JSON. No markdown.`;
      return runMeasured({
        driver: this,
        request,
        structured: true,
        invoke: () => invokeOllama(client, this, { ...request, instructions: instruction }, true)
      });
    }
  };
  return driver;
}

function assertNoImage(request) {
  if (request?.screenshot) throw new ProviderDriverError("unsupported_capability", "This Ollama driver does not accept image input.");
}

async function invokeOllama(client, driver, request, json = false) {
  if (!client?.chat?.completions?.create) throw new Error("Ollama client is not configured.");
  const body = {
    model: driver.model,
    temperature: 0.2,
    messages: ollamaMessages(driver.id, request.instructions, request.input)
  };
  if (json) body.response_format = { type: "json_object" };
  const response = await client.chat.completions.create(body, { signal: request.signal });
  const raw = stripReasoningTags(response.choices?.[0]?.message?.content || "");
  return {
    raw,
    usage: response.usage,
    requestId: response._request_id || response.id,
    model: response.model,
    warnings: json ? ["Ollama JSON mode does not enforce the supplied JSON Schema."] : []
  };
}

function health(driver, ok, status) {
  return { ok, status, provider: driver.id, model: driver.model, baseUrl: driver.publicConfig().baseUrl };
}
