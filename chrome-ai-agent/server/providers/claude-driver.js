import { createDriverRuntime, publicDriverConfig, runMeasured } from "./contracts.js";
import { claudeContent } from "./content.js";

const CAPABILITIES = Object.freeze({
  structuredGeneration: true,
  nativeJsonSchema: false,
  images: true,
  usage: true,
  cancellation: true,
  healthChecks: true,
  modelMetadata: true,
  remoteData: true
});

export function createClaudeDriver({ settings = {}, client, ...runtimeOptions } = {}) {
  const driver = {
    id: "claude_api_key",
    label: "Claude API key",
    model: settings.anthropicModel || settings.model || "",
    capabilities: CAPABILITIES,
    runtime: createDriverRuntime(runtimeOptions),
    publicConfig() {
      return publicDriverConfig({
        id: this.id,
        label: this.label,
        model: this.model,
        capabilities: this.capabilities,
        configured: Boolean(client || settings.anthropicApiKey)
      });
    },
    async healthCheck({ signal, probe = false } = {}) {
      if (signal?.aborted) return result(this, false, "request_aborted");
      if (!client && !settings.anthropicApiKey) return result(this, false, "missing_api_key");
      if (!probe) return result(this, true, "configured");
      if (typeof client?.healthCheck === "function") {
        const checked = await client.healthCheck({ signal });
        return typeof checked === "boolean" ? result(this, checked, checked ? "reachable" : "unreachable") : checked;
      }
      return result(this, true, "probe_unavailable");
    },
    generateText(request) {
      return runMeasured({ driver: this, request, invoke: () => invokeClaude(client, this.model, request) });
    },
    generateJson(request) {
      const schemaInstruction = request.schema
        ? `\nReturn only JSON matching this JSON Schema:\n${JSON.stringify(request.schema)}`
        : "\nReturn only a valid JSON value. No markdown.";
      return runMeasured({
        driver: this,
        request,
        structured: true,
        invoke: () => invokeClaude(client, this.model, {
          ...request,
          instructions: `${request.instructions}${schemaInstruction}`
        }, ["Claude uses constrained JSON prompting because native JSON Schema output is unavailable."])
      });
    }
  };
  return driver;
}

async function invokeClaude(client, model, request, warnings = []) {
  if (!client?.messages?.create) throw new Error("Claude client is not configured.");
  const response = await client.messages.create({
    model,
    max_tokens: request.maxOutputTokens || 1200,
    system: request.instructions,
    messages: [{ role: "user", content: claudeContent(request.input, request.screenshot) }]
  }, { signal: request.signal });
  const raw = (response.content || []).filter(block => block.type === "text").map(block => block.text).join("");
  return { raw, usage: response.usage, requestId: response._request_id || response.id, model: response.model, warnings };
}

function result(driver, ok, status) {
  return { ok, status, provider: driver.id, model: driver.model };
}
