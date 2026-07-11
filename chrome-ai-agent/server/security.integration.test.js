import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const extensionId = "a".repeat(32);
const extensionOrigin = `chrome-extension://${extensionId}`;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(error => error ? reject(error) : resolve(port));
    });
    probe.on("error", reject);
  });
}

async function startServer() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "chrome-ai-agent-test-"));
  const port = await freePort();
  const child = spawn(process.execPath, ["index.js"], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(port), RUNTIME_SECRETS_PATH: path.join(tempDir, "runtime.json") },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", chunk => { output += String(chunk); });
  child.stderr.on("data", chunk => { output += String(chunk); });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 5000);
    const check = setInterval(() => {
      const match = output.match(/Pair the extension with this one-time backend code: ([A-Za-z0-9_-]+)/);
      if (!match) return;
      clearTimeout(timer);
      clearInterval(check);
      resolve(match[1]);
    }, 20);
    child.once("error", reject);
    child.once("exit", code => reject(new Error(`Server exited early (${code}): ${output}`)));
  }).then(pairingCode => ({ pairingCode }));

  const pairingCode = output.match(/Pair the extension with this one-time backend code: ([A-Za-z0-9_-]+)/)?.[1];
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    pairingCode,
    async close() {
      child.kill();
      await new Promise(resolve => child.once("exit", resolve));
      await rm(tempDir, { recursive: true, force: true });
    }
  };
}

async function startFakeOllama() {
  const port = await freePort();
  let output = { reply: "Observed.", done: false, phase: "patient_search", action: null, fields: [], warnings: [] };
  let delayMs = 0;
  let requestCount = 0;
  let aborted = false;
  const requests = [];
  const server = createHttpServer(async (req, res) => {
    if (req.url !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    requestCount += 1;
    res.once("close", () => {
      if (!res.writableEnded) aborted = true;
    });
    const bodyChunks = [];
    for await (const chunk of req) bodyChunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(bodyChunks).toString("utf8")));
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
    if (res.destroyed) return;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "fake-request-id",
      model: "fake-local-model",
      choices: [{ message: { content: JSON.stringify(output) } }],
      usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 }
    }));
  });
  await new Promise((resolve, reject) => server.listen(port, "127.0.0.1", resolve).once("error", reject));
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    setOutput(value) { output = value; },
    setDelay(value) { delayMs = Number(value) || 0; aborted = false; },
    requestCount() { return requestCount; },
    lastRequest() { return requests.at(-1); },
    wasAborted() { return aborted; },
    close() { return new Promise(resolve => server.close(resolve)); }
  };
}

