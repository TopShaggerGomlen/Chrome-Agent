import assert from "node:assert/strict";
import test from "node:test";

import {
  PROVIDER_IDS,
  ProviderDriverError,
  createProviderDriver,
  createProviderRegistry,
  normalizeUsage
} from "./providers/index.js";
import { runtimeProviderMetadata, runtimeProviderStatus } from "./providers/runtime.js";

const SETTINGS = {
  openaiApiKey: "secret-openai-key",
  openaiModel: "gpt-test",
  anthropicApiKey: "secret-anthropic-key",
  anthropicModel: "claude-test",
  codexCommand: "codex",
  codexModel: "codex-test",
  ollamaApiKey: "secret-ollama-key",
  ollamaBaseUrl: "http://user:password@127.0.0.1:11434/v1",
  deepseekR1Model: "deepseek-test",
  gptOss20bModel: "gpt-oss-test"
};

test("registry exposes all five supported providers and no secrets", () => {
  const registry = createProviderRegistry({
    settings: SETTINGS,
    clients: mockClients(),
    executor: async () => "{}"
  });

  assert.deepEqual(registry.ids, PROVIDER_IDS);
  assert.equal(registry.ids.length, 5);

  const serialized = JSON.stringify(registry.publicConfigs());
  assert.doesNotMatch(serialized, /secret-|password/);
  assert.match(serialized, /127\.0\.0\.1:11434/);

  for (const provider of PROVIDER_IDS) {
    const config = registry.get(provider).publicConfig();
    assert.equal(config.id, provider);
    assert.equal(config.configured, true);
    assert.equal(config.capabilities.cancellation, true);
    assert.equal(config.capabilities.healthChecks, true);
    assert.equal(config.capabilities.modelMetadata, true);
    assert.equal(config.capabilities.structuredGeneration, true);
    assert.equal(typeof config.capabilities.nativeJsonSchema, "boolean");
    assert.equal("streaming" in config.capabilities, false);
  }
});

test("runtime metadata and non-probing health are available without provider calls", async () => {
  assert.equal(runtimeProviderMetadata("openai_api_key", SETTINGS).model, "gpt-test");
  const status = await runtimeProviderStatus("openai_signin_codex", SETTINGS, { codexExecutor: async () => "{}" });
  assert.equal(status.health.ok, true);
  assert.equal(status.capabilities.cancellation, true);
});

test("OpenAI uses native JSON Schema output and returns normalized metadata", async () => {
  let captured;
  const client = {
    responses: {
      async create(body, options) {
        captured = { body, options };
        return {
          id: "openai-request",
          model: "gpt-response-model",
          output_text: "{\"ok\":true}",
          usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 }
        };
      }
    }
  };
  const times = [100, 125];
  const driver = createProviderDriver("openai_api_key", {
    settings: SETTINGS,
    client,
    now: () => times.shift(),
    requestId: () => "local-request"
  });
  const signal = new AbortController().signal;
  const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
  const result = await driver.generateJson({ instructions: "System", input: "Input", schema, signal });

  assert.deepEqual(result.output, { ok: true });
  assert.equal(result.requestId, "openai-request");
  assert.equal(result.model, "gpt-response-model");
  assert.equal(result.latencyMs, 25);
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 4, totalTokens: 16 });
  assert.equal(captured.options.signal, signal);
  assert.deepEqual(captured.body.text.format.schema, schema);
  assert.equal(captured.body.text.format.strict, true);
});

test("Claude constrains JSON in the prompt and normalizes Anthropic usage", async () => {
  let captured;
  const signal = new AbortController().signal;
  const client = {
    messages: {
      async create(body, options) {
        captured = { body, options };
        return {
          id: "claude-request",
          model: "claude-response-model",
          content: [{ type: "text", text: "```json\n{\"answer\":42}\n```" }],
          usage: { input_tokens: 9, output_tokens: 3 }
        };
      }
    }
  };
  const driver = createProviderDriver("claude_api_key", { settings: SETTINGS, client });
  const result = await driver.generateJson({
    instructions: "System",
    input: "Input",
    schema: { type: "object" },
    signal
  });

  assert.deepEqual(result.output, { answer: 42 });
  assert.deepEqual(result.usage, { inputTokens: 9, outputTokens: 3, totalTokens: 12 });
  assert.match(captured.body.system, /JSON Schema/);
  assert.equal(captured.options.signal, signal);
  assert.equal(result.warnings.length, 1);
});

