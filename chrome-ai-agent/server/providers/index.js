import { PROVIDER_IDS, PROVIDER_ID_SET, ProviderDriverError } from "./contracts.js";
import { createOpenAIDriver } from "./openai-driver.js";
import { createClaudeDriver } from "./claude-driver.js";
import { createCodexDriver } from "./codex-driver.js";
import { createOllamaDriver } from "./ollama-driver.js";

export { PROVIDER_IDS, ProviderDriverError, normalizeUsage } from "./contracts.js";
export { createOpenAIDriver } from "./openai-driver.js";
export { createClaudeDriver } from "./claude-driver.js";
export { createCodexDriver } from "./codex-driver.js";
export { createOllamaDriver } from "./ollama-driver.js";

export function createProviderDriver(provider, options = {}) {
  if (!PROVIDER_ID_SET.has(provider)) {
    throw new ProviderDriverError("unsupported_provider", `Unsupported provider: ${provider}`, { provider });
  }
  const shared = {
    settings: options.settings || {},
    client: options.clients?.[provider] || options.client,
    now: options.now,
    requestId: options.requestId
  };
  if (provider === "openai_api_key") return createOpenAIDriver(shared);
  if (provider === "claude_api_key") return createClaudeDriver(shared);
  if (provider === "openai_signin_codex") {
    return createCodexDriver({
      ...shared,
      executor: options.executors?.[provider] || options.executor
    });
  }
  return createOllamaDriver({ ...shared, provider });
}

export function createProviderRegistry(options = {}) {
  return Object.freeze({
    ids: PROVIDER_IDS,
    has(provider) {
      return PROVIDER_ID_SET.has(provider);
    },
    get(provider, settings = options.settings || {}) {
      if (!PROVIDER_ID_SET.has(provider)) {
        throw new ProviderDriverError("unsupported_provider", `Unsupported provider: ${provider}`, { provider });
      }
      return createProviderDriver(provider, { ...options, settings });
    },
    publicConfigs(settings = options.settings || {}) {
      return PROVIDER_IDS.map(id => this.get(id, settings).publicConfig());
    },
    clear() {}
  });
}