test("local backend pairs one extension and rejects cross-origin or unpaired settings access", async () => {
  const server = await startServer();

  try {
    const beforePair = await fetch(`${server.baseUrl}/settings`, { headers: { Origin: extensionOrigin } });
    assert.equal(beforePair.status, 403);

    const pairResponse = await fetch(`${server.baseUrl}/pair`, {
      method: "POST",
      headers: { Origin: extensionOrigin, "Content-Type": "application/json" },
      body: JSON.stringify({ extensionId, pairingCode: server.pairingCode })
    });
    assert.equal(pairResponse.status, 200);
    const { backendToken } = await pairResponse.json();
    assert.ok(backendToken);

    const foreign = await fetch(`${server.baseUrl}/settings`, { headers: { Origin: "https://example.invalid" } });
    assert.equal(foreign.status, 403);

    const unpaired = await fetch(`${server.baseUrl}/settings`, { headers: { Origin: extensionOrigin } });
    assert.equal(unpaired.status, 401);

    const settings = await fetch(`${server.baseUrl}/settings`, {
      headers: { Origin: extensionOrigin, Authorization: `Bearer ${backendToken}` }
    });
    assert.equal(settings.status, 200);
    assert.equal(settings.headers.get("access-control-allow-origin"), extensionOrigin);

    const profiles = await fetch(`${server.baseUrl}/workflow-profiles`, {
      headers: { Origin: extensionOrigin, Authorization: `Bearer ${backendToken}` }
    }).then(response => response.json());
    assert.equal(profiles.profiles[0].adapterId, "trakcare-chartbook");
    assert.equal(profiles.profiles[0].externalViewer.kind, "pacs");

    const workflow = await fetch(`${server.baseUrl}/workflow-runs`, {
      method: "POST",
      headers: { Origin: extensionOrigin, Authorization: `Bearer ${backendToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: "urolithiasis-v3", provider: "gpt_oss_20b_ollama", queue: "12345,2026-01-10,first" })
    });
    assert.equal(workflow.status, 201);
    const run = await workflow.json();
    assert.equal(run.records[0].id, "first");

    const exported = await fetch(`${server.baseUrl}/workflow-runs/${run.id}/export.csv`, {
      headers: { Origin: extensionOrigin, Authorization: `Bearer ${backendToken}` }
    });
    assert.equal(exported.status, 200);
    assert.match(await exported.text(), /record_id/);
  } finally {
    await server.close();
  }
});

test("workflow routes use the provider driver contract, strict action protocol, budgets, and diagnostics", async () => {
  const server = await startServer();
  const fakeOllama = await startFakeOllama();
  try {
    const pairResponse = await fetch(`${server.baseUrl}/pair`, {
      method: "POST",
      headers: { Origin: extensionOrigin, "Content-Type": "application/json" },
      body: JSON.stringify({ extensionId, pairingCode: server.pairingCode })
    });
    const { backendToken } = await pairResponse.json();
    const headers = { Origin: extensionOrigin, Authorization: `Bearer ${backendToken}`, "Content-Type": "application/json" };
    const savedSettings = await fetch(`${server.baseUrl}/settings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ provider: "gpt_oss_20b_ollama", baseUrl: fakeOllama.baseUrl, model: "fake-local-model" })
    });
    assert.equal(savedSettings.status, 200);

    const statusResponse = await fetch(`${server.baseUrl}/providers/status`, { headers });
    assert.equal(statusResponse.status, 200);
    const providerStatus = await statusResponse.json();
    assert.equal(providerStatus.providers.length, 5);
    assert.ok(providerStatus.providers.every(provider => provider.capabilities.structuredGeneration));
    assert.doesNotMatch(JSON.stringify(providerStatus), /backendToken|apiKey/i);

    const createResponse = await fetch(`${server.baseUrl}/workflow-runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ profileId: "urolithiasis-v3", provider: "gpt_oss_20b_ollama", queue: "12345,2026-01-10,route-record" })
    });
    const run = await createResponse.json();
    const planUrl = `${server.baseUrl}/workflow-runs/${run.id}/records/route-record/plan`;
    const context = { fullPage: { url: "http://fixture.test/record", title: "Record", chunks: [
      { chunkId: "one", text: "Initial evidence." },
      { chunkId: "stable", text: "UNCHANGED_REGION_SENTINEL" }
    ], elements: [], formValues: [] } };
    const planResponse = await fetch(planUrl, { method: "POST", headers, body: JSON.stringify({ provider: "gpt_oss_20b_ollama", context }) });
    assert.equal(planResponse.status, 200);
    const plan = await planResponse.json();
    assert.equal(plan.action, null);
    assert.equal("actions" in plan, false);

    const diagnosticsResponse = await fetch(`${server.baseUrl}/workflow-runs/${run.id}/diagnostics`, { headers });
    const diagnostics = await diagnosticsResponse.json();
    assert.equal(diagnostics.inputTokens, 11);
    assert.equal(diagnostics.outputTokens, 3);
    assert.ok(diagnostics.cacheHits >= 0);
    assert.match(diagnostics.runId, /^sha256:/);

    const hostileEventResponse = await fetch(`${server.baseUrl}/workflow-runs/${run.id}/diagnostics/events`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        eventType: "provider_response",
        result: "succeeded",
        phase: "patient-12345",
        model: "model-for-12345",
        prompt: "MRN 12345",
        url: "http://fixture.test/patient/12345"
      })
    });
    const hostileEvent = await hostileEventResponse.json();
    assert.equal(hostileEvent.event.eventType, "workflow_action");
    assert.equal(JSON.stringify(hostileEvent).includes("12345"), false);

    const deltaResponse = await fetch(planUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        provider: "gpt_oss_20b_ollama",
        context: {
          cursor: plan.contextCursor,
          regionHashes: { "chunk:one": "changed", "chunk:stable": "stable" },
          delta: { changedChunks: [{ chunkId: "one", text: "Changed evidence." }], changedElements: [], changedFormValues: [] }
        }
      })
    });
    assert.equal(deltaResponse.status, 200);
    const providerPayload = JSON.stringify(fakeOllama.lastRequest());
    assert.match(providerPayload, /Changed evidence/);
    assert.doesNotMatch(providerPayload, /UNCHANGED_REGION_SENTINEL/);
    const deltaDiagnostics = await fetch(`${server.baseUrl}/workflow-runs/${run.id}/diagnostics`, { headers }).then(response => response.json());
    assert.ok(deltaDiagnostics.cacheHits >= 1);

    fakeOllama.setOutput({
      reply: "Wrong phase field.", done: false, phase: "patient_search", action: null, warnings: [],
      fields: [{ fieldId: "K", status: "found", value: "1", source: "Visible source", sourceDate: "", url: "", snippet: "Direct evidence", note: "" }]
    });
    const outOfPhase = await fetch(planUrl, { method: "POST", headers, body: JSON.stringify({ provider: "gpt_oss_20b_ollama", context }) });
    assert.equal(outOfPhase.status, 400);
    assert.match((await outOfPhase.json()).error, /not allowed during phase patient_search/i);

    fakeOllama.setOutput({ reply: "Observed.", done: false, phase: "patient_search", action: null, fields: [], warnings: [] });
    const hugeContext = {
      fullPage: {
        url: "http://fixture.test/large",
        title: "Large",
        chunks: Array.from({ length: 60 }, (_, index) => ({ chunkId: `large-${index}`, text: "x".repeat(5000) })),
        elements: Array.from({ length: 80 }, (_, index) => ({
          selector: `#large-${index}`,
          frameId: 0,
          text: "control ".repeat(800),
          label: "label ".repeat(800),
          ariaLabel: "aria ".repeat(800)
        })),
        formValues: []
      }
    };
    const oversized = await fetch(planUrl, { method: "POST", headers, body: JSON.stringify({ provider: "gpt_oss_20b_ollama", context: hugeContext }) });
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json()).code, "CONTEXT_BUDGET_EXCEEDED");

    fakeOllama.setOutput({ reply: "General agent result.", actions: [] });
    const agentResponse = await fetch(`${server.baseUrl}/agent`, {
      method: "POST",
      headers,
      body: JSON.stringify({ task: "Read the fixture", provider: "gpt_oss_20b_ollama", page: context.fullPage })
    });
    assert.equal(agentResponse.status, 200);
    fakeOllama.setOutput({
      reply: "Collection result.", done: true, actions: [], rows: [], fields: [], warnings: [], nextRecordHint: "", stopReason: "complete"
    });
    const collectionResponse = await fetch(`${server.baseUrl}/collection/step`, {
      method: "POST",
      headers,
      body: JSON.stringify({ task: "Collect fixture data", provider: "gpt_oss_20b_ollama", page: context.fullPage, runState: {} })
    });
    assert.equal(collectionResponse.status, 200);
    const generalDiagnostics = await fetch(`${server.baseUrl}/diagnostics/summary`, { headers }).then(response => response.json());
    assert.equal(generalDiagnostics.agent.inputTokens, 11);
    assert.equal(generalDiagnostics.collection.outputTokens, 3);

    fakeOllama.setOutput({ reply: "Observed.", done: false, phase: "patient_search", action: null, fields: [], warnings: [] });
    fakeOllama.setDelay(600);
    const requestsBeforeRace = fakeOllama.requestCount();
    const latePlanPromise = fetch(planUrl, { method: "POST", headers, body: JSON.stringify({ provider: "gpt_oss_20b_ollama", context }) });
    const deadline = Date.now() + 2000;
    while (fakeOllama.requestCount() === requestsBeforeRace && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(fakeOllama.requestCount() > requestsBeforeRace);
    const stoppedResponse = await fetch(`${server.baseUrl}/workflow-runs/${run.id}/stop`, { method: "POST", headers, body: "{}" });
    assert.equal(stoppedResponse.status, 200);
    const latePlan = await latePlanPromise;
    assert.notEqual(latePlan.status, 200);
    assert.equal(fakeOllama.wasAborted(), true);
    const stoppedRunResponse = await fetch(`${server.baseUrl}/workflow-runs/${run.id}`, { headers });
    assert.equal((await stoppedRunResponse.json()).status, "stopped");
  } finally {
    await fakeOllama.close();
    await server.close();
  }
});