test("both Ollama variants preserve their message conventions and normalized output", async () => {
  const requests = [];
  const client = {
    chat: {
      completions: {
        async create(body, options) {
          requests.push({ body, options });
          return {
            id: `ollama-${requests.length}`,
            model: body.model,
            choices: [{ message: { content: "<think>private reasoning</think>{\"done\":true}" } }],
            usage: { prompt_tokens: 6, completion_tokens: 2 }
          };
        }
      }
    }
  };

  for (const provider of ["deepseek_r1_ollama", "gpt_oss_20b_ollama"]) {
    const driver = createProviderDriver(provider, { settings: SETTINGS, client });
    const result = await driver.generateJson({ instructions: "System", input: "Input", schema: { type: "object" } });
    assert.deepEqual(result.output, { done: true });
    assert.equal(result.provider, provider);
    assert.equal(result.usage.totalTokens, 8);
  }

  assert.equal(requests[0].body.messages.length, 1, "DeepSeek combines system and user prompts");
  assert.equal(requests[1].body.messages.length, 2, "gpt-oss uses system and user roles");
  assert.deepEqual(requests[0].body.response_format, { type: "json_object" });
});

test("Codex supports injected execution, cancellation signals, and structured parsing", async () => {
  let captured;
  const signal = new AbortController().signal;
  const executor = async request => {
    captured = request;
    return {
      stdout: "{\"phase\":\"labs\"}",
      usage: { inputTokens: 7, outputTokens: 2 },
      requestId: "codex-request"
    };
  };
  const driver = createProviderDriver("openai_signin_codex", {
    settings: SETTINGS,
    executor,
    requestId: () => "fallback-request"
  });
  const result = await driver.generateJson({
    instructions: "System",
    input: "Input",
    schema: { type: "object" },
    signal
  });

  assert.deepEqual(result.output, { phase: "labs" });
  assert.equal(result.requestId, "codex-request");
  assert.equal(captured.signal, signal);
  assert.match(captured.prompt, /Return only valid JSON/);
});

test("an already-aborted signal fails before invoking a provider", async () => {
  let invoked = false;
  const client = {
    responses: {
      async create() {
        invoked = true;
        return { output_text: "{}" };
      }
    }
  };
  const controller = new AbortController();
  controller.abort();
  const driver = createProviderDriver("openai_api_key", { settings: SETTINGS, client });

  await assert.rejects(
    driver.generateJson({ instructions: "", input: "", signal: controller.signal }),
    error => error instanceof ProviderDriverError && error.code === "request_aborted"
  );
  assert.equal(invoked, false);
});

test("drivers reject image input when their declared capability is false", () => {
  const driver = createProviderDriver("gpt_oss_20b_ollama", {
    settings: SETTINGS,
    client: mockClients().gpt_oss_20b_ollama
  });
  assert.throws(
    () => driver.generateJson({ instructions: "System", input: "Input", screenshot: { dataUrl: "data:image/png;base64,AA==" } }),
    error => error instanceof ProviderDriverError && error.code === "unsupported_capability"
  );
});

test("abort errors during provider execution are normalized", async () => {
  const controller = new AbortController();
  const client = {
    responses: {
      async create() {
        controller.abort();
        throw Object.assign(new Error("socket closed"), { name: "AbortError" });
      }
    }
  };
  const driver = createProviderDriver("openai_api_key", { settings: SETTINGS, client });

  await assert.rejects(
    driver.generateText({ instructions: "", input: "", signal: controller.signal }),
    error => error.code === "request_aborted" && error.provider === "openai_api_key" && Boolean(error.requestId)
  );
});

test("health checks are injectable and do not make network calls by default", async () => {
  let probes = 0;
  const clients = mockClients();
  clients.openai_api_key.healthCheck = async ({ signal }) => {
    assert.equal(signal.aborted, false);
    probes += 1;
    return { ok: true, status: "healthy", detail: "mock" };
  };
  const registry = createProviderRegistry({ settings: SETTINGS, clients, executor: async () => "{}" });

  assert.equal((await registry.get("openai_api_key").healthCheck()).status, "configured");
  assert.equal(probes, 0);
  const checked = await registry.get("openai_api_key").healthCheck({
    probe: true,
    signal: new AbortController().signal
  });
  assert.equal(checked.status, "healthy");
  assert.equal(probes, 1);
});

test("usage normalizer accepts API and local-model naming conventions", () => {
  assert.deepEqual(
    normalizeUsage({ prompt_eval_count: 5, eval_count: 3 }),
    { inputTokens: 5, outputTokens: 3, totalTokens: 8 }
  );
  assert.deepEqual(
    normalizeUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  );
});

function mockClients() {
  const openaiShape = {
    responses: { create: async () => ({ output_text: "{}" }) },
    chat: { completions: { create: async () => ({ choices: [{ message: { content: "{}" } }] }) } }
  };
  return {
    openai_api_key: openaiShape,
    claude_api_key: { messages: { create: async () => ({ content: [{ type: "text", text: "{}" }] }) } },
    deepseek_r1_ollama: openaiShape,
    gpt_oss_20b_ollama: openaiShape
  };
}
