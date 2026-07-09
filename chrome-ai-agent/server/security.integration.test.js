import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
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
