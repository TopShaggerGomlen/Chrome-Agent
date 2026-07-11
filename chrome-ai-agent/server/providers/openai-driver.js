import {
  createDriverRuntime,
  publicDriverConfig,
  runMeasured
} from "./contracts.js";
import { openAIInput } from "./content.js";

const CAPABILITIES = Object.freeze({
  structuredGeneration: true,
  nativeJsonSchema: true,
  images: true,
  usage: true,
  cancellation: true,
  healthChecks: true,
  modelMetadata: true,
  remoteData: true
});

export function createOpenAIDriver({ settings = {}, client, ...runtimeOptions } = {}) {
  const driver = {
    id: "openai_api_key",
    label: "OpenAI API key",
    model: settings.openaiModel || settings.model || "",
    capabilities: CAPABILITIES,
    runtime: createDriverRuntime(runtimeOptions),
    publicConfig() {
      return publicDriverConfig({
        id: this.id,
        label: this.label,
        model: this.model,
        capabilities: this.capabilities,
        configured: Boolean(client || settings.openaiApiKey)
      });
    },
    async healthCheck({ signal, probe = false } = {}) {
      if (signal?.aborted) return health(this, false, "request_aborted");
      if (!client && !settings.openaiApiKey) return health(this, false, "missing_api_key");
      if (!probe) return health(this, true, "configured");
      if (typeof client?.healthCheck === "function") return normalizeHealth(this, await client.healthCheck({ signal }));
      if (typeof client?.models?.list === "function") {
        await client.models.list({}, { signal });
        return health(this, true, "reachable");
      }
      return health(this, true, "probe_unavailable");
    },
    generateText(request) {
      return runMeasured({ driver: this, request, invoke: () => invokeOpenAI(client, this.model, request) });
    },
    generateJson(request) {
      return runMeasured({
        driver: this,
        request,
        structured: true,
        invoke: () => invokeOpenAI(client, this.model, request, request.schema)
      });
    }
  };
  return driver;
}

async function invokeOpenAI(client, model, request, schema) {
  if (!client?.responses?.create) throw new Error("OpenAI client is not configured.");
  const body = {
    model,
    instructions: request.instructions,
    input: openAIInput(request.input, request.screenshot)
  };
  if (schema) {
    body.text = {
      format: {
        type: "json_schema",
        name: request.schemaName || "provider_response",
        strict: true,
        schema
      }
    };
  }
  const response = await client.responses.create(body, { signal: request.signal });
  return {
    raw: response.output_text || "",
    usage: response.usage,
    requestId: response._request_id || response.id,
    model: response.model
  };
}

function health(driver, ok, status) {
  return { ok, status, provider: driver.id, model: driver.model };
}

function normalizeHealth(driver, result) {
  if (typeof result === "boolean") return health(driver, result, result ? "reachable" : "unreachable");
  return { ...health(driver, Boolean(result?.ok), result?.status || "unknown"), ...result };
}
