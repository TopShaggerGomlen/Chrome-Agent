import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

import { createProviderDriver } from "./index.js";

function requireSetting(value, message) {
  if (!value) throw new Error(message);
  return value;
}

export function createRuntimeProviderDriver(provider, settings, { codexExecutor } = {}) {
  if (provider === "openai_api_key") {
    const apiKey = requireSetting(settings.openaiApiKey, "Missing OpenAI API key. Save it in Provider settings or set OPENAI_API_KEY in server/.env.");
    return createProviderDriver(provider, { settings, client: new OpenAI({ apiKey }) });
  }
  if (provider === "claude_api_key") {
    const apiKey = requireSetting(settings.anthropicApiKey, "Missing Claude API key. Save it in Provider settings or set ANTHROPIC_API_KEY in server/.env.");
    return createProviderDriver(provider, { settings, client: new Anthropic({ apiKey }) });
  }
  if (provider === "openai_signin_codex") {
    return createProviderDriver(provider, { settings, executor: codexExecutor });
  }
  if (provider === "deepseek_r1_ollama" || provider === "gpt_oss_20b_ollama") {
    requireSetting(settings.ollamaBaseUrl, "Missing Ollama base URL. Set OLLAMA_BASE_URL in server/.env.");
    const client = new OpenAI({
      apiKey: settings.ollamaApiKey || "ollama",
      baseURL: settings.ollamaBaseUrl
    });
    return createProviderDriver(provider, { settings, client });
  }
  return createProviderDriver(provider, { settings });
}

export function runtimeProviderPublicConfig(provider, settings, options = {}) {
  try {
    return createRuntimeProviderDriver(provider, settings, options).publicConfig();
  } catch (error) {
    const driver = createProviderDriver(provider, { settings, executor: options.codexExecutor });
    return { ...driver.publicConfig(), configured: false, status: error.message };
  }
}

export async function runtimeProviderStatus(provider, settings, options = {}) {
  let driver;
  try {
    driver = createRuntimeProviderDriver(provider, settings, options);
  } catch {
    driver = createProviderDriver(provider, { settings, executor: options.codexExecutor });
  }
  return {
    ...driver.publicConfig(),
    health: await driver.healthCheck({ probe: Boolean(options.probe), signal: options.signal })
  };
}

export function runtimeProviderMetadata(provider, settings = {}) {
  const driver = createProviderDriver(provider, { settings });
  return { model: driver.model, capabilities: driver.capabilities };
}
