import assert from "node:assert/strict";
import test from "node:test";

import { DiagnosticsRegistry, sanitizeDiagnosticEvent } from "./observability.js";
import { WorkflowContextCache } from "./workflows/context-cache.js";
import { trakCarePhaseFieldIds } from "./workflows/trakcare-adapter.js";
import { assertPhaseFieldAllowed, assertSingleWorkflowAction } from "./workflows/workflow-protocol.js";
import { assertPromptByteBudget, collectionPlaybookForPrompt } from "./workflows/prompt-policy.js";
import { publicWorkflowPolicy, workflowAdapterFor } from "./workflows/workflow-adapters.js";

test("workflow protocol accepts one action or null and rejects legacy arrays", () => {
  assert.equal(assertSingleWorkflowAction({ action: null }), null);
  assert.deepEqual(assertSingleWorkflowAction({ action: { type: "click" } }), { type: "click" });
  assert.throws(() => assertSingleWorkflowAction({ actions: [{ type: "click" }] }), error => error?.code === "INVALID_WORKFLOW_PROTOCOL");
  assert.throws(() => assertSingleWorkflowAction({ action: null, actions: [] }), error => error?.code === "INVALID_WORKFLOW_PROTOCOL");
});

test("collection playbooks are sent once and oversized workflow prompts fail with a retryable code", () => {
  const sanitize = value => String(value).slice(0, 12000);
  assert.equal(collectionPlaybookForPrompt("playbook", { playbookAcknowledged: false }, sanitize), "playbook");
  assert.equal(collectionPlaybookForPrompt("playbook", { playbookAcknowledged: true }, sanitize), "");
  assert.equal(assertPromptByteBudget("small", 10), 5);
  assert.throws(() => assertPromptByteBudget("too large", 3), error => error?.code === "CONTEXT_BUDGET_EXCEEDED");
});

test("workflow prompts include only phase-relevant field state", () => {
  assert.deepEqual(trakCarePhaseFieldIds("patient_search", ["K", "BF"]), []);
  assert.deepEqual(trakCarePhaseFieldIds("radiology", ["K", "BF"]), ["BF", "BG", "BH", "AL", "CS", "CT", "CU", "CV", "CW"]);
  assert.deepEqual(trakCarePhaseFieldIds("validation", ["K", "BF"]), ["K", "BF"]);
});

test("generic workflow profiles can define phases, fields, and viewer policy without TrakCare code", () => {
  const profile = {
    adapterId: "generic-browser-read-only",
    mode: "read_only",
    phases: ["search", "results"],
    phaseFields: { search: [], results: ["A"] },
    blockedActionWords: ["save"],
    externalViewer: { phase: "results", kind: "document-viewer" }
  };
  const adapter = workflowAdapterFor(profile);
  assert.equal(adapter.id, "generic-browser-read-only");
  assert.deepEqual(adapter.phaseFieldIds(profile, "results", ["A", "B"]), ["A"]);
  assert.equal(adapter.transitionAllowed(profile, "search", "results"), true);
  assert.equal(adapter.actionAllowed(profile, { type: "click", description: "Save record" }), false);
  assert.equal(publicWorkflowPolicy(profile).externalViewer.kind, "document-viewer");
});

test("workflow context cache applies deltas and requires a valid cursor", () => {
  const cache = new WorkflowContextCache({ ttlMs: 60_000 });
  const first = cache.resolve("run:record", {
    fullPage: {
      url: "https://example.test/one",
      chunks: [{ chunkId: "a", text: "one" }, { chunkId: "stable", text: "unchanged evidence" }],
      elements: [{ frameId: 0, selector: "#a", text: "A" }, { frameId: 0, selector: "#stable", text: "Stable" }],
      formValues: []
    },
    regionHashes: { "chunk:a": "one", "chunk:stable": "stable" }
  });
  assert.equal(first.cacheHit, false);

  const second = cache.resolve("run:record", {
    cursor: first.cursor,
    delta: {
      changedChunks: [{ chunkId: "a", text: "two" }],
      changedElements: [{ frameId: 0, selector: "#b", text: "B" }],
      removedElementIds: ['target:0:#a:[]']
    }
  });
  assert.equal(second.cacheHit, true);
  assert.equal(second.changedPage.contextMode, "delta");
  assert.equal(second.changedPage.chunks.length, 1);
  assert.equal(second.changedPage.elements.length, 1);
  assert.equal(second.changedPage.chunks.some(chunk => chunk.text === "unchanged evidence"), false);
  assert.equal(second.page.chunks[0].text, "two");
  assert.equal(second.page.chunks.length, 2);
  assert.ok(second.page.elements.some(element => element.selector === "#b"));
  assert.throws(() => cache.resolve("run:record", { cursor: first.cursor, delta: {} }), /fresh full page snapshot/);
});

test("out-of-phase workflow fields are rejected", () => {
  assert.doesNotThrow(() => assertPhaseFieldAllowed("BF", "radiology", trakCarePhaseFieldIds("radiology")));
  assert.throws(
    () => assertPhaseFieldAllowed("K", "radiology", trakCarePhaseFieldIds("radiology")),
    error => error?.code === "OUT_OF_PHASE_FIELD"
  );
});

test("diagnostics keep only allowlisted non-PHI fields", () => {
  const sanitized = sanitizeDiagnosticEvent({
    eventType: "provider_response",
    result: "succeeded",
    provider: "openai_api_key",
    model: "model",
    phase: "radiology",
    inputTokens: 12,
    prompt: "MRN 123456",
    url: "https://hospital/patient/123456",
    selector: "#patient-123456"
  });
  assert.equal(sanitized.inputTokens, 12);
  assert.equal("prompt" in sanitized, false);
  assert.equal("url" in sanitized, false);
  assert.equal("selector" in sanitized, false);

  const hostileAllowedFields = sanitizeDiagnosticEvent({
    timestamp: "MRN-123456",
    correlationId: "MRN-123456",
    phase: "patient-123456",
    provider: "provider-123456",
    model: "model-for-123456",
    actionType: "patient-123456"
  });
  assert.equal(JSON.stringify(hostileAllowedFields).includes("123456"), false);
  assert.match(hostileAllowedFields.model, /^sha256:/);

  const registry = new DiagnosticsRegistry();
  registry.record("run_test", sanitized);
  assert.equal(registry.summary("run_test").eventCount, 1);
  assert.equal(JSON.stringify(registry.summary("run_test")).includes("123456"), false);
});
